import { loadManifest, loadPlan, loadTask } from "./agent-store.ts";
import { areExecDepsMet } from "./task-deps.ts";
import { isExecRunnable, isFixRunnable, isMarkPassEligible, isReviewRunnable } from "./task-status.ts";
import type { AgentPlan, AgentTask } from "./types.ts";

export function loadActivePlan(cwd: string): AgentPlan {
	const manifest = loadManifest(cwd);
	if (!manifest.activePlanId) {
		throw new Error("No active plan. Run /agent plan <goal> first.");
	}
	const plan = loadPlan(cwd, manifest.activePlanId);
	if (!plan) {
		throw new Error(`Active plan not found: ${manifest.activePlanId}`);
	}
	return plan;
}

export interface BatchSelection {
	plan: AgentPlan;
	runnable: AgentTask[];
	/** Exec-runnable but waiting on depends_on. */
	blocked: AgentTask[];
	skipped: AgentTask[];
}

function tasksForBatch(
	cwd: string,
	isRunnable: (status: AgentTask["status"]) => boolean,
	opts?: { fromTaskId?: string; checkDeps?: boolean },
): BatchSelection {
	const plan = loadActivePlan(cwd);
	let ids = [...plan.taskIds];
	if (opts?.fromTaskId) {
		const idx = ids.indexOf(opts.fromTaskId);
		if (idx === -1) {
			throw new Error(`Task ${opts.fromTaskId} is not in active plan ${plan.id}`);
		}
		ids = ids.slice(idx);
	}

	const runnable: AgentTask[] = [];
	const blocked: AgentTask[] = [];
	const skipped: AgentTask[] = [];
	for (const id of ids) {
		const task = loadTask(cwd, id);
		if (!task) continue;
		if (!isRunnable(task.status)) {
			skipped.push(task);
			continue;
		}
		if (opts?.checkDeps && !areExecDepsMet(task, cwd)) {
			blocked.push(task);
			continue;
		}
		runnable.push(task);
	}
	return { plan, runnable, blocked, skipped };
}

export type ExecBatchSelection = BatchSelection;

export function tasksForExecBatch(cwd: string, opts?: { fromTaskId?: string }): BatchSelection {
	return tasksForBatch(cwd, isExecRunnable, { ...opts, checkDeps: true });
}

export type ReviewBatchSelection = BatchSelection;

export function tasksForReviewBatch(
	cwd: string,
	opts?: { fromTaskId?: string },
): BatchSelection {
	return tasksForBatch(cwd, isReviewRunnable, opts);
}

export type FixBatchSelection = BatchSelection;

export function tasksForFixBatch(cwd: string, opts?: { fromTaskId?: string }): BatchSelection {
	return tasksForBatch(cwd, isFixRunnable, opts);
}

export function tasksForMarkPassBatch(cwd: string, opts?: { fromTaskId?: string }): BatchSelection {
	return tasksForBatch(cwd, isMarkPassEligible, opts);
}
