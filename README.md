# pi-agent-foreman

[English](README.md) · [中文](README.zh-CN.md)

Pi TUI extension: **Codex** plans; **Claude** or **Codex** review; **Claude**, **Codex**, or **Antigravity (`agy`)** execute tasks — one `/agent` workflow.

## Prerequisites

- [Pi](https://github.com/badlogic/pi-mono) coding agent (`pi install …`)
- A **git repository** (Codex trusted directory)
- CLIs on `PATH` for the roles you use:
  - **Plan:** `codex`
  - **Review:** `codex` (default), `claude` (`--reviewer claude`)
  - **Exec:** `claude`, and/or `codex`, and/or `agy` (Antigravity CLI)

Install Antigravity CLI:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
command -v agy
```

## Install

```bash
git clone git@github.com:bioShaun/pi-agent-foreman.git
cd pi-agent-foreman
pi install -l .
```

Or one-off without installing the package:

```bash
pi -e /path/to/pi-agent-foreman/index.ts
```

## Commands

| Command | Description |
|---------|-------------|
| `/agent plan <goal>` | Codex generates a plan → tasks under `.agent/` |
| `/agent list` | List tasks (widget also shows active plan in TUI) |
| `/agent run T001 [--worker claude] [--reviewer claude\|codex]` | Exec → review → **one auto-retry** if review fails |
| `/agent exec T001 [--worker claude]` | Execute a single task |
| `/agent exec --all [--worker claude]` | Exec all `pending` / `review_fail` tasks in active plan |
| | Options: `--from T003`, `--continue-on-error` |
| `/agent resume` | Resume last stopped batch from `boulder.json` |
| `/agent resume --continue-on-error` | Resume and keep going after task failures |
| `/agent resume status` | Show resume info without running |
| `/agent review T001 [--reviewer claude\|codex] [--fix]` | Review uncommitted changes (default: Codex) |
| `/agent review --all [--reviewer claude\|codex] [--fix]` | Review all `done` tasks (`--fix` also includes `review_fail`) |
| | Options: `--from T003`, `--continue-on-error`, `--fix` (bounded review-fix loop) |
| `/agent mark_pass T001` | After **manual** fix/review — set task to `review_pass` |
| `/agent mark_pass --all [--from T003]` | Mark all `done` / `review_fail` / stale `running` in plan |
| `/agent logs T001` | Run history and artifact paths |
| `/agent help` | Command reference |

**Workers:** `--worker claude` (default) · `codex` · `antigravity`  
**Reviewers:** `--reviewer codex` (default) · `claude`

```
/agent plan Improve test coverage
/agent exec --all --worker claude
/agent review --all --reviewer claude
/agent resume
```

## Agent roles (`agents/*.md`)

Role agents are markdown files with YAML frontmatter. **Project overrides package:** `.pi/agents/*.md` wins over bundled `agents/*.md`.

| File | Role | Invocation |
|------|------|------------|
| `planner.md` | Plan | `codex exec -` (stdin = planner prompt) |
| `worker-claude.md` | Exec | `claude -p` (stream-json) |
| `worker-codex.md` | Exec | `codex exec -` |
| `worker-antigravity.md` | Exec | `agy -p` (Antigravity CLI) |
| `reviewer.md` | Review | `codex exec -` (stream-json + foreman-verdict) |
| `reviewer-claude.md` | Review | `claude -p` (git diff + foreman-verdict) |

Optional frontmatter:

- `cli` — logical CLI name
- `bin` — executable on `PATH` (e.g. `bin: agy` for Antigravity)
- `worker` — worker id for exec (`claude`, `codex`, `antigravity`)
- `reviewer` — reviewer id (`claude`, `codex`)

After `review_fail`, re-running `/agent exec T001` injects structured findings from `.agent/artifacts/review/T001/{runId}.json` (or falls back to the review report). Verify via `.agent/prompts/exec/T001/{runId}.md` (`incorporated_review_run_id` in frontmatter).

### Review-fix (`--fix`)

`/agent review T001 --fix` runs a **bounded** loop (see [ADR 0002](docs/adr/0002-review-fix-loop.md)):

1. Review → if pass, stop.
2. **Major/critical** findings → `review_fail` (use `/agent exec`).
3. **Lint-only** → `ruff check --fix` + pre-review gate → `review_pass` if gate OK (no re-review).
4. **Minor** (or lint+minor after step 3) → reviewer fix (prompt mode) → **one** re-review → pass or fail.
5. Stops if working tree unchanged or findings unchanged after fix (no infinite loop).

## Task lifecycle

| Status | Meaning |
|--------|---------|
| `pending` | Not executed yet (or exec failed / cancelled → back to pending) |
| `running` | Exec in progress |
| `done` | Exec finished, awaiting review |
| `review_pass` | Review passed |
| `review_fail` | Review failed — re-exec picks up review feedback |

## Pre-review gate (after exec, before review)

After the worker exits 0, foreman runs `ruff check` on **changed Python files** in the same scope the reviewer uses (staged + unstaged + untracked, excluding `.agent/`):

- **Pass** → task becomes `done`, review may proceed
- **Fail** → exec is **not** complete; status reverts; error includes a `ruff check … --fix` hint
- **Skipped** when there are no changed `.py` files, ruff is unavailable, or `FOREMAN_SKIP_EXEC_GATE=1`

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
| Plan artifact | `artifacts/plan/PLAN-001/{runId}.md` | Codex plan output |
| Live trace | `traces/T001/{runId}.live.log` | Stream tail while exec runs |

Run ID format: `{UTC-ts}-{provider}` (e.g. `20250525T120058Z-claude`).

Each re-run creates a **new** artifact file; `tasks/T001.json` always points at the latest paths.

## Architecture

```
/agent  →  index.ts  →  lib/commands.ts
              │              ├── task-run.ts      (exec / review lifecycle)
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
