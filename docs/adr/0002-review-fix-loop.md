# ADR 0002: Review-fix loop (`--fix`)

## Status

**Superseded** by the dedicated `fixer` role and `/agent fix` command (see [README.md](../../README.md#how-fix-works)).

## What replaced it

The bounded per-task `--fix` loop (lint → ruff+gate → reviewer-fix → 1 re-review) was removed in favor of a single, **plan-scoped** fixer pass:

- New role: `fixer` (`agents/fixer-{claude,codex,antigravity}.md`), default Claude.
- New command: `/agent fix [--fixer claude|codex|antigravity] [--from T003]`.
- Behavior: collect **every** `review_fail` task in the active plan → build one aggregated prompt (task + review report + structured findings per task) → **single** CLI invocation → on success mark each included task `review_pass` directly (no re-review).
- Artifacts are plan-scoped: `.agent/artifacts/fix/PLAN-00N/{runId}.log`, `.agent/prompts/fix/PLAN-00N/{runId}.md`, `.agent/traces/PLAN-00N/{runId}.live.log`.

Also removed alongside the loop:

- `/agent review --fix` flag and the per-task `runReviewWithFixLoop` / `runReviewFixPhase` orchestration.
- `/agent run` auto-retry-on-review-fail behavior (run is now exec → review, single pass).
- Re-exec injection of structured review findings into the worker prompt (re-exec on a `review_fail` task is no longer the path; use `/agent fix` instead).
- `review_fix` run phase, `lib/review-fix-loop.ts`, `lib/review-fix.ts`.

## Why

- One simple workflow (`exec → review → fix`) is easier to reason about than per-task lint/minor/major routing.
- A single aggregated fixer pass gives the model global context across failures and is cheaper than N re-reviews.
- Decision 3(b): trust the fixer; skip re-review (use `/agent review T00N` manually if you need a second opinion).

## Migration notes

- Old `.agent/artifacts/review_fix/...` artifacts on disk are inert; the new pipeline neither reads nor writes that path.
- `tasks/T00N.json` entries with `runs[].phase: "review_fix"` are tolerated at runtime (display only).
- `FOREMAN_SKIP_EXEC_GATE` was renamed to `PIPELINE_SKIP_EXEC_GATE` during the broader rename.
