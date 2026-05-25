import { loadTask, updateTaskStatus } from "./agent-store.ts";
import { tasksForMarkPassBatch } from "./task-queries.ts";
import { isMarkPassEligible } from "./task-status.ts";

export { isMarkPassEligible, tasksForMarkPassBatch };
export type { BatchSelection as MarkPassBatchSelection } from "./task-queries.ts";

export function parseMarkPassArgs(args: string):
	| { mode: "single"; taskId: string }
	| { mode: "batch"; fromTaskId?: string } {
	const trimmed = args.trim();
	if (!trimmed) {
		throw new Error("Usage: /agent mark_pass T001 | /agent mark_pass --all [--from T003]");
	}

	if (/^--all\b/i.test(trimmed)) {
		const fromMatch = trimmed.match(/--from\s+(T\d+)/i);
		return { mode: "batch", fromTaskId: fromMatch?.[1]?.toUpperCase() };
	}

	const taskId = trimmed.match(/^(T\d+)/i)?.[1]?.toUpperCase();
	if (!taskId) {
		throw new Error("Usage: /agent mark_pass T001 | /agent mark_pass --all [--from T003]");
	}
	return { mode: "single", taskId };
}

export function markTaskReviewPass(cwd: string, taskId: string) {
	const task = loadTask(cwd, taskId);
	if (!task) throw new Error(`Task not found: ${taskId}`);
	if (task.status === "review_pass") {
		return task;
	}
	if (!isMarkPassEligible(task.status)) {
		throw new Error(
			`${taskId} is [${task.status}] — only done, review_fail, or stale running can be mark_pass`,
		);
	}
	return updateTaskStatus(cwd, taskId, "review_pass", {
		timestamps: { ...task.timestamps, reviewed: new Date().toISOString() },
	});
}
