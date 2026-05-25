import { existsSync, readFileSync } from "node:fs";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { shortenDisplayPath } from "./format-display.ts";
import { formatElapsed, isLoaderProgressLine } from "./run-display.ts";

export interface ParallelExecStartInfo {
	taskId: string;
	livePath: string;
	label: string;
}

export interface ParallelExecListener {
	onStarted?(info: ParallelExecStartInfo): void;
	onFinished?(taskId: string): void;
}

export interface ParallelBatchMeta {
	planId: string;
	worker: string;
	parallel: number;
	pool: string[];
}

function readLiveProgressTail(livePath: string, maxLines = 4): string[] {
	if (!existsSync(livePath)) return [];
	try {
		return readFileSync(livePath, "utf-8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => {
				if (!line || line.startsWith("# Executing") || line.startsWith("## ")) return false;
				return line.startsWith("↳") || isLoaderProgressLine(line);
			})
			.slice(-maxLines);
	} catch {
		return [];
	}
}

/** Show a multi-task progress panel while parallel exec runs (silent invoke + live log tails). */
export async function withParallelBatchDisplay(
	ctx: ExtensionCommandContext,
	meta: ParallelBatchMeta,
	run: (listener: ParallelExecListener) => Promise<string>,
): Promise<string> {
	if (!ctx.hasUI) {
		return run({});
	}

	return ctx.ui.custom<string>((tui, theme, _kb, done) => {
		const container = new Container();
		const border = new DynamicBorder((s: string) => theme.fg("border", s));
		const headerOutput = new Text("", 1, 0);
		const bodyOutput = new Text("", 1, 0);

		container.addChild(border);
		container.addChild(headerOutput);
		container.addChild(bodyOutput);
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(
				theme.fg("dim", "Parallel exec — live traces update below · full summary when batch completes"),
				1,
				0,
			),
		);
		container.addChild(border);

		const active = new Map<string, ParallelExecStartInfo>();
		let finished = 0;
		const started = Date.now();

		const listener: ParallelExecListener = {
			onStarted: (info) => {
				active.set(info.taskId, info);
				scheduleRefresh();
			},
			onFinished: (taskId) => {
				active.delete(taskId);
				finished += 1;
				scheduleRefresh();
			},
		};

		const redraw = () => {
			container.invalidate();
			tui.requestRender();
		};

		const refresh = () => {
			const elapsed = theme.fg("dim", `  (${formatElapsed(Date.now() - started)})`);
			headerOutput.setText(
				theme.fg("text", theme.bold(`Exec batch ${meta.planId}`)) +
					theme.fg("accent", ` · ${meta.worker}`) +
					theme.fg("dim", ` · parallel ${meta.parallel}`) +
					theme.fg("muted", ` · ${finished}/${meta.pool.length} done`) +
					elapsed,
			);

			const blocks: string[] = [];
			if (active.size === 0) {
				blocks.push(theme.fg("dim", finished === 0 ? "Starting…" : "Waiting for next wave…"));
			}
			for (const info of active.values()) {
				const liveHint = shortenDisplayPath(info.livePath, ctx.cwd);
				blocks.push(theme.fg("accent", theme.bold(info.taskId)) + theme.fg("dim", ` · ${info.label}`));
				blocks.push(theme.fg("dim", `  tail -f ${liveHint}`));
				const tail = readLiveProgressTail(info.livePath);
				if (tail.length === 0) {
					blocks.push(theme.fg("dim", "  …"));
				} else {
					for (const line of tail) {
						if (line.startsWith("$ ")) {
							blocks.push(theme.fg("syntaxPunctuation", "  $ ") + theme.fg("muted", line.slice(2)));
						} else {
							blocks.push(theme.fg("muted", `  ${line}`));
						}
					}
				}
				blocks.push("");
			}
			bodyOutput.setText(blocks.join("\n").trimEnd());
			redraw();
		};

		let refreshCoalescing = false;
		const scheduleRefresh = () => {
			if (refreshCoalescing) return;
			refreshCoalescing = true;
			setImmediate(() => {
				refreshCoalescing = false;
				refresh();
			});
		};

		refresh();
		const timer = setInterval(refresh, 800);

		void run(listener)
			.then((summary) => {
				clearInterval(timer);
				done(summary);
			})
			.catch((err) => {
				clearInterval(timer);
				done(err instanceof Error ? err.message : String(err));
			});

		return {
			render: (width: number) => container.render(width),
			invalidate: redraw,
		};
	});
}
