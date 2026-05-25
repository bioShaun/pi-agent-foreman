---
name: agent-foreman
description: Multi-CLI orchestration. Use /agent plan, run, exec, review when Codex should plan/review and Claude/Codex/Antigravity should execute.
---

# Agent Foreman

| Command | Action |
|---------|--------|
| `/agent plan <goal>` | Codex 规划 → `.agent/tasks/` |
| `/agent run T001 [--worker claude] [--reviewer claude\|codex]` | exec → review → 失败自动重试 1 次 |
| `/agent exec T001 [--worker claude]` | 单步执行 |
| `/agent exec --all [--worker claude]` | 按 active plan 顺序 exec 全部 pending/review_fail |
| | 可选：`--from T003` `--continue-on-error` |
| `/agent resume [--continue-on-error]` | 从 boulder.json 恢复上次中断的 batch exec |
| `/agent resume status` | 查看可恢复内容，不执行 |
| `/agent review T001 [--reviewer claude\|codex] [--fix]` | review（默认 codex）；`--fix` 有界修复循环 |
| `/agent review --all [--reviewer claude\|codex] [--fix]` | 审核 active plan 中全部 done 任务 |
| `/agent mark_pass T001` / `mark_pass --all` | 手动改完后标记 `review_pass`（不跑 reviewer） |
| `/agent list` | 任务列表 |

角色定义：`agents/*.md`，项目可覆盖 `.pi/agents/*.md`。

`review_fail` 后再次 exec 会注入结构化 findings；用 `/agent logs T001` 查看 prompt/verdict 路径。

`--fix`：lint-only → `ruff --fix` + gate → 可直接 `review_pass`；minor → reviewer 修 + 最多 1 次 re-review；major/critical 不自动修。见 `docs/adr/0002-review-fix-loop.md`。

Exec 成功后、review 前会自动对变更的 `.py` 跑 **pre-review Ruff gate**（与 reviewer 同范围）；失败则 exec 不算完成。跳过：`FOREMAN_SKIP_EXEC_GATE=1`。
