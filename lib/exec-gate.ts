import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendLiveLog } from "./live-log.ts";
import { which } from "./run-command.ts";

export interface ExecGateResult {
	passed: boolean;
	/** Gate not applicable (no ruff, no changed .py, or disabled). */
	skipped: boolean;
	files: string[];
	output?: string;
	skipReason?: string;
	/** Set when `ruff check --fix` completed with exit 0. */
	applied?: boolean;
}

function gateDisabled(): boolean {
	return process.env.PIPELINE_SKIP_EXEC_GATE === "1" || process.env.PIPELINE_SKIP_EXEC_GATE === "true";
}

function isGatePythonPath(path: string): boolean {
	if (!path.endsWith(".py")) return false;
	if (path.startsWith(".agent/") || path.includes("/.agent/")) return false;
	return true;
}

async function gitLines(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string[]> {
	const result = await pi.exec("git", args, { cwd, timeout: 15_000 });
	if (result.code !== 0) return [];
	return result.stdout
		.trim()
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

/** Python files in the working tree that review would inspect (staged + unstaged + untracked). */
export async function listExecGatePythonFiles(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const [unstaged, staged, untracked] = await Promise.all([
		gitLines(pi, cwd, ["diff", "--name-only", "HEAD"]),
		gitLines(pi, cwd, ["diff", "--cached", "--name-only"]),
		gitLines(pi, cwd, ["ls-files", "--others", "--exclude-standard"]),
	]);
	const paths = new Set<string>();
	for (const line of [...unstaged, ...staged, ...untracked]) {
		if (isGatePythonPath(line)) paths.add(line);
	}
	return [...paths].sort();
}

interface RuffInvocation {
	command: string;
	argsPrefix: string[];
}

async function resolveRuffInvocation(pi: ExtensionAPI, cwd: string): Promise<RuffInvocation | null> {
	const venvRuff = join(cwd, ".venv/bin/ruff");
	if (existsSync(venvRuff)) {
		return { command: venvRuff, argsPrefix: [] };
	}
	if (await which(pi, cwd, "uv")) {
		return { command: "uv", argsPrefix: ["run", "ruff"] };
	}
	if (await which(pi, cwd, "ruff")) {
		return { command: "ruff", argsPrefix: [] };
	}
	return null;
}

function formatGateFailure(files: string[], output: string, fixPrefix: string): string {
	const fileList = files.length <= 6 ? files.join(" ") : `${files.slice(0, 5).join(" ")} … (+${files.length - 5} more)`;
	return [
		"Pre-review gate failed: Ruff reported issues on changed Python files.",
		"This matches what the reviewer checks — fix before review to avoid wasted review runs.",
		"",
		output.trim() || "(no ruff output)",
		"",
		`Fix: ${fixPrefix} check ${fileList} --fix`,
		"Skip gate (not recommended): PIPELINE_SKIP_EXEC_GATE=1",
	].join("\n");
}

function ruffFixPrefix(ruff: RuffInvocation): string {
	return ruff.command === "uv" ? "uv run ruff" : ruff.command.includes(".venv") ? ".venv/bin/ruff" : "ruff";
}

async function runRuffOnChangedPy(
	pi: ExtensionAPI,
	cwd: string,
	opts?: { fix?: boolean; liveLogPath?: string },
): Promise<ExecGateResult> {
	if (gateDisabled()) {
		return { passed: true, skipped: true, files: [], skipReason: "PIPELINE_SKIP_EXEC_GATE" };
	}

	const files = await listExecGatePythonFiles(pi, cwd);
	if (files.length === 0) {
		return { passed: true, skipped: true, files: [], skipReason: "no changed Python files" };
	}

	const ruff = await resolveRuffInvocation(pi, cwd);
	if (!ruff) {
		return { passed: true, skipped: true, files, skipReason: "ruff not found" };
	}

	const fix = opts?.fix ?? false;
	const args = [...ruff.argsPrefix, "check", ...(fix ? ["--fix"] : []), ...files];
	const label = fix ? "lint auto-fix" : "pre-review gate";
	appendLiveLog(opts?.liveLogPath, "progress", `$ ${[ruff.command, ...args].join(" ")}  (${label})`);

	const result = await pi.exec(ruff.command, args, { cwd, timeout: 120_000 });
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

	if (result.code === 0) {
		const progress = fix ? "✓ lint auto-fix finished" : "✓ pre-review gate passed";
		appendLiveLog(opts?.liveLogPath, "progress", progress);
		return {
			passed: true,
			skipped: false,
			files,
			output: output.trim() || undefined,
			applied: fix ? true : undefined,
		};
	}

	if (fix) {
		appendLiveLog(opts?.liveLogPath, "progress", "✗ lint auto-fix reported issues");
		return { passed: false, skipped: false, files, output: output.trim() || undefined, applied: false };
	}

	return {
		passed: false,
		skipped: false,
		files,
		output: formatGateFailure(files, output, ruffFixPrefix(ruff)),
	};
}

export async function runExecGate(
	pi: ExtensionAPI,
	cwd: string,
	opts?: { liveLogPath?: string },
): Promise<ExecGateResult> {
	return runRuffOnChangedPy(pi, cwd, opts);
}

export type RuffAutoFixResult = ExecGateResult;

export async function runRuffAutoFix(
	pi: ExtensionAPI,
	cwd: string,
	opts?: { liveLogPath?: string },
): Promise<ExecGateResult> {
	return runRuffOnChangedPy(pi, cwd, { ...opts, fix: true });
}
