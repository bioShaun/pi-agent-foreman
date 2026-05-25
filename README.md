# pi-agent-pipeline

[English](README.md) · [中文](README.zh-CN.md)

Pi TUI extension: **Codex** plans; **Claude** or **Codex** review; **Claude**, **Codex**, or **Antigravity (`agy`)** execute tasks; a dedicated **fixer** (default Claude) cleans up all review failures in one pass — one `/agent` workflow.

## Workflow

```
plan ─► exec T001 ─► review T001 ─┐
       │                          ├─► fix ─► review_pass
       └► exec T002 ─► review T002┘   (single fixer pass over all review_fail tasks)
```

## Prerequisites

- [Pi](https://github.com/badlogic/pi-mono) coding agent (`pi install …`)
- A **git repository** (Codex trusted directory)
- CLIs on `PATH` for the roles you use:
  - **Plan:** `codex`
  - **Review:** `codex` (default), `claude` (`--reviewer claude`)
  - **Exec:** `claude`, and/or `codex`, and/or `agy` (Antigravity CLI)
  - **Fix:** `claude` (default), `codex`, or `agy` (`--fixer …`)

Install Antigravity CLI:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
command -v agy
```

## Install

```bash
git clone git@github.com:bioShaun/pi-agent-pipeline.git
cd pi-agent-pipeline
pi install -l .
```

Or one-off without installing the package:

```bash
pi -e /path/to/pi-agent-pipeline/index.ts
```

## Commands

| Command | Description |
|---------|-------------|
| `/agent plan <goal>` | Codex generates a plan → tasks under `.agent/` |
| `/agent list` | List tasks (widget also shows active plan in TUI) |
| `/agent run T001 [--worker claude] [--reviewer claude\|codex]` | Exec → review (single pass, no auto-retry) |
| `/agent exec T001 [--worker claude]` | Execute a single task |
| `/agent exec --all [--worker claude]` | Exec all `pending` tasks in active plan |
| | Options: `--parallel N`, `--from T003`, `--continue-on-error` |
| `/agent resume` | Resume last stopped batch from `boulder.json` |
| `/agent resume --continue-on-error` | Resume and keep going after task failures |
| `/agent resume status` | Show resume info without running |
| `/agent review T001 [--reviewer claude\|codex]` | Review uncommitted changes (default: Codex) |
| `/agent review --all [--reviewer claude\|codex]` | Review all `done` tasks |
| | Options: `--from T003`, `--continue-on-error` |
| `/agent fix [--fixer claude\|codex\|antigravity] [--from T003]` | **Single fixer pass** over all `review_fail` tasks → `review_pass` |
| `/agent mark_pass T001` | After **manual** fix/review — set task to `review_pass` |
| `/agent mark_pass --all [--from T003]` | Mark all `done` / `review_fail` / stale `running` in plan |
| `/agent logs T001` | Run history and artifact paths |
| `/agent help` | Command reference |

**Workers:** `--worker claude` (default) · `codex` · `antigravity`  
**Reviewers:** `--reviewer codex` (default) · `claude`  
**Fixers:** `--fixer claude` (default) · `codex` · `antigravity`

```
/agent plan Improve test coverage
/agent exec --all --worker claude
/agent review --all --reviewer claude
/agent fix                         # one fixer pass cleans up all review_fail
```

## Agent roles (`agents/*.md`)

Role agents are markdown files with YAML frontmatter. **Project overrides package:** `.pi/agents/*.md` wins over bundled `agents/*.md`.

| File | Role | Invocation |
|------|------|------------|
| `planner.md` | Plan | `codex exec -` (stdin = planner prompt) |
| `worker-claude.md` | Exec | `claude -p` (stream-json) |
| `worker-codex.md` | Exec | `codex exec -` |
| `worker-antigravity.md` | Exec | `agy -p` (Antigravity CLI) |
| `reviewer.md` | Review | `codex exec -` (stream-json + pipeline-verdict) |
| `reviewer-claude.md` | Review | `claude -p` (git diff + pipeline-verdict) |
| `fixer-claude.md` | Fix | `claude -p` (aggregated multi-task prompt) |
| `fixer-codex.md` | Fix | `codex exec -` (aggregated multi-task prompt) |
| `fixer-antigravity.md` | Fix | `agy -p` (aggregated multi-task prompt) |

Optional frontmatter:

- `cli` — logical CLI name
- `bin` — executable on `PATH` (e.g. `bin: agy` for Antigravity)
- `worker` — worker id for exec (`claude`, `codex`, `antigravity`)
- `reviewer` — reviewer id (`claude`, `codex`)
- `fixer` — fixer id (`claude`, `codex`, `antigravity`)

### How `fix` works

`/agent fix` collects **every** `review_fail` task in the active plan, builds a single aggregated prompt (task description + review report + structured findings per task), and invokes one fixer CLI call. On success every included task is marked `review_pass` directly — there is no re-review.

Artifacts (plan-scoped, single run covers many tasks):

- Log: `.agent/artifacts/fix/PLAN-001/{runId}.log`
- Prompt: `.agent/prompts/fix/PLAN-001/{runId}.md`
- Live trace: `.agent/traces/PLAN-001/{runId}.live.log`
- Each task gets a `runs[]` entry with `phase: "fix"` plus `artifacts.fixLog` / `artifacts.fixPrompt`.

## Task lifecycle

| Status | Meaning |
|--------|---------|
| `pending` | Not executed yet (exec failure / cancel returns to `pending`) |
| `running` | Exec in progress |
| `done` | Exec finished, awaiting review |
| `review_pass` | Review passed (or fixer pass succeeded) |
| `review_fail` | Review failed — run `/agent fix` to apply a single aggregated fixer pass |

## Pre-review gate (after exec, before review)

After the worker exits 0, pipeline runs `ruff check` on **changed Python files** in the same scope the reviewer uses (staged + unstaged + untracked, excluding `.agent/`):

- **Pass** → task becomes `done`, review may proceed
- **Fail** → exec is **not** complete; status reverts; error includes a `ruff check … --fix` hint
- **Skipped** when there are no changed `.py` files, ruff is unavailable, or `PIPELINE_SKIP_EXEC_GATE=1`

Ruff resolution: `.venv/bin/ruff` → `uv run ruff` → `ruff` on PATH.

## State (`.agent/`)

Layout inspired by [oh-my-claudecode REFERENCE](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/main/docs/REFERENCE.md):

| Role | Path | Notes |
|------|------|-------|
| Manifest | `manifest.json` | Counters, `activePlanId` |
| Boulder | `boulder.json` | Resume pointer, batch worker, last task |
| Plan | `plans/PLAN-001.json`, `plans/PLAN-001.md` | Task list + raw plan markdown |
| Task | `tasks/T001.json` | Status, artifacts, `runs[]` |
| Exec log | `artifacts/exec/T001/{runId}.log` | Immutable per run |
| Exec prompt | `prompts/exec/T001/{runId}.md` | Full worker prompt (audit) |
| Review | `artifacts/review/T001/{runId}.md` | Narrative review report |
| Review verdict | `artifacts/review/T001/{runId}.json` | Structured findings (`approve/revise/reject`) |
| Review prompt | `prompts/review/T001/{runId}.md` | Full reviewer prompt (audit) |
| Fix log | `artifacts/fix/PLAN-001/{runId}.log` | One log per fix invocation (covers all included tasks) |
| Fix prompt | `prompts/fix/PLAN-001/{runId}.md` | Aggregated fixer prompt |
| Plan artifact | `artifacts/plan/PLAN-001/{runId}.md` | Codex plan output |
| Live trace | `traces/T001/{runId}.live.log` · `traces/PLAN-001/{runId}.live.log` | Stream tail while exec/review/fix runs |

Run ID format: `{UTC-ts}-{provider}` (e.g. `20250525T120058Z-claude`).

Each re-run creates a **new** artifact file; `tasks/T001.json` always points at the latest paths.

## Architecture

```
/agent  →  index.ts  →  lib/commands.ts
              │              ├── task-run.ts      (exec / review lifecycle)
              │              ├── fix-run.ts       (aggregated fixer pass)
              │              ├── agents.ts        (role agent discovery)
              │              ├── role-invoke.ts   (cli → spawn args)
              │              ├── agent-store.ts   (persistence)
              │              └── spawn-process.ts (subprocess seam)
              ↓
         agents/*.md  →  codex / claude / agy
              ↓
           .agent/
```

Domain glossary: [CONTEXT.md](CONTEXT.md)
