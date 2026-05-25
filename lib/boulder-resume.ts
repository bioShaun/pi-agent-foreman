import { loadBoulder } from "./agent-store.ts";
import type { Worker } from "./types.ts";
import { isWorker } from "./types.ts";

export interface BoulderResumeRequest {
	fromTaskId: string;
	worker: Worker;
	planName: string;
	stoppedReason?: string;
}



export function resolveBoulderResume(
	cwd: string,
): { ok: true; request: BoulderResumeRequest } | { ok: false; message: string } {
	const boulder = loadBoulder(cwd);
	if (!boulder) {
		return { ok: false, message: "No boulder.json. Run /agent plan <goal> then /agent exec --all." };
	}

	if (boulder.project_path !== cwd) {
		return {
			ok: false,
			message: `Boulder belongs to ${boulder.project_path}, not this repo (${cwd}).`,
		};
	}

	const batch = boulder.batch;
	if (!batch || batch.mode !== "exec") {
		return { ok: false, message: "No exec batch recorded. Run /agent exec --all --worker claude." };
	}

	if (!boulder.current_task_id) {
		return { ok: false, message: "Boulder has no current task. Run /agent exec --all --worker claude." };
	}

	const worker = batch.worker.toLowerCase() as Worker;
	if (!isWorker(worker)) {
		return { ok: false, message: `Unknown worker in boulder: ${batch.worker}` };
	}

	return {
		ok: true,
		request: {
			fromTaskId: boulder.current_task_id,
			worker,
			planName: boulder.plan_name,
			stoppedReason: batch.stopped_reason,
		},
	};
}

export function formatBoulderStatus(cwd: string): string {
	const resolved = resolveBoulderResume(cwd);
	if (!resolved.ok) return resolved.message;

	const { request } = resolved;
	const lines = [
		`Plan: ${request.planName}`,
		`Resume from: ${request.fromTaskId}`,
		`Worker: ${request.worker}`,
	];
	if (request.stoppedReason) lines.push(`Last stop: ${request.stoppedReason}`);
	lines.push("", "Run: /agent resume  (or /agent resume --continue-on-error)");
	return lines.join("\n");
}
