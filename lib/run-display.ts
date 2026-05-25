import { summarizeShellCommand } from "./format-display.ts";

const MAX_RECENT = 80;
/** Max lines shown in loader after folding consecutive same-tool commands. */
const TAIL_LINES = 5;

function tail(text: string, lines: number): string {
	const parts = text.trim().split("\n");
	return parts.slice(-lines).join("\n");
}

export function tailLines(text: string, lines = 8): string {
	return tail(text, lines);
}

export function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Group key for collapsing repeated tool commands in the loader (display only). */
export function foldProgressKey(line: string): string | null {
	const t = line.trim();
	if (!t.startsWith("$ ")) return null;
	const body = t.slice(2).replace(/ \(failed\)$/, "");
	if (/^(Starting |Working|Authenticated)/.test(body)) return null;

	if (/(?:^|[;\s]|&&)\s*(?:\S+\/)?pytest\b/i.test(body)) return "pytest";
	if (/\bruff\b/i.test(body)) return "ruff";
	if (/\bpyright\b/i.test(body)) return "pyright";
	if (/\bpython3?\b/i.test(body)) return "python";
	if (/^git\b/i.test(body)) return "git";

	const verb = body.match(/^(\w+)/)?.[1]?.toLowerCase();
	if (verb && ["read", "list", "grep", "glob", "edit", "find", "check", "permission", "mcp", "task"].includes(verb)) {
		return verb;
	}
	return null;
}

interface ProgressFoldGroup {
	id: string;
	lines: string[];
}

export type ProgressEntry = { kind: "line"; line: string } | { kind: "fold"; fold: ProgressFoldGroup };

export interface ProgressViewLine {
	raw: string;
	/** Fold group id (toggle row only). */
	foldId?: string;
	/** Row shows ▸/▾; only this cell toggles expand/collapse. */
	isFoldToggle?: boolean;
	foldExpanded?: boolean;
}

/** Terminal columns reserved for the fold arrow (▸/▾ + space). */
export const FOLD_ARROW_HIT_COLS = 2;

export interface ProgressViewOptions {
	expandedFoldIds: ReadonlySet<string>;
	tailLines?: number;
}

function buildProgressEntries(lines: string[]): ProgressEntry[] {
	const out: ProgressEntry[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		const key = foldProgressKey(line);
		if (!key) {
			out.push({ kind: "line", line });
			i++;
			continue;
		}
		const startIdx = i;
		const groupLines = [line];
		i++;
		while (i < lines.length && foldProgressKey(lines[i]!) === key) {
			groupLines.push(lines[i]!);
			i++;
		}
		if (groupLines.length === 1) {
			out.push({ kind: "line", line: groupLines[0]! });
		} else {
			out.push({
				kind: "fold",
				fold: { id: `${key}@${startIdx}`, lines: groupLines },
			});
		}
	}
	return out;
}

function flattenProgressEntries(entries: ProgressEntry[], expandedFoldIds: ReadonlySet<string>): ProgressViewLine[] {
	const flat: ProgressViewLine[] = [];
	for (const entry of entries) {
		if (entry.kind === "line") {
			flat.push({ raw: entry.line });
			continue;
		}
		const { fold } = entry;
		const expanded = expandedFoldIds.has(fold.id);
		if (expanded) {
			for (let i = 0; i < fold.lines.length; i++) {
				const isToggle = i === fold.lines.length - 1;
				flat.push({
					raw: fold.lines[i]!,
					...(isToggle
						? { foldId: fold.id, isFoldToggle: true, foldExpanded: true }
						: {}),
				});
			}
		} else {
			flat.push({
				raw: fold.lines[fold.lines.length - 1]!,
				foldId: fold.id,
				isFoldToggle: true,
				foldExpanded: false,
			});
		}
	}
	return flat;
}

function tailProgressViewLines(lines: ProgressViewLine[], max: number): ProgressViewLine[] {
	if (lines.length <= max) return lines;
	let start = lines.length - max;
	const visibleFoldIds = new Set<string>();
	for (const line of lines.slice(start)) {
		if (line.foldId) visibleFoldIds.add(line.foldId);
	}
	for (const foldId of visibleFoldIds) {
		const firstIdx = lines.findIndex((l) => l.foldId === foldId);
		if (firstIdx >= 0 && firstIdx < start) start = firstIdx;
	}
	return lines.slice(start);
}

export function buildProgressViewLines(lines: string[], options: ProgressViewOptions): ProgressViewLine[] {
	const entries = buildProgressEntries(lines);
	const flat = flattenProgressEntries(entries, options.expandedFoldIds);
	return tailProgressViewLines(flat, options.tailLines ?? TAIL_LINES);
}

export function foldGroupIds(viewLines: ProgressViewLine[]): string[] {
	return [
		...new Set(
			viewLines.flatMap((line) => (line.isFoldToggle && line.foldId ? [line.foldId] : [])),
		),
	];
}

export interface LoaderOptions {
	jsonStream?: "claude" | "codex";
	antigravityProgress?: boolean;
}

export function usesStructuredProgress(options?: LoaderOptions): boolean {
	return Boolean(options?.jsonStream || options?.antigravityProgress);
}

export function loaderFallback(options?: LoaderOptions): string {
	if (options?.jsonStream === "claude") return "Starting Claude…";
	if (options?.jsonStream === "codex") return "Starting Codex…";
	if (options?.antigravityProgress) return "Starting Antigravity…";
	return "Waiting for output…";
}

/** Lines suitable for the exec loader (tool progress, not model prose). */
export function isLoaderProgressLine(line: string): boolean {
	const t = line.trim();
	if (!t) return false;
	if (t.startsWith("$ ")) return true;
	if (/^(Starting (Claude|Codex|Antigravity)|Authenticated with Antigravity|Working…)/.test(t)) return true;
	if (/^[⚠✗]/.test(t)) return true;
	return false;
}

function progressDedupeKey(line: string): string {
	const body = line.replace(/^\$ /, "").replace(/ \(failed\)$/, "");
	return summarizeShellCommand(body, 160);
}

export function pushDisplayLine(recentLines: string[], line: string): void {
	const trimmed = line.trim();
	if (!trimmed) return;

	const key = progressDedupeKey(trimmed);
	const last = recentLines[recentLines.length - 1];
	if (last === "$ running command…" && trimmed.startsWith("$ ")) {
		recentLines[recentLines.length - 1] = trimmed;
		return;
	}
	if (last === trimmed) return;
	if (last && progressDedupeKey(last) === key) return;

	if (trimmed.startsWith("$ ") && last?.startsWith("$ ")) {
		const lastCmd = last.replace(/ \(failed\)$/, "");
		const nextCmd = trimmed.replace(/ \(failed\)$/, "");
		if (nextCmd.startsWith(lastCmd) || lastCmd.startsWith(nextCmd)) {
			recentLines[recentLines.length - 1] = trimmed;
			return;
		}
	}

	recentLines.push(trimmed);
	if (recentLines.length > MAX_RECENT) recentLines.shift();
}
