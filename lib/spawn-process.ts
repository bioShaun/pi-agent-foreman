import { spawn } from "node:child_process";
import { createClaudeStreamState, summarizeClaudeStreamLine, type ClaudeStreamState } from "./claude-stream.ts";
import { createCodexStreamState, summarizeCodexStreamLine, type CodexStreamState } from "./codex-stream.ts";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	killed: boolean;
}

export interface SpawnProcessOptions {
	command: string;
	args: string[];
	cwd?: string;
	stdin?: string;
	timeoutMs?: number;
	jsonStream?: "claude" | "codex";
	mergeStderr?: boolean;
	onProgressLine?: (line: string) => void;
	onOutputLine?: (line: string) => void;
}

export interface SpawnProcessHandle {
	result: Promise<RunResult>;
	kill: () => void;
}

export function spawnProcess(options: SpawnProcessOptions): SpawnProcessHandle {
	let killed = false;
	let proc: ReturnType<typeof spawn> | undefined;

	const kill = () => {
		killed = true;
		proc?.kill("SIGTERM");
	};

	const result = new Promise<RunResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let lineBuffer = "";
		let partialLine = "";
		const streamState: ClaudeStreamState | CodexStreamState | undefined =
			options.jsonStream === "claude"
				? createClaudeStreamState()
				: options.jsonStream === "codex"
					? createCodexStreamState()
					: undefined;

		const emitProgress = (line: string) => options.onProgressLine?.(line);
		const emitOutput = (line: string) => options.onOutputLine?.(line);

		const emitPlainLines = (text: string) => {
			partialLine += text;
			const lines = partialLine.split("\n");
			partialLine = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("Warning: no stdin")) continue;
				emitProgress(trimmed);
			}
		};

		const processJsonLine = (line: string) => {
			if (!streamState || !options.jsonStream) return;
			const parsed =
				options.jsonStream === "codex"
					? summarizeCodexStreamLine(line, streamState as CodexStreamState)
					: summarizeClaudeStreamLine(line, streamState as ClaudeStreamState);
			if (!parsed) return;
			if (parsed.kind === "output") emitOutput(parsed.line);
			else emitProgress(parsed.line);
		};

		const processLines = (text: string, isErr: boolean) => {
			if (options.jsonStream) {
				if (!isErr) lineBuffer += text;
				else stderr += text;
				const lines = lineBuffer.split("\n");
				lineBuffer = lines.pop() ?? "";
				for (const line of lines) processJsonLine(line);
				return;
			}

			if (isErr && !options.mergeStderr) stderr += text;
			else stdout += text;
			emitPlainLines(text);
		};

		proc = spawn(options.command, options.args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, CI: "1", TERM: "dumb" },
		});

		const timeout = options.timeoutMs ? setTimeout(kill, options.timeoutMs) : undefined;

		if (options.stdin !== undefined) {
			proc.stdin?.write(options.stdin);
		}
		proc.stdin?.end();

		proc.stdout?.on("data", (chunk: Buffer) => processLines(chunk.toString(), false));
		proc.stderr?.on("data", (chunk: Buffer) => {
			if (options.jsonStream || options.mergeStderr) processLines(chunk.toString(), false);
			else processLines(chunk.toString(), true);
		});

		proc.on("close", (code) => {
			if (timeout) clearTimeout(timeout);
			if (!options.jsonStream && partialLine.trim()) emitProgress(partialLine.trim());
			if (lineBuffer.trim() && options.jsonStream) processJsonLine(lineBuffer);
			const textBuffer =
				streamState && "textBuffer" in streamState ? streamState.textBuffer.trim() : "";
			const finalOut = textBuffer || stdout;
			resolve({ code: code ?? 1, stdout: finalOut, stderr, killed });
		});

		proc.on("error", (err) => {
			if (timeout) clearTimeout(timeout);
			stderr += `\n${err.message}`;
			resolve({ code: 1, stdout, stderr, killed });
		});
	});

	return { result, kill };
}
