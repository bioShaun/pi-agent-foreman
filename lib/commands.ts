import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { assertRoleAgentAvailable, plannerInvocation, plannerRefineInvocation } from "./agents.ts";
import { parsePlanOutput } from "./parse-plan.ts";
import {
	parseExecArgs,
	parseFixArgs,
	parseReviewArgs,
	parseRunArgs,
	runWithLoader,
} from "./run-command.ts";
import { artifactPath, createRunId, ensureRunDirs, planDraftPath } from "./agent-paths.ts";
import {
	clearActivePlan,
	createPlanFromParsed,
	loadManifest,
	loadPlan,
	listTasks,
	loadBoulder,
	loadTask,
	saveBoulder,
	updateBoulderProgress,
} from "./agent-store.ts";
import { formatBoulderStatus, parseResumeArgs, resolveBoulderResume } from "./boulder-resume.ts";
import { formatTaskList, formatTaskLogs } from "./format-tasks.ts";
import { tasksForExecBatch, tasksForFixBatch, tasksForReviewBatch } from "./task-queries.ts";
import { areExecDepsMet } from "./task-deps.ts";
import { runFixPhase } from "./fix-run.ts";
import { makeTaskRunDeps, runExecPhase, runReviewPhase } from "./task-run.ts";
import { withParallelBatchDisplay, type ParallelExecListener } from "./parallel-batch-ui.ts";
import { markTaskReviewPass, parseMarkPassArgs, tasksForMarkPassBatch } from "./mark-pass.ts";
import { isActivePlanComplete, refreshTaskWidget } from "./task-widget.ts";
import { isExecRunnable, isRunComplete, isRunStillFailing } from "./task-status.ts";
import { isPlanner, isWorker, type Planner, type Reviewer, type Worker } from "./types.ts";

function pipelineTaskDeps(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	opts?: { silent?: boolean; onExecStarted?: ParallelExecListener["onStarted"] },
) {
	return makeTaskRunDeps(pi, ctx, () => refreshTaskWidget(ctx), opts);
}

function resolveDefaultWorker(cwd: string, fallback: Worker = "claude"): Worker {
	const manifest = loadManifest(cwd);
	if (!manifest.activePlanId) return fallback;
	const plan = loadPlan(cwd, manifest.activePlanId);
	return plan?.worker ?? fallback;
}

async function invokePlanner(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	goal: string,
	planner?: Planner,
	refine?: { priorPlan: string; refinement: string },
): Promise<{ raw: string; cli: string; runId: string }> {
	const agent = await assertRoleAgentAvailable(pi, ctx.cwd, "planner", undefined, undefined, undefined, planner);
	const { invocation } = refine
		? plannerRefineInvocation(ctx.cwd, goal, refine.priorPlan, refine.refinement, planner)
		: plannerInvocation(ctx.cwd, goal, planner);

	const runId = createRunId(agent.cli);
	const label = refine
		? `Re-planning (revision): ${goal.slice(0, 50)}…`
		: `Planning: ${goal.slice(0, 60)}…`;
	const result = await runWithLoader(pi, ctx, label, invocation.command, invocation.args, {
		cwd: ctx.cwd,
		stdin: invocation.stdin,
		jsonStream: invocation.jsonStream,
		antigravityProgress: invocation.antigravityProgress,
		timeoutMs: 30 * 60 * 1000,
	});

	if (result.killed) throw new Error("Planning cancelled");
	if (result.code !== 0) {
		const detail =
			result.stderr.trim() ||
			result.stdout.trim() ||
			"(no stdout/stderr captured — check live trace if available)";
		throw new Error(
			`${agent.cli} exec failed (exit ${result.code})\n\n${detail.slice(0, 2000)}`,
		);
	}

	const raw = result.stdout.trim() || result.stderr.trim();
	if (!raw) throw new Error(`${agent.cli} produced no output`);
	return { raw, cli: agent.cli, runId };
}

/** Drop fenced code blocks; the draft should show the human plan, not the JSON payload. */
function stripCodeBlocks(raw: string): string {
	return raw.replace(/```[\s\S]*?```/g, "").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function normalizeHeading(line: string): string {
	return line
		.replace(/^\s*#{1,6}\s*/, "")
		.replace(/^\s*\*\*(.*?)\*\*\s*$/, "$1")
		.trim()
		.toLowerCase();
}

function isMarkdownHeadingLine(line: string): boolean {
	return /^\s*#{1,6}\s+\S/.test(line) || /^\s*\*\*[^*]+\*\*\s*$/.test(line);
}

function cleanPlanNarrative(raw: string): string {
	const withoutCode = stripCodeBlocks(raw).trim();
	const lines = withoutCode.split(/\r?\n/);
	const humanPlanIndex = lines.findIndex((line) =>
		isMarkdownHeadingLine(line) &&
		["human-readable plan", "human readable plan", "plan"].includes(normalizeHeading(line)),
	);
	const relevantLines = humanPlanIndex >= 0 ? lines.slice(humanPlanIndex + 1) : lines;

	const cleaned: string[] = [];
	let skipSection = false;
	const skippedHeadings = new Set([
		"repository findings",
		"repo findings",
		"repository scan",
		"read-only scan",
		"sources",
		"references",
	]);

	for (const line of relevantLines) {
		const heading = normalizeHeading(line);
		if (isMarkdownHeadingLine(line) && skippedHeadings.has(heading)) {
			skipSection = true;
			continue;
		}
		if (skipSection && isMarkdownHeadingLine(line)) {
			skipSection = false;
		}
		if (!skipSection) cleaned.push(line);
	}

	return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const DIVIDER = "─".repeat(60);

function parsePlanArgs(input: string): { goal: string; applyNow: boolean; planner?: Planner; worker?: Worker } {
	const parts = input.trim().split(/\s+/).filter(Boolean);
	const applyNow = parts.includes("--apply");
	let planner: Planner | undefined;
	let worker: Worker | undefined;
	const goalParts: string[] = [];

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		if (part === "--apply") continue;
		if (part.startsWith("--planner=")) {
			const rawPlanner = part.slice("--planner=".length);
			if (!rawPlanner) throw new Error("--planner requires one of: claude, codex, antigravity");
			const candidate = rawPlanner.toLowerCase();
			if (!isPlanner(candidate)) throw new Error(`Unknown planner: ${rawPlanner}`);
			planner = candidate;
			continue;
		}
		if (part === "--planner") {
			const rawPlanner = parts[++i];
			if (!rawPlanner) throw new Error("--planner requires one of: claude, codex, antigravity");
			const candidate = rawPlanner.toLowerCase();
			if (!isPlanner(candidate)) throw new Error(`Unknown planner: ${rawPlanner}`);
			planner = candidate;
			continue;
		}
		if (part.startsWith("--worker=")) {
			const rawWorker = part.slice("--worker=".length);
			if (!rawWorker) throw new Error("--worker requires one of: claude, codex, antigravity");
			const candidate = rawWorker.toLowerCase();
			if (!isWorker(candidate)) throw new Error(`Unknown worker: ${rawWorker}`);
			worker = candidate;
			continue;
		}
		if (part === "--worker") {
			const rawWorker = parts[++i];
			if (!rawWorker) throw new Error("--worker requires one of: claude, codex, antigravity");
			const candidate = rawWorker.toLowerCase();
			if (!isWorker(candidate)) throw new Error(`Unknown worker: ${rawWorker}`);
			worker = candidate;
			continue;
		}
		goalParts.push(part);
	}

	return {
		goal: goalParts.join(" "),
		applyNow,
		planner,
		worker,
	};
}

function showPlanDraft(
	pi: ExtensionAPI,
	raw: string,
	iteration: number,
	goal: string,
	planner?: Planner,
	worker?: Worker,
): void {
	const titleLine =
		iteration === 1
			? `PLAN DRAFT`
			: `PLAN DRAFT — iteration ${iteration}`;
	const narrative = cleanPlanNarrative(raw);
	const body = [
		titleLine,
		`Goal: ${goal}`,
		planner ? `Planner: ${planner}` : null,
		worker ? `Worker: ${worker}` : null,
		DIVIDER,
		narrative,
		DIVIDER,
		"No task files have been created yet.",
		"Next: pick  Create tasks  /  Refine draft  /  Discard",
	].filter(Boolean).join("\n");
	pi.sendMessage(
		{
			customType: "agent-pipeline-result",
			content: body,
			display: true,
		},
		{ triggerTurn: false },
	);
}

function applyPlanDraft(
	cwd: string,
	goal: string,
	raw: string,
	cli: string,
	planRunId: string,
	planner?: Planner,
	worker?: Worker,
): string {
	const draftPath = planDraftPath(cwd);
	ensureRunDirs(draftPath);
	writeFileSync(draftPath, raw, "utf-8");

	const parsed = parsePlanOutput(raw, goal);
	const plan = createPlanFromParsed(cwd, parsed.goal, raw, parsed, { planner, worker });

	const planArtifact = artifactPath(cwd, "plan", plan.id, planRunId);
	ensureRunDirs(planArtifact);
	writeFileSync(planArtifact, raw, "utf-8");

	return [
		`Plan ${plan.id} created (${plan.taskIds.length} tasks) via ${cli}`,
		planner ? `Planner: ${planner}` : null,
		worker ? `Worker: ${worker}` : null,
		`Draft: ${draftPath}`,
		`Plan artifact: ${planArtifact}`,
		"",
		formatTaskList(plan.taskIds.map((id) => loadTask(cwd, id)!).filter(Boolean)),
		"",
		worker
			? `Next: /agent run ${plan.taskIds[0]}  ·  or  /agent exec --all`
			: `Next: /agent run ${plan.taskIds[0]} --worker claude  ·  or  /agent exec --all`,
	].filter(Boolean).join("\n");
}

export async function runPlan(pi: ExtensionAPI, ctx: ExtensionCommandContext, goal: string): Promise<string> {
	const { goal: cleanedGoal, applyNow, planner, worker } = parsePlanArgs(goal);
	if (!cleanedGoal) {
		throw new Error(
			"Usage: /agent plan [--apply] [--planner claude|codex|antigravity] [--worker claude|codex|antigravity] <goal>",
		);
	}

	let { raw, cli, runId } = await invokePlanner(pi, ctx, cleanedGoal, planner);
	let iteration = 1;

	if (applyNow) {
		return applyPlanDraft(ctx.cwd, cleanedGoal, raw, cli, runId, planner, worker);
	}

	if (!ctx.hasUI) {
		return [
			"PLAN DRAFT",
			`Goal: ${cleanedGoal}`,
			planner ? `Planner: ${planner}` : null,
			worker ? `Worker: ${worker}` : null,
			DIVIDER,
			cleanPlanNarrative(raw),
			DIVIDER,
			worker
				? `No task files created. Re-run with \`/agent plan --apply${planner ? ` --planner ${planner}` : ""} --worker ${worker} <goal>\` to create tasks in a non-interactive context.`
				: `No task files created. Re-run with \`/agent plan --apply${planner ? ` --planner ${planner}` : ""} <goal>\` to create tasks in a non-interactive context.`,
		].filter(Boolean).join("\n");
	}

	const OPT_APPLY = "Create tasks from this draft";
	const OPT_REFINE = "Refine draft";
	const OPT_DISCARD = "Discard";

	while (true) {
		showPlanDraft(pi, raw, iteration, cleanedGoal, planner, worker);

		const choice = await ctx.ui.select(
			"Plan ready — what next?",
			[OPT_APPLY, OPT_REFINE, OPT_DISCARD],
		);

		if (!choice || choice === OPT_DISCARD) {
			return `Plan discarded. No tasks created.\n\nRetry: /agent plan ${cleanedGoal}`;
		}

		if (choice === OPT_APPLY) {
			return applyPlanDraft(ctx.cwd, cleanedGoal, raw, cli, runId, planner, worker);
		}

		const refinement = await ctx.ui.input(
			"Refinement prompt — what should change?",
			'e.g. "split T002 into two tasks", "add Q&A at the end", "use less time on T001"',
		);
		if (!refinement?.trim()) {
			// Cancelled or empty — re-show same plan + dialog
			continue;
		}

		iteration++;
		({ raw, cli, runId } = await invokePlanner(pi, ctx, cleanedGoal, planner, {
			priorPlan: raw,
			refinement: refinement.trim(),
		}));
	}
}

async function execTask(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	taskId: string,
	worker: Worker,
	deps = pipelineTaskDeps(pi, ctx),
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
	const resolvedDefaultWorker = resolveDefaultWorker(ctx.cwd, defaultWorker);
	const parsed = parseExecArgs(args || `T001 --worker ${resolvedDefaultWorker}`, resolvedDefaultWorker);
	if (parsed.mode === "batch") {
		return runExecAll(pi, ctx, parsed);
	}
	const lines = [await execTask(pi, ctx, parsed.taskId, parsed.worker), "", `Next: /agent review ${parsed.taskId}`];
	return lines.join("\n");
}

async function runExecAll(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	opts: { worker: Worker; fromTaskId?: string; continueOnError: boolean; parallel: number },
): Promise<string> {
	const selection = tasksForExecBatch(ctx.cwd, { fromTaskId: opts.fromTaskId });
	const pending = new Set([...selection.runnable, ...selection.blocked].map((t) => t.id));

	if (pending.size === 0) {
		const skippedSummary =
			selection.skipped.length > 0
				? `\nSkipped (${selection.skipped.length}): ${selection.skipped.map((t) => `${t.id}[${t.status}]`).join(", ")}`
				: "";
		return `No runnable tasks in ${selection.plan.id} (pending with deps met).${skippedSummary}\n\nNext: /agent list`;
	}

	await assertRoleAgentAvailable(pi, ctx.cwd, "worker", opts.worker);

	const batchStartedAt = new Date().toISOString();
	const boulder = loadBoulder(ctx.cwd);
	const firstTaskId = (selection.runnable[0] ?? selection.blocked[0])!.id;
	if (boulder) {
		saveBoulder(ctx.cwd, {
			...boulder,
			current_task_id: firstTaskId,
			batch: {
				mode: "exec",
				worker: opts.worker,
				started_at: batchStartedAt,
			},
		});
	}

	const sections: string[] = [
		`## Exec batch — ${selection.plan.id}`,
		`Worker: ${opts.worker} · Parallel: ${opts.parallel} · Pool: ${[...pending].join(", ")}`,
	];
	if (opts.fromTaskId) sections.push(`From: ${opts.fromTaskId}`);
	if (selection.runnable.length > 0) {
		sections.push(`Ready now: ${selection.runnable.map((t) => t.id).join(", ")}`);
	}
	if (selection.blocked.length > 0) {
		sections.push(`Blocked (deps): ${selection.blocked.map((t) => t.id).join(", ")}`);
	}
	if (selection.skipped.length > 0) {
		sections.push(`Skipped: ${selection.skipped.map((t) => `${t.id}[${t.status}]`).join(", ")}`);
	}
	if (opts.parallel > 1) {
		sections.push("Parallel mode: multi-task progress panel · tail `.agent/traces/T00N/*.live.log` for full detail");
	}

	let succeeded = 0;
	let failed = 0;
	const failures: string[] = [];

	const recordFailure = (taskId: string, message: string): void => {
		failed++;
		const firstLine = message.split("\n")[0] ?? "exec failed";
		failures.push(`${taskId}: ${firstLine}`);
		sections.push(`### ${taskId} — FAILED`, message);
		if (boulder) {
			saveBoulder(ctx.cwd, {
				...loadBoulder(ctx.cwd)!,
				current_task_id: taskId,
				batch: {
					mode: "exec",
					worker: opts.worker,
					started_at: batchStartedAt,
					stopped_at: new Date().toISOString(),
					stopped_reason: firstLine,
				},
			});
		}
	};

	const stopBatchEarly = (taskId: string): string => {
		const taskIdx = selection.plan.taskIds.indexOf(taskId);
		const nextTaskId = taskIdx >= 0 ? selection.plan.taskIds[taskIdx + 1] : undefined;
		sections.push(
			"",
			`Batch stopped at ${taskId} (${succeeded} ok, ${failed} failed).`,
			`Resume: /agent resume`,
			`Retry: /agent exec --all --from ${taskId} --worker ${opts.worker}`,
		);
		if (nextTaskId) {
			sections.push(`Skip to ${nextTaskId}: /agent exec --all --from ${nextTaskId} --worker ${opts.worker}`);
		}
		sections.push(`Or: /agent exec --all --continue-on-error --worker ${opts.worker}`);
		return sections.join("\n\n");
	};

	const runBatch = async (listener: ParallelExecListener): Promise<string> => {
		while (pending.size > 0) {
			const ready = [...pending].filter((id) => {
				const task = loadTask(ctx.cwd, id);
				return task && isExecRunnable(task.status) && areExecDepsMet(task, ctx.cwd);
			});

			if (ready.length === 0) break;

			const chunk = ready.slice(0, opts.parallel);
			const batchDeps = pipelineTaskDeps(pi, ctx, {
				silent: opts.parallel > 1,
				onExecStarted: listener.onStarted,
			});

			const runOne = async (taskId: string) => {
				updateBoulderProgress(ctx.cwd, { current_task_id: taskId });
				try {
					const summary = await execTask(pi, ctx, taskId, opts.worker, batchDeps);
					return { taskId, ok: true as const, summary };
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return { taskId, ok: false as const, message };
				} finally {
					listener.onFinished?.(taskId);
				}
			};

			const outcomes = await Promise.all(chunk.map(runOne));
			for (const outcome of outcomes) {
				pending.delete(outcome.taskId);
				if (outcome.ok) {
					sections.push(`### ${outcome.taskId}`, outcome.summary);
					succeeded++;
				} else {
					recordFailure(outcome.taskId, outcome.message);
					if (!opts.continueOnError) {
						return stopBatchEarly(outcome.taskId);
					}
				}
			}
		}

		if (pending.size > 0) {
			sections.push(`Still blocked (deps): ${[...pending].join(", ")}`);
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

		sections.push("", `Batch complete: ${succeeded} succeeded${failed > 0 ? `, ${failed} failed` : ""}.`);
		if (failures.length > 0) {
			sections.push(`Failures:\n${failures.map((f) => `- ${f}`).join("\n")}`);
		}
		sections.push("", "Next: /agent review --all  (review stays serial; or /agent review T00N)");

		return sections.join("\n\n");
	};

	if (opts.parallel > 1 && ctx.hasUI) {
		return withParallelBatchDisplay(
			ctx,
			{
				planId: selection.plan.id,
				worker: opts.worker,
				parallel: opts.parallel,
				pool: [...pending],
			},
			runBatch,
		);
	}

	return runBatch({});
}

async function reviewTask(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	taskId: string,
	reviewer: Reviewer = "codex",
): Promise<string> {
	await assertRoleAgentAvailable(pi, ctx.cwd, "reviewer", undefined, reviewer);
	const deps = pipelineTaskDeps(pi, ctx);
	const { summary } = await runReviewPhase(deps, taskId, reviewer);
	return summary;
}

async function runReviewAll(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	opts: { reviewer: Reviewer; fromTaskId?: string; continueOnError: boolean },
): Promise<string> {
	const { plan, runnable, skipped } = tasksForReviewBatch(ctx.cwd, {
		fromTaskId: opts.fromTaskId,
	});

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
	const batchDeps = pipelineTaskDeps(pi, ctx);

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
		sections.push("", "Fix all review failures: /agent fix  (single fixer pass over all review_fail tasks)");
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

export async function runFix(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
): Promise<string> {
	const { fixer, fromTaskId } = parseFixArgs(args);
	const { plan, runnable, skipped } = tasksForFixBatch(ctx.cwd, { fromTaskId });

	if (runnable.length === 0) {
		const skippedSummary =
			skipped.length > 0
				? `\nSkipped (${skipped.length}): ${skipped.map((t) => `${t.id}[${t.status}]`).join(", ")}`
				: "";
		return `No review_fail tasks in ${plan.id}.${skippedSummary}\n\nNext: /agent list`;
	}

	await assertRoleAgentAvailable(pi, ctx.cwd, "fixer", undefined, undefined, fixer);

	const sections: string[] = [
		`## Fix batch — ${plan.id}`,
		`Fixer: ${fixer} · Tasks: ${runnable.map((t) => t.id).join(", ")}`,
	];
	if (fromTaskId) sections.push(`From: ${fromTaskId}`);
	if (skipped.length > 0) {
		sections.push(`Skipped: ${skipped.map((t) => `${t.id}[${t.status}]`).join(", ")}`);
	}

	const deps = pipelineTaskDeps(pi, ctx);
	const { summary } = await runFixPhase(deps, plan, runnable, fixer);
	sections.push(summary);

	if (isActivePlanComplete(ctx.cwd)) {
		sections.push("", "All tasks in active plan are review_pass — sidebar hidden.", "Dismiss: /agent clear");
	}

	return sections.join("\n\n");
}

export function runClear(ctx: ExtensionCommandContext): string {
	const manifest = loadManifest(ctx.cwd);
	const planId = manifest.activePlanId;
	const wasComplete = planId ? isActivePlanComplete(ctx.cwd) : false;
	clearActivePlan(ctx.cwd);
	refreshTaskWidget(ctx);
	if (!planId) {
		return "No active plan. Sidebar refreshed.";
	}
	if (wasComplete) {
		return `Cleared active plan ${planId}. Plan complete — sidebar hidden.\n\nStart fresh: /agent plan <goal>`;
	}
	return `Cleared active plan ${planId}.\n\nSidebar shows all tasks (no plan filter). /agent list · new plan: /agent plan <goal>`;
}

export function runMarkPass(ctx: ExtensionCommandContext, args: string): string {
	const parsed = parseMarkPassArgs(args);
	if (parsed.mode === "single") {
		const prior = loadTask(ctx.cwd, parsed.taskId);
		if (prior?.status === "review_pass") {
			return `${parsed.taskId} already review_pass (unchanged)`;
		}
		const updated = markTaskReviewPass(ctx.cwd, parsed.taskId);
		refreshTaskWidget(ctx);
		const lines = [
			`## Mark pass — ${parsed.taskId}`,
			"",
			`${parsed.taskId} → review_pass (manual)`,
			`Reviewed: ${updated.timestamps.reviewed}`,
		];
		if (isActivePlanComplete(ctx.cwd)) {
			lines.push("", "All tasks in active plan are review_pass — sidebar hidden.", "Dismiss: /agent clear");
		}
		return lines.join("\n");
	}

	const { plan, runnable, skipped } = tasksForMarkPassBatch(ctx.cwd, {
		fromTaskId: parsed.fromTaskId,
	});
	if (runnable.length === 0) {
		const skippedSummary =
			skipped.length > 0
				? `\nSkipped (${skipped.length}): ${skipped.map((t) => `${t.id}[${t.status}]`).join(", ")}`
				: "";
		return `No markable tasks in ${plan.id} (done / review_fail / running only).${skippedSummary}\n\nNext: /agent list`;
	}

	const sections: string[] = [
		`## Mark pass — ${plan.id}`,
		`Manual finish · Markable: ${runnable.map((t) => t.id).join(", ")}`,
	];
	if (parsed.fromTaskId) sections.push(`From: ${parsed.fromTaskId}`);
	if (skipped.length > 0) {
		sections.push(`Skipped: ${skipped.map((t) => `${t.id}[${t.status}]`).join(", ")}`);
	}

	let marked = 0;
	for (const task of runnable) {
		markTaskReviewPass(ctx.cwd, task.id);
		sections.push(`- ${task.id}: review_pass ✓`);
		marked++;
	}

	refreshTaskWidget(ctx);
	sections.push("", `Batch complete: ${marked} task(s) marked review_pass.`);
	if (isActivePlanComplete(ctx.cwd)) {
		sections.push("", "All tasks in active plan are review_pass — sidebar hidden.");
		sections.push("Dismiss plan pointer: /agent clear");
	}
	return sections.join("\n");
}

export async function runTask(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
	defaultWorker: Worker = "claude",
): Promise<string> {
	const resolvedDefaultWorker = resolveDefaultWorker(ctx.cwd, defaultWorker);
	const { taskId, worker, reviewer } = parseRunArgs(args || `T001 --worker ${resolvedDefaultWorker}`, resolvedDefaultWorker);
	const deps = pipelineTaskDeps(pi, ctx);
	const sections: string[] = [`## Run ${taskId} (exec → review)`];

	await assertRoleAgentAvailable(pi, ctx.cwd, "worker", worker);
	await assertRoleAgentAvailable(pi, ctx.cwd, "reviewer", undefined, reviewer);

	let { summary, task } = await runExecPhase(deps, taskId, worker);
	sections.push("### Exec", summary);

	({ summary, task } = await runReviewPhase(deps, taskId, reviewer));
	sections.push("### Review", summary);

	if (isRunComplete(task.status)) {
		sections.push("", `✓ ${taskId} complete`);
	} else if (isRunStillFailing(task.status)) {
		sections.push("", `✗ ${taskId} review failed — run /agent fix to apply fixer pass`);
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
		parallel: 1,
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
			"Agent Pipeline — Codex plans, workers execute, reviewers verify, fixer cleans up",
			"",
			"/agent plan [--planner codex] [--worker claude] <goal>",
			"                                     Draft a plan; no tasks until confirmed",
			"/agent plan --apply [--planner codex] [--worker claude] <goal>",
			"                                     Create tasks immediately (for non-interactive use)",
			"/agent run T001 [--worker claude] [--reviewer claude|codex]",
			"                                     Exec + review (single pass, no auto-retry)",
			"/agent exec T001 [--worker claude]   Execute one task",
			"/agent exec --all [--worker claude]  Exec all pending tasks in active plan",
			"                                     [--parallel N] [--from T003] [--continue-on-error]",
			"/agent resume                        Resume last stopped exec batch (boulder.json)",
			"                                     [--continue-on-error] · resume status",
			"/agent review T001 [--reviewer claude|codex]",
			"/agent review --all [--reviewer claude|codex]",
			"                                     [--from T003] [--continue-on-error]",
			"/agent fix [--fixer claude|codex|antigravity] [--from T003]",
			"                                     Single fixer pass over all review_fail tasks → review_pass",
			"/agent mark_pass T001                Manual finish → review_pass",
			"/agent mark_pass --all [--from T003] Mark done/review_fail tasks pass",
			"/agent clear                         Clear active plan · hide sidebar when done",
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
		case "fix":
			return runFix(pi, ctx, rest);
		case "mark_pass":
		case "mark-pass":
			return runMarkPass(ctx, rest);
		case "clear":
			return runClear(ctx);
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
