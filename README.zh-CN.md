# pi-agent-pipeline

[English](README.md) · [中文](README.zh-CN.md)

Pi TUI 扩展：**Codex** 负责规划；**Claude** 或 **Codex** 负责审核；**Claude**、**Codex** 或 **Antigravity（`agy`）** 负责执行；专门的 **fixer**（默认 Claude）在最后一次性收尾所有审核失败 —— 统一 `/agent` 工作流。

## 流程

```
plan ─► 聊天里展示 draft ─► [Create tasks | Refine ↺ | Discard]
                              │
                              ▼
                  exec T001 ─► review T001 ─┐
                  │                         ├─► fix ─► review_pass
                  └► exec T002 ─► review T002┘  （一次 fixer 聚合修全部 review_fail）
```

`plan` 是交互式的：draft 推送到聊天流，但不会创建 `.agent/tasks/*`。选择器提供 **Create tasks**（创建任务）、**Refine**（输入修改提示词→重新生成→再次选择）、**Discard**。可加 `--planner claude|codex|antigravity` 选择规划阶段 CLI，加 `--worker claude|codex|antigravity` 设置该 plan 的默认执行 worker。只有 `/agent plan --apply <goal>` 或选择 Create tasks 才会立即写任务文件。Apply 后会把 markdown 同时写到 `.agent/drafts/plan.md` 作为可追溯记录。

## 前置条件

- 已安装 [Pi](https://github.com/badlogic/pi-mono) coding agent（`pi install …`）
- 当前目录为 **git 仓库**（Codex 可信目录）
- `PATH` 上有所需 CLI：
  - **规划：** `codex`
  - **审核：** `codex`（默认）、`claude`（`--reviewer claude`）
  - **执行：** `claude`、`codex`、`agy`（按需）
  - **修复：** `claude`（默认）、`codex`、`agy`（`--fixer …`）

安装 Antigravity CLI：

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
command -v agy
```

## 安装

```bash
git clone git@github.com:bioShaun/pi-agent-pipeline.git
cd pi-agent-pipeline
pi install -l .
```

或一次性加载（不安装包）：

```bash
pi -e /path/to/pi-agent-pipeline/index.ts
```

## 命令

| 命令 | 说明 |
|------|------|
| `/agent plan [--planner codex] [--worker claude] <goal>` | 起草 plan → 在聊天里展示，再弹 **Create tasks / Refine / Discard** 选项 |
| `/agent plan --apply [--planner codex] [--worker claude] <goal>` | 立即创建 plan/tasks，主要用于非交互场景 |
| `/agent list` | 列出任务（TUI 侧边栏也会显示 active plan） |
| `/agent run T001 [--worker claude] [--reviewer claude\|codex]` | 执行 → 审核（**一次性**，不自动重试） |
| `/agent exec T001 [--worker claude]` | 单步执行 |
| `/agent exec --all [--worker claude]` | 按 active plan 顺序执行全部 `pending` 任务 |
| | 可选：`--parallel N`、`--from T003`、`--continue-on-error` |
| `/agent resume` | 从 `boulder.json` 恢复上次中断的 batch |
| `/agent resume --continue-on-error` | 恢复执行，单个任务失败仍继续后续 |
| `/agent resume status` | 查看可恢复信息，不执行 |
| `/agent review T001 [--reviewer claude\|codex]` | 审核 |
| `/agent review --all [--reviewer claude\|codex]` | 审核所有 `done` |
| | 可选：`--from T003`、`--continue-on-error` |
| `/agent fix [--fixer claude\|codex\|antigravity] [--from T003]` | **单次 fixer pass**，聚合修复全部 `review_fail` → `review_pass` |
| `/agent mark_pass T001` | 手动修完后标记 `review_pass` |
| `/agent mark_pass --all [--from T003]` | 批量标记 `done` / `review_fail` / stale `running` |
| `/agent clear` | 清除 active plan；计划全部 `review_pass` 时侧边栏自动隐藏 |
| `/agent logs T001` | 运行历史与 artifact 路径 |
| `/agent help` | 命令帮助 |

**Worker：** `--worker claude`（默认）· `codex` · `antigravity`  
**Reviewer：** `--reviewer codex`（默认）· `claude`  
**Fixer：** `--fixer claude`（默认）· `codex` · `antigravity`

```
/agent plan 改善测试覆盖
/agent exec --all --worker claude
/agent review --all --reviewer claude
/agent fix                              # 一次 fixer 收尾所有 review_fail
```

## 角色定义（`agents/*.md`）

角色为带 YAML frontmatter 的 Markdown 文件。**项目覆盖内置：** `.pi/agents/*.md` 优先于包内 `agents/*.md`。

| 文件 | 角色 | 调用方式 |
|------|------|----------|
| `planner.md` | 规划 | `codex exec -`（stdin 传入规划 prompt） |
| `worker-claude.md` | 执行 | `claude -p`（stream-json） |
| `worker-codex.md` | 执行 | `codex exec -` |
| `worker-antigravity.md` | 执行 | `agy -p`（Antigravity CLI） |
| `reviewer.md` | 审核 | `codex exec -`（stream-json + pipeline-verdict） |
| `reviewer-claude.md` | 审核 | `claude -p`（git diff + pipeline-verdict） |
| `fixer-claude.md` | 修复 | `claude -p`（聚合多任务 prompt） |
| `fixer-codex.md` | 修复 | `codex exec -`（聚合多任务 prompt） |
| `fixer-antigravity.md` | 修复 | `agy -p`（聚合多任务 prompt） |

可选 frontmatter 字段：

- `cli` — 逻辑 CLI 名称
- `bin` — 实际可执行文件名（如 Antigravity 使用 `bin: agy`）
- `worker` — 执行 worker 标识（`claude`、`codex`、`antigravity`）
- `reviewer` — 审核 reviewer 标识（`claude`、`codex`）
- `fixer` — 修复 fixer 标识（`claude`、`codex`、`antigravity`）

### `fix` 的工作方式

`/agent fix` 收集 active plan 中**所有** `review_fail` 任务，把它们的描述、review 报告和结构化 findings 聚合到 **一个 prompt** 里，**单次** 调用 fixer CLI。CLI 成功退出后，所有被收纳的任务直接标 `review_pass`，**不再重新 review**。

产物路径（按 plan 归档，一次调用覆盖多个任务）：

- 日志：`.agent/artifacts/fix/PLAN-001/{runId}.log`
- Prompt：`.agent/prompts/fix/PLAN-001/{runId}.md`
- Live trace：`.agent/traces/PLAN-001/{runId}.live.log`
- 每个任务会追加一条 `runs[]`（`phase: "fix"`），并写入 `artifacts.fixLog` / `artifacts.fixPrompt`。

## 任务状态

| 状态 | 含义 |
|------|------|
| `pending` | 未执行（exec 失败 / 取消后回退） |
| `running` | 执行中 |
| `done` | 执行完成，待审核 |
| `review_pass` | 审核通过（或 fixer pass 成功） |
| `review_fail` | 审核未通过 —— 跑 `/agent fix` 一次性收尾 |

## Pre-review gate（exec 后、review 前）

Worker 成功退出后，pipeline 会对 **与 reviewer 相同范围** 的变更 Python 文件跑 `ruff check`（staged + unstaged + untracked，排除 `.agent/`）：

- 通过 → 任务标为 `done`，可进入 review
- 失败 → exec **不算完成**，状态回退，错误里附带 `ruff check … --fix` 提示
- 跳过：无变更 `.py`、找不到 ruff、或 `PIPELINE_SKIP_EXEC_GATE=1`

Ruff 解析顺序：`.venv/bin/ruff` → `uv run ruff` → `ruff`。

## 状态目录（`.agent/`）

| 用途 | 路径 | 说明 |
|------|------|------|
| Manifest | `manifest.json` | 计数器、`activePlanId` |
| Boulder | `boulder.json` | 恢复指针、batch worker、当前任务 |
| Plan | `plans/PLAN-001.json`、`plans/PLAN-001.md` | 任务列表 + 原始规划 markdown |
| Task | `tasks/T001.json` | 状态、artifacts、`runs[]` |
| Exec 日志 | `artifacts/exec/T001/{runId}.log` | 每次运行 immutable |
| Exec prompt | `prompts/exec/T001/{runId}.md` | 完整 worker prompt（可审计） |
| Review | `artifacts/review/T001/{runId}.md` | 审核报告 |
| Review verdict | `artifacts/review/T001/{runId}.json` | 结构化 findings |
| Review prompt | `prompts/review/T001/{runId}.md` | 完整 reviewer prompt |
| Fix 日志 | `artifacts/fix/PLAN-001/{runId}.log` | 单次 fix 调用一份日志，覆盖多个任务 |
| Fix prompt | `prompts/fix/PLAN-001/{runId}.md` | 聚合后的 fixer prompt |
| Plan 产物 | `artifacts/plan/PLAN-001/{runId}.md` | Codex 规划输出 |
| Live trace | `traces/T001/{runId}.live.log` · `traces/PLAN-001/{runId}.live.log` | 执行/审核/修复过程中的流式 tail |

Run ID 格式：`{UTC-ts}-{provider}`（例如 `20250525T120058Z-claude`）。

每次重新 exec / review 都会生成 **新** artifact 文件；`tasks/T001.json` 中的路径始终指向最新一次。

## 架构

```
/agent  →  index.ts  →  lib/commands.ts
              │              ├── task-run.ts      （exec / review 生命周期）
              │              ├── fix-run.ts       （聚合 fixer 调用）
              │              ├── agents.ts        （角色 agent 发现）
              │              ├── role-invoke.ts   （cli → spawn 参数）
              │              ├── agent-store.ts  （持久化）
              │              └── spawn-process.ts（子进程 seam）
              ↓
         agents/*.md  →  codex / claude / agy
              ↓
           .agent/
```

领域术语见 [CONTEXT.md](CONTEXT.md)。
