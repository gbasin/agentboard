---
name: Agentboard iPhone live-session slice
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

# Design System: Agentboard iPhone live-session slice

## Overview

**Creative North Star: "A native iPhone window onto working agents"**

Use the user-approved Apple-native direction: San Francisco, semantic iOS surfaces, system blue actions, SF Symbols, native navigation and sheets. The terminal owns the detail screen. This documents the SwiftUI live-session slice, preserving the visual world established by the earlier spike.

**Key Characteristics:**
- Native controls and system typography.
- Dense terminal content with compact surrounding controls.
- Adaptive light and dark appearance.

## Colors

Native colors remain semantic SwiftUI/UIKit values, not frozen hex approximations. `Color.accentColor` supplies system action tint. `.primary` is the foreground for session names and status text; `.secondary` is for summaries, agent names and secondary information. Status symbols use `.green` for Working, `.orange` for Waiting and `.secondary` for Sleeping. Each status also has text and a distinct SF Symbol.

Terminal surfaces use `.systemBackground`. Quick keys use `.tertiarySystemFill`; Enter and armed Control use accent text over accent fill at 12% opacity. The strip uses `.bar` material and a system divider. Live connection validation uses `.primary` body text with a `.red` `exclamationmark.circle` symbol. The legacy demo retains red validation text. Destructive actions use the native destructive role.

The frontmatter records the explicit xterm light/dark palette only. It does not replace native adaptive colors. Unspecified ANSI slots retain xterm defaults.

## Typography

Native text uses system San Francisco with SwiftUI semantic styles and Dynamic Type. Session names use `.headline`, summaries `.subheadline`, agent and status labels `.caption`, and terminal keys `.callout.weight(.medium)`. Do not hard-code point sizes for these roles. Quick-key glyphs and text alone stop scaling at `.xxxLarge` and stay on one line, preserving terminal space and 44-point minimum targets. The surrounding catalog and native sheets retain uncapped Dynamic Type.

System large titles belong only on the session list. Terminal detail and sheet navigation titles are inline. The detail principal item combines a one-line headline and caption status with 2-point spacing. Monospaced text belongs inside xterm, using the frontmatter terminal role. Its explicit size controls range from 11 to 22 CSS pixels; terminal text does not inherit native Dynamic Type.

## Layout

`NavigationStack` contains a system `List` with a connection-status section, project sections, native search and navigation links. Sleeping sessions stay in their project section. Empty, connecting, unavailable and no-search-result states use native progress and unavailable-content views. The explicit demo retains its separate Sleeping section. Native row insets remain system-owned. Each row uses a leading vertical stack with 7-point spacing and 5-point vertical padding; the title/status spacer has an 8-point minimum. Summaries wrap to two lines. At accessibility Dynamic Type sizes, the live catalog stacks fully wrapped session name/status and connection state/Retry vertically with 8-point spacing; standard sizes retain their horizontal layout.

The detail terminal fills available space with 8-point horizontal native padding and 8 CSS pixels of top inset inside the web view. A bottom `safeAreaInset` holds the horizontal quick-key strip, following the software keyboard. Keys have minimum 44-by-44-point targets, 4-point gaps, 8-point horizontal strip padding and 6-point vertical strip padding. The strip stays in one non-scrolling row. Keys share the available width; the dismissal key appears only while terminal input has focus.

## Elevation & Depth

Use native navigation, sheet and popover presentation. The keyboard strip's bar material and divider separate controls from content. There are no custom shadows or custom animation curves. Preserve system transitions and accessibility behavior.

## Shapes

Quick keys use a rounded rectangle with a 10-point radius. List groups, forms, sheets, alerts and menus retain native system shapes. Do not copy their current OS geometry into custom containers.

## Components

- **Session row:** native navigation link; name, status, two-line summary and agent/host label. Status text stays primary for contrast, with color confined to its symbol. Sleeping and server-restricted remote sessions have disabled navigation and a written reason.
- **Navigation:** Sessions uses system large-title behavior, search, pull-to-refresh and a Connection action. New session is available only in explicit demo mode. Detail uses native back navigation, a compact name/status title and a session-actions menu.
- **Quick keys:** Enter, Escape, Tab, arrows, Control and Paste, with Hide keyboard only while terminal input has focus. Tapping the terminal opens the keyboard; there is no show-keyboard button. Control highlights while armed and clears after a single-character input. Arrows open a native popover; keys retain accessible labels. Interrupt, Delete word and Insert newline live in the session-actions menu.
- **Connection:** native Form and URL keyboard within a medium/large sheet. The live sheet accepts the browser's base HTTP(S) URL. Invalid URLs show text and disable Connect. The catalog shows connection state and Retry in place.
- **Paste:** native TextEditor in a medium/large sheet; Insert is disabled while empty. Rename/create alerts and the destructive end confirmation belong only to explicit demo samples.
- **Terminal:** WKWebView hosts xterm output and scrolling, follows appearance and refits to available space. `TerminalInputView`, a public-API UIKit text-view proxy, owns keyboard input. Native `BoardConnection` owns the live socket; the web view renders output and bridges input. Connection state appears in the actions menu and, while attachment is not ready, above the disabled quick-key row with Reconnect. Input is accepted only after readiness. Background suspension and foreground reattachment preserve the selected session; disconnected input is not replayed.

Native input removes WebKit's previous/next/Done accessory, leaving the SwiftUI quick-key strip as the sole accessory row. IME, VoiceOver, multiline paste and physical-device parity remain unverified; the proxy's use of public APIs does not establish that parity.

## Do's and Don'ts

- Do preserve native semantic colors, typography and presentation.
- Do keep status text primary and pair its colored symbol with a written label.
- Do keep terminal controls reachable with minimum 44-point targets.
- Don't introduce large titles on terminal detail or duplicate dashboard cards.
- Don't treat terminal pixel sizes as native text-style tokens.
- Don't remove keyboard accessories through private class swizzling.

Source of truth: `AgentboardSpike/*.swift` and `AgentboardSpike/Web/terminal.html`. Evidence lives in `evidence/`. Earlier spike and keyboard captures are historical and may precede the primary-status-text correction or live catalog. See README.md for the validation scope; consult current source when older captures disagree.
