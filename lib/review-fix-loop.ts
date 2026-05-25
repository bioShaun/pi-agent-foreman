import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadTask } from "./agent-store.ts";
import { runRuffAutoFix } from "./exec-gate.ts";
import {
	findingFingerprint,
	formatReviewFixSkipped,
	gitWorkingTreeFingerprint,
	summarizeFindingRoutes,
} from "./review-fix.ts";
import { loadReviewContext } from "./review-verdict.ts";
import { markTaskReviewPass } from "./mark-pass.ts";
import { runReviewFixPhase, runReviewPhase, type TaskRunDeps } from "./task-run.ts";
import { execHintAfterReviewFail, formatReviewVerdict } from "./task-status.ts";
import type { AgentTask, Reviewer, ReviewVerdictPayload } from "./types.ts";

export interface ReviewWithFixResult {
	summary: string;
	task: AgentTask;
	passed: boolean;
}

function reviewPayload(task: AgentTask, taskId: string): ReviewVerdictPayload | undefined {
	return loadReviewContext(task.artifacts.review, task.artifacts.reviewVerdict, taskId)?.payload;
}

async function runLintPath(
	deps: TaskRunDeps,
	pi: ExtensionAPI,
	sections: string[],
	liveLogPath?: string,
): Promise<boolean> {
	sections.push("### Lint auto-fix (ruff --fix)");
	const fix = await runRuffAutoFix(pi, deps.cwd, { liveLogPath });
	if (fix.skipped) {
		sections.push(`Skipped: ${fix.skipReason ?? "n/a"}`);
	} else if (fix.applied) {
		sections.push(`Files: ${fix.files.join(", ") || "(none)"}`);
		if (fix.output) sections.push(fix.output.slice(0, 1200));
	} else {
		sections.push(fix.output?.slice(0, 1200) ?? "ruff --fix did not complete cleanly");
	}

	sections.push("", "### Post-fix gate");
	const gate = await deps.runExecGate!({ liveLogPath });

	if (gate.skipped) {
		sections.push(`Gate skipped (${gate.skipReason ?? "n/a"})`);
		return false;
	}
	if (gate.passed) {
		sections.push(`Gate passed (${gate.files.length} file(s))`);
		return true;
	}

	sections.push(gate.output ?? "Gate failed");
	return false;
}

export async function runReviewWithFixLoop(
	deps: TaskRunDeps,
	pi: ExtensionAPI,
	taskId: string,
	reviewer: Reviewer,
): Promise<ReviewWithFixResult> {
	const sections: string[] = [];

	let { summary, task, passed } = await runReviewPhase(deps, taskId, reviewer);
	sections.push("### Review", summary);

	if (passed) {
		return { summary: sections.join("\n\n"), task, passed: true };
	}

	let payload = reviewPayload(task, taskId);
	if (!payload || payload.findings.length === 0) {
		sections.push(
			"",
			formatReviewFixSkipped("no structured findings — cannot run review-fix loop"),
			execHintAfterReviewFail(taskId, task.worker),
		);
		return { summary: sections.join("\n\n"), task, passed: false };
	}

	const route = summarizeFindingRoutes(payload.findings);

	if (route === "blocking") {
		sections.push("", formatReviewFixSkipped("major/critical findings — use /agent exec"));
		sections.push(execHintAfterReviewFail(taskId, task.worker));
		return { summary: sections.join("\n\n"), task, passed: false };
	}

	const liveLog = task.artifacts.liveTrace;

	if (route === "lint-only" || route === "lint-and-minor") {
		const gateOk = await runLintPath(deps, pi, sections, liveLog);
		if (!gateOk) {
			sections.push("", `Review ${taskId}: still FAIL (gate after lint auto-fix)`);
			sections.push(execHintAfterReviewFail(taskId, task.worker));
			return { summary: sections.join("\n\n"), task, passed: false };
		}

		if (route === "lint-only") {
			task = markTaskReviewPass(deps.cwd, taskId);
			deps.refreshWidget?.();
			sections.push(
				"",
				`Review ${taskId}: ${formatReviewVerdict(true)} (lint auto-fixed + gate; no re-review)`,
			);
			return { summary: sections.join("\n\n"), task, passed: true };
		}

		sections.push("", "Lint fixed; remaining minor findings → reviewer fix + re-review");
		task = loadTask(deps.cwd, taskId)!;
		payload = reviewPayload(task, taskId) ?? payload;
	}

	const treePreFix = await gitWorkingTreeFingerprint(pi, deps.cwd);
	const findingHashPre = findingFingerprint(payload.findings);

	sections.push("### Review-fix");
	try {
		const fixSummary = await runReviewFixPhase(deps, taskId, reviewer, payload);
		sections.push(fixSummary.summary);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		sections.push(message);
		sections.push(execHintAfterReviewFail(taskId, task.worker));
		return { summary: sections.join("\n\n"), task: loadTask(deps.cwd, taskId)!, passed: false };
	}

	const treePostFix = await gitWorkingTreeFingerprint(pi, deps.cwd);
	if (treePostFix === treePreFix) {
		sections.push("", "No progress: working tree unchanged after review-fix");
		sections.push(execHintAfterReviewFail(taskId, task.worker));
		return { summary: sections.join("\n\n"), task: loadTask(deps.cwd, taskId)!, passed: false };
	}

	sections.push("", "### Re-review");
	({ summary, task, passed } = await runReviewPhase(deps, taskId, reviewer));
	sections.push(summary);

	if (passed) {
		return { summary: sections.join("\n\n"), task, passed: true };
	}

	const payloadAfter = reviewPayload(task, taskId);
	if (payloadAfter) {
		if (findingFingerprint(payloadAfter.findings) === findingHashPre) {
			sections.push("", "No progress: same findings after review-fix + re-review");
		}
		if (summarizeFindingRoutes(payloadAfter.findings) === "blocking") {
			sections.push(formatReviewFixSkipped("re-review surfaced major/critical findings"));
		}
	}

	sections.push(execHintAfterReviewFail(taskId, task.worker));
	return { summary: sections.join("\n\n"), task, passed: false };
}
