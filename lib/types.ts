export type TaskStatus = "pending" | "running" | "done" | "review_pass" | "review_fail";

export const REVIEWERS = ["claude", "codex"] as const;

export type Reviewer = (typeof REVIEWERS)[number];

export function isReviewer(value: string): value is Reviewer {
	return (REVIEWERS as readonly string[]).includes(value);
}

export const WORKERS = ["claude", "codex", "antigravity"] as const;

export type Worker = (typeof WORKERS)[number];

export function isWorker(value: string): value is Worker {
	return (WORKERS as readonly string[]).includes(value);
}

export type ReviewVerdictKind = "approve" | "revise" | "reject";

export type ReviewFindingSeverity = "critical" | "major" | "minor" | "nit";

export interface ReviewFinding {
	severity: ReviewFindingSeverity;
	message: string;
	file?: string;
	line?: number;
}

export interface ReviewVerdictPayload {
	task_id: string;
	review_run_id: string;
	verdict: ReviewVerdictKind;
	summary: string;
	findings: ReviewFinding[];
}

export type RunPhase = "exec" | "review" | "plan";

export interface TaskRun {
	runId: string;
	phase: RunPhase;
	worker?: Worker | "codex" | "claude";
	startedAt: string;
	endedAt?: string;
	exitCode?: number;
	paths: {
		output?: string;
		live?: string;
		prompt?: string;
	};
}

export interface AgentBoulder {
	active_plan: string;
	plan_name: string;
	started_at: string;
	project_path: string;
	current_task_id?: string;
	batch?: {
		mode: "exec";
		worker: string;
		started_at: string;
		stopped_at?: string;
		stopped_reason?: string;
	};
}

export interface AgentManifest {
	planCounter: number;
	taskCounter: number;
	activePlanId: string | null;
	updatedAt: string;
}

export interface AgentPlan {
	id: string;
	goal: string;
	raw: string;
	taskIds: string[];
	createdAt: string;
}

export interface AgentTask {
	id: string;
	planId: string;
	title: string;
	status: TaskStatus;
	/** Upstream task IDs that must finish exec before this task runs. */
	depends_on?: string[];
	worker?: Worker;
	prompt: string;
	artifacts: {
		log?: string;
		review?: string;
		reviewVerdict?: string;
		execPrompt?: string;
		reviewPrompt?: string;
		branch?: string;
		liveTrace?: string;
	};
	runs?: TaskRun[];
	timestamps: {
		created: string;
		executed?: string;
		reviewed?: string;
	};
}

export interface ParsedPlan {
	goal: string;
	tasks: Array<{ id?: string; title: string; prompt: string; depends_on?: string[] }>;
}
