---
name: agent-foreman
description: Multi-CLI orchestration. Use /agent plan, run, exec, review when Codex should plan/review and Claude/Codex/Antigravity should execute.
---

# Agent Foreman

| Command | Action |
|---------|--------|
| `/agent plan <goal>` | Codex 规划 → `.agent/tasks/` |
| `/agent run T001 [--worker claude]` | exec → review → 失败自动重试 1 次 |
| `/agent exec T001 [--worker claude]` | 单步执行 |
| `/agent review T001` | Codex review |
| `/agent list` | 任务列表 |

角色定义：`agents/*.md`，项目可覆盖 `.pi/agents/*.md`。

`review_fail` 后再次 exec 会自动带上 review 意见。
