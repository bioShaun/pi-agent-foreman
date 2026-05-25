import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildRoleInvocation, type RoleInvocation } from "./role-invoke.ts";
import { cliBinCandidates } from "./cli-resolve.ts";
import { which } from "./run-command.ts";
import type { Worker } from "./types.ts";

export type AgentRole = "planner" | "worker" | "reviewer";

export interface RoleAgent {
	name: string;
	role: AgentRole;
	cli: string;
	/** Executable on PATH; defaults from cli (e.g. antigravity → agy). */
	bin?: string;
	worker?: Worker;
	description: string;
	systemPrompt: string;
	source: "package" | "project";
	filePath: string;
}

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));

function loadAgentsFromDir(dir: string, source: "package" | "project"): RoleAgent[] {
	if (!existsSync(dir)) return [];

	const agents: RoleAgent[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const filePath = join(dir, entry.name);
		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.role || !frontmatter.cli) continue;

		const role = frontmatter.role as AgentRole;
		if (!["planner", "worker", "reviewer"].includes(role)) continue;

		agents.push({
			name: frontmatter.name ?? entry.name.replace(/\.md$/, ""),
			role,
			cli: frontmatter.cli,
			bin: frontmatter.bin,
			worker: frontmatter.worker as Worker | undefined,
			description: frontmatter.description ?? "",
			systemPrompt: body.trim(),
			source,
			filePath,
		});
	}
	return agents;
}

export function discoverRoleAgents(cwd: string): RoleAgent[] {
	const projectDir = join(cwd, ".pi", "agents");
	const packageDir = join(PACKAGE_ROOT, "..", "agents");

	const project = loadAgentsFromDir(projectDir, "project");
	const pkg = loadAgentsFromDir(packageDir, "package");

	// project overrides package by role (+ worker for worker role)
	const byKey = new Map<string, RoleAgent>();
	for (const agent of pkg) {
		byKey.set(agentKey(agent), agent);
	}
	for (const agent of project) {
		byKey.set(agentKey(agent), agent);
	}
	return [...byKey.values()];
}

function agentKey(agent: RoleAgent): string {
	return agent.role === "worker" ? `worker:${agent.worker ?? agent.cli}` : agent.role;
}

export function getAgent(cwd: string, role: AgentRole, worker?: Worker): RoleAgent {
	const agents = discoverRoleAgents(cwd);
	if (role === "worker") {
		const match =
			agents.find((a) => a.role === "worker" && a.worker === worker) ??
			agents.find((a) => a.role === "worker" && a.cli === worker) ??
			agents.find((a) => a.role === "worker");
		if (!match) throw new Error(`No worker agent for ${worker ?? "default"}. Add agents/worker-*.md`);
		return match;
	}
	const match = agents.find((a) => a.role === role);
	if (!match) throw new Error(`No ${role} agent. Add agents/${role}.md or .pi/agents/`);
	return match;
}

export function buildPlannerPrompt(agent: RoleAgent, goal: string): string {
	return `${agent.systemPrompt}\n\n---\n\nGoal: ${goal}`;
}

export function buildWorkerPrompt(
	agent: RoleAgent,
	taskPrompt: string,
	reviewFeedback?: string,
): string {
	let prompt = `${agent.systemPrompt}\n\n---\n\n## Task\n\n${taskPrompt}`;
	if (reviewFeedback?.trim()) {
		prompt += `\n\n---\n\n## Previous review feedback\n\n${reviewFeedback.trim()}\n\nAddress the feedback and complete the task.`;
	}
	return prompt;
}

export function buildReviewerPrompt(agent: RoleAgent, taskId: string, title: string): string {
	return `${agent.systemPrompt}\n\n---\n\nTask ${taskId}: ${title}`;
}

export function readReviewFeedback(reviewPath: string | undefined): string | undefined {
	if (!reviewPath || !existsSync(reviewPath)) return undefined;
	try {
		return readFileSync(reviewPath, "utf-8");
	} catch {
		return undefined;
	}
}

export async function assertRoleAgentAvailable(
	pi: ExtensionAPI,
	cwd: string,
	role: AgentRole,
	worker?: Worker,
): Promise<RoleAgent> {
	const agent = getAgent(cwd, role, worker);
	const candidates = cliBinCandidates(agent.cli, agent.bin);
	for (const bin of candidates) {
		if (await which(pi, cwd, bin)) return agent;
	}
	throw new Error(
		`${candidates.join(" or ")} CLI not found in PATH (${agent.name}, ${agent.source}). Install Antigravity CLI (agy) or override .pi/agents/`,
	);
}

export function plannerInvocation(cwd: string, goal: string): { agent: RoleAgent; invocation: RoleInvocation } {
	const agent = getAgent(cwd, "planner");
	const prompt = buildPlannerPrompt(agent, goal);
	return { agent, invocation: buildRoleInvocation(agent, { mode: "prompt", prompt }) };
}

export function workerInvocation(
	cwd: string,
	worker: Worker,
	taskPrompt: string,
	reviewFeedback?: string,
): { agent: RoleAgent; invocation: RoleInvocation } {
	const agent = getAgent(cwd, "worker", worker);
	const prompt = buildWorkerPrompt(agent, taskPrompt, reviewFeedback);
	return { agent, invocation: buildRoleInvocation(agent, { mode: "prompt", prompt }) };
}

export function reviewerInvocation(
	cwd: string,
	taskId: string,
	title: string,
): { agent: RoleAgent; invocation: RoleInvocation } {
	const agent = getAgent(cwd, "reviewer");
	const criteria = buildReviewerPrompt(agent, taskId, title).replace(/\s+/g, " ").slice(0, 400);
	const reviewTitle = `${taskId}: ${title} — ${criteria}`;
	return {
		agent,
		invocation: buildRoleInvocation(agent, { mode: "review-title", title: reviewTitle }),
	};
}

export type { RoleInvocation } from "./role-invoke.ts";
