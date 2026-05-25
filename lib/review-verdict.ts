import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { ReviewFinding, ReviewVerdictKind, ReviewVerdictPayload } from "./types.ts";

const VALID_VERDICTS = new Set<string>(["approve", "revise", "reject"]);
const VALID_SEVERITIES = new Set<string>(["critical", "major", "minor", "nit"]);

export function renderReviewVerdictContract(taskId: string): string {
	return [
		"",
		"---",
		"## REQUIRED: Structured verdict (foreman-verdict)",
		"",
		"After your narrative review, end the response with a fenced JSON block tagged `foreman-verdict`:",
		"",
		"```json foreman-verdict",
		"{",
		`  "task_id": "${taskId}",`,
		'  "verdict": "approve" | "revise" | "reject",',
		'  "summary": "one- or two-sentence overall assessment",',
		'  "findings": [',
		"    {",
		'      "severity": "critical" | "major" | "minor" | "nit",',
		'      "message": "what is wrong and why it matters",',
		'      "file": "optional/path/to/file",',
		'      "line": 42',
		"    }",
		"  ]",
		"}",
		"```",
		"",
		"Rules:",
		"- Also include a human-readable line **PASS** or **FAIL** (FAIL for revise/reject).",
		"- `verdict: approve` only when there are no blocking concerns (`findings` may be empty).",
		"- Each finding must include `severity` and `message`.",
		"- On reject/revise, list every blocking issue in `findings`.",
	].join("\n");
}

export function runIdFromReviewPath(reviewPath: string): string {
	return basename(reviewPath).replace(/\.md$/i, "");
}

function parseFinding(entry: unknown, idx: number): ReviewFinding {
	if (!entry || typeof entry !== "object") {
		throw new Error(`finding_${idx}_not_object`);
	}
	const f = entry as Record<string, unknown>;
	const severity = f.severity;
	if (typeof severity !== "string" || !VALID_SEVERITIES.has(severity)) {
		throw new Error(`finding_${idx}_invalid_severity`);
	}
	const message = f.message;
	if (typeof message !== "string" || !message.trim()) {
		throw new Error(`finding_${idx}_missing_message`);
	}
	const finding: ReviewFinding = {
		severity: severity as ReviewFinding["severity"],
		message: message.trim(),
	};
	if (typeof f.file === "string" && f.file.trim()) finding.file = f.file.trim();
	if (typeof f.line === "number" && Number.isFinite(f.line)) finding.line = f.line;
	return finding;
}

export function parseReviewVerdictPayload(raw: unknown, taskId: string, reviewRunId: string): ReviewVerdictPayload {
	if (!raw || typeof raw !== "object") throw new Error("verdict_not_object");
	const obj = raw as Record<string, unknown>;

	const id = obj.task_id;
	if (typeof id !== "string" || !id) throw new Error("verdict_missing_task_id");

	const verdict = obj.verdict;
	if (typeof verdict !== "string" || !VALID_VERDICTS.has(verdict)) {
		throw new Error(`verdict_invalid:${String(verdict)}`);
	}

	const summary = obj.summary;
	if (typeof summary !== "string") throw new Error("verdict_missing_summary");

	const findingsRaw = obj.findings;
	if (!Array.isArray(findingsRaw)) throw new Error("verdict_findings_not_array");

	return {
		task_id: id.toUpperCase(),
		review_run_id: reviewRunId,
		verdict: verdict as ReviewVerdictKind,
		summary: summary.trim(),
		findings: findingsRaw.map((entry, idx) => parseFinding(entry, idx)),
	};
}

function extractForemanVerdictBlocks(body: string): string[] {
	const blocks: string[] = [];
	const re = /```json\s+foreman-verdict\s*\n([\s\S]*?)```/gi;
	for (const match of body.matchAll(re)) {
		if (match[1]?.trim()) blocks.push(match[1].trim());
	}
	return blocks;
}

function extractGenericJsonBlocks(body: string): string[] {
	const blocks: string[] = [];
	const re = /```json\s*\n([\s\S]*?)```/gi;
	for (const match of body.matchAll(re)) {
		if (match[1]?.trim()) blocks.push(match[1].trim());
	}
	return blocks;
}

function tryParseVerdictBlock(
	block: string,
	taskId: string,
	reviewRunId: string,
): ReviewVerdictPayload | undefined {
	try {
		const payload = parseReviewVerdictPayload(JSON.parse(block), taskId, reviewRunId);
		return payload.task_id === taskId.toUpperCase() ? payload : undefined;
	} catch {
		return undefined;
	}
}

export function extractReviewVerdictFromBody(
	body: string,
	taskId: string,
	reviewRunId: string,
): ReviewVerdictPayload | undefined {
	for (const block of extractForemanVerdictBlocks(body)) {
		const payload = tryParseVerdictBlock(block, taskId, reviewRunId);
		if (payload) return payload;
	}
	for (const block of extractGenericJsonBlocks(body)) {
		const payload = tryParseVerdictBlock(block, taskId, reviewRunId);
		if (payload) return payload;
	}

	const tail = body.trim().slice(-4000);
	const jsonStart = tail.lastIndexOf("{");
	if (jsonStart >= 0) {
		return tryParseVerdictBlock(tail.slice(jsonStart), taskId, reviewRunId);
	}

	return undefined;
}

function parseLegacyPassFail(body: string): boolean {
	return /\bPASS\b/i.test(body) && !/\bFAIL\b/i.test(body.split("PASS").pop() ?? "");
}

export function reviewPassed(body: string, payload?: ReviewVerdictPayload): boolean {
	if (payload) return verdictPassed(payload);
	return parseLegacyPassFail(body);
}

export function loadReviewVerdictJson(path: string | undefined): ReviewVerdictPayload | undefined {
	if (!path || !existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		const taskId = raw.task_id;
		const reviewRunId = raw.review_run_id;
		if (typeof taskId !== "string" || typeof reviewRunId !== "string") return undefined;
		return parseReviewVerdictPayload(raw, taskId, reviewRunId);
	} catch {
		return undefined;
	}
}

export function writeReviewVerdictJson(path: string, payload: ReviewVerdictPayload): void {
	writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

export function verdictPassed(payload: ReviewVerdictPayload): boolean {
	return payload.verdict === "approve";
}

export function formatFindingsForWorker(payload: ReviewVerdictPayload): string {
	const lines = [
		`## Review findings (from review ${payload.review_run_id})`,
		"",
		`**Summary:** ${payload.summary}`,
		"",
		"Address **ALL** findings below, then complete the task.",
		"",
	];
	if (payload.findings.length === 0) {
		lines.push("- (no structured findings — see full review report)");
	} else {
		for (const f of payload.findings) {
			const loc = f.file ? ` (${f.file}${f.line !== undefined ? `:${f.line}` : ""})` : "";
			lines.push(`- [${f.severity}] ${f.message}${loc}`);
		}
	}
	return lines.join("\n");
}

export interface ReviewContext {
	runId: string;
	payload?: ReviewVerdictPayload;
	rawReview?: string;
}

export function loadReviewContext(
	reviewMdPath: string | undefined,
	reviewVerdictPath: string | undefined,
	taskId: string,
): ReviewContext | undefined {
	if (!reviewMdPath || !existsSync(reviewMdPath)) return undefined;

	const runId = runIdFromReviewPath(reviewMdPath);
	let payload = loadReviewVerdictJson(reviewVerdictPath);
	let rawReview: string | undefined;

	try {
		rawReview = readFileSync(reviewMdPath, "utf-8");
	} catch {
		return undefined;
	}

	if (!payload && rawReview) {
		payload = extractReviewVerdictFromBody(rawReview, taskId, runId);
	}

	return { runId, payload, rawReview };
}

export function formatFindingsSummary(payload: ReviewVerdictPayload): string {
	if (payload.findings.length === 0) return `Findings: 0 (${payload.verdict})`;
	const bySeverity = payload.findings.map((f) => f.severity).join(", ");
	return `Findings: ${payload.findings.length} [${bySeverity}] — ${payload.summary}`;
}
