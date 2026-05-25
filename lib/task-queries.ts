import { loadManifest, loadPlan, loadTask } from "./agent-store.ts";
import { isExecRunnable } from "./task-status.ts";
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

export interface ExecBatchSelection {
	plan: AgentPlan;
	runnable: AgentTask[];
	skipped: AgentTask[];
}

export function tasksForExecBatch(cwd: string, opts?: { fromTaskId?: string }): ExecBatchSelection {
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
	const skipped: AgentTask[] = [];
	for (const id of ids) {
		const task = loadTask(cwd, id);
		if (!task) continue;
		if (isExecRunnable(task.status)) runnable.push(task);
		else skipped.push(task);
	}
	return { plan, runnable, skipped };
}
