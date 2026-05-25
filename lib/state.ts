import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentManifest, AgentPlan, AgentTask, ParsedPlan, TaskStatus } from "./types.ts";

export const AGENT_DIR = ".agent";

export function agentRoot(cwd: string): string {
	return join(cwd, AGENT_DIR);
}

function ensureAgentDirs(cwd: string): void {
	const root = agentRoot(cwd);
	mkdirSync(join(root, "plans"), { recursive: true });
	mkdirSync(join(root, "tasks"), { recursive: true });
}

export function loadManifest(cwd: string): AgentManifest {
	ensureAgentDirs(cwd);
	const path = join(agentRoot(cwd), "manifest.json");
	if (!existsSync(path)) {
		const manifest: AgentManifest = {
			planCounter: 0,
			taskCounter: 0,
			activePlanId: null,
			updatedAt: new Date().toISOString(),
		};
		writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
		return manifest;
	}
	return JSON.parse(readFileSync(path, "utf-8")) as AgentManifest;
}

function saveManifest(cwd: string, manifest: AgentManifest): void {
	manifest.updatedAt = new Date().toISOString();
	writeFileSync(join(agentRoot(cwd), "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

export function loadPlan(cwd: string, planId: string): AgentPlan | null {
	const path = join(agentRoot(cwd), "plans", `${planId}.json`);
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf-8")) as AgentPlan;
}

export function loadTask(cwd: string, taskId: string): AgentTask | null {
	const path = join(agentRoot(cwd), "tasks", `${taskId}.json`);
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf-8")) as AgentTask;
}

export function saveTask(cwd: string, task: AgentTask): void {
	ensureAgentDirs(cwd);
	writeFileSync(join(agentRoot(cwd), "tasks", `${task.id}.json`), `${JSON.stringify(task, null, 2)}\n`, "utf-8");
}

export function listTasks(cwd: string): AgentTask[] {
	ensureAgentDirs(cwd);
	const dir = join(agentRoot(cwd), "tasks");
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as AgentTask)
		.sort((a, b) => a.id.localeCompare(b.id));
}

export function nextPlanId(cwd: string): string {
	const manifest = loadManifest(cwd);
	manifest.planCounter += 1;
	const id = `PLAN-${String(manifest.planCounter).padStart(3, "0")}`;
	saveManifest(cwd, manifest);
	return id;
}

export function nextTaskId(cwd: string): string {
	const manifest = loadManifest(cwd);
	manifest.taskCounter += 1;
	const id = `T${String(manifest.taskCounter).padStart(3, "0")}`;
	saveManifest(cwd, manifest);
	return id;
}

export function setActivePlan(cwd: string, planId: string): void {
	const manifest = loadManifest(cwd);
	manifest.activePlanId = planId;
	saveManifest(cwd, manifest);
}

export function createPlanFromParsed(cwd: string, goal: string, raw: string, parsed: ParsedPlan): AgentPlan {
	ensureAgentDirs(cwd);
	const planId = nextPlanId(cwd);
	const taskIds: string[] = [];

	const tasks =
		parsed.tasks.length > 0
			? parsed.tasks
			: [{ title: goal, prompt: `Implement the following goal:\n\n${goal}\n\nUse the plan below:\n\n${raw}` }];

	for (const item of tasks) {
		const taskId = item.id?.match(/^T\d+$/i) ? item.id.toUpperCase() : nextTaskId(cwd);
		const task: AgentTask = {
			id: taskId,
			planId,
			title: item.title,
			status: "pending",
			prompt: item.prompt,
			artifacts: {},
			timestamps: { created: new Date().toISOString() },
		};
		saveTask(cwd, task);
		taskIds.push(taskId);
	}

	const plan: AgentPlan = {
		id: planId,
		goal,
		raw,
		taskIds,
		createdAt: new Date().toISOString(),
	};
	writeFileSync(join(agentRoot(cwd), "plans", `${planId}.json`), `${JSON.stringify(plan, null, 2)}\n`, "utf-8");
	writeFileSync(join(agentRoot(cwd), "plans", `${planId}.md`), raw, "utf-8");
	setActivePlan(cwd, planId);
	return plan;
}

export function updateTaskStatus(cwd: string, taskId: string, status: TaskStatus, patch?: Partial<AgentTask>): AgentTask {
	const task = loadTask(cwd, taskId);
	if (!task) throw new Error(`Task not found: ${taskId}`);
	const updated: AgentTask = { ...task, ...patch, status };
	saveTask(cwd, updated);
	return updated;
}

export function formatTaskList(tasks: AgentTask[]): string {
	if (tasks.length === 0) return "No tasks. Run /agent plan <goal> first.";
	const icon: Record<TaskStatus, string> = {
		pending: "○",
		running: "◐",
		done: "●",
		review_pass: "✓",
		review_fail: "✗",
	};
	return tasks
		.map((t) => `${icon[t.status]} ${t.id} [${t.status}] ${t.title}${t.worker ? ` (${t.worker})` : ""}`)
		.join("\n");
}
