# Agent Foreman

Pi TUI extension that orchestrates a multi-CLI pipeline: Codex plans and reviews; Claude/Codex/Antigravity execute tasks. All state lives under `.agent/` in the git repo.

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
Which kind of run this is: `exec` (worker executes task), `review` (Codex reviews uncommitted changes), or `plan` (Codex generates a plan).
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

**Role agent**:
A markdown-defined persona (`agents/*.md`) with a role (`planner`, `worker`, `reviewer`), CLI hint, and system prompt. Project overrides via `.pi/agents/`. The `cli` field drives both availability checks and invocation args.
_Avoid_: Persona, bot, profile

**Role invocation**:
Maps a resolved role agent to `{ command, args, stdin?, streamJson? }`. Invocation patterns live in `role-invoke.ts`; frontmatter `cli` selects the binary.
_Avoid_: CLI builder, command factory

**Boulder**:
Resume pointer in `boulder.json` tracking the active plan, current task, and last exec batch. `/agent resume` reads it to continue a stopped batch; `/agent resume status` shows what would run.
_Avoid_: Checkpoint, state file

## Example dialogue

> **Dev:** I want to re-run T003 after review failed.
> **Expert:** That's an exec-phase task run. The task is `review_fail`, so the run module injects the latest review artifact as feedback, runs the worker, writes a new exec log, and sets status to `done`. Review is a separate run phase afterward.
