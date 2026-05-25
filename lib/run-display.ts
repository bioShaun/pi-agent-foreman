const MAX_RECENT = 80;
const TAIL_LINES = 12;

function tail(text: string, lines: number): string {
	const parts = text.trim().split("\n");
	return parts.slice(-lines).join("\n");
}

export function tailLines(text: string, lines = 8): string {
	return tail(text, lines);
}

export function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function buildLoaderBody(recentLines: string[], fallback: string): string {
	return recentLines.length > 0 ? tail(recentLines.join("\n"), TAIL_LINES) : fallback;
}

export interface LoaderOptions {
	jsonStream?: "claude" | "codex";
	antigravityProgress?: boolean;
}

export function usesStructuredProgress(options?: LoaderOptions): boolean {
	return Boolean(options?.jsonStream || options?.antigravityProgress);
}

export function loaderFallback(options?: LoaderOptions): string {
	if (options?.jsonStream === "claude") return "Starting Claude…";
	if (options?.jsonStream === "codex") return "Starting Codex…";
	if (options?.antigravityProgress) return "Starting Antigravity…";
	return "Waiting for output…";
}

/** Lines suitable for the exec loader (tool progress, not model prose). */
export function isLoaderProgressLine(line: string): boolean {
	const t = line.trim();
	if (!t) return false;
	if (t.startsWith("$ ")) return true;
	if (/^(Starting (Claude|Codex|Antigravity)|Authenticated with Antigravity|Working…)/.test(t)) return true;
	if (/^[⚠✗]/.test(t)) return true;
	return false;
}

export function pushDisplayLine(recentLines: string[], line: string): void {
	const trimmed = line.trim();
	if (!trimmed) return;

	const last = recentLines[recentLines.length - 1];
	if (last === "$ running command…" && trimmed.startsWith("$ ")) {
		recentLines[recentLines.length - 1] = trimmed;
		return;
	}
	if (last === trimmed) return;

	if (trimmed.startsWith("$ ") && last?.startsWith("$ ")) {
		const lastCmd = last.replace(/ \(failed\)$/, "");
		const nextCmd = trimmed.replace(/ \(failed\)$/, "");
		if (nextCmd.startsWith(lastCmd) || lastCmd.startsWith(nextCmd)) {
			recentLines[recentLines.length - 1] = trimmed;
			return;
		}
	}

	recentLines.push(trimmed);
	if (recentLines.length > MAX_RECENT) recentLines.shift();
}
