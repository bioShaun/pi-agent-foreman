# pi-agent-foreman

[English](README.md) · [中文](README.zh-CN.md)

Pi TUI extension: **Codex** plans and reviews; **Claude**, **Codex**, or **Antigravity (`agy`)** execute tasks — one `/agent` workflow.

## Prerequisites

- [Pi](https://github.com/badlogic/pi-mono) coding agent (`pi install …`)
- A **git repository** (Codex trusted directory)
- CLIs on `PATH` for the roles you use:
  - **Plan / review:** `codex`
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
| `/agent run T001 [--worker claude]` | Exec → review → **one auto-retry** if review fails |
| `/agent exec T001 [--worker claude]` | Execute a single task |
| `/agent exec --all [--worker claude]` | Exec all `pending` / `review_fail` tasks in active plan |
| | Options: `--from T003`, `--continue-on-error` |
| `/agent resume` | Resume last stopped batch from `boulder.json` |
| `/agent resume --continue-on-error` | Resume and keep going after task failures |
| `/agent resume status` | Show resume info without running |
| `/agent review T001` | Codex review (uncommitted changes) |
| `/agent logs T001` | Run history and artifact paths |
| `/agent help` | Command reference |

**Workers:** `--worker claude` (default) · `codex` · `antigravity`

```
/agent plan Improve test coverage
/agent exec --all --worker claude
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
| `reviewer.md` | Review | `codex exec review --uncommitted` |

Optional frontmatter:

- `cli` — logical CLI name
- `bin` — executable on `PATH` (e.g. `bin: agy` for Antigravity)
- `worker` — worker id for exec (`claude`, `codex`, `antigravity`)

After `review_fail`, re-running `/agent exec T001` injects the latest review artifact into the worker prompt.

## Task lifecycle

| Status | Meaning |
|--------|---------|
| `pending` | Not executed yet (or exec failed / cancelled → back to pending) |
| `running` | Exec in progress |
| `done` | Exec finished, awaiting review |
| `review_pass` | Review passed |
| `review_fail` | Review failed — re-exec picks up review feedback |

## State (`.agent/`)

Layout inspired by [oh-my-claudecode REFERENCE](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/main/docs/REFERENCE.md):

| Role | Path | Notes |
|------|------|-------|
| Manifest | `manifest.json` | Counters, `activePlanId` |
| Boulder | `boulder.json` | Resume pointer, batch worker, last task |
| Plan | `plans/PLAN-001.json`, `plans/PLAN-001.md` | Task list + raw plan markdown |
| Task | `tasks/T001.json` | Status, artifacts, `runs[]` |
| Exec log | `artifacts/exec/T001/{runId}.log` | Immutable per run |
| Review | `artifacts/review/T001/{runId}.md` | Immutable per run |
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
