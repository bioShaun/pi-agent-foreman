import { writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readReviewFeedback, reviewerInvocation, workerInvocation } from "./agents.ts";
import { runWithLoader, type RunResult } from "./run-command.ts";
import { artifactPath, createRunId, ensureRunDirs, tracePath } from "./agent-paths.ts";
import { loadTask, updateTaskStatus } from "./agent-store.ts";
import {
	execHintAfterReviewFail,
	formatReviewVerdict,
	parseReviewVerdict,
	reviewStatusFromVerdict,
	shouldInjectReviewFeedback,
} from "./task-status.ts";
import type { AgentTask, TaskRun, TaskStatus, Worker } from "./types.ts";

export interface InvokeSpec {
	label: string;
	command: string;
	args: string[];
	stdin?: string;
	jsonStream?: "claude" | "codex";
	antigravityProgress?: boolean;
	liveLogPath?: string;
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
			timeoutMs: spec.timeoutMs,
		});
}

function tailLines(text: string, lines = 8): string {
	const parts = text.trim().split("\n").filter(Boolean);
	return parts.slice(-lines).join("\n");
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

	const reviewFeedback = shouldInjectReviewFeedback(task.status)
		? readReviewFeedback(task.artifacts.review)
		: undefined;
	const { agent, invocation } = workerInvocation(deps.cwd, worker, task.prompt, reviewFeedback);

	const runId = createRunId(worker);
	const startedAt = new Date().toISOString();
	const logPath = artifactPath(deps.cwd, "exec", taskId, runId);
	const live = tracePath(deps.cwd, taskId, runId);
	ensureRunDirs(logPath, live);

	patchTaskStatus(deps, taskId, "running", { worker });

	try {
		const result = await deps.invoke({
			label: `Executing ${taskId} with ${agent.cli}`,
			command: invocation.command,
			args: invocation.args,
			stdin: invocation.stdin,
			jsonStream: invocation.jsonStream,
			antigravityProgress: invocation.antigravityProgress,
			liveLogPath: live,
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
			paths: { output: logPath, live },
		};

		if (result.killed) {
			patchTaskStatus(deps, taskId, "pending", {
				artifacts: { log: logPath, liveTrace: live },
				run,
			});
			throw new Error(`Execution cancelled (${taskId})`);
		}

		if (result.code !== 0) {
			patchTaskStatus(deps, taskId, "pending", {
				artifacts: { log: logPath, liveTrace: live },
				run,
			});
			const detail = workerFailureDetail(result, logBody);
			throw new Error(
				`Worker ${agent.cli} failed (exit ${result.code}). See ${logPath}${detail ? `\n\n${detail.slice(0, 800)}` : ""}`,
			);
		}

		const updated = patchTaskStatus(deps, taskId, "done", {
			worker,
			artifacts: { log: logPath, liveTrace: live },
			timestamps: { ...task.timestamps, executed: endedAt },
			run,
		});

		const retryNote = reviewFeedback ? " (incorporating review feedback)" : "";
		const summary = [
			`${taskId} done (${agent.cli})${retryNote}`,
			`Log: ${logPath}`,
			`Live trace: ${live}`,
		].join("\n");

		return { summary, task: updated };
	} catch (err) {
		const current = loadTask(deps.cwd, taskId);
		if (current?.status === "running") {
			patchTaskStatus(deps, taskId, "pending", { worker });
		}
		throw err;
	}
}

export async function runReviewPhase(
	deps: TaskRunDeps,
	taskId: string,
): Promise<{ summary: string; task: AgentTask; passed: boolean }> {
	const task = loadTask(deps.cwd, taskId);
	if (!task) throw new Error(`Task not found: ${taskId}`);

	const { agent, invocation } = reviewerInvocation(deps.cwd, taskId, task.title);

	const runId = createRunId(agent.cli);
	const startedAt = new Date().toISOString();
	const reviewPath = artifactPath(deps.cwd, "review", taskId, runId);
	ensureRunDirs(reviewPath);

	const result = await deps.invoke({
		label: `Reviewing ${taskId}`,
		command: invocation.command,
		args: invocation.args,
		timeoutMs: 30 * 60 * 1000,
	});

	const body = result.stdout.trim() || result.stderr.trim();
	writeFileSync(reviewPath, body, "utf-8");

	if (result.killed) throw new Error("Review cancelled");
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `${agent.cli} review failed (exit ${result.code})`);
	}

	const passed = parseReviewVerdict(body);
	const status = reviewStatusFromVerdict(passed);
	const endedAt = new Date().toISOString();
	const run: TaskRun = {
		runId,
		phase: "review",
		worker: agent.cli === "codex" ? "codex" : undefined,
		startedAt,
		endedAt,
		exitCode: result.code,
		paths: { output: reviewPath },
	};

	const updated = patchTaskStatus(deps, taskId, status, {
		artifacts: { review: reviewPath },
		timestamps: { ...task.timestamps, reviewed: endedAt },
		run,
	});

	const verdict = formatReviewVerdict(passed);
	const next = passed ? "" : execHintAfterReviewFail(taskId, task.worker);
	const summary = [
		`Review ${taskId}: ${verdict}`,
		`Report: ${reviewPath}`,
		next,
		"",
		body.slice(0, 2000) + (body.length > 2000 ? "\n…(truncated, see file)" : ""),
	].join("\n");

	return { summary, task: updated, passed };
}
