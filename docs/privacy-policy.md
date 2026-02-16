# Privacy Policy (Engineering Claims)

This document defines machine-checkable privacy claims for Agentboard's current implementation.

Scope notes:
- These are engineering assertions enforced by static checks in this repository.
- This is not a legal policy and does not replace legal review.
- The checker is static analysis only. It does not verify runtime behavior in all environments.

## Machine-Checkable Claims

| Claim ID | Claim | Static Enforcement |
| --- | --- | --- |
| PP-001 | Server session database defaults to `~/.agentboard/agentboard.db` unless explicitly overridden by `AGENTBOARD_DB_PATH`. | `src/server/privacyPolicyChecker.ts` verifies `src/server/db.ts` default path constants. |
| PP-002 | Server log file defaults to `~/.agentboard/agentboard.log` unless explicitly overridden by `LOG_FILE`. | `src/server/privacyPolicyChecker.ts` verifies `src/server/config.ts` default path constants. |
| PP-003 | `POST /api/paste-image` writes clipboard images to `/tmp` and returns that temporary path. | `src/server/privacyPolicyChecker.ts` verifies `/api/paste-image` implementation in `src/server/index.ts`. |
| PP-004 | Browser persistence is limited to Zustand persistence backed by `safeStorage`, which uses `localStorage` (with in-memory fallback) and does not use cookies, `sessionStorage`, or IndexedDB. | `src/server/privacyPolicyChecker.ts` verifies storage configuration in client stores and `src/client/utils/storage.ts`. |
| PP-005 | `package.json` must not include denylisted telemetry/analytics dependencies (for example Sentry, Segment, PostHog, Mixpanel, Amplitude). | `src/server/privacyPolicyChecker.ts` verifies dependency names in `package.json`. |
| PP-006 | Runtime source must not contain hardcoded outbound HTTP(S)/WS(S) targets in `fetch`, `Request`, or `WebSocket` calls; only local-relative targets are allowed. | `src/server/privacyPolicyChecker.ts` scans runtime source files for disallowed literal network targets. |
