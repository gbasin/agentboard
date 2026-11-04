# Design

## Context

See proposal.md for motivation. `CodexSessionDriver.getCommandState()` currently always returns unavailable; boot initializes an app-server then starts or resumes a thread. `startCodexTurn` sends only a text input. `setProjectPath` only updates the path. The manager already snapshots command state and forwards command changes, and the shared composer already supports filtering, keyboard/pointer selection, and in-place slash insertion.

The checked-in protocol has `skills/list { cwds, forceReload }`, returning entries with `cwd`, `skills`, and `errors`; each skill reports name, description, path, scope and enabled. `skills/changed` is an invalidation notification. `UserInput` includes `{ type: 'skill', name, path }`. `AppServerClient` requests already have a 30-second deadline and reject on process exit. These local types ground this design; no inferred Codex terminal command catalog is needed.

## Goals / Non-Goals

**Goals:** supply the existing composer contract from Codex's own effective skill catalog; preserve exact human text and explicitly attach referenced skills; ensure discovery races never cross process or directory boundaries.

**Non-Goals:** terminal commands such as `/model` or `/status`, file/path or prose completion, a `$` completion menu, enumerating plugins separately, reading SKILL.md files ourselves, changing Claude behavior, durable catalog storage, or a new database/slot/recovery mechanism. Codex's native handling of plain `$skill` text remains upstream behavior.

## Decisions

### D1. Use agent discovery and retain paths only on the server

Add `src/server/chat/codex/codexCommands.ts` for catalog normalization and input resolution. Ask the running session's existing app-server for `skills/list` with `cwds: [projectPath]`; its existing launch environment supplies the Codex home. Do not scan host directories or share catalogs across chats/homes. Accept exactly one entry whose normalized absolute cwd equals the requested cwd; use lexical path normalization, not prefix matching. No matching entry, multiple matching entries, or malformed response structure is a discovery failure. Other cwd entries are ignored.

For that entry, include only enabled skills with a nonempty absolute path and a slash-safe name matching `[A-Za-z0-9][A-Za-z0-9._:-]*`. Trim no names or paths. Exclude case-insensitive `clear`, `reset`, and `new`. Group by exact case-sensitive name: repeated records with the same path collapse to the first; different paths for the same name exclude the entire name. Do not invent precedence between paths. Exclude malformed individual records while keeping valid siblings; entry-level `errors` are logged without file content and do not discard valid skills. Description uses `interface.shortDescription`, then `shortDescription`, then `description`, taking the first nonempty string. Map repo scope to `project`, user scope to `user`, and system/admin to the existing `builtin` source. Use empty aliases and no invented argument hints. Sort by name using a deterministic code-unit comparator.

Publish only the existing `ChatCommand` metadata. Keep the exact name-to-path map privately, derived once alongside that list, so the composer and submission resolver cannot disagree. A client-supplied path is never accepted. Alternative: adding path-bearing selection metadata throughout the shared wire protocol would increase scope and make manual typing a different code path.

### D2. Refresh independently of turn readiness

Replace the unavailable constant with per-driver state and use the existing command-state callback. Start discovery after successful thread start/resume as a detached operation; do not include its promise in `ready` or any send path. `setProjectPath` invalidates old state immediately and refreshes if the client is ready; if boot is pending, refresh after boot using the latest path. A `skills/changed` notification refreshes with `forceReload: true`; directory changes also force reload, initial boot can use the upstream cache.

Each trigger immediately publishes loading with an empty list/map and supersedes any prior request. Capture client identity, requested cwd, and a unique request identity; completion can publish only while all three still match. Request identity is an in-memory async callback guard, not a lease, slot, or persisted revision. Rapid invalidations during an in-flight request coalesce to one follow-up scan for the latest context; superseded results are ignored and cannot briefly appear. At most one discovery request per live client is in flight. A process change may start its own request while the ended process's promise settles.

On current request failure, unsupported method, malformed response, or timeout, publish unavailable with an empty list/map. Do not emit a failed chat turn or alter chat status. A later notification, directory change, or process start retries; no new retry timer. On process exit/archive/kill/restart/shutdown, invalidate pending work and publish unavailable. Archived attach uses the existing no-start guard. Identical state publications can be deduplicated. Catalog state is ephemeral and is rediscovered after restart.

### D3. Preserve slash insertion and attach native skill inputs

Reuse the shared `/` menu unchanged. A human `send(text)` captures skill inputs synchronously against the current ready catalog; that snapshot is fixed for the accepted send. Tokenize by whitespace and match only complete words equal to `/<eligible-name>`, case-sensitively. Multiple references attach one skill per name, ordered by first occurrence. URLs, path segments, punctuation-suffixed names, and partial names do not resolve. This follows the composer's whitespace-word model; there is no special Markdown/code-block exclusion, so a standalone slash name in code also counts. Unknown/loading/unavailable references are plain text and never delay a send.

Pass the unchanged text as the first `UserInput`, followed by resolved `{type: 'skill', name, path}` inputs into the existing `turn/start` flow, including a send during a running turn. The send-time snapshot prevents a boot completion from unexpectedly changing an already accepted message. `deliver(envelope)` explicitly passes no skill attachments, independent of envelope text. Internal continuations must likewise default to none. No browser path metadata, hidden prompt expansion, or synthetic user turn is introduced.

Alternative: inserting `$name` would change the shared menu's specified slash insertion and require client/protocol work. Native skill input supplies explicit invocation while leaving the existing composer and transcript text intact. A fake-server test must inspect the actual native input, and a controlled live smoke must confirm the supported installed Codex accepts text plus skill input together.

### D4. Preserve the existing client and history contracts

The manager's `getCommands` snapshot and `onCommandState` fanout serve Codex state just as they serve Claude state. Verify production driver creation wires the callback; do not rely only on a helper harness. The composer remains session-scoped and client-local reset/new handling stays ahead of any agent send. Do not list reserved skill names. A middle-of-message `/clear` remains ordinary text.

Codex skill inputs must not become additional user transcript rows or expose SKILL.md content. Test a representative rollout containing a skill invocation through `codexRollout.ts`; preserve the text row and suppress protocol skill metadata as user prose if the existing parser needs adjustment. Changes stay in Codex normalization rather than generic transcript handling.

## Acceptance oracles

Tables below are acceptance data and must be committed verbatim as table-driven tests with their implementation. `*` means don't-care. C and S are staged decisions, with the evaluation order below; W lists independent integration cases. L partitions lifecycle event decisions. For lifecycle rows, visible list state and command pushes are the outputs, not private counters. Use the production driver, fake app-server, manager composition, and browser seams to avoid the hand-built-harness hazard in `docs/oracle-hazards.md`.

### Catalog table C

Evaluate response rows C1-C4 first; for a valid matching entry apply C5-C9 per name group. Empty eligibility yields ready/empty.

| Id | Input | Observable result |
| --- | --- | --- |
| C1 | Exactly one matching cwd entry, eligible repo/user/system/admin skills | Ready, sorted names/descriptions, project/user/builtin source respectively; no paths on client |
| C2 | Valid matching entry, no eligible skills | Ready, empty commands |
| C3 | Missing/duplicate matching cwd entry or malformed response container | Unavailable, empty commands |
| C4 | Other cwd entries beside one matching entry | Only matching cwd skills offered |
| C5 | Disabled or malformed record, valid siblings | Record excluded; valid siblings offered |
| C6 | Name clear/reset/new in any case | Name excluded |
| C7 | Repeated enabled eligible exact name and same path | One command using first record metadata |
| C8 | Enabled eligible exact name with different paths | Entire name excluded |
| C9 | Matching entry has skill-load errors and valid skills | Ready with valid skills |

### Lifecycle table L

Rows apply per incoming event. Reply freshness is the conjunction of current client, cwd, and request identity. An ended client has no current request. At boot, attach triggers existing process start; discovery is requested only once thread readiness succeeds.

| Id | Event | Context | Observable result |
| --- | --- | --- | --- |
| L1 | Start/resume succeeds | Live client, no discovery pending | Loading/empty then discovery for latest cwd; no model turn |
| L2 | Skills changed or cwd changes | Live ready client, no discovery pending | Loading/empty; discovery for current cwd with forceReload |
| L3 | Skills changed or cwd changes | Discovery pending, or boot pending | Loading/empty; one latest-context follow-up after pending request/boot settles |
| L4 | Discovery reply | Current request, valid response | Ready with C table result |
| L5 | Discovery rejection/timeout or invalid response | Current request | Unavailable/empty; normal sends unaffected |
| L6 | Discovery reply or rejection | Superseded request, any outcome | No state publication from old result; pending latest-context scan proceeds if live |
| L7 | Agent exits or is stopped | * | Unavailable/empty; no later reply restores candidates |
| L8 | Client reconnects | Live chat, any catalog state | Snapshot contains current state/list; no model turn |
| L9 | Client attaches or skill invalidation arrives | Archived/stopped chat without a live client | Unavailable/empty; no discovery request |

L4's valid response means successful structural matching under C; an invalid container follows L5/C3. A reply cannot be both fresh and superseded, and an ended client cannot have a fresh request. Events are start-success, invalidation, completion, end, reconnect, and attach; for each, the live/boot/pending/fresh axes select one applicable row. Completion of a superseded scan with no live client remains L6 with no follow-up. Startup has no persisted catalog to reconcile and no transaction boundaries.

### Submission table S

Apply S1 first by origin; then S2 by catalog state; then S3-S6 per word with deduplication. Text is unchanged in every row.

| Id | Origin / catalog / text | Observable Codex input |
| --- | --- | --- |
| S1 | Peer or internal continuation / * / contains slash references | Text only; no skill inputs |
| S2 | Human / loading or unavailable / * | Text only, request does not await discovery |
| S3 | Human / ready / exact eligible slash word anywhere | Original text then skill with server-reported name/path |
| S4 | Human / ready / unknown, removed, ambiguous, disabled, reserved name | No skill for that word |
| S5 | Human / ready / path, URL, case mismatch, punctuation suffix, partial name | No skill for that word |
| S6 | Human / ready / repeated and multiple exact eligible references | One skill input per name, first-reference order |
| S7 | Human accepted in ready state; catalog changes before turn/start | Skill identities captured at send remain fixed |

### Production integration and UI table W

| Id | Input / seam | Observable result |
| --- | --- | --- |
| W1 | Real manager driver factory, attach two subscribers then refresh skills | Both receive loading/ready changes; reconnect snapshot matches |
| W2 | Codex composer: name/description filter, Up/Down then Tab/Enter; pointer hover/click | Visible selection follows choice; replaces only caret word with slash name and space; sends nothing |
| W3 | Codex composer: later line, path, Escape, no-match Enter | Later line opens; paths do not; Escape preserves draft; no-match sends text |
| W4 | Local /clear, /reset, /new versus middle-of-message /clear | Local commands keep profile/policy and create/archive as before; middle word goes unchanged with no skill |
| W5 | Codex rollout with text plus explicit skill input, replay and reconnect | Human text appears once unchanged, no skill-file content or metadata user row |
| W6 | Claude composer and driver regression fixture | Existing command discovery, insertion, and submission unchanged |

### Properties

- **P1: Catalog order is independent of unique-record input order.** Generate 500 seeded permutations of distinct eligible name/path records and disabled siblings; seed `0xC0DE01`. Seam: production catalog normalizer; assert identical ordered list/map. Same-name differing metadata is excluded from this property because C7 intentionally uses the first record.
- **P2: Skill input paths come only from the accepted catalog.** Generate 1,000 messages with known/unknown slash words, paths, URLs, punctuation, case variants, duplicates, and peer origins; seed `0xC0DE02`. Seam: production resolver plus recorded driver turn/start; assert every attached pair is in the send-time catalog and text is byte-identical.
- **P3: Superseded discovery never publishes its candidates.** Run 300 sequences of 40 seeded events (boot, invalidate, change cwd, resolve/reject old and current requests, duplicate notification, exit, respawn, reconnect), seed `0xC0DE03`. Use L as the reference model with scripted RPC replies and fake clock. Assert published states and requested cwd/forceReload, including at process crashes before request, after request, before publication, and after publication; a restart begins unavailable and rediscovers. There are no database transaction boundaries in this ephemeral state. Use existing test utilities, no new dependency.

## Risks / Trade-offs

- [Same-named skills in different paths are hidden] → Avoid invoking an arbitrary identity; report a concise server diagnostic, with no new UI warning flow. A later disambiguation UI is separate scope.
- [Slash words in code can invoke skills] → Exact whitespace boundaries are explicit; attach only catalog-listed names, and never inspect peer envelopes for invocation.
- [Discovery fails on an installed version] → Degrade to unavailable while chat continues. Use supported checked-in methods; validate text-plus-skill input on the installed baseline before declaring implementation complete.
- [Skill selection becomes stale before send] → Only the current ready catalog is resolved, with a fixed send-time snapshot. A missing skill becomes plain text; Codex reports any subsequent file disappearance normally.
- [Refresh storms] → Coalesce invalidations into one follow-up scan per client; use existing bounded RPC requests. No polling timer or persistent cache.

## Migration Plan

No database migration or dependency change. Ship the server catalog and invocation path with tests, verify existing manager/client wiring, then run the browser and controlled Codex smoke. Rollback removes the discovery/invocation additions and restores unavailable commands for Codex; existing transcripts remain readable because human text stays unchanged.
