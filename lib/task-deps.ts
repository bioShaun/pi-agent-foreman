import { loadTask } from "./agent-store.ts";
import type { AgentTask, TaskStatus } from "./types.ts";

/** Dep is satisfied once its exec phase has finished (review may still be pending). */
const EXEC_DEP_SATISFIED: ReadonlySet<TaskStatus> = new Set(["done", "review_pass", "review_fail"]);

export function normalizeDependsOn(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw) || raw.length === 0) return undefined;
	const ids = raw
		.filter((v): v is string => typeof v === "string" && /^T\d+$/i.test(v.trim()))
		.map((v) => v.toUpperCase());
	return ids.length > 0 ? [...new Set(ids)] : undefined;
}

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

export function validateDependsOn(taskIds: string[], dependsOn: string[] | undefined, taskId: string): void {
	if (!dependsOn?.length) return;
	for (const depId of dependsOn) {
		if (depId === taskId) {
			throw new Error(`Task ${taskId} cannot depend on itself`);
		}
		if (!taskIds.includes(depId)) {
			throw new Error(`Task ${taskId} depends on ${depId}, which is not in the plan`);
		}
	}
}
