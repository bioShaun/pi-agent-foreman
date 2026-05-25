import { isFixer, isPlanner, isReviewer, isWorker } from "./types.ts";
import type { Fixer, Planner, Reviewer, Worker } from "./types.ts";

export const MAX_EXEC_PARALLEL = 8;

function parseReviewer(raw: string, defaultReviewer: Reviewer): Reviewer {
	const reviewer = raw.toLowerCase();
	if (!isReviewer(reviewer)) throw new Error(`Unknown reviewer: ${reviewer}`);
	return reviewer;
}

function parseWorker(raw: string, defaultWorker: Worker): Worker {
	const worker = raw.toLowerCase();
	if (!isWorker(worker)) throw new Error(`Unknown worker: ${worker}`);
	return worker;
}

function parseFixer(raw: string): Fixer {
	const fixer = raw.toLowerCase();
	if (!isFixer(fixer)) throw new Error(`Unknown fixer: ${fixer}`);
	return fixer;
}

export function parseParallelFlag(trimmed: string): number {
	const match = trimmed.match(/--parallel\s+(\d+)/i);
	if (!match) return 1;
	const n = Number.parseInt(match[1]!, 10);
	if (!Number.isFinite(n) || n < 1) {
		throw new Error("--parallel must be a positive integer");
	}
	return Math.min(n, MAX_EXEC_PARALLEL);
}

export function parsePlanArgs(input: string): { goal: string; applyNow: boolean; planner?: Planner; worker?: Worker } {
	const parts = input.trim().split(/\s+/).filter(Boolean);
	const applyNow = parts.includes("--apply");
	let planner: Planner | undefined;
	let worker: Worker | undefined;
	const goalParts: string[] = [];

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		if (part === "--apply") continue;
		if (part.startsWith("--planner=")) {
			const rawPlanner = part.slice("--planner=".length);
			if (!rawPlanner) throw new Error("--planner requires one of: claude, codex, antigravity");
			const candidate = rawPlanner.toLowerCase();
			if (!isPlanner(candidate)) throw new Error(`Unknown planner: ${rawPlanner}`);
			planner = candidate;
			continue;
		}
		if (part === "--planner") {
			const rawPlanner = parts[++i];
			if (!rawPlanner) throw new Error("--planner requires one of: claude, codex, antigravity");
			const candidate = rawPlanner.toLowerCase();
			if (!isPlanner(candidate)) throw new Error(`Unknown planner: ${rawPlanner}`);
			planner = candidate;
			continue;
		}
		if (part.startsWith("--worker=")) {
			const rawWorker = part.slice("--worker=".length);
			if (!rawWorker) throw new Error("--worker requires one of: claude, codex, antigravity");
			const candidate = rawWorker.toLowerCase();
			if (!isWorker(candidate)) throw new Error(`Unknown worker: ${rawWorker}`);
			worker = candidate;
			continue;
		}
		if (part === "--worker") {
			const rawWorker = parts[++i];
			if (!rawWorker) throw new Error("--worker requires one of: claude, codex, antigravity");
			const candidate = rawWorker.toLowerCase();
			if (!isWorker(candidate)) throw new Error(`Unknown worker: ${rawWorker}`);
			worker = candidate;
			continue;
		}
		goalParts.push(part);
	}

	return {
		goal: goalParts.join(" "),
		applyNow,
		planner,
		worker,
	};
}

export function parseExecArgs(
	args: string,
	defaultWorker: Worker = "claude",
):
	| { mode: "single"; taskId: string; worker: Worker }
	| { mode: "batch"; worker: Worker; fromTaskId?: string; continueOnError: boolean; parallel: number } {
	const trimmed = args.trim();
	if (!trimmed) {
		throw new Error(
			"Usage: /agent exec T001 [--worker claude|codex|antigravity] | /agent exec --all [--worker claude] [--parallel N] [--from T003] [--continue-on-error]",
		);
	}

	if (/^--all\b/i.test(trimmed)) {
		const workerMatch = trimmed.match(/--worker\s+(\w+)/i);
		const worker = parseWorker(workerMatch?.[1]?.toLowerCase() ?? defaultWorker, defaultWorker);
		const fromMatch = trimmed.match(/--from\s+(T\d+)/i);
		return {
			mode: "batch",
			worker,
			fromTaskId: fromMatch?.[1]?.toUpperCase(),
			continueOnError: /--continue-on-error\b/i.test(trimmed),
			parallel: parseParallelFlag(trimmed),
		};
	}

	const match = trimmed.match(/^(T\d+)\s*(?:--worker\s+(\w+))?/i);
	if (!match) {
		throw new Error(
			"Usage: /agent exec T001 [--worker claude|codex|antigravity] | /agent exec --all [--worker claude] [--parallel N] [--from T003] [--continue-on-error]",
		);
	}
	const worker = parseWorker(match[2]?.toLowerCase() ?? defaultWorker, defaultWorker);
	return { mode: "single", taskId: match[1].toUpperCase(), worker };
}

export function parseSingleExecArgs(args: string, defaultWorker: Worker = "claude"): { taskId: string; worker: Worker } {
	const parsed = parseExecArgs(args, defaultWorker);
	if (parsed.mode !== "single") {
		throw new Error("This command requires a single task id (T001). Use /agent exec --all for batch execution.");
	}
	return parsed;
}

export function parseReviewArgs(
	args: string,
	defaultReviewer: Reviewer = "codex",
):
	| { mode: "single"; taskId: string; reviewer: Reviewer }
	| { mode: "batch"; reviewer: Reviewer; fromTaskId?: string; continueOnError: boolean } {
	const trimmed = args.trim();
	if (!trimmed) {
		throw new Error(
			"Usage: /agent review T001 [--reviewer claude|codex] | /agent review --all [--reviewer claude|codex] [--from T003] [--continue-on-error]",
		);
	}

	const reviewerMatch = trimmed.match(/--reviewer\s+(\w+)/i);
	const reviewer = parseReviewer(reviewerMatch?.[1]?.toLowerCase() ?? defaultReviewer, defaultReviewer);

	if (/^--all\b/i.test(trimmed)) {
		const fromMatch = trimmed.match(/--from\s+(T\d+)/i);
		return {
			mode: "batch",
			reviewer,
			fromTaskId: fromMatch?.[1]?.toUpperCase(),
			continueOnError: /--continue-on-error\b/i.test(trimmed),
		};
	}

	const taskId = trimmed.match(/^(T\d+)/i)?.[1]?.toUpperCase();
	if (!taskId) {
		throw new Error(
			"Usage: /agent review T001 [--reviewer claude|codex] | /agent review --all [--reviewer claude|codex] [--from T003] [--continue-on-error]",
		);
	}
	return { mode: "single", taskId, reviewer };
}

export function parseFixArgs(
	args: string,
	defaultFixer: Fixer = "claude",
): { fixer: Fixer; fromTaskId?: string } {
	const trimmed = args.trim();
	const fixerMatch = trimmed.match(/--fixer\s+(\w+)/i);
	const fixer = fixerMatch ? parseFixer(fixerMatch[1]!.toLowerCase()) : defaultFixer;
	const fromMatch = trimmed.match(/--from\s+(T\d+)/i);
	return {
		fixer,
		fromTaskId: fromMatch?.[1]?.toUpperCase(),
	};
}

export function parseRunArgs(
	args: string,
	defaultWorker: Worker = "claude",
	defaultReviewer: Reviewer = "codex",
): { taskId: string; worker: Worker; reviewer: Reviewer } {
	const { taskId, worker } = parseSingleExecArgs(args, defaultWorker);
	const reviewerMatch = args.match(/--reviewer\s+(\w+)/i);
	const reviewer = parseReviewer(reviewerMatch?.[1]?.toLowerCase() ?? defaultReviewer, defaultReviewer);
	return { taskId, worker, reviewer };
}

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

export function parseResumeArgs(args: string): { continueOnError: boolean } {
	return { continueOnError: /--continue-on-error\b/i.test(args.trim()) };
}
