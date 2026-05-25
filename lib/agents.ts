import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Worker } from "./types.ts";

export type AgentRole = "planner" | "worker" | "reviewer";

export interface RoleAgent {
	name: string;
	role: AgentRole;
	cli: string;
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

export function buildPlannerPrompt(cwd: string, goal: string): string {
	const agent = getAgent(cwd, "planner");
	return `${agent.systemPrompt}\n\n---\n\nGoal: ${goal}`;
}

export function buildWorkerPrompt(cwd: string, worker: Worker, taskPrompt: string, reviewFeedback?: string): string {
	const agent = getAgent(cwd, "worker", worker);
	let prompt = `${agent.systemPrompt}\n\n---\n\n## Task\n\n${taskPrompt}`;
	if (reviewFeedback?.trim()) {
		prompt += `\n\n---\n\n## Previous review feedback\n\n${reviewFeedback.trim()}\n\nAddress the feedback and complete the task.`;
	}
	return prompt;
}

export function buildReviewerPrompt(cwd: string, taskId: string, title: string): string {
	const agent = getAgent(cwd, "reviewer");
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
