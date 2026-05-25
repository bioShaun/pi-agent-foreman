import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RunPhase } from "./types.ts";

export const AGENT_DIR = ".agent";

export function agentRoot(cwd: string): string {
	return join(cwd, AGENT_DIR);
}

/** UTC compact timestamp + provider, e.g. 20250525T120058Z-claude */
export function createRunId(provider: string): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const ts = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
	return `${ts}-${provider}`;
}

export function artifactPath(cwd: string, phase: RunPhase, entityId: string, runId: string): string {
	const ext = phase === "exec" || phase === "fix" ? "log" : "md";
	return join(agentRoot(cwd), "artifacts", phase, entityId, `${runId}.${ext}`);
}

export function reviewVerdictPath(cwd: string, taskId: string, runId: string): string {
	return join(agentRoot(cwd), "artifacts", "review", taskId, `${runId}.json`);
}

export function promptPath(cwd: string, phase: RunPhase, taskId: string, runId: string): string {
	return join(agentRoot(cwd), "prompts", phase, taskId, `${runId}.md`);
}

export function tracePath(cwd: string, taskId: string, runId: string): string {
	return join(agentRoot(cwd), "traces", taskId, `${runId}.live.log`);
}

export function ensureRunDirs(...paths: string[]): void {
	for (const p of paths) {
		mkdirSync(join(p, ".."), { recursive: true });
	}
}
