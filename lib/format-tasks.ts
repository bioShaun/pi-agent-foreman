import { loadTask } from "./agent-store.ts";
import { statusLabel } from "./task-status.ts";
import type { AgentTask } from "./types.ts";

export function formatTaskList(tasks: AgentTask[]): string {
	if (tasks.length === 0) return "No tasks. Run /agent plan <goal> first.";
	return tasks.map((t) => statusLabel(t)).join("\n");
}

export function formatTaskLogs(cwd: string, taskId: string): string {
	const task = loadTask(cwd, taskId);
	if (!task) throw new Error(`Task not found: ${taskId}`);

	const lines: string[] = [`Run history for ${taskId}:`];
	if (task.artifacts.log) lines.push(`Latest exec: ${task.artifacts.log}`);
	if (task.artifacts.execPrompt) lines.push(`Latest exec prompt: ${task.artifacts.execPrompt}`);
	if (task.artifacts.review) lines.push(`Latest review: ${task.artifacts.review}`);
	if (task.artifacts.reviewVerdict) lines.push(`Latest verdict: ${task.artifacts.reviewVerdict}`);
	if (task.artifacts.reviewPrompt) lines.push(`Latest review prompt: ${task.artifacts.reviewPrompt}`);
	if (task.artifacts.liveTrace) lines.push(`Latest trace: ${task.artifacts.liveTrace}`);

	const runs = task.runs ?? [];
	if (runs.length === 0) {
		lines.push("", "(no runs[] entries yet)");
		return lines.join("\n");
	}

	lines.push("");
	for (const r of runs) {
		const end = r.endedAt ? ` ended ${r.endedAt}` : "";
		const code = r.exitCode !== undefined ? ` exit=${r.exitCode}` : "";
		lines.push(`- ${r.runId} [${r.phase}]${r.worker ? ` ${r.worker}` : ""}${code}${end}`);
		if (r.paths.output) lines.push(`  output: ${r.paths.output}`);
		if (r.paths.prompt) lines.push(`  prompt: ${r.paths.prompt}`);
		if (r.paths.live) lines.push(`  live:   ${r.paths.live}`);
	}
	return lines.join("\n");
}
