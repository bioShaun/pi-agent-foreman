import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadManifest, listTasks } from "./agent-store.ts";
import { statusIcon } from "./task-status.ts";

export function taskWidgetLines(cwd: string): string[] | undefined {
	const tasks = listTasks(cwd);
	if (tasks.length === 0) return undefined;
	const manifest = loadManifest(cwd);
	const header = manifest.activePlanId ? `📋 ${manifest.activePlanId}` : "📋 agent tasks";
	const lines = tasks.slice(0, 8).map((t) => `${statusIcon(t.status)} ${t.id} ${t.title.slice(0, 40)}`);
	return [header, ...lines];
}

export function refreshTaskWidget(ctx: ExtensionCommandContext): void {
	ctx.ui.setWidget("agent-foreman", taskWidgetLines(ctx.cwd));
}
