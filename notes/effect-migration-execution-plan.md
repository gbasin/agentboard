# Effect TS Migration Execution Plan (Stress-Tested)

Date: 2026-02-18  
Scope: Agentboard backend-first migration to Effect TS with low breakage risk.

## Goals

- Improve safety and maintainability in `src/server/` with typed errors, managed resources, and clearer service boundaries.
- Avoid behavioral regressions in tmux/session/log/WebSocket flows.
- Preserve current transport contracts in `src/shared/types.ts` during initial phases.

## Non-Goals (for initial migration)

- No full frontend rewrite to Effect.
- No "big bang" replacement of `src/server/index.ts`.
- No public API or wire-protocol changes unless explicitly planned.

## Core Risks

- Mutating operations (`session-create`, `session-kill`, `session-rename`, `session-pin`, `session-resume`) cannot safely run dual-write legacy+candidate logic.
- WS behavior depends on ordering/timing, not just message shape.
- Existing background loops/workers are concurrency-sensitive.
- Log format drift from Claude/Codex can invalidate fixtures.
- Rollback is unsafe if schema/data changes are not backward-compatible.
- Effect adoption can regress latency/memory before functional tests fail.

## Guardrails

- Keep `EFFECT_ENABLED=false` by default through early phases.
- Use shadow compare only on pure/read-only paths.
- Gate each slice with:
  - `bun run lint`
  - `bun run typecheck`
  - `bun run test`
- Add explicit perf budgets and rollback drills before broader rollout.

## Phase 0A: Safety Rails (Before Any Meaningful Migration)

1. Baseline invariants doc
- Create and maintain a "must-not-change" checklist for:
  - HTTP response shapes from `src/server/index.ts` routes.
  - WS message types/payloads from `src/shared/types.ts`.
  - Status transition behavior (`unknown -> working -> waiting`, permission edge cases).

2. Contract tests (public API)
- Add HTTP contract tests for current routes.
- Add WS contract tests for:
  - Message shape
  - Message ordering assumptions
  - Error semantics/codes

3. Golden fixtures + replay
- Add curated fixture corpus for:
  - Log matching
  - Status inference
  - Poll/update edge cases
- Include rotation/truncation and malformed line cases.

4. Soak + concurrency stress harness
- Multi-client concurrent attach/input/resize/refresh cycles.
- Randomized operation streams for session lifecycle commands.
- Minimum 30-60 minute soak runs.

5. Chaos scenarios
- tmux unavailable/restart
- SSH timeout and stale remote host states
- Worker restart/failure paths
- Log watcher gaps and delayed filesystem events

## Phase 0B: Shadow Infrastructure (Read-Only First)

1. Feature flags
- `EFFECT_ENABLED`
- `EFFECT_SHADOW`
- `EFFECT_FAIL_ON_DIFF`
- Additional per-subsystem flags as migration progresses.

2. Shadow compare utility
- Run legacy + candidate for read-only/pure seams.
- Return legacy result.
- Normalize and log structured diffs.
- Never apply shadow mode to mutating paths unless candidate is explicitly dry-run.

3. Diff observability
- Emit counters for:
  - diff count by seam
  - first/last seen
  - payload samples (bounded/redacted)

## Phase 0C: POCs (Required Upfront)

Only small targeted POCs before broad migration:

1. Route boundary POC (read-only endpoint)
- Introduce Effect decode/validation + typed error mapping on one read route.
- No contract change.

2. Shadow compare POC (pure read path)
- Apply to one status/read computation seam.
- Validate zero diff under fixture + soak load.

3. Resource lifecycle POC
- Wrap one loop/service lifecycle with Effect-managed startup/shutdown/cancel.
- Validate no leaks and clean termination on SIGINT/SIGTERM.

## Phase 0D: Go / No-Go Criteria

Proceed to broader migration only if:

- Zero unexpected shadow diffs on fixture suite.
- Zero flaky failures over repeated CI runs (recommend 10).
- No p95 latency regression >10% on targeted flows.
- No sustained memory growth >5% during soak window.
- Rollback drill validated via env-flag disable path.

## Phase 1: Backend-First Incremental Migration

1. Validation/config seam
- Move input decoding + validation logic behind Effect boundary.

2. DB seam
- Wrap DB operations in service interface with typed domain errors.
- Keep SQL and schema behavior stable initially.

3. Polling/matching seam
- Migrate read computation and orchestration incrementally.
- Keep wire contracts unchanged.

4. Terminal/remote seam
- Introduce managed resource semantics for attach/detach/cleanup.

5. WebSocket message handlers
- Migrate one case family at a time; preserve message contracts.

## Phase 2: Write-Path Canary (After Confidence)

- Enable Effect path per mutating command behind dedicated flags.
- Run gradual canary rollout with strict monitoring.
- Keep immediate rollback path to legacy.

## Commit Strategy

Atomic, small commits:

1. docs + safety checklist
2. contract tests
3. fixture/replay tests
4. stress/chaos harness
5. flags + shadow infra
6. POC 1
7. POC 2
8. POC 3

## Success Definition

- Behavior parity maintained while backend internals become more explicit and safer.
- No user-visible regressions in session lifecycle, terminal control, or status inference.
- Migration pace remains reversible at every phase boundary.
