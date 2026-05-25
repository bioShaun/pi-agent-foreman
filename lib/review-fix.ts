import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listExecGatePythonFiles } from "./exec-gate.ts";
import type { ReviewFinding } from "./types.ts";

const LINT_FINDING_RE =
	/\b(ruff|flake8|pylint|mypy|I\d{3}|F\d{3}|E\d{3}|W\d{3}|unsorted import|import sort|trailing whitespace|unused import|formatting|quality gate)\b/i;

type FindingRoute = "blocking" | "lint" | "minor";

export type FindingRouteSummary = "blocking" | "lint-only" | "minor-only" | "lint-and-minor";

function classifyFinding(finding: ReviewFinding): FindingRoute {
	if (finding.severity === "critical" || finding.severity === "major") return "blocking";
	if (LINT_FINDING_RE.test(finding.message)) return "lint";
	return "minor";
}

export function summarizeFindingRoutes(findings: ReviewFinding[]): FindingRouteSummary {
	if (findings.length === 0) return "minor-only";
	const routes = findings.map(classifyFinding);
	if (routes.includes("blocking")) return "blocking";
	const hasLint = routes.includes("lint");
	const hasMinor = routes.includes("minor");
	if (hasLint && hasMinor) return "lint-and-minor";
	if (hasLint) return "lint-only";
	return "minor-only";
}

export function findingFingerprint(findings: ReviewFinding[]): string {
	const parts = findings
		.map(
			(f) =>
				`${f.severity}|${f.file ?? ""}|${f.line ?? ""}|${f.message.trim()}`,
		)
		.sort();
	return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

/** Same file scope as exec gate (staged + unstaged + untracked .py paths + diffs). */
export async function gitWorkingTreeFingerprint(pi: ExtensionAPI, cwd: string): Promise<string> {
	const files = await listExecGatePythonFiles(pi, cwd);
	const [unstaged, staged] = await Promise.all([
		pi.exec("git", ["diff", "HEAD", "--no-ext-diff"], { cwd, timeout: 30_000 }),
		pi.exec("git", ["diff", "--cached", "--no-ext-diff"], { cwd, timeout: 30_000 }),
	]);
	const blob = `${files.join("\n")}\n${unstaged.stdout}\n---\n${staged.stdout}`;
	return createHash("sha256").update(blob).digest("hex").slice(0, 16);
}

export function formatReviewFixSkipped(reason: string): string {
	return `Review-fix skipped: ${reason}`;
}
