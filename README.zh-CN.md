# pi-agent-foreman

[English](README.md) · [中文](README.zh-CN.md)

Pi TUI 扩展：**Codex** 负责规划；**Claude** 或 **Codex** 负责审核；**Claude**、**Codex** 或 **Antigravity（`agy`）** 负责执行任务 —— 统一 `/agent` 工作流。

## 前置条件

- 已安装 [Pi](https://github.com/badlogic/pi-mono) coding agent（`pi install …`）
- 当前目录为 **git 仓库**（Codex 可信目录）
- `PATH` 上有所需 CLI：
  - **规划：** `codex`
  - **审核：** `codex`（默认）、`claude`（`--reviewer claude`）
  - **执行：** `claude`、`codex`、`agy`（Antigravity CLI，按需）

安装 Antigravity CLI：

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
command -v agy
```

## 安装

```bash
git clone git@github.com:bioShaun/pi-agent-foreman.git
cd pi-agent-foreman
pi install -l .
```

或一次性加载（不安装包）：

```bash
pi -e /path/to/pi-agent-foreman/index.ts
```

## 命令

| 命令 | 说明 |
|------|------|
| `/agent plan <goal>` | Codex 生成规划 → 写入 `.agent/` 任务 |
| `/agent list` | 列出任务（TUI 侧边栏也会显示 active plan） |
| `/agent run T001 [--worker claude] [--reviewer claude\|codex]` | 执行 → 审核 → 审核失败 **自动重试 1 次** |
| `/agent exec T001 [--worker claude]` | 单步执行 |
| `/agent exec --all [--worker claude]` | 按 active plan 顺序执行全部 `pending` / `review_fail` 任务 |
| | 可选：`--from T003`、`--continue-on-error` |
| `/agent resume` | 从 `boulder.json` 恢复上次中断的 batch |
| `/agent resume --continue-on-error` | 恢复执行，单个任务失败仍继续后续 |
| `/agent resume status` | 查看可恢复信息，不执行 |
| `/agent review T001 [--reviewer claude\|codex]` | 审核未提交变更（默认 Codex） |
| `/agent review --all [--reviewer claude\|codex]` | 按 active plan 审核全部 `done` 任务 |
| | 可选：`--from T003`、`--continue-on-error` |
| `/agent logs T001` | 运行历史与 artifact 路径 |
| `/agent help` | 命令帮助 |

**Worker：** `--worker claude`（默认）· `codex` · `antigravity`  
**Reviewer：** `--reviewer codex`（默认）· `claude`

```
/agent plan 改善测试覆盖
/agent exec --all --worker claude
/agent review --all --reviewer claude
/agent resume
```

## 角色定义（`agents/*.md`）

角色为带 YAML frontmatter 的 Markdown 文件。**项目覆盖内置：** `.pi/agents/*.md` 优先于包内 `agents/*.md`。

| 文件 | 角色 | 调用方式 |
|------|------|----------|
| `planner.md` | 规划 | `codex exec -`（stdin 传入规划 prompt） |
| `worker-claude.md` | 执行 | `claude -p`（stream-json） |
| `worker-codex.md` | 执行 | `codex exec -` |
| `worker-antigravity.md` | 执行 | `agy -p`（Antigravity CLI） |
| `reviewer.md` | 审核 | `codex exec -`（stream-json + foreman-verdict） |
| `reviewer-claude.md` | 审核 | `claude -p`（git diff + foreman-verdict） |

可选 frontmatter 字段：

- `cli` — 逻辑 CLI 名称
- `bin` — 实际可执行文件名（如 Antigravity 使用 `bin: agy`）
- `worker` — 执行 worker 标识（`claude`、`codex`、`antigravity`）
- `reviewer` — 审核 reviewer 标识（`claude`、`codex`）

`review_fail` 后再次 `/agent exec T001` 会注入 `.agent/artifacts/review/T001/{runId}.json` 中的结构化 findings（无 JSON 时回退到 review 报告）。可在 `.agent/prompts/exec/T001/{runId}.md` 查看 `incorporated_review_run_id`。

## 任务状态

| 状态 | 含义 |
|------|------|
| `pending` | 未执行（或执行失败 / 取消后回退） |
| `running` | 执行中 |
| `done` | 执行完成，待审核 |
| `review_pass` | 审核通过 |
| `review_fail` | 审核未通过 —— 再次 exec 会带上 review 反馈 |

## 状态目录（`.agent/`）

目录结构参考 [oh-my-claudecode REFERENCE](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/main/docs/REFERENCE.md)：

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
| Plan 产物 | `artifacts/plan/PLAN-001/{runId}.md` | Codex 规划输出 |
| Live trace | `traces/T001/{runId}.live.log` | 执行过程中的流式 tail |

Run ID 格式：`{UTC-ts}-{provider}`（例如 `20250525T120058Z-claude`）。

每次重新 exec / review 都会生成 **新** artifact 文件；`tasks/T001.json` 中的路径始终指向最新一次。

## 架构

```
/agent  →  index.ts  →  lib/commands.ts
              │              ├── task-run.ts      （exec / review 生命周期）
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
