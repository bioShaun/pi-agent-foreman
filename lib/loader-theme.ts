import { buildProgressViewLines, formatElapsed, type ProgressViewLine, type ProgressViewOptions } from "./run-display.ts";

type ThemeColor =
	| "accent"
	| "dim"
	| "muted"
	| "text"
	| "toolTitle"
	| "mdCode"
	| "syntaxString"
	| "syntaxKeyword"
	| "syntaxNumber"
	| "syntaxPunctuation"
	| "syntaxFunction"
	| "warning"
	| "error"
	| "bashMode";

export interface LoaderTheme {
	fg(color: ThemeColor, text: string): string;
	bold(text: string): string;
}

const FILE_TOOLS = new Set(["read", "write", "edit"]);

function formatFileTarget(theme: LoaderTheme, target: string): string {
	const range = target.match(/^(.+?)(:\d+(?:-\d+)?)$/);
	if (range) {
		return theme.fg("mdCode", range[1]!) + theme.fg("syntaxNumber", range[2]!);
	}
	return theme.fg("mdCode", target);
}

function formatGrepArgs(theme: LoaderTheme, args: string): string {
	const inIdx = args.lastIndexOf(" in ");
	if (inIdx === -1) {
		return theme.fg("syntaxString", args);
	}
	const pattern = args.slice(0, inIdx);
	const path = args.slice(inIdx + 4);
	return (
		theme.fg("syntaxString", pattern) +
		" " +
		theme.fg("syntaxKeyword", "in") +
		" " +
		theme.fg("mdCode", path)
	);
}

function formatEditArgs(theme: LoaderTheme, args: string): string {
	return args
		.split(/,\s*/)
		.map((part) => {
			const m = part.match(/^(update|delete|add|rename)\s+(.+)$/i);
			if (m) {
				return theme.fg("syntaxKeyword", m[1]!) + " " + theme.fg("mdCode", m[2]!);
			}
			return theme.fg("mdCode", part);
		})
		.join(theme.fg("syntaxPunctuation", ", "));
}

function formatShellCommand(theme: LoaderTheme, args: string): string {
	if (args.includes(" │")) {
		const [head, tail] = args.split(" │", 2);
		return theme.fg("syntaxFunction", head!) + theme.fg("dim", ` │${tail ?? "…"}`);
	}
	const tool = args.match(/^(pytest|git|python(?:3)?|rg|grep|sed|nl|cat|find|wc)\b/i)?.[1];
	if (tool) {
		const rest = args.slice(tool.length);
		return theme.fg("toolTitle", theme.bold(tool.toLowerCase())) + theme.fg("mdCode", rest);
	}
	return theme.fg("bashMode", args);
}

function formatProgressViewLine(theme: LoaderTheme, line: ProgressViewLine): string {
	if (line.isFoldToggle) {
		const marker = line.foldExpanded ? "▾" : "▸";
		return theme.fg("accent", marker) + theme.fg("dim", " ") + formatProgressLine(theme, line.raw);
	}
	return formatProgressLine(theme, line.raw);
}

function formatProgressLine(theme: LoaderTheme, line: string): string {
	const failed = line.endsWith(" (failed)");
	const body = failed ? line.slice(0, -" (failed)".length) : line;

	if (body.startsWith("⚠")) return theme.fg("warning", body);
	if (body.startsWith("✗")) return theme.fg("error", body);
	if (/^(Starting |Working|Authenticated)/.test(body)) return theme.fg("dim", body);
	if (body === "$ running command…") return theme.fg("dim", body);

	if (!body.startsWith("$ ")) {
		return theme.fg("muted", body);
	}

	const rest = body.slice(2);
	const verbMatch = rest.match(/^(\w+)\s*(.*)$/);
	if (!verbMatch) {
		return theme.fg("syntaxPunctuation", "$ ") + theme.fg("muted", rest);
	}

	const verb = verbMatch[1]!.toLowerCase();
	const args = verbMatch[2] ?? "";

	let out =
		theme.fg("syntaxPunctuation", "$ ") + theme.fg("toolTitle", theme.bold(verb));

	if (!args) {
		if (failed) out += theme.fg("error", " (failed)");
		return out;
	}

	out += " ";

	if (verb === "grep") out += formatGrepArgs(theme, args);
	else if (verb === "glob" || verb === "search") out += theme.fg("syntaxString", args);
	else if (verb === "task") out += theme.fg("syntaxString", args);
	else if (verb === "mcp") out += theme.fg("accent", args);
	else if (verb === "edit" && /^(update|delete|add|rename)\s/i.test(args)) out += formatEditArgs(theme, args);
	else if (verb === "permission" || verb === "check") out += theme.fg("syntaxKeyword", args);
	else if (FILE_TOOLS.has(verb)) out += formatFileTarget(theme, args);
	else out += formatShellCommand(theme, args);

	if (failed) out += theme.fg("error", " (failed)");
	return out;
}

function formatContextLine(theme: LoaderTheme, line: string): string {
	if (line.startsWith("↳")) return theme.fg("accent", theme.bold(line));
	const finding = line.match(/^  \[(\w+)\]\s*(.+)$/);
	if (finding) {
		const severity = finding[1]!.toLowerCase();
		const color =
			severity === "critical" || severity === "major"
				? "warning"
				: severity === "minor"
					? "muted"
					: "dim";
		return theme.fg("dim", "  ") + theme.fg(color, `[${finding[1]}]`) + theme.fg("text", ` ${finding[2]}`);
	}
	if (line.startsWith("  …")) return theme.fg("dim", line);
	if (line.startsWith("  ")) return theme.fg("muted", line);
	return theme.fg("muted", line);
}

function formatLoaderHeader(theme: LoaderTheme, label: string, elapsedMs: number): string {
	const elapsed = theme.fg("dim", `  (${formatElapsed(elapsedMs)})`);
	const withMatch = label.match(/^Executing\s+(T\d+)\s+with\s+(\S+)(?:\s+· review retry)?$/i);
	if (withMatch) {
		return (
			theme.fg("text", theme.bold(`Executing ${withMatch[1]}`)) +
			" " +
			theme.fg("accent", `with ${withMatch[2]}`) +
			(label.includes("review retry") ? " " + theme.fg("warning", "· review retry") : "") +
			elapsed
		);
	}
	const reviewMatch = label.match(/^Reviewing\s+(T\d+)\s+with\s+(\S+)$/i);
	if (reviewMatch) {
		return (
			theme.fg("text", theme.bold(`Reviewing ${reviewMatch[1]}`)) +
			" " +
			theme.fg("accent", `with ${reviewMatch[2]}`) +
			elapsed
		);
	}
	const planMatch = label.match(/^(Planning:\s+)(.+)$/);
	if (planMatch) {
		return theme.fg("text", theme.bold(planMatch[1]!)) + theme.fg("accent", planMatch[2]!) + elapsed;
	}
	return theme.fg("text", theme.bold(label)) + elapsed;
}

/** Header + pinned context — kept in a separate TUI region so progress cannot scroll it away. */
export function buildThemedLoaderPinned(
	theme: LoaderTheme,
	label: string,
	elapsedMs: number,
	contextLines: string[] = [],
): string {
	const header = formatLoaderHeader(theme, label, elapsedMs);
	if (contextLines.length === 0) return header;
	const context = contextLines.map((line) => formatContextLine(theme, line)).join("\n");
	return `${header}\n\n${context}`;
}

export type LoaderProgressState = ProgressViewOptions;

export function buildThemedLoaderProgress(
	theme: LoaderTheme,
	recentLines: string[],
	fallback: string,
	state?: LoaderProgressState,
	viewLines?: ProgressViewLine[],
): string {
	if (recentLines.length === 0) return theme.fg("dim", fallback);
	const lines =
		viewLines ??
		buildProgressViewLines(recentLines, {
			expandedFoldIds: state?.expandedFoldIds ?? new Set(),
		});
	return lines.map((line) => formatProgressViewLine(theme, line)).join("\n");
}

export function buildThemedLoaderText(
	theme: LoaderTheme,
	label: string,
	elapsedMs: number,
	recentLines: string[],
	fallback: string,
	contextLines: string[] = [],
): string {
	const pinned = buildThemedLoaderPinned(theme, label, elapsedMs, contextLines);
	const body = buildThemedLoaderProgress(theme, recentLines, fallback);
	return `${pinned}\n\n${body}`;
}
