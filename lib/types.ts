export type TaskStatus = "pending" | "running" | "done" | "review_pass" | "review_fail";

export type Worker = "claude" | "codex" | "antigravity";

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
	worker?: Worker;
	prompt: string;
	artifacts: {
		log?: string;
		review?: string;
		branch?: string;
	};
	timestamps: {
		created: string;
		executed?: string;
		reviewed?: string;
	};
}

export interface ParsedPlan {
	goal: string;
	tasks: Array<{ id?: string; title: string; prompt: string }>;
}
