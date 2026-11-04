# Design

## Context

`ChatMessages.tsx` maps each visible event to a row. Its `message()` helper
returns author, role, and body for the three message kinds
(`user_message` → `event.text`, `assistant_text` → `event.text` rendered
through `Markdown.tsx`, `peer_message` → `event.body`). It passes them to
`MessageRow` in `ChatRow.tsx`, which renders a metadata slot
(`.chat-row-meta`: author and `ChatTime`) and a body slot. Assistant text
blocks are merged per entry before rendering (docs/architecture/chat.md,
chat transcript bullet), so an entry's `text` is exactly the source of what
its row shows. Every other event kind renders as an `AsideRow`.

The browser already holds every message's original string, so no server work
is needed. The only clipboard writes today are in `Header.tsx` (unguarded
`navigator.clipboard.writeText`) and the terminal's `pasteChannel.ts`, which
falls back to a manual-copy dialog. Kawai is commonly served over
`http://<lan-or-tailscale-ip>:4040`. That is not a secure context, so
`navigator.clipboard` is undefined there.

## Goals / Non-Goals

**Goals:**
- Copy each message row's stored source string byte for byte, from the event
  and never from the DOM.
- Work in insecure contexts and report failure visibly.
- Keep the row layout and the typing-performance budget unchanged.

**Non-Goals:**
- Copying a whole turn, a selection, tool output, command output, or notices.
- Rich-text (`text/html`) clipboard flavors. Only `text/plain` is written.
- Changing `Header.tsx` or the terminal clipboard paths.

## Decisions

### D1 — The copy source is the event field, chosen in `message()`

`message()` gains a `copyText` field: `event.text` for user and assistant
rows, `event.body` for peer rows. `MessageRow` takes an optional `copyText`
prop and renders the control only when the prop is given, so aside rows never
get one (S4). *Alternative:* read `textContent` from the rendered body. That
was rejected because it is exactly the lossy behavior this change fixes, and
it would also pick up workspace-context lines and peer metadata.

### D2 — The control lives in the metadata slot

`MessageCopyButton` renders inside `.chat-row-meta`, after `ChatTime`. In
gutter layout it sits under the author and time. In stacked layout it sits
beside the time. Either way it never overlaps body text, which an absolutely
positioned overlay in the body's top-right corner would do on short or
wide-code rows. Space for the button is always reserved: it is hidden with
`opacity: 0`, not `display: none`, so showing it causes no layout shift. It
becomes visible on `.chat-row:hover` and `.chat-row:focus-within`, and always
under `@media (hover: none)`. An `opacity: 0` button stays focusable, and
focusing it triggers `:focus-within`, so keyboard users always see it.

### D3 — Clipboard helper with an event-based fallback

`src/client/utils/copyText.ts` already exports `copyText(text): void`, a
textarea select-and-copy with an async-API fallback whose result is discarded,
used by seven call sites (debug panel, mailbox, session rows, terminal clipboard
offer). It stays unchanged; migrating those callers is out of scope. The same
module gains `copyTextExact(text): Promise<boolean>`:

1. If `window.isSecureContext` and `navigator.clipboard?.writeText` exist,
   await `writeText(text)`. On success, return true.
2. Otherwise, or after a rejection, use the fallback. Add a one-shot
   capturing `copy` listener on `document` that calls
   `event.clipboardData.setData('text/plain', text)` and `preventDefault()`.
   Then call `document.execCommand('copy')` and remove the listener in
   `finally`. Return true only if `execCommand` returned true **and** the
   listener ran.
3. Any thrown error returns false.

*Alternative:* the hidden-`<textarea>` select-and-copy trick. Rejected
because setting a textarea's value normalizes CR/CRLF line endings, which
breaks the byte-for-byte guarantee. The `copy`-event route writes the string
untouched and changes neither the user's selection nor focus. The helper is
called synchronously from the click handler, so the fallback runs inside the
user gesture when the async API is absent. After an async rejection it runs
within the gesture's transient-activation window.

### D4 — Feedback state is local to each button

`MessageCopyButton` holds `idle | copied | failed`. It shows the Untitled UI
line icons `Copy01Icon` when idle, `CheckIcon` when copied, and
`AlertCircleIcon` when failed, each imported by its
`@untitledui-icons/react/line/esm/<Name>` path like the existing chat icons.
After a result it returns to `idle` after 2000 ms. A new click restarts that
timer, and unmount clears it. The button's accessible name stays
`Copy message`. A visually hidden `role="status"` span inside it holds
`Copied` or `Copy failed` while that state lasts, so the outcome is
announced. State is per row, so a copy never re-renders the transcript. The
`chatTypingPerformance` budget is unaffected because the button only receives
a string prop.

### Acceptance oracles

Oracle tests run through the production composition (`ChatMessages`
rendering real events, then clicking the real button), per hazard M1 in
docs/oracle-hazards.md. Only C1–C5 may also be tested on `copyTextExact` directly.

**Copy source (per row kind):**

| id | event type | control rendered | clipboard text |
|----|------------|------------------|----------------|
| S1 | `user_message` | yes | `event.text`, with no workspace-context label |
| S2 | `assistant_text` (merged entry) | yes | the merged entry's `event.text`, Markdown source |
| S3 | `peer_message` | yes | `event.body` only |
| S4 | any other type (tool_call, tool_result, notice, error, command_output, turn lines, request lines) | no | — |

**Copy outcome** (`async` = secure context and `writeText` present; `*` = don't care):

| id | async available | async result | fallback result | outcome | async called | fallback called |
|----|-----------------|--------------|-----------------|---------|--------------|-----------------|
| C1 | yes | resolves | * | Copied | yes | no |
| C2 | yes | rejects | listener ran and execCommand true | Copied | yes | yes |
| C3 | yes | rejects | execCommand false, throws, or listener did not run | Copy failed | yes | yes |
| C4 | no | * | listener ran and execCommand true | Copied | no | yes |
| C5 | no | * | execCommand false, throws, or listener did not run | Copy failed | no | yes |

Unreachable: async unavailable with an async result. The async API is never
called, so that column is a don't-care in C4 and C5.

**Feedback timing (fake timers):**

| id | sequence | state |
|----|----------|-------|
| F1 | success, then +1999 ms | copied |
| F2 | success, then +2000 ms | idle |
| F3 | success, click again at +1500 ms, success, then +1999 ms from the second click | copied |
| F4 | failure, then +2000 ms | idle |
| F5 | success, then unmount before 2000 ms | no timer fires and no state update after unmount |

**Property P1 — byte-for-byte round trip** (on `copyTextExact`). For any string, the clipboard
text equals the event string on both the C1 and C4 paths. Generator: a seeded
LCG (seed `0x5eed`, 200 cases) that builds strings from a pool of Markdown
syntax (`#`, `- `, ```` ``` ````, `|`, `[a](b)`, `~~`), `\r\n`, `\n`, `\t`,
trailing spaces, non-BMP emoji, and RTL text. Seams: a stubbed
`navigator.clipboard.writeText` for C1, and a stubbed `execCommand` that
dispatches a synthetic `copy` event with a recording `clipboardData` for C4.
No new dependency.

## Risks / Trade-offs

- [`document.execCommand` is deprecated] → It remains supported in every
  browser Kawai targets. It is only the fallback, and a failure reports
  "Copy failed" instead of losing data silently.
- [Some browsers, Safari for example, drop transient activation after an
  awaited rejection, so C2 may become C3 in practice] → This is rare, because
  rejections in secure contexts are usually permission denials. The user sees
  "Copy failed" and can retry.
- [A reserved, invisible button takes space in the metadata slot] → It is
  small and icon-sized. In gutter layout the 6.5em gutter already has room.
  In stacked layout it shares the time's line.
- [Each row's hidden status region adds live regions] → They are empty
  except during a two-second outcome, so screen readers announce only the
  row the user just acted on.
