import { buildLoaderBody, formatElapsed } from "./run-display.ts";

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
	else if (FILE_TOOLS.has(verb)) out += formatFileTarget(theme, args);
	else out += theme.fg("bashMode", args);

	if (failed) out += theme.fg("error", " (failed)");
	return out;
}

function formatLoaderHeader(theme: LoaderTheme, label: string, elapsedMs: number): string {
	const elapsed = theme.fg("dim", `  (${formatElapsed(elapsedMs)})`);
	const withMatch = label.match(/^(.+?\s+(T\d+))\s+(with\s+\S+)$/i);
	if (withMatch) {
		return (
			theme.fg("text", theme.bold(withMatch[1]!)) +
			" " +
			theme.fg("accent", withMatch[3]!) +
			elapsed
		);
	}
	const planMatch = label.match(/^(Planning:\s+)(.+)$/);
	if (planMatch) {
		return theme.fg("text", theme.bold(planMatch[1]!)) + theme.fg("accent", planMatch[2]!) + elapsed;
	}
	return theme.fg("text", theme.bold(label)) + elapsed;
}

export function buildThemedLoaderText(
	theme: LoaderTheme,
	label: string,
	elapsedMs: number,
	recentLines: string[],
	fallback: string,
): string {
	const header = formatLoaderHeader(theme, label, elapsedMs);
	const bodyRaw = buildLoaderBody(recentLines, fallback);
	const body =
		recentLines.length > 0
			? bodyRaw
					.split("\n")
					.map((line) => formatProgressLine(theme, line))
					.join("\n")
			: theme.fg("dim", fallback);

	return `${header}\n\n${body}`;
}
