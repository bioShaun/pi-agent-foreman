import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { assertRoleAgentAvailable, plannerInvocation } from "./agents.ts";
import { parsePlanOutput } from "./parse-plan.ts";
import {
	parseExecArgs,
	parseReviewArgs,
	parseRunArgs,
	runWithLoader,
} from "./run-command.ts";
import { artifactPath, createRunId, ensureRunDirs } from "./agent-paths.ts";
import {
	createPlanFromParsed,
	listTasks,
	loadBoulder,
	loadTask,
	saveBoulder,
	updateBoulderProgress,
} from "./agent-store.ts";
import { formatBoulderStatus, parseResumeArgs, resolveBoulderResume } from "./boulder-resume.ts";
import { formatTaskList, formatTaskLogs } from "./format-tasks.ts";
import { tasksForExecBatch, tasksForReviewBatch } from "./task-queries.ts";
import { makeTaskRunDeps, runExecPhase, runReviewPhase } from "./task-run.ts";
import { refreshTaskWidget } from "./task-widget.ts";
import { isRunComplete, isRunStillFailing } from "./task-status.ts";
import type { Reviewer, Worker } from "./types.ts";

function foremanTaskDeps(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	return makeTaskRunDeps(pi, ctx, () => refreshTaskWidget(ctx));
}

export async function runPlan(pi: ExtensionAPI, ctx: ExtensionCommandContext, goal: string): Promise<string> {
	if (!goal.trim()) throw new Error("Usage: /agent plan <goal>");

	const agent = await assertRoleAgentAvailable(pi, ctx.cwd, "planner");
	const { invocation } = plannerInvocation(ctx.cwd, goal);

	const planRunId = createRunId(agent.cli);
	const result = await runWithLoader(
		pi,
		ctx,
		`Planning: ${goal.slice(0, 60)}…`,
		invocation.command,
		invocation.args,
		{
			cwd: ctx.cwd,
			stdin: invocation.stdin,
			jsonStream: invocation.jsonStream,
			timeoutMs: 30 * 60 * 1000,
		},
	);

	if (result.killed) throw new Error("Planning cancelled");
	if (result.code !== 0) {
		throw new Error(
			result.stderr.trim() || result.stdout.trim() || `${agent.cli} exec failed (exit ${result.code})`,
		);
	}

	const raw = result.stdout.trim() || result.stderr.trim();
	const parsed = parsePlanOutput(raw, goal);
	const plan = createPlanFromParsed(ctx.cwd, parsed.goal, raw, parsed);

	const planArtifact = artifactPath(ctx.cwd, "plan", plan.id, planRunId);
	ensureRunDirs(planArtifact);
	writeFileSync(planArtifact, raw, "utf-8");

	return [
		`Plan ${plan.id} created (${plan.taskIds.length} tasks)`,
		`Plan artifact: ${planArtifact}`,
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
	deps = foremanTaskDeps(pi, ctx),
): Promise<string> {
	await assertRoleAgentAvailable(pi, ctx.cwd, "worker", worker);
	const { summary } = await runExecPhase(deps, taskId, worker);
	return summary;
}

export async function runExec(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
	defaultWorker: Worker = "claude",
): Promise<string> {
	const parsed = parseExecArgs(args || `T001 --worker ${defaultWorker}`, defaultWorker);
	if (parsed.mode === "batch") {
		return runExecAll(pi, ctx, parsed);
	}
	const lines = [await execTask(pi, ctx, parsed.taskId, parsed.worker), "", `Next: /agent review ${parsed.taskId}`];
	return lines.join("\n");
}

async function runExecAll(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	opts: { worker: Worker; fromTaskId?: string; continueOnError: boolean },
): Promise<string> {
	const { plan, runnable, skipped } = tasksForExecBatch(ctx.cwd, { fromTaskId: opts.fromTaskId });

	if (runnable.length === 0) {
		const skippedSummary =
			skipped.length > 0
				? `\nSkipped (${skipped.length}): ${skipped.map((t) => `${t.id}[${t.status}]`).join(", ")}`
				: "";
		return `No runnable tasks in ${plan.id} (pending or review_fail only).${skippedSummary}\n\nNext: /agent list`;
	}

	await assertRoleAgentAvailable(pi, ctx.cwd, "worker", opts.worker);

	const batchStartedAt = new Date().toISOString();
	const boulder = loadBoulder(ctx.cwd);
	if (boulder) {
		saveBoulder(ctx.cwd, {
			...boulder,
			current_task_id: runnable[0]!.id,
			batch: {
				mode: "exec",
				worker: opts.worker,
				started_at: batchStartedAt,
			},
		});
	}

	const sections: string[] = [
		`## Exec batch — ${plan.id}`,
		`Worker: ${opts.worker} · Runnable: ${runnable.map((t) => t.id).join(", ")}`,
	];
	if (opts.fromTaskId) sections.push(`From: ${opts.fromTaskId}`);
	if (skipped.length > 0) {
		sections.push(`Skipped: ${skipped.map((t) => `${t.id}[${t.status}]`).join(", ")}`);
	}

	let succeeded = 0;
	let failed = 0;
	const failures: string[] = [];
	const batchDeps = foremanTaskDeps(pi, ctx);

	for (const task of runnable) {
		updateBoulderProgress(ctx.cwd, { current_task_id: task.id });
		try {
			sections.push(`### ${task.id}`, await execTask(pi, ctx, task.id, opts.worker, batchDeps));
			succeeded++;
		} catch (err) {
			failed++;
			const message = err instanceof Error ? err.message : String(err);
			failures.push(`${task.id}: ${message.split("\n")[0]}`);
			sections.push(`### ${task.id} — FAILED`, message);

			if (boulder) {
				saveBoulder(ctx.cwd, {
					...loadBoulder(ctx.cwd)!,
					current_task_id: task.id,
					batch: {
						mode: "exec",
						worker: opts.worker,
						started_at: batchStartedAt,
						stopped_at: new Date().toISOString(),
						stopped_reason: message.split("\n")[0] ?? "exec failed",
					},
				});
			}

			if (!opts.continueOnError) {
				const taskIdx = plan.taskIds.indexOf(task.id);
				const nextTaskId = taskIdx >= 0 ? plan.taskIds[taskIdx + 1] : undefined;
				sections.push(
					"",
					`Batch stopped at ${task.id} (${succeeded} ok, ${failed} failed).`,
					`Resume: /agent resume`,
					`Retry: /agent exec --all --from ${task.id} --worker ${opts.worker}`,
				);
				if (nextTaskId) {
					sections.push(`Skip to ${nextTaskId}: /agent exec --all --from ${nextTaskId} --worker ${opts.worker}`);
				}
				sections.push(`Or: /agent exec --all --continue-on-error --worker ${opts.worker}`);
				return sections.join("\n\n");
			}
		}
	}

	if (boulder && failed === 0) {
		const latest = loadBoulder(ctx.cwd)!;
		saveBoulder(ctx.cwd, {
			...latest,
			batch: {
				mode: "exec",
				worker: opts.worker,
				started_at: batchStartedAt,
				stopped_at: new Date().toISOString(),
			},
		});
	}

	sections.push(
		"",
		`Batch complete: ${succeeded} succeeded${failed > 0 ? `, ${failed} failed` : ""}.`,
	);
	if (failures.length > 0) {
		sections.push(`Failures:\n${failures.map((f) => `- ${f}`).join("\n")}`);
	}
	sections.push("", "Next: /agent review --all  (or /agent review T00N for one task)");

	return sections.join("\n\n");
}

async function reviewTask(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	taskId: string,
	reviewer: Reviewer = "codex",
): Promise<string> {
	await assertRoleAgentAvailable(pi, ctx.cwd, "reviewer", undefined, reviewer);
	const deps = foremanTaskDeps(pi, ctx);
	const { summary } = await runReviewPhase(deps, taskId, reviewer);
	return summary;
}

async function runReviewAll(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	opts: { reviewer: Reviewer; fromTaskId?: string; continueOnError: boolean },
): Promise<string> {
	const { plan, runnable, skipped } = tasksForReviewBatch(ctx.cwd, { fromTaskId: opts.fromTaskId });

	if (runnable.length === 0) {
		const skippedSummary =
			skipped.length > 0
				? `\nSkipped (${skipped.length}): ${skipped.map((t) => `${t.id}[${t.status}]`).join(", ")}`
				: "";
		return `No reviewable tasks in ${plan.id} (done only).${skippedSummary}\n\nNext: /agent list`;
	}

	await assertRoleAgentAvailable(pi, ctx.cwd, "reviewer", undefined, opts.reviewer);

	const sections: string[] = [
		`## Review batch — ${plan.id}`,
		`Reviewer: ${opts.reviewer} · Reviewable: ${runnable.map((t) => t.id).join(", ")}`,
	];
	if (opts.fromTaskId) sections.push(`From: ${opts.fromTaskId}`);
	if (skipped.length > 0) {
		sections.push(`Skipped: ${skipped.map((t) => `${t.id}[${t.status}]`).join(", ")}`);
	}

	let passed = 0;
	let failed = 0;
	let cliErrors = 0;
	const failures: string[] = [];
	const batchDeps = foremanTaskDeps(pi, ctx);

	for (const task of runnable) {
		try {
			const { summary, passed: ok } = await runReviewPhase(batchDeps, task.id, opts.reviewer);
			sections.push(`### ${task.id}`, summary);
			if (ok) passed++;
			else {
				failed++;
				failures.push(`${task.id}: review FAIL`);
			}
		} catch (err) {
			cliErrors++;
			const message = err instanceof Error ? err.message : String(err);
			failures.push(`${task.id}: ${message.split("\n")[0]}`);
			sections.push(`### ${task.id} — ERROR`, message);

			if (!opts.continueOnError) {
				const taskIdx = plan.taskIds.indexOf(task.id);
				const nextTaskId = taskIdx >= 0 ? plan.taskIds[taskIdx + 1] : undefined;
				sections.push(
					"",
					`Batch stopped at ${task.id} (${passed} pass, ${failed} fail, ${cliErrors} error).`,
					`Retry: /agent review --all --from ${task.id} --reviewer ${opts.reviewer}`,
				);
				if (nextTaskId) {
					sections.push(`Skip to ${nextTaskId}: /agent review --all --from ${nextTaskId} --reviewer ${opts.reviewer}`);
				}
				sections.push(`Or: /agent review --all --continue-on-error --reviewer ${opts.reviewer}`);
				return sections.join("\n\n");
			}
		}
	}

	sections.push(
		"",
		`Batch complete: ${passed} passed, ${failed} failed${cliErrors > 0 ? `, ${cliErrors} CLI error(s)` : ""}.`,
	);
	if (failures.length > 0) {
		sections.push(`Issues:\n${failures.map((f) => `- ${f}`).join("\n")}`);
	}
	if (failed > 0) {
		sections.push("", "Re-exec failed tasks: /agent exec --all --worker claude");
		sections.push("Verify exec prompts: .agent/prompts/exec/T00N/ (incorporated_review_run_id in frontmatter)");
	}

	return sections.join("\n\n");
}

export async function runReview(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<string> {
	const parsed = parseReviewArgs(args);
	if (parsed.mode === "batch") {
		return runReviewAll(pi, ctx, parsed);
	}
	return reviewTask(pi, ctx, parsed.taskId, parsed.reviewer);
}

export async function runTask(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
	defaultWorker: Worker = "claude",
): Promise<string> {
	const { taskId, worker, reviewer } = parseRunArgs(args || `T001 --worker ${defaultWorker}`, defaultWorker);
	const deps = foremanTaskDeps(pi, ctx);
	const sections: string[] = [`## Run ${taskId} (exec → review)`];

	await assertRoleAgentAvailable(pi, ctx.cwd, "worker", worker);
	await assertRoleAgentAvailable(pi, ctx.cwd, "reviewer", undefined, reviewer);

	let { summary, task } = await runExecPhase(deps, taskId, worker);
	sections.push("### Exec", summary);

	({ summary, task } = await runReviewPhase(deps, taskId, reviewer));
	sections.push("### Review", summary);

	if (isRunStillFailing(task.status)) {
		sections.push("### Retry exec (review failed)");
		({ summary } = await runExecPhase(deps, taskId, worker));
		sections.push(summary);
		sections.push("### Re-review");
		({ summary, task } = await runReviewPhase(deps, taskId, reviewer));
		sections.push(summary);
	}

	if (isRunComplete(task.status)) {
		sections.push("", `✓ ${taskId} complete`);
	} else if (isRunStillFailing(task.status)) {
		sections.push("", `✗ ${taskId} still failing review — check ${task.artifacts.review}`);
	}

	return sections.join("\n\n");
}

export function runList(ctx: ExtensionCommandContext): string {
	return formatTaskList(listTasks(ctx.cwd));
}

export function runLogs(ctx: ExtensionCommandContext, args: string): string {
	const taskId = args.trim().match(/^(T\d+)/i)?.[1]?.toUpperCase();
	if (!taskId) throw new Error("Usage: /agent logs T001");
	return formatTaskLogs(ctx.cwd, taskId);
}

export async function runResume(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
): Promise<string> {
	const trimmed = args.trim();
	if (trimmed === "status" || trimmed === "show") {
		return formatBoulderStatus(ctx.cwd);
	}

	const { continueOnError } = parseResumeArgs(args);
	const resolved = resolveBoulderResume(ctx.cwd);
	if (!resolved.ok) throw new Error(resolved.message);

	const { request } = resolved;
	const header = [
		`## Resume — ${request.planName}`,
		`From ${request.fromTaskId} · Worker: ${request.worker}`,
		request.stoppedReason ? `Previous stop: ${request.stoppedReason}` : "",
	]
		.filter(Boolean)
		.join("\n");

	const body = await runExecAll(pi, ctx, {
		worker: request.worker,
		fromTaskId: request.fromTaskId,
		continueOnError,
	});

	return `${header}\n\n${body}`;
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
			"/agent run T001 [--worker claude] [--reviewer claude|codex]",
			"                                     Exec + review (+ 1 retry if fail)",
			"/agent exec T001 [--worker claude]   Execute one task",
			"/agent exec --all [--worker claude]  Exec all pending/review_fail in active plan",
			"                                     [--from T003] [--continue-on-error]",
			"/agent resume                        Resume last stopped exec batch (boulder.json)",
			"                                     [--continue-on-error] · resume status",
			"/agent review T001 [--reviewer claude|codex]",
			"/agent review --all [--reviewer claude|codex]",
			"                                     [--from T003] [--continue-on-error]",
			"/agent logs T001                     Run history + artifact paths",
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
		case "resume":
			return runResume(pi, ctx, rest);
		case "list":
		case "status":
		case "tasks":
			return runList(ctx);
		case "logs":
			return runLogs(ctx, rest);
		default:
			throw new Error(`Unknown subcommand: ${sub}. Try /agent help`);
	}
}
