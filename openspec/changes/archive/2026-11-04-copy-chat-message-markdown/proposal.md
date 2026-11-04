# Proposal

## Why

The chat transcript renders assistant text as formatted Markdown. Selecting
that rendered text and copying it loses the source: headings, lists, code
fences, tables, and links come out as flattened plain text. Users who want to
reuse an answer in an issue, a document, or another chat have no way to get
the Markdown the agent actually wrote, short of opening the protocol log.

## What Changes

- Every user, assistant, and peer message row in a chat transcript gets a
  **Copy** control (an icon button). It copies that message's original text
  exactly as stored: the assistant's Markdown source, the user's literal text,
  or the peer message body. It never copies the rendered DOM text.
- The control stays out of the way: it shows when the row is hovered or has
  keyboard focus, and it is always visible on touch devices. It is a real
  button with an accessible name, so keyboard and screen-reader users can
  reach it.
- After a copy, the control confirms success ("Copied") for a short time, and
  assistive technology announces it. When the browser refuses clipboard
  access, the control reports "Copy failed" instead of failing silently.
- Copying works outside secure contexts too. Kawai is often opened over plain
  HTTP on a LAN or Tailscale address, where the async Clipboard API is
  missing, so the control falls back to the legacy copy command.
- The control works the same in live and archived chats, in nested worker
  transcripts, and while a message is still streaming (it copies the text
  received so far).

Assumption (recorded, not asked): "a message" means one transcript message
row. An assistant reply split by tool calls shows as several rows, and each
row copies its own text. Copying a whole turn is out of scope.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: adds the requirement that transcript message rows offer a
  copy-as-original-Markdown control, plus its feedback and fallback behavior.
  Existing requirements are unchanged.

## Impact

- Client only: `src/client/components/chat/ChatRow.tsx` (`MessageRow` gets a
  copy slot), `ChatMessages.tsx` (passes each row's source text), a new small
  copy-button component with a clipboard helper under `src/client/`, and row
  styles in `src/client/styles/index.css`.
- Uses the existing `@untitledui-icons/react` dependency. Adds no new
  dependency, no server change, and no wire or protocol change.
- Docs: the chat-transcript bullet in `docs/architecture/chat.md`.
- Tests: unit tests next to `chatTranscriptRows.test.tsx` and
  `chatComponents.test.tsx`, plus one Playwright spec.
