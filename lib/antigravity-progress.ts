import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatAgyLegacyTranscript, formatAgyToolCall } from "./antigravity-tools.ts";

const AGY_LOG_DIR = join(homedir(), ".gemini", "antigravity-cli", "log");
const AGY_BRAIN_DIR = join(homedir(), ".gemini", "antigravity-cli", "brain");

export interface AntigravityProgressWatcher {
	stop: () => void;
}

function summarizeCliLine(line: string): string | undefined {
	if (line.includes("Print mode: silent auth succeeded")) return "Authenticated with Antigravity";
	if (line.includes("Print mode: starting")) return "Starting Antigravity…";
	return undefined;
}

function conversationIdFromLine(line: string): string | undefined {
	return line.match(/Print mode: conversation=([a-f0-9-]+)/)?.[1];
}

function summarizeTranscriptLine(line: string): string | undefined {
	try {
		const obj = JSON.parse(line) as {
			type?: string;
			status?: string;
			tool_calls?: Array<{ name?: string; args?: Record<string, unknown> }>;
			content?: string;
		};

		if (obj.type === "PLANNER_RESPONSE" && obj.tool_calls?.length) {
			for (const tc of obj.tool_calls) {
				if (!tc.name) continue;
				const formatted = formatAgyToolCall(tc.name, tc.args ?? {});
				if (formatted) return formatted;
			}
		}

		if (obj.type === "RUN_COMMAND") {
			if (obj.status === "RUNNING") return "$ running command…";
			const desc = obj.content?.match(/Task Description: (.+)/)?.[1]?.trim();
			if (desc) return `$ ${desc.replace(/^"+|"+$/g, "")}`;
		}

		if (obj.content && obj.type) {
			return formatAgyLegacyTranscript(obj.type, obj.content);
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function findLatestAgyLog(startedMs: number): string | undefined {
	try {
		const candidates = readdirSync(AGY_LOG_DIR)
			.filter((name) => name.startsWith("cli-") && name.endsWith(".log"))
			.map((name) => {
				const path = join(AGY_LOG_DIR, name);
				return { path, mtime: statSync(path).mtimeMs };
			})
			.filter((entry) => entry.mtime >= startedMs - 10_000)
			.sort((a, b) => b.mtime - a.mtime);
		return candidates[0]?.path;
	} catch {
		return undefined;
	}
}

function readFromOffset(path: string, offset: number): { chunk: string; offset: number } {
	if (!existsSync(path)) return { chunk: "", offset };
	const stat = statSync(path);
	if (stat.size <= offset) return { chunk: "", offset };
	const fd = openSync(path, "r");
	try {
		const len = stat.size - offset;
		const buf = Buffer.alloc(len);
		readSync(fd, buf, 0, len, offset);
		return { chunk: buf.toString("utf8"), offset: stat.size };
	} finally {
		closeSync(fd);
	}
}

/** Tail agy transcript (+ auth lines from CLI log) for live tool progress. */
export function watchAntigravityProgress(
	startedMs: number,
	onLine: (line: string) => void,
): AntigravityProgressWatcher {
	let stopped = false;
	let cliLogPath: string | undefined;
	let cliOffset = 0;
	let transcriptPath: string | undefined;
	let transcriptOffset = 0;
	const seen = new Set<string>();

	const emit = (line: string) => {
		const trimmed = line.trim();
		if (!trimmed || seen.has(trimmed)) return;
		seen.add(trimmed);
		onLine(trimmed);
	};

	const processChunk = (chunk: string, summarize: (line: string) => string | undefined) => {
		for (const line of chunk.split("\n")) {
			const summary = summarize(line);
			if (summary) emit(summary);
		}
	};

	const poll = () => {
		if (stopped) return;

		if (!cliLogPath) cliLogPath = findLatestAgyLog(startedMs);

		if (cliLogPath && !transcriptPath) {
			const { chunk, offset } = readFromOffset(cliLogPath, cliOffset);
			cliOffset = offset;
			if (chunk) {
				for (const line of chunk.split("\n")) {
					const id = conversationIdFromLine(line);
					if (id) {
						transcriptPath = join(AGY_BRAIN_DIR, id, ".system_generated", "logs", "transcript.jsonl");
					}
				}
				processChunk(chunk, summarizeCliLine);
			}
		}

		if (transcriptPath) {
			const { chunk, offset } = readFromOffset(transcriptPath, transcriptOffset);
			transcriptOffset = offset;
			if (chunk) processChunk(chunk, summarizeTranscriptLine);
		}
	};

	const timer = setInterval(poll, 500);
	poll();

	return {
		stop: () => {
			stopped = true;
			clearInterval(timer);
		},
	};
}
