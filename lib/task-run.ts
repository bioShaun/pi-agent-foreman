import { writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { reviewerInvocation, workerInvocation } from "./agents.ts";
import { runWithLoader, type RunResult } from "./run-command.ts";
import { tailLines } from "./run-display.ts";
import { artifactPath, createRunId, ensureRunDirs, reviewVerdictPath, tracePath } from "./agent-paths.ts";
import { loadTask, updateTaskStatus } from "./agent-store.ts";
import { writePromptSnapshot } from "./prompt-persistence.ts";
import {
	extractReviewVerdictFromBody,
	formatFindingsSummary,
	formatReviewLoaderContext,
	formatReviewPhaseLoaderContext,
	loadReviewContext,
	type ReviewContext,
	reviewPassed,
	shouldIncorporateReviewOnExec,
	writeReviewVerdictJson,
} from "./review-verdict.ts";
import {
	execHintAfterReviewFail,
	execRevertStatus,
	formatReviewVerdict,
	reviewStatusFromVerdict,
} from "./task-status.ts";
import type { AgentTask, Reviewer, TaskRun, TaskStatus, Worker } from "./types.ts";

export interface InvokeSpec {
	label: string;
	command: string;
	args: string[];
	stdin?: string;
	jsonStream?: "claude" | "codex";
	antigravityProgress?: boolean;
	liveLogPath?: string;
	loaderContext?: string[];
	timeoutMs?: number;
}

export type InvokeAdapter = (spec: InvokeSpec) => Promise<RunResult>;

export interface TaskRunDeps {
	cwd: string;
	invoke: InvokeAdapter;
	refreshWidget?: () => void;
}

export function makeTaskRunDeps(pi: ExtensionAPI, ctx: ExtensionCommandContext, refreshWidget: () => void): TaskRunDeps {
	return {
		cwd: ctx.cwd,
		invoke: makeInvokeAdapter(pi, ctx),
		refreshWidget,
	};
}

function patchTaskStatus(
	deps: TaskRunDeps,
	taskId: string,
	status: TaskStatus,
	extra?: Parameters<typeof updateTaskStatus>[3],
): AgentTask {
	const updated = updateTaskStatus(deps.cwd, taskId, status, extra);
	deps.refreshWidget?.();
	return updated;
}

export function makeInvokeAdapter(pi: ExtensionAPI, ctx: ExtensionCommandContext): InvokeAdapter {
	return (spec) =>
		runWithLoader(pi, ctx, spec.label, spec.command, spec.args, {
			cwd: ctx.cwd,
			stdin: spec.stdin,
			jsonStream: spec.jsonStream,
			antigravityProgress: spec.antigravityProgress,
			liveLogPath: spec.liveLogPath,
			loaderContext: spec.loaderContext,
			timeoutMs: spec.timeoutMs,
		});
}

function resolveExecReviewLoad(
	task: AgentTask,
	taskId: string,
): { incorporatingReview: boolean; reviewContext?: ReviewContext; loaderContext?: string[] } {
	if (!shouldIncorporateReviewOnExec(task)) {
		return { incorporatingReview: false };
	}

	const reviewContext = loadReviewContext(task.artifacts.review, task.artifacts.reviewVerdict, taskId);
	if (reviewContext) {
		return {
			incorporatingReview: true,
			reviewContext,
			loaderContext: formatReviewLoaderContext(reviewContext),
		};
	}

	const hint = task.artifacts.review
		? `↳ review_fail · could not read ${task.artifacts.review}`
		: "↳ review_fail · no review artifact on task";
	return { incorporatingReview: true, loaderContext: [hint] };
}

function workerFailureDetail(result: { stdout: string; stderr: string }, logBody: string): string {
	return result.stderr.trim() || tailLines(result.stdout) || tailLines(logBody);
}

export async function runExecPhase(
	deps: TaskRunDeps,
	taskId: string,
	worker: Worker,
): Promise<{ summary: string; task: AgentTask }> {
	const task = loadTask(deps.cwd, taskId);
	if (!task) throw new Error(`Task not found: ${taskId}`);

	const priorStatus = task.status;
	const { incorporatingReview, reviewContext, loaderContext } = resolveExecReviewLoad(task, taskId);
	const { agent, prompt, invocation } = workerInvocation(deps.cwd, worker, task.prompt, reviewContext);
	const revertStatus = execRevertStatus(priorStatus, incorporatingReview);

	const runId = createRunId(worker);
	const startedAt = new Date().toISOString();
	const logPath = artifactPath(deps.cwd, "exec", taskId, runId);
	const live = tracePath(deps.cwd, taskId, runId);
	ensureRunDirs(logPath, live);

	const promptPath = writePromptSnapshot(deps.cwd, {
		task_id: taskId,
		phase: "exec",
		run_id: runId,
		cli: agent.cli,
		worker,
		incorporated_review_run_id: reviewContext?.runId,
		finding_count: reviewContext?.payload?.findings.length,
	}, prompt);

	patchTaskStatus(deps, taskId, "running", { worker });

	try {
		const result = await deps.invoke({
			label: incorporatingReview
				? `Executing ${taskId} with ${agent.cli} · review retry`
				: `Executing ${taskId} with ${agent.cli}`,
			command: invocation.command,
			args: invocation.args,
			stdin: invocation.stdin,
			jsonStream: invocation.jsonStream,
			antigravityProgress: invocation.antigravityProgress,
			liveLogPath: live,
			loaderContext,
			timeoutMs: 60 * 60 * 1000,
		});

		const logBody = [result.stdout, result.stderr].filter(Boolean).join("\n--- stderr ---\n");
		writeFileSync(logPath, logBody, "utf-8");

		const endedAt = new Date().toISOString();
		const run: TaskRun = {
			runId,
			phase: "exec",
			worker,
			startedAt,
			endedAt,
			exitCode: result.code,
			paths: { output: logPath, live, prompt: promptPath },
		};

		if (result.killed) {
			patchTaskStatus(deps, taskId, revertStatus, {
				artifacts: { log: logPath, liveTrace: live, execPrompt: promptPath },
				run,
			});
			throw new Error(`Execution cancelled (${taskId})`);
		}

		if (result.code !== 0) {
			patchTaskStatus(deps, taskId, revertStatus, {
				artifacts: { log: logPath, liveTrace: live, execPrompt: promptPath },
				run,
			});
			const detail = workerFailureDetail(result, logBody);
			throw new Error(
				`Worker ${agent.cli} failed (exit ${result.code}). See ${logPath}${detail ? `\n\n${detail.slice(0, 800)}` : ""}`,
			);
		}

		const updated = patchTaskStatus(deps, taskId, "done", {
			worker,
			artifacts: { log: logPath, liveTrace: live, execPrompt: promptPath },
			timestamps: { ...task.timestamps, executed: endedAt },
			run,
		});

		const retryNote = incorporatingReview
			? ` (from review ${reviewContext?.runId ?? "unknown"}${reviewContext?.payload ? `, ${reviewContext.payload.findings.length} finding(s)` : ""})`
			: "";
		const summary = [
			`${taskId} done (${agent.cli})${retryNote}`,
			`Prompt: ${promptPath}`,
			`Log: ${logPath}`,
			`Live trace: ${live}`,
		].join("\n");

		return { summary, task: updated };
	} catch (err) {
		const current = loadTask(deps.cwd, taskId);
		if (current?.status === "running") {
			patchTaskStatus(deps, taskId, revertStatus, { worker });
		}
		throw err;
	}
}

export async function runReviewPhase(
	deps: TaskRunDeps,
	taskId: string,
	reviewer?: Reviewer,
): Promise<{ summary: string; task: AgentTask; passed: boolean }> {
	const task = loadTask(deps.cwd, taskId);
	if (!task) throw new Error(`Task not found: ${taskId}`);

	const { agent, prompt, invocation } = reviewerInvocation(deps.cwd, taskId, task.title, reviewer);

	const runId = createRunId(agent.cli);
	const startedAt = new Date().toISOString();
	const reviewPath = artifactPath(deps.cwd, "review", taskId, runId);
	const verdictPath = reviewVerdictPath(deps.cwd, taskId, runId);
	const live = tracePath(deps.cwd, taskId, runId);
	ensureRunDirs(reviewPath, live, verdictPath);

	const promptPath = writePromptSnapshot(deps.cwd, {
		task_id: taskId,
		phase: "review",
		run_id: runId,
		cli: agent.cli,
		reviewer: reviewer ?? agent.reviewer ?? agent.cli,
	}, prompt);

	const result = await deps.invoke({
		label: `Reviewing ${taskId} with ${agent.cli}`,
		command: invocation.command,
		args: invocation.args,
		stdin: invocation.stdin,
		jsonStream: invocation.jsonStream,
		liveLogPath: live,
		loaderContext: formatReviewPhaseLoaderContext(task, deps.cwd),
		timeoutMs: 30 * 60 * 1000,
	});

	const body = result.stdout.trim() || result.stderr.trim();
	writeFileSync(reviewPath, body, "utf-8");

	if (result.killed) throw new Error("Review cancelled");
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `${agent.cli} review failed (exit ${result.code})`);
	}

	const payload = extractReviewVerdictFromBody(body, taskId, runId);
	if (payload) writeReviewVerdictJson(verdictPath, payload);

	const passed = reviewPassed(body, payload);
	const status = reviewStatusFromVerdict(passed);
	const endedAt = new Date().toISOString();
	const run: TaskRun = {
		runId,
		phase: "review",
		worker: agent.cli === "codex" || agent.cli === "claude" ? agent.cli : undefined,
		startedAt,
		endedAt,
		exitCode: result.code,
		paths: { output: reviewPath, live, prompt: promptPath },
	};

	const updated = patchTaskStatus(deps, taskId, status, {
		artifacts: {
			review: reviewPath,
			reviewVerdict: payload ? verdictPath : undefined,
			liveTrace: live,
			reviewPrompt: promptPath,
		},
		timestamps: { ...task.timestamps, reviewed: endedAt },
		run,
	});

	const verdict = formatReviewVerdict(passed);
	const findingsLine = payload ? formatFindingsSummary(payload) : "";
	const next = passed ? "" : execHintAfterReviewFail(taskId, task.worker);
	const summary = [
		`Review ${taskId}: ${verdict}`,
		`Report: ${reviewPath}`,
		payload ? `Verdict: ${verdictPath}` : "",
		`Prompt: ${promptPath}`,
		findingsLine,
		next,
		"",
		body.slice(0, 2000) + (body.length > 2000 ? "\n…(truncated, see file)" : ""),
	]
		.filter(Boolean)
		.join("\n");

	return { summary, task: updated, passed };
}
