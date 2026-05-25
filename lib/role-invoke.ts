import type { RoleAgent } from "./agents.ts";
import { cliBinCandidates, defaultCliBin, isAntigravityCli } from "./cli-resolve.ts";

export interface RoleInvocation {
	command: string;
	args: string[];
	stdin?: string;
	jsonStream?: "claude" | "codex";
	/** Tail ~/.gemini/antigravity-cli logs for tool progress (agy -p buffers stdout). */
	antigravityProgress?: boolean;
}

export type RoleInvokeInput =
	| { mode: "prompt"; prompt: string }
	| { mode: "review-title"; title: string };

export function buildRoleInvocation(agent: RoleAgent, input: RoleInvokeInput): RoleInvocation {
	const command = defaultCliBin(agent.cli, agent.bin);

	if (input.mode === "review-title") {
		if (agent.role !== "reviewer") {
			throw new Error(`Review invocation requires reviewer role, got ${agent.role} (${agent.name})`);
		}
		return {
			command,
			args: ["exec", "review", "--json", "--uncommitted", "--title", input.title],
			jsonStream: "codex",
		};
	}

	const { prompt } = input;

	if (agent.cli === "claude") {
		return {
			command,
			args: [
				"-p",
				prompt,
				"--dangerously-skip-permissions",
				"--output-format",
				"stream-json",
				"--include-partial-messages",
				"--no-session-persistence",
				"--verbose",
			],
			jsonStream: "claude",
		};
	}

	if (agent.cli === "codex") {
		return {
			command,
			args: ["exec", "--json", "-"],
			stdin: prompt,
			jsonStream: "codex",
		};
	}

	if (isAntigravityCli(agent.cli)) {
		return {
			command,
			args: ["-p", prompt, "--dangerously-skip-permissions", "--print-timeout=60m"],
			antigravityProgress: true,
		};
	}

	throw new Error(
		`Unknown CLI "${agent.cli}" for ${agent.role} agent (${agent.name}). Supported: claude, codex, antigravity`,
	);
}
