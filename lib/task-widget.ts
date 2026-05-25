import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadManifest, loadPlan, loadTask, listTasks } from "./agent-store.ts";
import { statusIcon } from "./task-status.ts";
import type { AgentPlan } from "./types.ts";

function isPlanComplete(cwd: string, plan: AgentPlan): boolean {
	if (plan.taskIds.length === 0) return false;
	for (const id of plan.taskIds) {
		const task = loadTask(cwd, id);
		if (!task || task.status !== "review_pass") return false;
	}
	return true;
}

export function isActivePlanComplete(cwd: string): boolean {
	const manifest = loadManifest(cwd);
	if (!manifest.activePlanId) return false;
	const plan = loadPlan(cwd, manifest.activePlanId);
	if (!plan) return false;
	return isPlanComplete(cwd, plan);
}

export function taskWidgetLines(cwd: string): string[] | undefined {
	const manifest = loadManifest(cwd);
	const planId = manifest.activePlanId;

	if (planId) {
		const plan = loadPlan(cwd, planId);
		if (plan && isPlanComplete(cwd, plan)) return undefined;
	}

	const tasks = listTasks(cwd);
	if (tasks.length === 0) return undefined;

	const header = planId ? `📋 ${planId}` : "📋 agent tasks";
	const scoped = planId ? tasks.filter((t) => t.planId === planId) : tasks;
	const lines = scoped.slice(0, 8).map((t) => `${statusIcon(t.status)} ${t.id} ${t.title.slice(0, 40)}`);
	return [header, ...lines];
}

export function refreshTaskWidget(ctx: ExtensionContext): void {
	ctx.ui.setWidget("agent-pipeline", taskWidgetLines(ctx.cwd));
}
