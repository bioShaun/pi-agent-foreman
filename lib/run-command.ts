import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { watchAntigravityProgress } from "./antigravity-progress.ts";
import { shortenDisplayPath } from "./format-display.ts";
import { buildThemedLoaderPinned, buildThemedLoaderProgress } from "./loader-theme.ts";
import { appendLiveLog, ensureLiveOutputSection, initLiveLog } from "./live-log.ts";
import {
	buildProgressViewLines,
	FOLD_ARROW_HIT_COLS,
	foldGroupIds,
	isLoaderProgressLine,
	loaderFallback,
	pushDisplayLine,
	type ProgressViewLine,
	usesStructuredProgress,
} from "./run-display.ts";
import { spawnProcess, type RunResult } from "./spawn-process.ts";
import type { Fixer, Reviewer, Worker } from "./types.ts";
import { isFixer, isReviewer, isWorker } from "./types.ts";

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

export type { RunResult } from "./spawn-process.ts";

export interface RunWithLoaderOptions {
	cwd?: string;
	stdin?: string;
	timeoutMs?: number;
	jsonStream?: "claude" | "codex";
	antigravityProgress?: boolean;
	liveLogPath?: string;
	/** Pinned context lines (e.g. loaded review findings) shown above progress. */
	loaderContext?: string[];
}

export async function runWithLoader(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	label: string,
	command: string,
	args: string[],
	options?: RunWithLoaderOptions,
): Promise<RunResult> {
	if (!ctx.hasUI) {
		return pi.exec(command, args, {
			cwd: options?.cwd ?? ctx.cwd,
			timeout: options?.timeoutMs ?? 30 * 60 * 1000,
		});
	}

	if (options?.liveLogPath) {
		initLiveLog(options.liveLogPath, label, options.loaderContext);
	}

	const loaderContext = options?.loaderContext ?? [];

	const cwd = options?.cwd ?? ctx.cwd;
	const liveHint = options?.liveLogPath
		? shortenDisplayPath(options.liveLogPath, cwd)
		: ".agent/traces/T001/<runId>.live.log";

	const structured = usesStructuredProgress(options);

	const MOUSE_TRACKING_ON = "\x1b[?1006h\x1b[?1000h";
	const MOUSE_TRACKING_OFF = "\x1b[?1006l\x1b[?1000l";

	return ctx.ui.custom<RunResult>((tui, theme, kb, done) => {
		const container = new Container();
		const border = new DynamicBorder((s: string) => theme.fg("border", s));
		const pinnedOutput = new Text("", 1, 0);
		const progressOutput = new Text("", 1, 0);
		const footerOutput = new Text("", 1, 0);

		container.addChild(border);
		container.addChild(pinnedOutput);
		container.addChild(progressOutput);
		container.addChild(new Spacer(1));
		container.addChild(footerOutput);
		container.addChild(border);

		const redraw = () => {
			container.invalidate();
			tui.requestRender();
		};

		const recentLines: string[] = [];
		const expandedFoldIds = new Set<string>();
		const started = Date.now();
		let outputSectionOpen = !structured;
		const fallback = loaderFallback(options);
		let mouseTracking = false;
		let componentLineCount = 0;
		const foldToggleAtLine = new Map<number, string>();
		let cachedViewLines: ProgressViewLine[] = [];

		const updateLayoutHints = (pinnedLineCount: number, viewLines: ProgressViewLine[]) => {
			const progressStart = 1 + pinnedLineCount;
			foldToggleAtLine.clear();
			for (let i = 0; i < viewLines.length; i++) {
				const line = viewLines[i]!;
				if (line.isFoldToggle && line.foldId) {
					foldToggleAtLine.set(progressStart + i, line.foldId);
				}
			}
			componentLineCount = 1 + pinnedLineCount + viewLines.length + 1 + 1 + 1;
		};

		const toggleFold = (foldId: string) => {
			if (expandedFoldIds.has(foldId)) expandedFoldIds.delete(foldId);
			else expandedFoldIds.add(foldId);
		};

		const enableMouseTracking = () => {
			if (mouseTracking) return;
			tui.terminal.write(MOUSE_TRACKING_ON);
			mouseTracking = true;
		};

		const disableMouseTracking = () => {
			if (!mouseTracking) return;
			tui.terminal.write(MOUSE_TRACKING_OFF);
			mouseTracking = false;
		};

		const refreshFooter = (hasFolds: boolean) => {
			if (hasFolds) enableMouseTracking();
			const hint = hasFolds
				? `点击 ▸/▾ 展开/收起 · Esc cancel · tail -f ${liveHint}`
				: `Esc cancel · tail -f ${liveHint}`;
			footerOutput.setText(theme.fg("dim", hint));
		};

		const refresh = () => {
			const elapsedMs = Date.now() - started;
			cachedViewLines = buildProgressViewLines(recentLines, { expandedFoldIds });
			const pinnedText = buildThemedLoaderPinned(theme, label, elapsedMs, loaderContext);
			pinnedOutput.setText(pinnedText);
			progressOutput.setText(
				buildThemedLoaderProgress(theme, recentLines, fallback, { expandedFoldIds }, cachedViewLines),
			);
			refreshFooter(foldGroupIds(cachedViewLines).length > 0);
			updateLayoutHints(pinnedText.split("\n").length, cachedViewLines);
			redraw();
		};

		let refreshCoalescing = false;
		const scheduleRefresh = () => {
			if (refreshCoalescing) return;
			refreshCoalescing = true;
			setImmediate(() => {
				refreshCoalescing = false;
				refresh();
			});
		};

		refresh();

		const onProgressLine = (line: string, filterStructured = structured) => {
			if (filterStructured && !isLoaderProgressLine(line)) return;
			pushDisplayLine(recentLines, line);
			appendLiveLog(options?.liveLogPath, "progress", line);
			scheduleRefresh();
		};

		const onOutputLine = (line: string) => {
			if (!outputSectionOpen) {
				ensureLiveOutputSection(options?.liveLogPath);
				outputSectionOpen = true;
			}
			appendLiveLog(options?.liveLogPath, "output", line);
		};

		const agyWatcher = options?.antigravityProgress
			? watchAntigravityProgress(started, (line) => onProgressLine(line))
			: undefined;

		const handle = spawnProcess({
			command,
			args,
			cwd: options?.cwd ?? ctx.cwd,
			stdin: options?.stdin,
			timeoutMs: options?.timeoutMs,
			jsonStream: options?.jsonStream,
			mergeStderr: options?.antigravityProgress,
			onProgressLine: (line) => onProgressLine(line, structured),
			onOutputLine: structured ? onOutputLine : undefined,
		});

		const elapsedTimer = setInterval(refresh, 1000);

		void handle.result.then((result) => {
			clearInterval(elapsedTimer);
			agyWatcher?.stop();
			disableMouseTracking();
			done(result);
		});

		const parseMousePress = (data: string): { row: number; col: number } | null => {
			const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([mM])$/);
			if (!match) return null;
			const button = Number(match[1]);
			const release = match[4] === "m";
			if (release || (button !== 0 && button !== 32)) return null;
			return { col: Number(match[2]), row: Number(match[3]) };
		};

		/** Returns true when the click toggled a fold (event consumed). */
		const handleMousePress = (row: number, col: number): boolean => {
			if (componentLineCount <= 0) return false;
			const topRow = Math.max(1, tui.terminal.rows - componentLineCount + 1);
			const relLine = row - topRow;
			const foldId = foldToggleAtLine.get(relLine);
			if (!foldId || col > FOLD_ARROW_HIT_COLS) return false;
			toggleFold(foldId);
			return true;
		};

		return {
			render: (width: number) => container.render(width),
			invalidate: redraw,
			dispose: () => disableMouseTracking(),
			handleInput: (data: string) => {
				const mouse = parseMousePress(data);
				if (mouse !== null) {
					if (handleMousePress(mouse.row, mouse.col)) {
						scheduleRefresh();
						return;
					}
					// Non-arrow clicks: do not return — allow terminal selection / other handlers.
				}
				if (kb.matches(data, "tui.select.cancel")) {
					disableMouseTracking();
					agyWatcher?.stop();
					handle.kill();
				}
			},
		};
	});
}

export async function which(pi: ExtensionAPI, cwd: string, bin: string): Promise<boolean> {
	if (!/^[A-Za-z0-9._+-]+$/.test(bin)) return false;
	const result = await pi.exec("bash", ["-lc", `command -v -- ${JSON.stringify(bin)}`], { cwd, timeout: 5000 });
	return result.code === 0 && result.stdout.trim().length > 0;
}

export const MAX_EXEC_PARALLEL = 8;

export function parseParallelFlag(trimmed: string): number {
	const match = trimmed.match(/--parallel\s+(\d+)/i);
	if (!match) return 1;
	const n = Number.parseInt(match[1]!, 10);
	if (!Number.isFinite(n) || n < 1) {
		throw new Error("--parallel must be a positive integer");
	}
	return Math.min(n, MAX_EXEC_PARALLEL);
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
