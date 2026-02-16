# Agentboard Privacy Policy (Engineering Claims)

This document defines machine-verifiable privacy claims for this repository.
It is an engineering policy for static consistency checks, not legal advice and not
an exhaustive runtime compliance audit.

## Scope

These claims are enforced by `bun run privacy:check`, which performs static checks
against source files and `package.json`.

## PP-001 Telemetry and analytics dependencies are denylisted

Agentboard does not include telemetry or analytics client/server SDK dependencies
from a denylist in root `package.json` (including dependencies, devDependencies,
and optionalDependencies).

## PP-002 Runtime fetch calls are local-relative only

Runtime `fetch()` usage in `src/client` and `src/server` must target local-relative
paths only (for example `/api/...`, `./...`, `../...`). Dynamic and absolute HTTP(S)
targets are disallowed by policy.

## PP-003 `/api/paste-image` writes image data to `/tmp` and returns that path

The `/api/paste-image` endpoint in `src/server/index.ts` must:
- Assign uploads to a filepath under `/tmp`
- Persist uploaded bytes to that filepath
- Return `{ path: filepath }` on success

## PP-004 Persisted browser state must use `safeStorage` with in-memory fallback

Client-side persisted Zustand stores in runtime code under `src/client` must use
`createJSONStorage(() => safeStorage)`.

`safeStorage` in `src/client/utils/storage.ts` must provide an in-memory fallback
for all storage operations (`getItem`, `setItem`, `removeItem`) when:
- `localStorage` is unavailable
- `localStorage` throws at runtime

## PP-005 Default server persistence paths resolve under `~/.agentboard`

Default persistence paths must resolve under the user home `.agentboard` directory:
- Database default path: `~/.agentboard/agentboard.db`
- Log file default path: `~/.agentboard/agentboard.log`

## Limitations

The checker is static analysis only. It does not prove runtime behavior under every
environment, dependency transitive tree behavior, or legal/privacy-regulatory compliance.
