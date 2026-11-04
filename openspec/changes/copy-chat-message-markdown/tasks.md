# Tasks

## 1. Clipboard helper

- [x] 1.1 Add `copyTextExact` to the existing `src/client/utils/copyText.ts` (D3), leaving `copyText` and its callers unchanged. It uses the async API when `window.isSecureContext` and `navigator.clipboard?.writeText` are present. Otherwise, or after a rejection, it uses the one-shot capturing `copy`-listener plus `document.execCommand('copy')` fallback, removing the listener in `finally`. It returns `Promise<boolean>`. Update the module's header comment to describe both exports.
- [x] 1.2 Add `src/client/__tests__/copyText.test.ts`, testing `copyTextExact`, with design table C1–C5 committed verbatim as table-driven rows (inputs, outcome, async called, fallback called). Restore every global stub after each test. Verify: `bun run test src/client/__tests__/copyText.test.ts` passes. C1 kills the mutant "always use the fallback". C2 kills "return false after an async rejection". C3 kills "trust execCommand's return without checking that the listener ran". C4 kills "skip the `isSecureContext` check". C5 kills "return true when the fallback throws".
- [x] 1.3 In the same file, add property P1 (seeded LCG, seed `0x5eed`, 200 cases, covering the C1 and C4 paths). Verify: it passes, and it kills the mutant that writes `text.replace(/\r\n/g, '\n')` on the fallback path.

## 2. Copy control in message rows

- [x] 2.1 Add `src/client/components/chat/MessageCopyButton.tsx` (D4). It has `idle | copied | failed` state, the `Copy01Icon`/`CheckIcon`/`AlertCircleIcon` line icons, a 2000 ms reset that restarts on each click and is cleared on unmount, the accessible name `Copy message`, and a visually hidden `role="status"` span holding `Copied` or `Copy failed`.
- [x] 2.2 Give `MessageRow` in `ChatRow.tsx` an optional `copyText` prop that renders `MessageCopyButton` in `.chat-row-meta` after `ChatTime`. In `ChatMessages.tsx`, add `copyText` to `message()` (D1): `event.text` for user and assistant rows, `event.body` for peer rows. Update both files' header comments.
- [x] 2.3 Add `.chat-row-copy` styles to `src/client/styles/index.css` (D2). The control has `opacity: 0` by default, is visible on `.chat-row:hover` and `.chat-row:focus-within`, and is always visible under `@media (hover: none)`. It reserves its space so showing it never shifts layout, and it fits both gutter and stacked layouts.
- [x] 2.4 Add a table-driven test in `src/client/__tests__/chatTranscriptRows.test.tsx` (or a new `chatMessageCopy.test.tsx`) that renders real events through `ChatMessages` and clicks the real button (hazard M1). Commit S1–S4 verbatim. Include a merged text → tool → text assistant message: the second row must copy only its own text. Include a user message with a workspace context, and a peer message with tags, task, and thread. Verify: S1 kills "copy `textContent`", S2 kills "copy the first block of the message id", S3 kills "copy the rendered peer body including metadata", and S4 kills "render the control on aside rows". Annotate each test with `// @covers: chat-sessions › Transcript messages can be copied as their original text › <scenario>`.
- [x] 2.5 Add fake-timer tests F1–F5 for `MessageCopyButton` through the same composition. Assert the accessible name, the `role="status"` text, and that an archived-chat render shows the control. Verify: F2 kills "never reset", F3 kills "keep the first timer on a re-click", F4 kills "reset only after success", and F5 kills "skip the cleanup on unmount" (the test asserts no state-update warning and no timer is left). Add `@covers` annotations for the outcome and accessibility requirements' scenarios.
- [x] 2.6 Run `src/client/__tests__/chatTypingPerformance.test.tsx` and confirm it still passes unchanged.

## 3. Documentation

- [ ] 3.1 Extend the chat transcript bullet in `docs/architecture/chat.md`. Cover the per-row copy control, which copies the event's source text (not the DOM), its placement in the metadata slot, and the `copyText` fallback for insecure contexts. Verify: `bun run lint` passes and the readsGuard and specCoverageGuard tests pass.

## 4. Browser verification

- [ ] 4.1 Add `tests/e2e/chat-message-copy.spec.ts`, a fixture spec (`AGENTBOARD_CHAT_FIXTURE=1`) that grants `clipboard-read` and `clipboard-write`. It sends `markdown`, hovers the assistant row, clicks **Copy message**, and asserts that the clipboard text contains the fixture's raw Markdown (`#`, code fences, `|` table rows) and that the row shows `Copied`. It asserts the control is hidden before hover and the row's bounding box is unchanged after hover. A second test removes `navigator.clipboard` with `addInitScript` to force the D3 fallback, then asserts that the same text is copied. A third test checks keyboard focus visibility. Add the spec to the fixture `playwright test` list in `.github/workflows/ci.yml`, then parse ci.yml with `Bun.YAML.parse`. Verify: run `bun run build`, then run the spec on a spare `E2E_PORT` and confirm it passes.
- [ ] 4.2 Run `bun run check` on the clean committed tree and confirm it passes. Run `openspec validate copy-chat-message-markdown --strict` and confirm it passes.

## Workflow follow-up

- Archive the change after review, syncing the three ADDED requirements into `openspec/specs/chat-sessions/spec.md`, with `@covers` annotations already in place.
