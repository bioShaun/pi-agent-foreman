/**
 * Agent Foreman — Pi extension for multi-CLI orchestration.
 *
 * TUI commands:
 *   /agent plan <goal>
 *   /agent exec T001 [--worker claude|codex|antigravity]
 *   /agent run T001 [--worker claude]
 *   /agent list
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { dispatchAgentCommand } from "./lib/commands.ts";
import { listTasks, loadManifest } from "./lib/state.ts";

const SUBCOMMANDS = ["plan", "run", "exec", "review", "list", "status", "tasks", "help"];

function taskWidgetLines(cwd: string): string[] | undefined {
	const tasks = listTasks(cwd);
	if (tasks.length === 0) return undefined;
	const manifest = loadManifest(cwd);
	const header = manifest.activePlanId ? `📋 ${manifest.activePlanId}` : "📋 agent tasks";
	const lines = tasks.slice(0, 8).map((t) => {
		const icon =
			t.status === "review_pass"
				? "✓"
				: t.status === "review_fail"
					? "✗"
					: t.status === "running"
						? "◐"
						: t.status === "done"
							? "●"
							: "○";
		return `${icon} ${t.id} ${t.title.slice(0, 40)}`;
	});
	return [header, ...lines];
}

export default function agentForemanExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setWidget("agent-foreman", taskWidgetLines(ctx.cwd));
	});

	pi.registerCommand("agent", {
		description: "Agent foreman: plan (Codex), exec (worker), review (Codex)",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1 && !prefix.includes(" ")) {
				const filtered = SUBCOMMANDS.filter((s) => s.startsWith(prefix.toLowerCase()));
				return filtered.map((s) => ({ value: s, label: s }));
			}
			const sub = parts[0]?.toLowerCase();
			if ((sub === "exec" || sub === "review" || sub === "run") && parts.length === 2) {
				// Task IDs — we can't access cwd here easily; offer pattern
				return [{ value: "T001", label: "T001" }];
			}
			if (sub === "exec" && parts.length >= 2 && prefix.endsWith(" --worker ")) {
				return ["claude", "codex", "antigravity"].map((w) => ({ value: w, label: w }));
			}
			return null;
		},
		handler: async (args, ctx) => {
			try {
				const summary = await dispatchAgentCommand(pi, ctx, args);

				pi.sendMessage(
					{
						customType: "agent-foreman-result",
						content: summary,
						display: true,
					},
					{ triggerTurn: false },
				);

				ctx.ui.setWidget("agent-foreman", taskWidgetLines(ctx.cwd));
				ctx.ui.notify(summary.split("\n")[0] ?? "Done", "info");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(message, "error");
			}
		},
	});

	pi.registerMessageRenderer("agent-foreman-result", (message, _opts, theme) => {
		const text = typeof message.content === "string" ? message.content : String(message.content);
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(theme.fg("accent", "agent ") + text, 0, 0));
		return box;
	});
}
