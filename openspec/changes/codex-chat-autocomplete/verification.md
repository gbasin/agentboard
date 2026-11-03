# Codex autocomplete verification

Implementation branch: `feat/codex-chat-autocomplete`; worktree: `.worktrees/codex-chat-autocomplete`.

## Recorded checks

- Strict OpenSpec validation passed.
- Focused acceptance: 37 tests passed across the six new test files; the combined run including specification and file-read guards passed 39 tests.
- Production browser test `Codex autocomplete selects without sending, refreshes both browsers, and invokes the exact native skill` passed. It checks name/description filtering, real caret movement, keyboard/pointer selection without sending, two-browser catalog refresh, exact native skill input, unknown text, and profile/policy-preserving `/clear`, `/reset`, `/new` creation/archive behavior.
- Existing Codex browser regression `a Codex chat drives the app-server: approval card, question card, and a live peer turn` passed in an independent server.
- Existing Claude typing/menu browser regression passed all four combinations of 0/500 prior messages and idle/streaming output. Browser runs used `NODE_ENV=development`, `AGENTBOARD_CHAT_FIXTURE=1`, separate ports, and isolated database/log/tmux homes from `playwright.config.ts`.
- `bun run build` passed. Browser screenshots are generated under ignored `test-results/chat-codex-autocomplete-Co-4115c-okes-the-exact-native-skill/` (`codex-autocomplete-menu.png`, `codex-autocomplete-invoked.png`).
- Installed Codex 0.166.0 smoke on 2026-11-02: a temporary project and Codex home with an existing login discovered `autocomplete-smoke` before any model turn. Text plus `{type: 'skill', name, path}` completed successfully with `AUTOCOMPLETE_SMOKE_OK`. Replaying the actual rollout after the fix yielded exactly one user message, `/autocomplete-smoke Please follow the attached skill.`, and that assistant answer. Temporary credentials were removed. The sanitized observed format is preserved in `src/server/__tests__/fixtures/codex/skill-invocation.jsonl`.
- Mutation verification detected 31 deliberate behavioral regressions. Source was restored after every trial. A separate removal of discovery's cleanup publication was unobservable through the manager's archived-session fallback; that redundant-path trial is excluded from the killed set below. The direct stopped-invalidation mutant was detected after adding an explicit stopped-state assertion.
- Full repository check is recorded by the final clean-tree check certificate; no push or merge is part of this change.

## Reproduction

```sh
bun run test src/server/__tests__/codexCommands.test.ts src/server/__tests__/codexCommandDiscovery.test.ts src/server/__tests__/codexSkillInputs.test.ts src/server/__tests__/codexSkillReplay.test.ts src/server/__tests__/codexCommandConnections.test.ts src/client/__tests__/codexAutocomplete.test.tsx
bun run build
NODE_ENV=development AGENTBOARD_CHAT_FIXTURE=1 E2E_PORT=4287 bun run test:e2e tests/e2e/chat-codex-autocomplete.spec.ts --workers=1
NODE_ENV=development AGENTBOARD_CHAT_FIXTURE=1 E2E_PORT=4288 bun run test:e2e tests/e2e/chat-codex.spec.ts --workers=1
NODE_ENV=development AGENTBOARD_CHAT_FIXTURE=1 E2E_PORT=4289 bun run test:e2e tests/e2e/chat-typing-performance.spec.ts --workers=1
openspec validate codex-chat-autocomplete --strict
bun run check
```

Use a matching installed Playwright Chromium (or set `PLAYWRIGHT_BROWSERS_PATH` to its cache). Run Codex browser files in separate servers because the usage fill is intentionally once per Codex home. P1 uses seed `0xC0DE01`, 500 permutations; P2 uses `0xC0DE02`, 1,000 messages through helper and production-driver seams with human/peer origins; P3 uses `0xC0DE03`, 300 sequences of 40 lifecycle events.

## Oracle map

Each entry names an exact test title and an actually detected mutant. Rows sharing a test use its distinct assertions; the C/L/S/W tables are preserved verbatim in their test files.

| Oracle | Test file | Exact test title | Killed mutant |
| --- | --- | --- | --- |
| C1 | `src/server/__tests__/codexCommands.test.ts` | C1: source and descriptions follow metadata precedence; client metadata contains no paths | `C1-source` |
| C2 | `src/server/__tests__/codexCommands.test.ts` | C2: Valid matching entry, no eligible skills [case 0] | `C2-empty-failure` |
| C3 | `src/server/__tests__/codexCommands.test.ts` | C3: Missing/duplicate matching cwd entry or malformed response container [case 1] | `C3-duplicate-cwd` |
| C4 | `src/server/__tests__/codexCommands.test.ts` | C4: Other cwd entries beside one matching entry [case 8] | `C4-cwd-leak` |
| C5 | `src/server/__tests__/codexCommands.test.ts` | C5: Disabled or malformed record, valid siblings [case 9] | `C5-disabled` |
| C6 | `src/server/__tests__/codexCommands.test.ts` | C6: Name clear/reset/new in any case [case 10] | `C6-reserved` |
| C7 | `src/server/__tests__/codexCommands.test.ts` | C7: Repeated enabled eligible exact name and same path [case 11] | `C7-first-metadata` |
| C8 | `src/server/__tests__/codexCommands.test.ts` | C8: Enabled eligible exact name with different paths [case 12] | `C8-conflicting-path` |
| C9 | `src/server/__tests__/codexCommands.test.ts` | C9: Matching entry has skill-load errors and valid skills [case 13] | `C9-sibling-errors` |
| L1 | `src/server/__tests__/codexCommandDiscovery.test.ts` | L1/L4: production driver starts discovery after boot, before a model turn, and refreshes on resume | `L1-missing-boot-discovery` |
| L2 | `src/server/__tests__/codexCommandDiscovery.test.ts` | L1-L4/L6: invalidations coalesce and never publish a superseded cwd, including a return to the same cwd | `L2-force-reload` |
| L3 | `src/server/__tests__/codexCommandDiscovery.test.ts` | L1-L4/L6: invalidations coalesce and never publish a superseded cwd, including a return to the same cwd | `L3-parallel-scan` |
| L4 | `src/server/__tests__/codexCommandDiscovery.test.ts` | L1/L4: production driver starts discovery after boot, before a model turn, and refreshes on resume | `L4-no-ready` |
| L5 | `src/server/__tests__/codexCommandDiscovery.test.ts` | L5: a real RPC timeout leaves ordinary turns working without awaiting discovery | `L5-failure-loading` |
| L6 | `src/server/__tests__/codexCommandDiscovery.test.ts` | L1-L4/L6: invalidations coalesce and never publish a superseded cwd, including a return to the same cwd | `L6-stale-request` |
| L7 | `src/server/__tests__/codexCommandDiscovery.test.ts` | L5-L7/L9: failure, stopped invalidation, and late process replies cannot restore candidates | `L7-stop-keeps-catalog` |
| L8 | `src/server/__tests__/codexCommandConnections.test.ts` | W1/L8/L9/C4: two subscribers see refreshed Codex commands and reconnect snapshots without cross-session leakage | `L8-stale-snapshot` |
| L9 | `src/server/__tests__/codexCommandDiscovery.test.ts` | L5-L7/L9: failure, stopped invalidation, and late process replies cannot restore candidates | `L9-stopped-invalidation` |
| S1 | `src/server/__tests__/codexSkillInputs.test.ts` | S1/S7: peer text never attaches skills; active-turn human inputs keep their send-time identities | `S1-peer-parsed` |
| S2 | `src/server/__tests__/codexSkillInputs.test.ts` | S2: a send accepted before discovery stays plain text even when boot discovers the skill | `S2-resolve-after-ready` |
| S3 | `src/server/__tests__/codexSkillInputs.test.ts` | S3: Human / ready / exact eligible slash word anywhere on an actual Codex turn | `S3-attachment-removed` |
| S4 | `src/server/__tests__/codexSkillInputs.test.ts` | S4: Human / ready / unknown, removed, ambiguous, disabled, reserved name on an actual Codex turn | `S4-unknown-path` |
| S5 | `src/server/__tests__/codexSkillInputs.test.ts` | S5: Human / ready / path, URL, case mismatch, punctuation suffix, partial name on an actual Codex turn | `S5-case-fold` |
| S6 | `src/server/__tests__/codexSkillInputs.test.ts` | S6: Human / ready / repeated and multiple exact eligible references on an actual Codex turn | `S6-order-reversed` |
| S7 | `src/server/__tests__/codexSkillInputs.test.ts` | S1/S7: peer text never attaches skills; active-turn human inputs keep their send-time identities | `S7-send-snapshot-lost` |
| W1 | `src/server/__tests__/codexCommandConnections.test.ts` | W1/L8/L9/C4: two subscribers see refreshed Codex commands and reconnect snapshots without cross-session leakage | `W1-callback-unwired` |
| W2 | `src/client/__tests__/codexAutocomplete.test.tsx` | W2/W6: codex filters, highlights and inserts at the caret by keyboard and pointer without sending | `W2-W6-insert-at-end` |
| W3 | `src/client/__tests__/codexAutocomplete.test.tsx` | W3/W6: codex later lines, paths, Escape and unknown-command sending retain existing behavior | `W3-path-opens` |
| W4 | `src/client/__tests__/codexAutocomplete.test.tsx` | W4: Codex /clear keeps the profile and policy, archives after creation, and middle /clear stays text | `W4-local-forwarded` |
| W5 | `src/server/__tests__/codexSkillReplay.test.ts` | W5/S3: native skill rollout replays the submitted text once without injected skill content | `W5-expanded-skill-visible` |
| W6 | `src/client/__tests__/codexAutocomplete.test.tsx` | W2/W6: claude filters, highlights and inserts at the caret by keyboard and pointer without sending | `W2-W6-insert-at-end` |
| P1 | `src/server/__tests__/codexCommands.test.ts` | P1: 500 seeded unique-record permutations produce identical ordered catalogs | `P1-order` |
| P2 | `src/server/__tests__/codexSkillInputs.test.ts` | P2: 1000 seeded messages preserve text and attach only exact accepted identities | `S3-attachment-removed` |
| P3 | `src/server/__tests__/codexCommandDiscovery.test.ts` | P3: 300 seeded 40-event sequences agree with lifecycle publication model across crashes and stale replies | `L6-stale-request` |
