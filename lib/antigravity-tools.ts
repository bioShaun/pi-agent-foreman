import { progressLine, shortenDisplayPath, truncate } from "./format-display.ts";

function stripQuotes(value: string): string {
	return value.replace(/^"+|"+$/g, "").trim();
}

function argString(args: Record<string, unknown>, ...keys: string[]): string {
	for (const key of keys) {
		const v = args[key];
		if (typeof v === "string" && v.trim()) return stripQuotes(v);
	}
	return "";
}

/** Format one agy transcript tool call for the exec loader. */
export function formatAgyToolCall(name: string, args: Record<string, unknown>): string | undefined {
	const n = name.toLowerCase();
	const summary = argString(args, "toolSummary", "toolAction");

	switch (n) {
		case "view_file":
		case "read_file": {
			const path = argString(args, "AbsolutePath", "Path", "path");
			if (path) return progressLine(`read ${shortenDisplayPath(path)}`);
			if (summary) return progressLine(`read ${truncate(summary)}`);
			return progressLine("read file");
		}
		case "run_command": {
			const cmd = argString(args, "CommandLine", "command");
			if (cmd) return progressLine(truncate(cmd));
			if (summary) return progressLine(truncate(summary));
			return progressLine("run command");
		}
		case "list_dir":
		case "list_directory": {
			const dir = argString(args, "DirectoryPath", "path");
			if (dir) return progressLine(`list ${shortenDisplayPath(dir)}`);
			if (summary) return progressLine(`list ${truncate(summary)}`);
			return progressLine("list directory");
		}
		case "grep_search":
		case "grep": {
			const query = argString(args, "Query", "query", "pattern");
			const root = argString(args, "SearchPath", "path");
			if (query && root) return progressLine(`grep ${truncate(query)} in ${shortenDisplayPath(root)}`);
			if (query) return progressLine(`grep ${truncate(query)}`);
			if (summary) return progressLine(`grep ${truncate(summary)}`);
			return progressLine("grep");
		}
		case "edit":
		case "code_action":
		case "write_file": {
			const path = argString(args, "AbsolutePath", "Path", "path");
			if (path) return progressLine(`edit ${shortenDisplayPath(path)}`);
			if (summary) return progressLine(`edit ${truncate(summary)}`);
			return progressLine("edit");
		}
		case "ask_permission":
			return summary ? progressLine(`permission ${truncate(summary)}`) : progressLine("permission request");
		case "list_permissions":
			return progressLine("check permissions");
		default:
			if (summary) return progressLine(truncate(summary));
			return n ? progressLine(n.replace(/_/g, " ")) : undefined;
	}
}

export function formatAgyLegacyTranscript(type: string, content: string): string | undefined {
	if (type === "VIEW_FILE" || type === "READ_FILE") {
		const path = content.match(/File Path: `file:\/\/([^`]+)`/)?.[1];
		if (path) return progressLine(`read ${shortenDisplayPath(path)}`);
	}
	if (type === "EDIT" || type === "CODE_ACTION") return progressLine("edit");
	if (type === "LIST_DIRECTORY") {
		const summary = content.match(/Summary: (.+)/)?.[1];
		if (summary) return progressLine(`list ${truncate(summary, 60)}`);
	}
	if (type === "GREP_SEARCH") return progressLine("grep");
	return undefined;
}
