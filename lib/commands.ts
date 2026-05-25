import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildPlannerPrompt,
	buildReviewerPrompt,
	buildWorkerPrompt,
	readReviewFeedback,
} from "./agents.ts";
import { parsePlanOutput } from "./parse-plan.ts";
import {
	assertWorkerAvailable,
	parseExecArgs,
	parseReviewArgs,
	runWithLoader,
	workerCommand,
} from "./run-command.ts";
import {
	agentRoot,
	createPlanFromParsed,
	formatTaskList,
	listTasks,
	loadTask,
	updateTaskStatus,
} from "./state.ts";
import type { AgentTask, Worker } from "./types.ts";

function reviewPassed(body: string): boolean {
	return /\bPASS\b/i.test(body) && !/\bFAIL\b/i.test(body.split("PASS").pop() ?? "");
}

export async function runPlan(pi: ExtensionAPI, ctx: ExtensionCommandContext, goal: string): Promise<string> {
	if (!goal.trim()) throw new Error("Usage: /agent plan <goal>");

	await assertWorkerAvailable(pi, ctx.cwd, "codex");

	const result = await runWithLoader(pi, ctx, `Planning: ${goal.slice(0, 60)}…`, "codex", ["exec", "-"], {
		cwd: ctx.cwd,
		stdin: buildPlannerPrompt(ctx.cwd, goal),
		timeoutMs: 30 * 60 * 1000,
	});

	if (result.killed) throw new Error("Planning cancelled");
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `codex exec failed (exit ${result.code})`);
	}

	const raw = result.stdout.trim() || result.stderr.trim();
	const parsed = parsePlanOutput(raw, goal);
	const plan = createPlanFromParsed(ctx.cwd, parsed.goal, raw, parsed);

	return [
		`Plan ${plan.id} created (${plan.taskIds.length} tasks)`,
		"",
		formatTaskList(plan.taskIds.map((id) => loadTask(ctx.cwd, id)!).filter(Boolean)),
		"",
		`Next: /agent run ${plan.taskIds[0]} --worker claude`,
	].join("\n");
}

async function execTask(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	taskId: string,
	worker: Worker,
): Promise<string> {
	const task = loadTask(ctx.cwd, taskId);
	if (!task) throw new Error(`Task not found: ${taskId}`);

	await assertWorkerAvailable(pi, ctx.cwd, worker);

	const reviewFeedback =
		task.status === "review_fail" ? readReviewFeedback(task.artifacts.review) : undefined;
	const prompt = buildWorkerPrompt(ctx.cwd, worker, task.prompt, reviewFeedback);

	updateTaskStatus(ctx.cwd, taskId, "running", { worker });

	const { command, args: cmdArgs, stdin } = workerCommand(worker, prompt);
	const result = await runWithLoader(
		pi,
		ctx,
		`Executing ${taskId} with ${worker}`,
		command,
		cmdArgs,
		{ cwd: ctx.cwd, stdin, timeoutMs: 60 * 60 * 1000 },
	);

	mkdirSync(join(agentRoot(ctx.cwd), "logs"), { recursive: true });
	const logPath = join(agentRoot(ctx.cwd), "logs", `${taskId}.log`);
	const logBody = [result.stdout, result.stderr].filter(Boolean).join("\n--- stderr ---\n");
	writeFileSync(logPath, logBody, "utf-8");

	if (result.killed) {
		updateTaskStatus(ctx.cwd, taskId, "pending", {
			artifacts: { ...task.artifacts, log: logPath },
		});
		throw new Error(`Execution cancelled (${taskId})`);
	}

	if (result.code !== 0) {
		updateTaskStatus(ctx.cwd, taskId, "pending", {
			artifacts: { ...task.artifacts, log: logPath },
		});
		throw new Error(
			`Worker ${worker} failed (exit ${result.code}). See ${logPath}\n${result.stderr.trim().slice(0, 500)}`,
		);
	}

	updateTaskStatus(ctx.cwd, taskId, "done", {
		worker,
		artifacts: { ...task.artifacts, log: logPath },
		timestamps: { ...task.timestamps, executed: new Date().toISOString() },
	});

	const retryNote = reviewFeedback ? " (incorporating review feedback)" : "";
	return [`${taskId} done (${worker})${retryNote}`, `Log: ${logPath}`].join("\n");
}

export async function runExec(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
	defaultWorker: Worker = "claude",
): Promise<string> {
	const { taskId, worker } = parseExecArgs(args || `T001 --worker ${defaultWorker}`);
	const lines = [await execTask(pi, ctx, taskId, worker), "", `Next: /agent review ${taskId}`];
	return lines.join("\n");
}

async function reviewTask(pi: ExtensionAPI, ctx: ExtensionCommandContext, taskId: string): Promise<string> {
	const task = loadTask(ctx.cwd, taskId);
	if (!task) throw new Error(`Task not found: ${taskId}`);

	await assertWorkerAvailable(pi, ctx.cwd, "codex");

	const reviewPrompt = buildReviewerPrompt(ctx.cwd, taskId, task.title);
	const result = await runWithLoader(pi, ctx, `Reviewing ${taskId}`, "codex", ["review", "-", "--uncommitted"], {
		cwd: ctx.cwd,
		stdin: reviewPrompt,
		timeoutMs: 30 * 60 * 1000,
	});

	mkdirSync(join(agentRoot(ctx.cwd), "reviews"), { recursive: true });
	const reviewPath = join(agentRoot(ctx.cwd), "reviews", `${taskId}.md`);
	const body = result.stdout.trim() || result.stderr.trim();
	writeFileSync(reviewPath, body, "utf-8");

	if (result.killed) throw new Error("Review cancelled");
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `codex review failed (exit ${result.code})`);
	}

	const passed = reviewPassed(body);
	const status = passed ? "review_pass" : "review_fail";

	updateTaskStatus(ctx.cwd, taskId, status, {
		artifacts: { ...task.artifacts, review: reviewPath },
		timestamps: { ...task.timestamps, reviewed: new Date().toISOString() },
	});

	const verdict = passed ? "PASS ✓" : "FAIL ✗";
	const next = passed ? "" : `\nNext: /agent exec ${taskId} --worker ${task.worker ?? "claude"}  (auto-applies review feedback)`;
	return [
		`Review ${taskId}: ${verdict}`,
		`Report: ${reviewPath}`,
		next,
		"",
		body.slice(0, 2000) + (body.length > 2000 ? "\n…(truncated, see file)" : ""),
	].join("\n");
}

export async function runReview(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<string> {
	const taskId = parseReviewArgs(args);
	return reviewTask(pi, ctx, taskId);
}

export async function runTask(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
	defaultWorker: Worker = "claude",
): Promise<string> {
	const { taskId, worker } = parseExecArgs(args || `T001 --worker ${defaultWorker}`);
	const sections: string[] = [`## Run ${taskId} (exec → review)`];

	sections.push("### Exec", await execTask(pi, ctx, taskId, worker));
	sections.push("### Review", await reviewTask(pi, ctx, taskId));

	let task: AgentTask | null = loadTask(ctx.cwd, taskId);
	if (task?.status === "review_fail") {
		sections.push("### Retry exec (review failed)");
		sections.push(await execTask(pi, ctx, taskId, worker));
		sections.push("### Re-review");
		sections.push(await reviewTask(pi, ctx, taskId));
		task = loadTask(ctx.cwd, taskId);
	}

	if (task?.status === "review_pass") {
		sections.push("", `✓ ${taskId} complete`);
	} else if (task?.status === "review_fail") {
		sections.push("", `✗ ${taskId} still failing review — check ${task.artifacts.review}`);
	}

	return sections.join("\n\n");
}

export function runList(ctx: ExtensionCommandContext): string {
	return formatTaskList(listTasks(ctx.cwd));
}

export async function dispatchAgentCommand(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
): Promise<string> {
	const trimmed = args.trim();
	if (!trimmed || trimmed === "help") {
		return [
			"Agent Foreman — Codex plans/reviews, workers execute",
			"",
			"/agent plan <goal>                   Plan with Codex",
			"/agent run T001 [--worker claude]    Exec + review (+ 1 retry if fail)",
			"/agent exec T001 [--worker claude]   Execute task",
			"/agent review T001                   Codex review",
			"/agent list                          Show tasks",
			"",
			"Roles: agents/*.md (override via .pi/agents/)",
		].join("\n");
	}

	const space = trimmed.indexOf(" ");
	const sub = space === -1 ? trimmed : trimmed.slice(0, space);
	const rest = space === -1 ? "" : trimmed.slice(space + 1);

	switch (sub.toLowerCase()) {
		case "plan":
			return runPlan(pi, ctx, rest);
		case "run":
			return runTask(pi, ctx, rest);
		case "exec":
			return runExec(pi, ctx, rest);
		case "review":
			return runReview(pi, ctx, rest);
		case "list":
		case "status":
		case "tasks":
			return runList(ctx);
		default:
			throw new Error(`Unknown subcommand: ${sub}. Try /agent help`);
	}
}
