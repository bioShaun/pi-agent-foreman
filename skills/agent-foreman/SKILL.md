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
| `/agent exec --all [--worker claude]` | 按 active plan 顺序 exec 全部 pending/review_fail |
| | 可选：`--from T003` `--continue-on-error` |
| `/agent resume [--continue-on-error]` | 从 boulder.json 恢复上次中断的 batch exec |
| `/agent resume status` | 查看可恢复内容，不执行 |
| `/agent review T001` | Codex review |
| `/agent list` | 任务列表 |

角色定义：`agents/*.md`，项目可覆盖 `.pi/agents/*.md`。

`review_fail` 后再次 exec 会自动带上 review 意见。
