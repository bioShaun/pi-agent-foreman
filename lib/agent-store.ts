import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR, agentRoot } from "./agent-paths.ts";
import type {
	AgentBoulder,
	AgentManifest,
	AgentPlan,
	AgentTask,
	ParsedPlan,
	TaskRun,
	TaskStatus,
} from "./types.ts";

function ensureAgentDirs(cwd: string): void {
	const root = agentRoot(cwd);
	mkdirSync(join(root, "plans"), { recursive: true });
	mkdirSync(join(root, "tasks"), { recursive: true });
	mkdirSync(join(root, "artifacts"), { recursive: true });
	mkdirSync(join(root, "prompts"), { recursive: true });
	mkdirSync(join(root, "traces"), { recursive: true });
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

export function loadBoulder(cwd: string): AgentBoulder | null {
	const path = join(agentRoot(cwd), "boulder.json");
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf-8")) as AgentBoulder;
}

export function saveBoulder(cwd: string, boulder: AgentBoulder): void {
	ensureAgentDirs(cwd);
	writeFileSync(join(agentRoot(cwd), "boulder.json"), `${JSON.stringify(boulder, null, 2)}\n`, "utf-8");
}

export function initBoulderFromPlan(cwd: string, plan: AgentPlan): void {
	saveBoulder(cwd, {
		active_plan: join(AGENT_DIR, "plans", `${plan.id}.json`),
		plan_name: plan.goal.slice(0, 120),
		started_at: new Date().toISOString(),
		project_path: cwd,
	});
}

export function updateBoulderProgress(cwd: string, patch: Partial<AgentBoulder>): void {
	const existing = loadBoulder(cwd);
	if (!existing) return;
	saveBoulder(cwd, { ...existing, ...patch });
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
			runs: [],
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
	initBoulderFromPlan(cwd, plan);
	return plan;
}

export function updateTaskStatus(
	cwd: string,
	taskId: string,
	status: TaskStatus,
	patch?: Partial<AgentTask> & { run?: TaskRun },
): AgentTask {
	const task = loadTask(cwd, taskId);
	if (!task) throw new Error(`Task not found: ${taskId}`);
	const { run, artifacts, timestamps, ...rest } = patch ?? {};
	const runs = run ? [...(task.runs ?? []), run] : task.runs;
	const updated: AgentTask = {
		...task,
		...rest,
		status,
		runs,
		artifacts: artifacts ? { ...task.artifacts, ...artifacts } : task.artifacts,
		timestamps: timestamps ? { ...task.timestamps, ...timestamps } : task.timestamps,
	};
	saveTask(cwd, updated);
	return updated;
}
