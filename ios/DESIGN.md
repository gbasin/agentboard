---
name: Agentboard iPhone client
description: A native iPhone window onto working agents.
colors:
  terminal-background-light: "#ffffff"
  terminal-background-dark: "#000000"
  terminal-text-light: "#1c1c1e"
  terminal-text-dark: "#e5e5ea"
  terminal-cursor: "#007aff"
  terminal-selection-light: "#c6dfff"
  terminal-selection-dark: "#264b76"
  terminal-blue-light: "#005bc4"
  terminal-blue-dark: "#64aaff"
  terminal-green-light: "#16783a"
  terminal-green-dark: "#63d98a"
  terminal-yellow-light: "#865800"
  terminal-yellow-dark: "#ffce64"
  terminal-muted-light: "#68686f"
  terminal-muted-dark: "#a0a0a7"
typography:
  terminal:
    fontFamily: "Menlo, monospace"
    fontSize: "13px"
    lineHeight: 1.3
rounded:
  terminal-key: "10px"
---

# Design System: Agentboard iPhone client

## Overview

**Creative North Star: "A native iPhone window onto working agents"**

Use the user-approved Apple-native direction: San Francisco, semantic iOS surfaces, system blue actions, SF Symbols, native navigation and sheets. The terminal owns the detail screen. This documents the native parity extension, preserving the visual world and terminal palette established by the earlier spike. Supplemental workflows use native lists, forms, sheets and navigation destinations.

**Key Characteristics:**
- Native controls and system typography.
- Dense terminal content with compact surrounding controls.
- Adaptive light and dark appearance.

## Colors

Native colors remain semantic SwiftUI/UIKit values, not frozen hex approximations. `Color.accentColor` supplies system action tint. `.primary` is the foreground for session names and status text; `.secondary` is for summaries, agent names and secondary information. Status symbols use `.green` for Working, `.orange` for Waiting and `.secondary` for Sleeping. Each status also has text and a distinct SF Symbol.

Terminal surfaces use `.systemBackground`. Quick keys use `.tertiarySystemFill`; Enter and armed Control use accent text over accent fill at 12% opacity. The strip uses `.bar` material and a system divider. Live connection validation and session-action errors use `.primary` body text with a `.red` `exclamationmark.circle` symbol. The legacy demo retains red validation text. Destructive actions use the native destructive role.

The frontmatter records the explicit xterm light/dark palette only. It does not replace native adaptive colors. Unspecified ANSI slots retain xterm defaults.

## Typography

Native text uses system San Francisco with SwiftUI semantic styles and Dynamic Type. Session names use `.headline`, summaries `.subheadline`, agent and status labels `.caption`, and terminal keys `.callout.weight(.medium)`. Do not hard-code point sizes for these roles. Quick-key glyphs and text alone stop scaling at `.xxxLarge` and stay on one line, preserving terminal space and 44-point minimum targets. The surrounding catalog and native sheets retain uncapped Dynamic Type.

System large titles belong only on the session list. Terminal detail and sheet navigation titles are inline. The detail principal item combines a one-line headline and caption status with 2-point spacing. Xterm uses the frontmatter terminal role. The parity extension also uses semantic native monospace for session ID/data text, saved terminal previews and raw transcript Events; these remain data-reading roles, not general interface labels. Terminal text does not inherit native Dynamic Type. The current Settings stepper exposes 6–24 CSS pixels; the frontmatter remains the default, not a minimum-size guarantee.

## Layout

`NavigationStack` contains a system `List` with a connection-status section, a flat session section, native search and navigation links. Optional project labels preserve context in the flat list. Native Edit and move handles set shared manual order; filters and sorting remain in a separate native form. Empty, connecting, unavailable and no-search-result states use native progress and unavailable-content views. The explicit demo retains its separate Sleeping section. Native row insets remain system-owned. Each row uses a leading vertical stack with 7-point spacing and 5-point vertical padding; the title/status spacer has an 8-point minimum. Summaries wrap to two lines. At accessibility Dynamic Type sizes, the live catalog stacks fully wrapped session name/status and connection state/Retry vertically with 8-point spacing; standard sizes retain their horizontal layout.

The detail terminal fills available space with 8-point horizontal native padding and 8 CSS pixels of top inset inside the web view. A bottom `safeAreaInset` holds the horizontal quick-key strip, following the software keyboard. Keys have minimum 44-by-44-point targets, 4-point gaps, 8-point horizontal strip padding and 6-point vertical strip padding. The strip stays in one non-scrolling row. Keys share the available width; the dismissal key appears only while terminal input has focus.

## Elevation & Depth

Use native navigation, sheet and popover presentation. The keyboard strip's bar material and divider separate controls from content. There are no custom shadows or custom animation curves. Preserve system transitions and accessibility behavior.

## Shapes

Quick keys use a rounded rectangle with a 10-point radius. List groups, forms, sheets, alerts and menus retain native system shapes. Do not copy their current OS geometry into custom containers.

## Components

- **Session row:** native navigation link; name, status, two-line summary and agent/host label. Status text stays primary for contrast, with color confined to its symbol. Sleeping and server-restricted remote sessions have disabled navigation and a written reason.
- **Navigation:** Sessions uses system large-title behavior, search, pull-to-refresh and a Connection action. New session is available in the live catalog toolbar while connected. The bottom toolbar opens Library, Filter and sort, Edit and Settings. Detail uses native back navigation, a compact name/status title and a session-actions menu. Rename, duplicate, hibernate and end are also available from catalog context menus.
- **Quick keys:** Enter, Escape, Tab, arrows, Control and Paste, with Hide keyboard only while terminal input has focus. Tapping the terminal opens the keyboard; there is no show-keyboard button. Control highlights while armed and clears after a single-character input. Arrows open a native popover; keys retain accessible labels. Interrupt, Delete word and Insert newline live in the session-actions menu.
- **Connection:** native Form and URL keyboard within a medium/large sheet. The live sheet accepts the browser's base HTTP(S) URL. Invalid URLs show text and disable Connect. The catalog shows connection state and Retry in place.
- **Paste:** native TextEditor in a medium/large sheet; Insert is disabled while empty.
- **Session actions:** `SessionActionSheet` presents a native Form with an inline navigation title. Create requires a project directory and command, with optional name and configured remote host; field footers explain where the command runs. Rename starts with the current name and requires a nonempty value. End names the session, explains that its terminal and running processes will stop, and requires an explicit destructive End session button. Errors appear above the fields as primary text with a red symbol. When a server error arrives, the form scrolls to its identified error row so failure remains visible after submission from lower fields, including at accessibility text sizes. Submission dismisses the keyboard and preserves the draft on failure. While awaiting the server, a progress indicator appears and the form, confirmation, Cancel and swipe dismissal are disabled to prevent duplicate requests. Cancel is available before submission or after a failure; backgrounding or leaving the sheet cancels an in-flight request.
- **Action results:** `SessionActions` uses a separate one-request socket with a timeout and no automatic replay. An unconfirmed sent request tells the user to check the session list before retrying because the server may have completed it; failure before sending asks the user to check the connection. Acknowledged create clears search and opens the new session; acknowledged rename refreshes the catalog; confirmed removal returns to the catalog. These live actions extend the native world; explicit demo mode retains its local sample actions.
- **Create and duplicate:** extend the existing action form with a command-preset picker, command and permission controls, configured host, directory browsing and recent paths. Directory browsing uses its own native navigation stack, parent-directory action and Choose confirmation. Duplicate starts with the source session's values.
- **Library and history:** searchable native lists with state and pinned filters. Conversation destinations precede saved rows and pagination. Saved detail groups metadata, editable name, pin, resume, confirmed archive, terminal preview, conversations and lifecycle events. Hibernating conversations offer Wake and Move to history; historical conversations offer Resume.
- **Transcript:** an inline detail destination with a Messages/Events segmented picker. Role sections hold readable messages; disclosure groups contain tool calls, results and raw events. Text supports selection. Load earlier stays in the toolbar so pagination remains reachable above a long transcript.
- **Media and pull requests:** a native list opens image, document and link sheets or pull-request detail. Images support pinch zoom and scrolling. The media toolbar provides previous/next, position, share and browser actions. Document loading and failure states appear in place with Retry. Pull-request checks use written status labels and links, not color alone.
- **Settings and presets:** a searchable native Form groups shared settings and device terminal rendering controls. Use native pickers, toggles, steppers and sliders. Preset rows explicitly use primary text for both label and command so button tint does not reduce subtitle contrast. Preset editing is a focused form with Cancel and Save.
- **Upload:** a native Form opens the system file or photo picker, shows upload progress, then offers Insert file path. Its footer explains the size limit and that insertion does not press Enter. Pending upload disables dismissal and duplicate selection.
- **Number keys:** a separate scrollable sheet uses a three-column native bordered-button grid. Columns range from 64 to 96 points with 12-point spacing; labels have at least 44-point height. Only grid glyphs cap Dynamic Type at `.xxxLarge`. The sheet offers 500-point and large detents, keeping the Done toolbar separate from the keys at accessibility sizes.
- **Terminal:** WKWebView hosts xterm output and scrolling, follows appearance and refits to available space. `TerminalInputView`, a public-API UIKit text-view proxy, owns keyboard input. Native `BoardConnection` owns the live socket; the web view renders output and bridges input. Connection state appears in the actions menu and, while attachment is not ready, above the disabled quick-key row with Reconnect. Input is accepted only after readiness. Background suspension and foreground reattachment preserve the selected session; disconnected input is not replayed.

Native input removes WebKit's previous/next/Done accessory, leaving the SwiftUI quick-key strip as the sole accessory row. IME, VoiceOver and physical-device parity remain unverified; the proxy's use of public APIs does not establish that parity.

## Do's and Don'ts

- Do preserve native semantic colors, typography and presentation.
- Do keep status text primary and pair its colored symbol with a written label.
- Do keep terminal controls reachable with minimum 44-point targets.
- Don't introduce large titles on terminal detail or duplicate dashboard cards.
- Don't treat terminal pixel sizes as native text-style tokens.
- Don't remove keyboard accessories through private class swizzling.

**Observed title behavior:** Library, conversation history and command-preset destinations do not all explicitly set inline title mode. This documents their implementation without changing source or replacing the incumbent compact-detail guidance. The existing `.impeccable/design.json` still describes the earlier live-session slice and is not refreshed by this scoped extension.

Source of truth: `AgentboardSpike/*.swift` and `AgentboardSpike/Web/terminal.html`. Evidence lives in `evidence/`. Earlier spike and keyboard captures are historical and may precede the primary-status-text correction or live catalog. Historical session-action evidence in `evidence/session-actions/` includes ten reviewed captures and end-to-end checks in light appearance at standard text size and dark appearance at maximum Dynamic Type. That slice passed six action tests and six connection tests. Physical-device, remote-host and VoiceOver action behavior remain unverified. See README.md for the validation scope; consult current source when older captures disagree.

Current parity captures are in `evidence/parity-light/` and `evidence/parity-dark/`. The evidence index records final light and dark workflow results, recaptures and scoped review verdicts. Number-key layout, preset contrast and server-error visibility were each scored resolved; the ship verdicts apply to those corrections. See PARITY.md for the complete Simulator validation boundary. Earlier slice verdicts do not certify the parity extension.
