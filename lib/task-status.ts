import { loadManifest, loadPlan, loadTask, updateTaskStatus } from "./agent-store.ts";
import type { AgentPlan, AgentTask, TaskStatus } from "./types.ts";

export function isExecRunnable(status: TaskStatus): boolean {
	// `running` treated as stale — e.g. invoke threw before status was reverted.
	// `review_fail` is fixed by `/agent fix`, not re-exec.
	return status === "pending" || status === "running";
}

export function isReviewRunnable(status: TaskStatus): boolean {
	return status === "done";
}

export function isFixRunnable(status: TaskStatus): boolean {
	return status === "review_fail";
}

const MARK_PASS_ELIGIBLE: ReadonlySet<TaskStatus> = new Set(["done", "review_fail", "running"]);

export function isMarkPassEligible(status: TaskStatus): boolean {
	return MARK_PASS_ELIGIBLE.has(status);
}

export function reviewStatusFromVerdict(passed: boolean): "review_pass" | "review_fail" {
	return passed ? "review_pass" : "review_fail";
}

export function formatReviewVerdict(passed: boolean): string {
	return passed ? "PASS ✓" : "FAIL ✗";
}

export function isRunComplete(status: TaskStatus): boolean {
	return status === "review_pass";
}

export function isRunStillFailing(status: TaskStatus): boolean {
	return status === "review_fail";
}

/** Status to restore when exec is cancelled or fails. */
export function execRevertStatus(priorStatus: TaskStatus): TaskStatus {
	if (priorStatus === "review_fail") return "review_fail";
	return "pending";
}

export function statusIcon(status: TaskStatus): string {
	const icon: Record<TaskStatus, string> = {
		pending: "○",
		running: "◐",
		done: "●",
		review_pass: "✓",
		review_fail: "✗",
	};
	return icon[status];
}

export function statusLabel(task: AgentTask): string {
	const deps =
		task.depends_on?.length ? ` · deps ${task.depends_on.join(",")}` : "";
	return `${statusIcon(task.status)} ${task.id} [${task.status}] ${task.title}${deps}${task.worker ? ` (${task.worker})` : ""}`;
}

/** Dep is satisfied once its exec phase has finished (review may still be pending). */
const EXEC_DEP_SATISFIED: ReadonlySet<TaskStatus> = new Set(["done", "review_pass", "review_fail"]);

export function areExecDepsMet(task: AgentTask, cwd: string): boolean {
	return unmetExecDeps(task, cwd).length === 0;
}

export function unmetExecDeps(task: AgentTask, cwd: string): string[] {
	if (!task.depends_on?.length) return [];
	return task.depends_on.filter((depId) => {
		const dep = loadTask(cwd, depId);
		return !dep || !EXEC_DEP_SATISFIED.has(dep.status);
	});
}

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
	isRunnable: (status: TaskStatus) => boolean,
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

export function tasksForExecBatch(cwd: string, opts?: { fromTaskId?: string }): BatchSelection {
	return tasksForBatch(cwd, isExecRunnable, { ...opts, checkDeps: true });
}

export function tasksForReviewBatch(
	cwd: string,
	opts?: { fromTaskId?: string },
): BatchSelection {
	return tasksForBatch(cwd, isReviewRunnable, opts);
}

export function tasksForFixBatch(cwd: string, opts?: { fromTaskId?: string }): BatchSelection {
	return tasksForBatch(cwd, isFixRunnable, opts);
}

export function tasksForMarkPassBatch(cwd: string, opts?: { fromTaskId?: string }): BatchSelection {
	return tasksForBatch(cwd, isMarkPassEligible, opts);
}

export function markTaskReviewPass(cwd: string, taskId: string): AgentTask {
	const task = loadTask(cwd, taskId);
	if (!task) throw new Error(`Task not found: ${taskId}`);
	if (task.status === "review_pass") {
		return task;
	}
	if (!isMarkPassEligible(task.status)) {
		throw new Error(
			`${taskId} is [${task.status}] — only done, review_fail, or stale running can be mark_pass`
		);
	}
	return updateTaskStatus(cwd, taskId, "review_pass", {
		timestamps: { ...task.timestamps, reviewed: new Date().toISOString() },
	});
}
