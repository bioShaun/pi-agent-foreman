# pi-agent-foreman

Pi TUI extension: **Codex** plans and reviews, **Claude / Codex / Antigravity** execute — one `/agent` workflow.

## Install

```bash
pi install /Users/guilixuan/project/pi-agent-foreman
# or project-local:
pi install -l /Users/guilixuan/project/pi-agent-foreman
```

Or one-off: `pi -e /path/to/pi-agent-foreman/index.ts`

## TUI usage

```
/agent plan 改善代码库架构
/agent list
/agent run T001 --worker claude    # exec → review → auto retry once if fail
/agent exec T001 --worker claude   # step-by-step
/agent review T001
/agent help
```

**Requires a git repository** (Codex trusted directory).

## Agent roles (`agents/*.md`)

| File | Role | CLI |
|------|------|-----|
| `planner.md` | 规划 | codex exec |
| `worker-claude.md` | 执行 | claude -p |
| `worker-codex.md` | 执行 | codex exec |
| `reviewer.md` | 审核 | codex review |

Override per project: `.pi/agents/*.md` (same format, project wins).

After `review_fail`, `/agent exec T001` automatically injects review feedback into the worker prompt.

## State (`.agent/`)

| Path | Purpose |
|------|---------|
| `manifest.json` | Counters, active plan |
| `plans/PLAN-001.json` | Plan + task IDs |
| `tasks/T001.json` | Status, worker, prompt |
| `logs/T001.log` | Worker output |
| `reviews/T001.md` | Codex review |

## Architecture

```
/agent  →  index.ts  →  lib/commands.ts
              ↓              ↓
         agents/*.md    codex / claude CLI
              ↓
           .agent/
```
