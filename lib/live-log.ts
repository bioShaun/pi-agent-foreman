import { appendFileSync, writeFileSync } from "node:fs";
import { ensureRunDirs } from "./agent-paths.ts";

export type LiveLogSection = "progress" | "output";

const MARKERS: Record<LiveLogSection, string> = {
	progress: "## Progress",
	output: "## Output",
};

export function initLiveLog(path: string, header: string): void {
	ensureRunDirs(path);
	writeFileSync(path, `# ${header}\n\n${MARKERS.progress}\n`, "utf-8");
}

export function appendLiveLog(path: string | undefined, section: LiveLogSection, line: string): void {
	if (!path || !line.trim()) return;
	try {
		appendFileSync(path, `${line.trim()}\n`, "utf-8");
	} catch {
		// ignore
	}
}

/** Move from progress section to output section (once stdout prose begins). */
export function ensureLiveOutputSection(path: string | undefined): void {
	if (!path) return;
	try {
		appendFileSync(path, `\n${MARKERS.output}\n`, "utf-8");
	} catch {
		// ignore
	}
}
