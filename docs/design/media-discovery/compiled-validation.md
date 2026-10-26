# Compiled media discovery validation

Final source-freeze candidate validated 2026-10-26 on Darwin arm64 with Bun 1.3.14. This artifact includes the lifecycle fixes and global metadata publication batching. It was built from the frozen working tree while HEAD was `a63c618144fd76adf6fbbd3a45cefbfac904c0b0`; pending changes were included. Its SHA-256 is `63f239c03b1c98d50dc8d1e2c39d818deae3176b273a6fd2d4778b5d5ea50966`. This result supersedes the earlier snapshot validation.

Runtime source is committed as `7bbe0c8`; later regression/documentation commits do not change this executable.

## Build

`bun run build` passed. The release-shaped compile passed with both discovery workers as explicit entrypoints:

```sh
bun build src/server/index.ts src/server/sessionRefreshWorker.ts src/server/logMatchWorker.ts src/server/devinSyncWorker.ts src/server/stallWatchdogWorker.ts src/server/sessionReadWorker.ts src/server/sessionMetadataWorker.ts src/server/mediaDiscoveryReaderWorker.ts src/server/mediaDiscoveryWriterWorker.ts src/server/mediaThumbnailWorker.ts src/server/terminalRelayWorker.ts src/server/terminalSessionWorker.ts --compile --outfile /tmp/agentboard-media-discovery-candidate
bun scripts/verify-media-discovery-binary.ts /tmp/agentboard-media-discovery-candidate
bun scripts/verify-terminal-relay-binary.ts /tmp/agentboard-media-discovery-candidate
```

The compile bundled 343 modules. No discovery source files were newer than the tested artifact. Typecheck and the new script's scoped lint passed.

## Media smoke

The regression launches the actual compiled server on a reserved ephemeral port. It seeds a private database with a dormant transcript containing 120 links and two distinct PNG images. The transcript is 2,972,204 bytes and crosses the writer's default slice budget. It makes real HTTP requests through the compiled relay and checks:

- A cold JSON snapshot is empty and pending. Reading it does not start a transcript scan.
- A finite NDJSON stream starts with a snapshot, discovers items, reports ready, and ends with `done`.
- Every stream frame is at most 64 KiB; the stream stays below 512 KiB.
- Pagination returns all 122 unique items within the JSON page byte limit.
- A 5,500-character-plus external destination survives indexing unchanged. Its payload route redirects to the complete destination.
- Image neighbors agree with page order. Original image bytes match the fixture.
- After graceful shutdown and restart, the persisted page remains readable with the transcript renamed out of the way.
- Both server shutdowns complete with exit code zero within ten seconds.

Observed timings are from one local run, not performance guarantees:

| Measurement | Result |
|---|---:|
| Cold indexed snapshot | 84 ms |
| First nonempty streamed snapshot | 29 ms |
| Discovery completion | 130 ms |
| Stream frames / bytes | 5 / 15,682 |
| Persisted snapshot after restart, source absent | 61 ms |

The fixture initially reused identical image bytes and produced 121 items because image deduplication is intentional. The final regression uses two distinct PNGs and expects 122 items.

This smoke verifies the complete link destination in the API and redirect, not the browser clipboard permission/UI flow. It does not reproduce the reported minute-long delay, validate every release platform, or replace Safari/browser testing.

## Terminal compatibility

The existing compiled relay regression passed on the same executable: HTTP, real terminal attach, retained reconnect using the same observer, input/output echo, six concurrent observers, expiry, idle worker reuse, agent survival, and graceful shutdown with exit code zero.

## Isolation and cleanup

Both scripts use private temporary tmux sockets, data directories, databases, logs, and provider homes. Every child receives an explicit environment without `TMUX` or `TMUX_PANE`. Neither script contacts port 4040. The scripts stop their compiled servers, remove their own tmux sessions, and remove their temporary fixture directories. No compiled smoke process remains running.
