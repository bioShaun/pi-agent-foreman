import type { RoleAgent } from "./agents.ts";
import { defaultCliBin, isAntigravityCli } from "./cli-resolve.ts";

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
	| { mode: "review"; prompt: string };

function claudeStreamInvocation(command: string, prompt: string): RoleInvocation {
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

function codexStreamInvocation(command: string, prompt: string): RoleInvocation {
	return {
		command,
		args: ["exec", "--json", "-"],
		stdin: prompt,
		jsonStream: "codex",
	};
}

export function buildRoleInvocation(agent: RoleAgent, input: RoleInvokeInput): RoleInvocation {
	const command = defaultCliBin(agent.cli, agent.bin);
	const prompt = input.prompt;

	if (input.mode === "review" && agent.role !== "reviewer") {
		throw new Error(`Review invocation requires reviewer role, got ${agent.role} (${agent.name})`);
	}

	if (agent.cli === "claude") {
		return claudeStreamInvocation(command, prompt);
	}

	if (agent.cli === "codex") {
		return codexStreamInvocation(command, prompt);
	}

	if (isAntigravityCli(agent.cli)) {
		if (input.mode === "review") {
			throw new Error(
				`Review not supported for CLI "${agent.cli}" (${agent.name}). Supported reviewers: claude, codex`,
			);
		}
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
