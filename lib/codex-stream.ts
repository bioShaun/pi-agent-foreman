import { progressLine, shortenDisplayPath, truncate } from "./format-display.ts";

export interface CodexStreamState {
	textBuffer: string;
}

export function createCodexStreamState(): CodexStreamState {
	return { textBuffer: "" };
}

export type CodexStreamLineKind = "progress" | "output";

export interface CodexStreamLine {
	kind: CodexStreamLineKind;
	line: string;
}

function normalizeCommand(command: string): string {
	return command.replace(/^bash\s+-lc\s+/i, "").trim();
}

function formatCommandItem(item: Record<string, unknown>): string | undefined {
	const command = typeof item.command === "string" ? normalizeCommand(item.command) : "";
	if (!command) return undefined;
	const failed = item.status === "failed" ? " (failed)" : "";
	return progressLine(`${truncate(command)}${failed}`);
}

function formatFileChangeItem(item: Record<string, unknown>): string | undefined {
	const changes = item.changes as Array<{ path?: string; kind?: string }> | undefined;
	if (!changes?.length) return progressLine("edit files");
	const preview = changes
		.slice(0, 3)
		.map((c) => `${c.kind ?? "update"} ${shortenDisplayPath(String(c.path ?? "?"))}`)
		.join(", ");
	const suffix = changes.length > 3 ? ` (+${changes.length - 3})` : "";
	return progressLine(`edit ${preview}${suffix}`);
}

function formatMcpToolItem(item: Record<string, unknown>): string | undefined {
	const tool = typeof item.tool === "string" ? item.tool : "tool";
	const server = typeof item.server === "string" ? item.server : undefined;
	const failed = item.status === "failed" ? " (failed)" : "";
	const label = server ? `mcp ${server}/${tool}${failed}` : `mcp ${tool}${failed}`;
	return progressLine(label);
}

function summarizeCodexItem(item: Record<string, unknown>, eventType: string): CodexStreamLine | null {
	const itemType = item.type;
	if (itemType === "command_execution" && (eventType === "item.started" || eventType === "item.completed")) {
		const line = formatCommandItem(item);
		return line ? { kind: "progress", line } : null;
	}
	if (itemType === "file_change" && eventType === "item.completed") {
		const line = formatFileChangeItem(item);
		return line ? { kind: "progress", line } : null;
	}
	if (itemType === "mcp_tool_call" && (eventType === "item.started" || eventType === "item.completed")) {
		const line = formatMcpToolItem(item);
		return line ? { kind: "progress", line } : null;
	}
	if (itemType === "web_search" && eventType === "item.completed") {
		const query = typeof item.query === "string" ? item.query : "";
		return query ? { kind: "progress", line: progressLine(`search ${truncate(query)}`) } : null;
	}
	if (itemType === "agent_message" && eventType === "item.completed") {
		const text = typeof item.text === "string" ? item.text.trim() : "";
		if (!text) return null;
		return { kind: "output", line: text };
	}
	if (itemType === "error" && eventType === "item.completed") {
		const message = typeof item.message === "string" ? item.message.trim() : "";
		return message ? { kind: "progress", line: `⚠ ${truncate(message, 100)}` } : null;
	}
	return null;
}

export function summarizeCodexStreamLine(line: string, state: CodexStreamState): CodexStreamLine | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith("{")) return null;

	try {
		const ev = JSON.parse(trimmed) as Record<string, unknown>;
		const type = String(ev.type ?? "");

		if (type === "thread.started") return { kind: "progress", line: "Starting Codex…" };
		if (type === "turn.started") return { kind: "progress", line: "Working…" };
		if (type === "turn.failed") {
			const message = (ev.error as { message?: string } | undefined)?.message?.trim();
			return message ? { kind: "progress", line: `✗ ${truncate(message, 100)}` } : null;
		}
		if (type === "error") {
			const message = String(ev.message ?? "").trim();
			if (!message || /^Reconnecting\.\.\./i.test(message)) return null;
			return { kind: "progress", line: `⚠ ${truncate(message, 100)}` };
		}

		if (type === "item.started" || type === "item.updated" || type === "item.completed") {
			const item = ev.item as Record<string, unknown> | undefined;
			if (!item) return null;
			const parsed = summarizeCodexItem(item, type);
			if (parsed?.kind === "output") state.textBuffer += `${parsed.line}\n\n`;
			return parsed;
		}
	} catch {
		return null;
	}
	return null;
}
