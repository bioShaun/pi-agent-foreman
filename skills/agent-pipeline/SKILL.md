---
name: agent-pipeline
description: Multi-CLI orchestration. Use /agent plan, run, exec, review, fix when Codex should plan, Claude/Codex/Antigravity should execute, and a fixer should clean up review failures.
---

# Agent Pipeline

流程：`plan` → `exec` → `review` →（如有 `review_fail`）`fix` → `review_pass`。`fix` 在一次 fixer CLI 调用里聚合修复全部 `review_fail` 任务，成功后直接标 `review_pass`（不再 re-review）。

| Command | Action |
|---------|--------|
| `/agent plan <goal>` | Codex 规划 → `.agent/tasks/` |
| `/agent run T001 [--worker claude] [--reviewer claude\|codex]` | exec → review（单次，不自动重试） |
| `/agent exec T001 [--worker claude]` | 单步执行 |
| `/agent exec --all [--worker claude]` | 按 active plan 顺序 exec 全部 `pending` |
| | 可选：`--parallel N` `--from T003` `--continue-on-error` |
| `/agent resume [--continue-on-error]` | 从 boulder.json 恢复上次中断的 batch exec |
| `/agent resume status` | 查看可恢复内容，不执行 |
| `/agent review T001 [--reviewer claude\|codex]` | review（默认 codex） |
| `/agent review --all [--reviewer claude\|codex]` | 审核 active plan 中全部 `done` 任务 |
| `/agent fix [--fixer claude\|codex\|antigravity] [--from T003]` | 单次 fixer pass，聚合修复全部 `review_fail` → `review_pass` |
| `/agent mark_pass T001` / `mark_pass --all` | 手动改完后标记 `review_pass`（不跑 reviewer） |
| `/agent list` | 任务列表 |

角色定义：`agents/*.md`（包内）+ `.pi/agents/*.md`（项目覆盖）。`fixer` 角色默认 claude，可通过 `--fixer codex|antigravity` 切换。

Exec 成功后、review 前会自动对变更的 `.py` 跑 **pre-review Ruff gate**（与 reviewer 同范围）；失败则 exec 不算完成。跳过：`PIPELINE_SKIP_EXEC_GATE=1`。
