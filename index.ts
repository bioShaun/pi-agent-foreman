/**
 * Agent Foreman — Pi extension for multi-CLI orchestration.
 *
 * TUI: /agent plan | exec | run | review [--fix] | mark_pass | clear | resume | list | logs
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { dispatchAgentCommand } from "./lib/commands.ts";
import { refreshTaskWidget } from "./lib/task-widget.ts";

const SUBCOMMANDS = [
	"plan",
	"run",
	"exec",
	"review",
	"mark_pass",
	"clear",
	"resume",
	"list",
	"logs",
	"status",
	"tasks",
	"help",
];

function agentNotifySummary(summary: string): string {
	const batchStopped = summary.match(/Batch stopped at T\d+[^\n]*/);
	if (batchStopped) return batchStopped[0]!;
	const resumeHeader = summary.match(/## Resume —[^\n]*/);
	if (resumeHeader) return "Resuming exec batch…";
	const batchComplete = summary.match(/Batch complete: [^\n]+/);
	if (batchComplete) return batchComplete[0]!;
	const line = summary.split("\n").find((l) => l.trim() && !l.startsWith("#"));
	return line?.trim() ?? "Done";
}

export default function agentForemanExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		refreshTaskWidget(ctx);
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
			if ((sub === "exec" || sub === "review" || sub === "run" || sub === "logs") && parts.length === 2) {
				// Task IDs — we can't access cwd here easily; offer pattern
				return [{ value: "T001", label: "T001" }];
			}
			if (sub === "exec" && parts.length >= 2 && prefix.endsWith(" --worker ")) {
				return ["claude", "codex", "antigravity"].map((w) => ({ value: w, label: w }));
			}
			if (sub === "exec" && parts.length === 1 && !prefix.includes(" ")) {
				return [
					{ value: "--all", label: "exec all runnable tasks in active plan" },
					{ value: "T001", label: "T001" },
				];
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

				refreshTaskWidget(ctx);
				ctx.ui.notify(agentNotifySummary(summary), "info");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				pi.sendMessage(
					{
						customType: "agent-foreman-result",
						content: message,
						display: true,
					},
					{ triggerTurn: false },
				);
				refreshTaskWidget(ctx);
				ctx.ui.notify(message.split("\n")[0] ?? message, "error");
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
