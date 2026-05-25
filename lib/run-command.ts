import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Worker } from "./types.ts";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	killed: boolean;
}

const TAIL_LINES = 8;

function tail(text: string, lines = TAIL_LINES): string {
	const parts = text.trim().split("\n");
	return parts.slice(-lines).join("\n");
}

export async function runWithLoader(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	label: string,
	command: string,
	args: string[],
	options?: { cwd?: string; stdin?: string; timeoutMs?: number },
): Promise<RunResult> {
	if (!ctx.hasUI) {
		return pi.exec(command, args, {
			cwd: options?.cwd ?? ctx.cwd,
			timeout: options?.timeoutMs ?? 30 * 60 * 1000,
		});
	}

	return ctx.ui.custom<RunResult>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, label, { cancellable: true });
		const output = new Text("", 0, 0);
		loader.addChild(output);

		let stdout = "";
		let stderr = "";
		let killed = false;

		const proc = spawn(command, args, {
			cwd: options?.cwd ?? ctx.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const timeout = options?.timeoutMs
			? setTimeout(() => {
					killed = true;
					proc.kill("SIGTERM");
				}, options.timeoutMs)
			: undefined;

		loader.onAbort = () => {
			killed = true;
			proc.kill("SIGTERM");
		};

		if (options?.stdin !== undefined) {
			proc.stdin?.write(options.stdin);
			proc.stdin?.end();
		} else {
			proc.stdin?.end();
		}

		const refresh = () => {
			const combined = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
			const preview = tail(combined) || "(waiting for output…)";
			output.setText(theme.fg("muted", preview));
		};

		proc.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			refresh();
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			refresh();
		});

		proc.on("close", (code) => {
			if (timeout) clearTimeout(timeout);
			done({ code: code ?? 1, stdout, stderr, killed });
		});

		proc.on("error", (err) => {
			if (timeout) clearTimeout(timeout);
			stderr += `\n${err.message}`;
			done({ code: 1, stdout, stderr, killed });
		});

		return loader;
	});
}

export async function which(pi: ExtensionAPI, cwd: string, bin: string): Promise<boolean> {
	const result = await pi.exec("bash", ["-lc", `command -v ${bin}`], { cwd, timeout: 5000 });
	return result.code === 0 && result.stdout.trim().length > 0;
}

export function workerCommand(worker: Worker, prompt: string): { command: string; args: string[]; stdin?: string } {
	switch (worker) {
		case "claude":
			return {
				command: "claude",
				args: ["-p", prompt, "--dangerously-skip-permissions"],
			};
		case "codex":
			return {
				command: "codex",
				args: ["exec", prompt],
			};
		case "antigravity":
			return {
				command: "antigravity",
				args: ["-p", prompt],
			};
	}
}

export async function assertWorkerAvailable(
	pi: ExtensionAPI,
	cwd: string,
	worker: Worker,
): Promise<void> {
	const bin = worker === "codex" ? "codex" : worker === "claude" ? "claude" : "antigravity";
	if (!(await which(pi, cwd, bin))) {
		throw new Error(`${bin} CLI not found in PATH. Install it or pick another --worker.`);
	}
}

export function parseExecArgs(args: string): { taskId: string; worker: Worker } {
	const match = args.trim().match(/^(T\d+)\s*(?:--worker\s+(\w+))?/i);
	if (!match) throw new Error("Usage: /agent exec T001 [--worker claude|codex|antigravity]");
	const worker = (match[2]?.toLowerCase() ?? "claude") as Worker;
	if (!["claude", "codex", "antigravity"].includes(worker)) {
		throw new Error(`Unknown worker: ${worker}`);
	}
	return { taskId: match[1].toUpperCase(), worker };
}

export function parseReviewArgs(args: string): string {
	const taskId = args.trim().match(/^(T\d+)/i)?.[1]?.toUpperCase();
	if (!taskId) throw new Error("Usage: /agent review T001");
	return taskId;
}
