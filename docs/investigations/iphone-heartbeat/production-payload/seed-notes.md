# Compiled-server payload fixture

Run `bun .poc-stress-test/seed/seed.ts <manifest.json>` after creating private tmux windows and before starting either compiled server. Pass the harness's isolated environment to Bun. The helper does not run tmux or start a server.

The manifest is `{ dir, claudeDir, dbPath, windows }`. Each window has `{ name, tmuxWindow, projectPath? }`. Use the full tmux target, such as `cellular-old:@0`. Use the actual window name. Startup verification uses the matching persisted display name to preserve the preseeded association when terminal content supplies no log match.

Require 23 windows. Put `dir` below `.poc-stress-test` and both `claudeDir` and `dbPath` inside `dir`. The database must not exist yet. Read `seed-result.json` for generated session IDs and measured descriptor sizes.

The first window has 2,366 media descriptors and an 8,192-character preview. Main and subagent logs avoid the extractor's 2,000-entry limit per file. The first media array targets 919,628 bytes. Each remaining window targets 19,000 bytes of media. Total media is 1,337,628 bytes, before normal session fields. Path lengths affect the minimum possible descriptor size; inspect actual output.

The generated images are valid PNGs with distinct widths to prevent extractor deduplication. The synthetic logs use a Claude envelope and recognized `image_generation_call` content for explicit labels; they exercise the real parser but do not reproduce a particular provider's transcript verbatim.

Poll the compiled server's `/api/sessions` until the first session has 2,366 media entries and all 23 windows have media. Record the actual snapshot byte size. Do not proceed on window count alone: metadata is scanned asynchronously. Use actual session-rename messages to induce registry broadcasts after hydration, and record the resulting outbound frame sizes. Do not inject replacement frames into the browser.

Local validation seeded a private SQLite database and extracted all media through `getMergedMedia`: 23 records, 2,366 entries in the largest record, exactly 919,628 bytes there, and 1,337,628 total media bytes. No server or tmux process was started. Source at tag `v0.36.3` has the same relevant extractor, subagent path, and startup fallback.
