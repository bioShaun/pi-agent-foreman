# Agent Pipeline

Pi TUI extension that orchestrates a multi-CLI pipeline: Codex plans; Claude/Codex/Antigravity execute tasks; Claude or Codex review; a fixer (Claude by default) cleans up all review failures in a single aggregated pass. All state lives under `.agent/` in the git repo.

Workflow: `plan → exec → review →` (if any `review_fail`) `fix → review_pass`. There is no per-task auto-retry; failed reviews are deferred to one fixer invocation that sees every failure at once.

## Language

**Plan**:
A Codex-generated breakdown of a user goal into ordered tasks. Persisted as `PLAN-00N` with a task list and raw markdown.
_Avoid_: Sprint, epic, roadmap

**Task**:
A runnable unit of work (`T001`, …) with status, prompt, artifact pointers, and run history.
_Avoid_: Issue, ticket, job

**Run**:
One invocation of a worker or reviewer CLI. Identified by `{UTC-ts}-{provider}`; produces immutable artifact files.
_Avoid_: Attempt, execution, session

**Run phase**:
Which kind of run this is: `exec` (worker executes task), `review` (Claude or Codex reviews uncommitted changes), `fix` (fixer applies a single aggregated pass over all `review_fail` tasks), or `plan` (Codex generates a plan).
_Avoid_: Stage, step, action

**Task run**:
The module that owns a single run phase end-to-end: status transitions, artifact paths, CLI invocation, run recording. Callers pass phase-specific inputs; the module hides the shared lifecycle.
_Avoid_: Pipeline, orchestrator, handler

**Agent store**:
Persistence module for manifest, plan, task, and boulder records under `.agent/`.
_Avoid_: Repository, database layer, state manager

**Agent paths**:
Path helpers for run IDs, artifact files, and live trace locations. No persistence logic.
_Avoid_: File utils, path builder

**Process spawn**:
Subprocess adapter at the invoke seam — spawn, timeout, cancel, stream capture. Production TUI wraps it in `runWithLoader`; tests inject a fake or call `spawnProcess` directly.
_Avoid_: Shell runner, exec helper

**Task status**:
Rules for task lifecycle display and eligibility — exec runnable, review verdict parsing, status icons, run completion.
_Avoid_: State machine, status helper

**Worker**:
The CLI that executes a task: `claude`, `codex`, or `antigravity`. The Antigravity worker resolves to the `agy` binary on PATH (alias `antigravity` also accepted).
_Avoid_: Agent, executor, model

**Fixer**:
The CLI that cleans up review failures: `claude` (default), `codex`, or `antigravity`. Receives one aggregated prompt covering **every** `review_fail` task in the active plan (task description + review report + structured findings per task) and runs once. On success every included task is marked `review_pass` directly — there is no re-review.
_Avoid_: Patcher, doctor, retry agent

**Role agent**:
A markdown-defined persona (`agents/*.md`) with a role (`planner`, `worker`, `reviewer`, `fixer`), CLI hint, and system prompt. Project overrides via `.pi/agents/`. The `cli` field drives both availability checks and invocation args.
_Avoid_: Persona, bot, profile

**Role invocation**:
Maps a resolved role agent to `{ command, args, stdin?, streamJson? }`. Invocation patterns live in `role-invoke.ts`; frontmatter `cli` selects the binary.
_Avoid_: CLI builder, command factory

**Boulder**:
Resume pointer in `boulder.json` tracking the active plan, current task, and last exec batch. `/agent resume` reads it to continue a stopped batch; `/agent resume status` shows what would run.
_Avoid_: Checkpoint, state file

## Example dialogue

> **Dev:** Reviews failed on T002 and T005. How do I fix them?
> **Expert:** Run `/agent fix`. The fix-phase task run gathers every `review_fail` task in the active plan (T002 and T005), builds a single aggregated prompt that includes each task's description, review report, and structured findings, and invokes one fixer CLI call (Claude by default; override with `--fixer codex|antigravity`). On exit 0 every included task is marked `review_pass` directly and the per-plan log lands at `.agent/artifacts/fix/PLAN-00N/{runId}.log`. There is no re-review step.
