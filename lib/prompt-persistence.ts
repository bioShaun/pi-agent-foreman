import { writeFileSync } from "node:fs";
import { ensureRunDirs, promptPath } from "./agent-paths.ts";
import type { RunPhase } from "./types.ts";

function yamlQuote(value: string): string {
	return JSON.stringify(value);
}

export interface PromptSnapshotMeta {
	task_id: string;
	phase: RunPhase;
	run_id: string;
	cli: string;
	worker?: string;
	reviewer?: string;
}

export function writePromptSnapshot(
	cwd: string,
	meta: PromptSnapshotMeta,
	prompt: string,
): string {
	const path = promptPath(cwd, meta.phase, meta.task_id, meta.run_id);
	ensureRunDirs(path);

	const frontmatter = [
		"---",
		`task_id: ${yamlQuote(meta.task_id)}`,
		`phase: ${yamlQuote(meta.phase)}`,
		`run_id: ${yamlQuote(meta.run_id)}`,
		`cli: ${yamlQuote(meta.cli)}`,
		meta.worker ? `worker: ${yamlQuote(meta.worker)}` : null,
		meta.reviewer ? `reviewer: ${yamlQuote(meta.reviewer)}` : null,
		"---",
		"",
	].filter(Boolean);

	writeFileSync(path, `${frontmatter.join("\n")}${prompt}`, "utf-8");
	return path;
}
