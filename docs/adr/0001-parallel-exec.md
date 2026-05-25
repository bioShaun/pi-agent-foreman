# ADR 0001: Parallel exec batch

**Status:** Accepted  
**Date:** 2026-05-25

## Context

Pipeline today runs exec batches strictly sequentially (`for await` in `runExecAll`). Plan task order is conventional only — there is no `depends_on`, and `tasksForExecBatch` does not gate on upstream completion. Review batches remain sequential and inspect a shared working tree (`git diff`), so parallel review would race on the same uncommitted changes.

We studied [oh-my-claudecode](https://github.com/bioShaun/oh-my-claudecode) (OMC) ultrawork and team task readiness as reference, not as a port target.

## OMC → Pipeline adaptation checklist

| OMC concept | Location | Pipeline adaptation | Phase |
|-------------|----------|-------------------|-------|
| Parallel waves for independent work | `skills/ultrawork/SKILL.md` | `/agent exec --all --parallel N` runs up to N ready tasks per wave | **2** |
| Dependency matrix in plan | ultrawork step 5 | Planner JSON `depends_on: ["T001"]` on each task | **2** |
| `computeTaskReadiness` | `src/team/state/tasks.ts` | `areExecDepsMet()` — deps must be `done` \| `review_pass` \| `review_fail` | **2** |
| `depends_on` / `blocked_by` fields | team task JSON | `AgentTask.depends_on?: string[]` | **2** |
| Dep = `completed` | OMC task status | Dep = exec finished (review optional before dependent exec) | **2** |
| `claimTask` + lock before work | `src/team/state/tasks.ts`, `task-file-ops.ts` | Defer — single Pi session batch is enough for Phase 2 | 3 |
| `O_EXCL` task locks | `src/team/task-file-ops.ts` | Defer — needed only for multi-process workers | 3 |
| Git worktree per worker | `src/team/git-worktree.ts` | Defer — parallel exec on one tree risks file conflicts | 3 |
| Merge orchestrator | `src/team/merge-orchestrator.ts` | Defer — manual merge / re-review until worktrees | 4 |
| tmux / team runtime v2 | `src/team/runtime-v2.ts` | **Skip** — Pi extension spawns CLIs; no tmux panes | — |
| Native `TeamCreate` API | Claude Code teams | **Skip** — not available to Pi pipeline | — |
| Review / verify loop | team staged pipeline | Keep pipeline exec → review; review batch **serial only** | **2** |
| Boulder resume pointer | OMC + pipeline `boulder.json` | Extend later with `parallel` in batch metadata | 3 |

## Decisions

### 1. Task dependencies

- Add optional `depends_on: string[]` to `AgentTask` and planner JSON output.
- Validate at plan creation: IDs must exist in the same plan; no self-edges.
- **Exec readiness:** task status is exec-runnable (`pending`, `review_fail`, stale `running`) **and** every dep has status ∈ `{ done, review_pass, review_fail }`.
- Rationale: dependent work may need upstream code landed; review of the dep can happen before or after the dependent exec, but the dep’s implementation must exist.

### 2. Parallel exec (`--parallel N`)

- Flag: `/agent exec --all [--parallel N]` where `N` defaults to `1`, max `8`.
- Scheduler: dynamic waves — repeatedly pick all pending tasks that are exec-runnable **and** deps-satisfied, run up to `N` concurrently, repeat until none ready or batch stops on error.
- `N = 1`: current behaviour (TUI loader per task, sequential).
- `N > 1`: **silent invoke** per task (no per-task loader); **`withParallelBatchDisplay`** shows a batch progress panel with active task IDs, `tail -f` hints, and live log tails refreshed every ~800ms. Full batch summary appears when the panel closes.
- `--continue-on-error` and boulder resume behave as today; resume does not yet persist `parallel` (defaults to 1).

### 3. Review stays serial

- `/agent review` and `/agent review --all` remain sequential.
- Reviewers inspect one task’s uncommitted diff at a time; parallel review would interleave edits and produce meaningless verdicts.
- After parallel exec wave completes, user runs review per task (or `review --all`) as today.

### 4. Batch selection UX

- `tasksForExecBatch` returns three buckets:
  - **runnable** — exec-runnable and deps met
  - **blocked** — exec-runnable but deps unmet
  - **skipped** — not exec-runnable (`done`, `review_pass`, etc.)
- `/agent list` shows `depends_on` when present.

## Consequences

**Positive**

- Independent tasks (e.g. T002 + T003 with no deps) can exec in parallel.
- Explicit DAG replaces implicit plan order only.
- Clear path to Phase 3 (locks, worktrees) without rewriting the exec/review model.

**Negative / risks**

- Parallel exec on one git tree: tasks touching the same files may conflict — user must set `depends_on` or accept manual resolution.
- Batch progress panel during `--parallel > 1` (when TUI available); per-task detail still in `.agent/traces/…live.log`.
- Existing plans without `depends_on` behave as today (all runnable tasks appear independent).

## Phase 2 deliverables (this implementation)

- [x] ADR (this document)
- [x] `depends_on` in types, planner, parse-plan, agent-store
- [x] `lib/task-deps.ts` readiness helpers
- [x] `tasksForExecBatch` blocked/runnable split
- [x] `--parallel N` + wave scheduler in `runExecAll`
- [x] Silent invoke adapter for concurrent workers
- [x] Single-task exec rejects unmet deps with a clear error

## References

- OMC ultrawork: `/Users/guilixuan/script/oh-my-claudecode/skills/ultrawork/SKILL.md`
- OMC readiness: `/Users/guilixuan/script/oh-my-claudecode/src/team/state/tasks.ts`
- Pipeline CONTEXT: `CONTEXT.md`
