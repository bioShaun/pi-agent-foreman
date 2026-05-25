# ADR 0002: Review-fix loop (`--fix`)

## Status

Accepted

## Context

Review batches often fail on mechanical lint (Ruff) or minor issues. Re-running full worker exec is slow. We want a bounded loop: review → fix → verify → `review_pass`, without infinite cycles.

## Decision

Add `/agent review T00N --fix` and `/agent review --all --fix`.

Review batch with `--fix` includes tasks in `done` **or** `review_fail` (default batch remains `done` only).

### Flow

1. **Review** (attempt 1) — unchanged `runReviewPhase`.
2. If **PASS** → `review_pass`, stop.
3. If **FAIL** without structured `foreman-verdict` findings → `review_fail`, stop (no loop).
4. If findings include **major/critical** → `review_fail`, stop (escalate to `/agent exec`).
5. **Lint-only** findings → `ruff check --fix` on changed `.py` → **exec gate** → if gate OK → `review_pass` (**no re-review**).
6. **Lint + minor** → lint path first; if gate OK → **review-fix** (reviewer in prompt mode) → **one re-review** → pass or fail.
7. **Minor-only** → review-fix → one re-review → pass or fail.

### Anti-loop guards

| Guard | Rule |
|-------|------|
| Hard cap | At most **1** review-fix + re-review cycle per invocation (`MAX_REVIEW_FIX_CYCLES`) |
| Lint path | No LLM re-review; gate is the verifier |
| No progress | Same finding fingerprint after fix, or unchanged `git diff` tree hash → stop `review_fail` |
| Blocking | Major/critical never enter fix loop |

### Artifacts

- Review-fix runs: `.agent/artifacts/review_fix/T00N/{runId}.log`
- Prompts: `.agent/prompts/review_fix/T00N/{runId}.md`
- Run phase: `review_fix` on `TaskRun`

## Consequences

- Default `/agent review` behavior unchanged (no `--fix`).
- Lint-only passes may mark `review_pass` after auto-fix even when initial review said FAIL.
- Major issues still require worker exec.
