import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type LiveLogSection = "progress" | "output";

const MARKERS: Record<LiveLogSection, string> = {
	progress: "## Progress",
	output: "## Output",
};

export function initLiveLog(path: string, header: string): void {
	mkdirSync(dirname(path), { recursive: true });
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
