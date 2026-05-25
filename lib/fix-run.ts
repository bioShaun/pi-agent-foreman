import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixerInvocation, type FixerTaskBlock } from "./agents.ts";
import { agentRoot, createRunId } from "./agent-paths.ts";
import { updateTaskStatus } from "./agent-store.ts";
import { tailLines } from "./run-display.ts";
import {
	formatFindingsForWorker,
	formatFixerLoaderContext,
	loadReviewContext,
	type ReviewContext,
} from "./review-verdict.ts";
import type { TaskRunDeps } from "./task-run.ts";
import type { AgentPlan, AgentTask, Fixer, TaskRun } from "./types.ts";

export interface FixPhaseResult {
	summary: string;
	fixedTaskIds: string[];
	logPath: string;
}

/** Plan-scoped artifact paths (single CLI call covers many tasks). */
function planScopedPath(cwd: string, kind: "artifacts" | "prompts" | "traces", planId: string, runId: string): string {
	const sub = kind === "artifacts" ? join("artifacts", "fix") : kind === "prompts" ? join("prompts", "fix") : "traces";
	const ext = kind === "artifacts" ? "log" : kind === "prompts" ? "md" : "live.log";
	const path = join(agentRoot(cwd), sub, planId, `${runId}.${ext}`);
	mkdirSync(join(path, ".."), { recursive: true });
	return path;
}

function buildBlock(cwd: string, task: AgentTask): { block: FixerTaskBlock; ctx?: ReviewContext } {
	const ctx = loadReviewContext(task.artifacts.review, task.artifacts.reviewVerdict, task.id);
	const findings = ctx?.payload
		? formatFindingsForWorker(ctx.payload)
		: ctx?.rawReview
			? "(no structured findings — see full review report below)"
			: "(no review artifact found for this task)";

	return {
		block: {
			taskId: task.id,
			title: task.title,
			taskPrompt: task.prompt,
			reviewRunId: ctx?.runId,
			reviewSummary: ctx?.payload?.summary,
			findings,
			reviewReport: ctx?.rawReview,
		},
		ctx,
	};
}

function writeFixPromptSnapshot(
	promptPath: string,
	meta: { plan_id: string; task_ids: string[]; run_id: string; cli: string; fixer: Fixer },
	prompt: string,
): void {
	const frontmatter = [
		"---",
		`plan_id: ${JSON.stringify(meta.plan_id)}`,
		`task_ids: ${JSON.stringify(meta.task_ids.join(","))}`,
		`phase: "fix"`,
		`run_id: ${JSON.stringify(meta.run_id)}`,
		`cli: ${JSON.stringify(meta.cli)}`,
		`fixer: ${JSON.stringify(meta.fixer)}`,
		"---",
		"",
	].join("\n");
	writeFileSync(promptPath, `${frontmatter}${prompt}`, "utf-8");
}

export async function runFixPhase(
	deps: TaskRunDeps,
	plan: AgentPlan,
	tasks: AgentTask[],
	fixer: Fixer,
): Promise<FixPhaseResult> {
	if (tasks.length === 0) throw new Error("runFixPhase: no tasks supplied");

	const blocks: FixerTaskBlock[] = [];
	const ctxByTask: Array<{ taskId: string; payload?: ReviewContext["payload"] }> = [];
	for (const task of tasks) {
		const { block, ctx } = buildBlock(deps.cwd, task);
		blocks.push(block);
		ctxByTask.push({ taskId: task.id, payload: ctx?.payload });
	}

	const { agent, prompt, invocation } = fixerInvocation(deps.cwd, fixer, blocks);

	const runId = createRunId(agent.cli);
	const startedAt = new Date().toISOString();
	const logPath = planScopedPath(deps.cwd, "artifacts", plan.id, runId);
	const live = planScopedPath(deps.cwd, "traces", plan.id, runId);
	const promptPath = planScopedPath(deps.cwd, "prompts", plan.id, runId);

	writeFixPromptSnapshot(
		promptPath,
		{
			plan_id: plan.id,
			task_ids: blocks.map((b) => b.taskId),
			run_id: runId,
			cli: agent.cli,
			fixer,
		},
		prompt,
	);

	const result = await deps.invoke({
		label: `Fixing ${blocks.length} task(s) with ${agent.cli}`,
		command: invocation.command,
		args: invocation.args,
		stdin: invocation.stdin,
		jsonStream: invocation.jsonStream,
		antigravityProgress: invocation.antigravityProgress,
		liveLogPath: live,
		loaderContext: formatFixerLoaderContext(ctxByTask),
		timeoutMs: 60 * 60 * 1000,
	});

	const logBody = [result.stdout, result.stderr].filter(Boolean).join("\n--- stderr ---\n");
	writeFileSync(logPath, logBody, "utf-8");

	if (result.killed) throw new Error(`Fix run cancelled (${blocks.length} task(s))`);
	if (result.code !== 0) {
		const detail = result.stderr.trim() || tailLines(result.stdout) || tailLines(logBody);
		throw new Error(
			`Fixer ${agent.cli} failed (exit ${result.code}). See ${logPath}${detail ? `\n\n${detail.slice(0, 800)}` : ""}`,
		);
	}

	const endedAt = new Date().toISOString();
	const fixedTaskIds: string[] = [];
	for (const task of tasks) {
		const run: TaskRun = {
			runId,
			phase: "fix",
			worker: agent.cli === "codex" || agent.cli === "claude" ? agent.cli : undefined,
			startedAt,
			endedAt,
			exitCode: result.code,
			paths: { output: logPath, live, prompt: promptPath },
		};
		updateTaskStatus(deps.cwd, task.id, "review_pass", {
			artifacts: { fixLog: logPath, fixPrompt: promptPath, liveTrace: live },
			timestamps: { ...task.timestamps, reviewed: endedAt },
			run,
		});
		fixedTaskIds.push(task.id);
	}
	deps.refreshWidget?.();

	const summary = [
		`Fix complete (${agent.cli}) — ${fixedTaskIds.length} task(s) marked review_pass`,
		`Tasks: ${fixedTaskIds.join(", ")}`,
		`Log: ${logPath}`,
		`Prompt: ${promptPath}`,
		`Live trace: ${live}`,
	].join("\n");

	return { summary, fixedTaskIds, logPath };
}
