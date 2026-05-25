import { normalizeDependsOn } from "./task-deps.ts";
import type { ParsedPlan } from "./types.ts";

export function parsePlanOutput(raw: string, fallbackGoal: string): ParsedPlan {
	const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (jsonMatch) {
		try {
			const data = JSON.parse(jsonMatch[1]) as {
				goal?: string;
				tasks?: Array<{
					id?: string;
					title?: string;
					prompt?: string;
					description?: string;
					depends_on?: unknown;
				}>;
			};
			const goal = data.goal?.trim() || fallbackGoal;
			const tasks = (data.tasks ?? []).map((t, i) => ({
				id: t.id,
				title: t.title?.trim() || t.description?.trim() || `Task ${i + 1}`,
				prompt: t.prompt?.trim() || t.description?.trim() || t.title?.trim() || goal,
				depends_on: normalizeDependsOn(t.depends_on),
			}));
			if (tasks.length > 0) return { goal, tasks };
		} catch {
			// fall through
		}
	}

	const numbered = [...raw.matchAll(/^\s*(?:-\s*)?(T\d+)?[.:)]\s*(.+)$/gim)];
	if (numbered.length >= 2) {
		const tasks = numbered.map((m) => ({
			id: m[1]?.toUpperCase(),
			title: m[2].trim(),
			prompt: `Complete this task: ${m[2].trim()}\n\nContext from plan:\n${raw.slice(0, 4000)}`,
		}));
		return { goal: fallbackGoal, tasks };
	}

	return { goal: fallbackGoal, tasks: [] };
}
