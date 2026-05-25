import type { AgentTask, TaskStatus, Worker } from "./types.ts";

export function isExecRunnable(status: TaskStatus): boolean {
	// `running` treated as stale — e.g. invoke threw before status was reverted
	return status === "pending" || status === "review_fail" || status === "running";
}

export function isReviewRunnable(status: TaskStatus, opts?: { fix?: boolean }): boolean {
	if (status === "done") return true;
	if (opts?.fix && status === "review_fail") return true;
	return false;
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

/** Status to restore when exec is cancelled or fails — keep review_fail for review retries. */
export function execRevertStatus(priorStatus: TaskStatus, incorporatingReview: boolean): TaskStatus {
	if (priorStatus === "review_fail" || incorporatingReview) return "review_fail";
	return "pending";
}

export function execHintAfterReviewFail(taskId: string, worker?: Worker): string {
	return `\nNext: /agent exec ${taskId} --worker ${worker ?? "claude"}  (structured findings in exec prompt; verify .agent/prompts/exec/${taskId}/)`;
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
