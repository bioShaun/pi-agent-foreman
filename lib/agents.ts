import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	formatFindingsForWorker,
	renderReviewVerdictContract,
	type ReviewContext,
} from "./review-verdict.ts";
import { buildRoleInvocation, type RoleInvocation } from "./role-invoke.ts";
import { cliBinCandidates } from "./cli-resolve.ts";
import { which } from "./run-command.ts";
import type { Reviewer, Worker } from "./types.ts";

export type AgentRole = "planner" | "worker" | "reviewer";

export interface RoleAgent {
	name: string;
	role: AgentRole;
	cli: string;
	/** Executable on PATH; defaults from cli (e.g. antigravity → agy). */
	bin?: string;
	worker?: Worker;
	reviewer?: Reviewer;
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
			reviewer: frontmatter.reviewer as Reviewer | undefined,
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
	if (agent.role === "worker") return `worker:${agent.worker ?? agent.cli}`;
	if (agent.role === "reviewer") return `reviewer:${agent.reviewer ?? agent.cli}`;
	return agent.role;
}

export function getAgent(cwd: string, role: AgentRole, worker?: Worker, reviewer?: Reviewer): RoleAgent {
	const agents = discoverRoleAgents(cwd);
	if (role === "worker") {
		const match =
			agents.find((a) => a.role === "worker" && a.worker === worker) ??
			agents.find((a) => a.role === "worker" && a.cli === worker) ??
			agents.find((a) => a.role === "worker");
		if (!match) throw new Error(`No worker agent for ${worker ?? "default"}. Add agents/worker-*.md`);
		return match;
	}
	if (role === "reviewer") {
		const match =
			(reviewer &&
				agents.find(
					(a) => a.role === "reviewer" && (a.reviewer === reviewer || a.cli === reviewer),
				)) ??
			agents.find((a) => a.role === "reviewer" && (a.reviewer === "codex" || a.cli === "codex")) ??
			agents.find((a) => a.role === "reviewer");
		if (!match) {
			throw new Error(`No reviewer agent for ${reviewer ?? "default"}. Add agents/reviewer*.md`);
		}
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
	review?: ReviewContext,
): string {
	let prompt = `${agent.systemPrompt}\n\n---\n\n## Task\n\n${taskPrompt}`;
	if (review) {
		const block = review.payload
			? formatFindingsForWorker(review.payload)
			: review.rawReview?.trim();
		if (block) {
			const suffix = review.payload ? "" : "\n\nAddress the review feedback and complete the task.";
			prompt += `\n\n---\n\n${block}${suffix}`;
		}
	}
	return prompt;
}

export function buildReviewerPrompt(agent: RoleAgent, taskId: string, title: string): string {
	return `${agent.systemPrompt}\n\n---\n\nTask ${taskId}: ${title}\n\nInspect **uncommitted git changes** in this repository (\`git diff\`, \`git diff --staged\`, and read files as needed). Focus on whether the changes satisfy this task.${renderReviewVerdictContract(taskId)}`;
}

export async function assertRoleAgentAvailable(
	pi: ExtensionAPI,
	cwd: string,
	role: AgentRole,
	worker?: Worker,
	reviewer?: Reviewer,
): Promise<RoleAgent> {
	const agent = getAgent(cwd, role, worker, reviewer);
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
	review?: ReviewContext,
): { agent: RoleAgent; prompt: string; invocation: RoleInvocation } {
	const agent = getAgent(cwd, "worker", worker);
	const prompt = buildWorkerPrompt(agent, taskPrompt, review);
	return { agent, prompt, invocation: buildRoleInvocation(agent, { mode: "prompt", prompt }) };
}

export function reviewerInvocation(
	cwd: string,
	taskId: string,
	title: string,
	reviewer?: Reviewer,
): { agent: RoleAgent; prompt: string; invocation: RoleInvocation } {
	const agent = getAgent(cwd, "reviewer", undefined, reviewer);
	const prompt = buildReviewerPrompt(agent, taskId, title);
	return {
		agent,
		prompt,
		invocation: buildRoleInvocation(agent, { mode: "review", prompt }),
	};
}

export type { RoleInvocation } from "./role-invoke.ts";
