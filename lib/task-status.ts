import type { AgentTask, TaskStatus, Worker } from "./types.ts";

export function isExecRunnable(status: TaskStatus): boolean {
	// `running` treated as stale — e.g. invoke threw before status was reverted
	return status === "pending" || status === "review_fail" || status === "running";
}

export function shouldInjectReviewFeedback(status: TaskStatus): boolean {
	return status === "review_fail";
}

export function parseReviewVerdict(body: string): boolean {
	return /\bPASS\b/i.test(body) && !/\bFAIL\b/i.test(body.split("PASS").pop() ?? "");
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

export function execHintAfterReviewFail(taskId: string, worker?: Worker): string {
	return `\nNext: /agent exec ${taskId} --worker ${worker ?? "claude"}  (auto-applies review feedback)`;
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
	return `${statusIcon(task.status)} ${task.id} [${task.status}] ${task.title}${task.worker ? ` (${task.worker})` : ""}`;
}
