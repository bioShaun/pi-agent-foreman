import { progressLine, shortenDisplayPath, truncate } from "./format-display.ts";

export interface ClaudeStreamState {
	textBuffer: string;
	lastToolKey?: string;
}

export function createClaudeStreamState(): ClaudeStreamState {
	return { textBuffer: "" };
}

export type ClaudeStreamLineKind = "progress" | "output";

export interface ClaudeStreamLine {
	kind: ClaudeStreamLineKind;
	line: string;
}

function formatToolCall(name: string, input: Record<string, unknown>): string {
	switch (name) {
		case "Read": {
			const fp = String(input.file_path ?? input.path ?? "?");
			const offset = input.offset as number | undefined;
			const limit = input.limit as number | undefined;
			let s = `read ${shortenDisplayPath(fp)}`;
			if (offset !== undefined || limit !== undefined) {
				s += `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}`;
			}
			return s;
		}
		case "Write":
		case "Edit": {
			const fp = String(input.file_path ?? input.path ?? "?");
			return `${name.toLowerCase()} ${shortenDisplayPath(fp)}`;
		}
		case "Bash":
		case "bash":
			return truncate(String(input.command ?? "…"));
		case "Grep": {
			const pattern = String(input.pattern ?? "?");
			const fp = input.path ? shortenDisplayPath(String(input.path)) : ".";
			return `grep /${pattern}/ in ${fp}`;
		}
		case "Glob":
		case "GlobTool":
			return `glob ${String(input.pattern ?? input.glob_pattern ?? "?")}`;
		case "Task":
		case "Agent":
			return `task ${truncate(String(input.description ?? input.prompt ?? name), 48)}`;
		default: {
			if (Object.keys(input).length === 0) return name.toLowerCase();
			return `${name.toLowerCase()} ${truncate(JSON.stringify(input))}`;
		}
	}
}

function toolKey(name: string, input: Record<string, unknown>): string {
	return `${name}:${JSON.stringify(input)}`;
}

export function summarizeClaudeStreamLine(line: string, state: ClaudeStreamState): ClaudeStreamLine | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith("{")) return null;

	try {
		const ev = JSON.parse(trimmed) as Record<string, unknown>;
		const event = ev.event as Record<string, unknown> | undefined;

		if (ev.type === "system" && ev.subtype === "status") return null;

		if (event?.type === "content_block_delta") {
			const delta = event.delta as { type?: string; text?: string } | undefined;
			if (delta?.type === "text_delta" && delta.text) state.textBuffer += delta.text;
			return null;
		}

		if (ev.type === "assistant") {
			const message = ev.message as {
				content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
			} | undefined;
			for (const block of message?.content ?? []) {
				if (block.type === "text" && block.text?.trim()) {
					state.textBuffer += block.text;
					continue;
				}
				if (block.type === "tool_use" && block.name) {
					const key = toolKey(block.name, block.input ?? {});
					if (state.lastToolKey === key) return null;
					state.lastToolKey = key;
					return { kind: "progress", line: progressLine(formatToolCall(block.name, block.input ?? {})) };
				}
			}
		}

		if (ev.type === "result") {
			const result = ev.result as string | undefined;
			if (result?.trim()) {
				state.textBuffer = result.trim();
				return { kind: "output", line: truncate(result.trim(), 500) };
			}
		}
	} catch {
		return null;
	}
	return null;
}
