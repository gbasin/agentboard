---
name: Agentboard iPhone spike
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

# Design System: Agentboard iPhone spike

## Overview

**Creative North Star: "A native iPhone window onto working agents"**

Use the user-approved Apple-native direction: San Francisco, semantic iOS surfaces, system blue actions, SF Symbols, native navigation and sheets. The terminal owns the detail screen. This documents the isolated SwiftUI visual spike, not a redesign of the web app or a final framework decision.

**Key Characteristics:**
- Native controls and system typography.
- Dense terminal content with compact surrounding controls.
- Adaptive light and dark appearance.

## Colors

Native colors remain semantic SwiftUI/UIKit values, not frozen hex approximations. `Color.accentColor` supplies system action tint. `.primary` is the foreground for session names and status text; `.secondary` is for summaries, agent names and secondary information. Status symbols use `.green` for Working, `.orange` for Waiting and `.secondary` for Sleeping. Each status also has text and a distinct SF Symbol.

Terminal surfaces use `.systemBackground`. Quick keys use `.tertiarySystemFill`; Enter and armed Control use accent text over accent fill at 12% opacity. The strip uses `.bar` material and a system divider. Validation errors use `.red`; destructive actions use the native destructive role.

The frontmatter records the explicit xterm light/dark palette only. It does not replace native adaptive colors. Unspecified ANSI slots retain xterm defaults.

## Typography

Native text uses system San Francisco with SwiftUI semantic styles and Dynamic Type. Session names use `.headline`, summaries `.subheadline`, agent and status labels `.caption`, and terminal keys `.callout.weight(.medium)`. Do not hard-code point sizes for these roles.

System large titles belong only on the session list. Terminal detail and sheet navigation titles are inline. The detail principal item combines a one-line headline and caption status with 2-point spacing. Monospaced text belongs inside xterm, using the frontmatter terminal role. Its explicit size controls range from 11 to 22 CSS pixels; terminal text does not inherit native Dynamic Type.

## Layout

`NavigationStack` contains a system `List` with project and Sleeping sections, native search and navigation links. Native row insets remain system-owned. Each row uses a leading vertical stack with 7-point spacing and 5-point vertical padding; the title/status spacer has an 8-point minimum. Summaries wrap to two lines.

The detail terminal fills available space with 8-point horizontal native padding and 8 CSS pixels of top inset inside the web view. A bottom `safeAreaInset` holds the horizontal quick-key strip, following the software keyboard. Keys have minimum 44-by-44-point targets, 4-point gaps, 8-point horizontal strip padding and 6-point vertical strip padding. The strip scrolls horizontally when necessary.

## Elevation & Depth

Use native navigation, sheet and popover presentation. The keyboard strip's bar material and divider separate controls from content. There are no custom shadows or custom animation curves. Preserve system transitions and accessibility behavior.

## Shapes

Quick keys use a rounded rectangle with a 10-point radius. List groups, forms, sheets, alerts and menus retain native system shapes. Do not copy their current OS geometry into custom containers.

## Components

- **Session row:** native navigation link; name, status, two-line summary and agent label. Status text stays primary for contrast, with color confined to its symbol.
- **Navigation:** Sessions uses system large-title behavior, search, Connection and New session actions. Detail uses native back navigation, a compact name/status title and a session-actions menu.
- **Quick keys:** Enter, Escape, arrows, Paste, Control, keyboard show/hide, Tab, Delete word and Interrupt. Control highlights while armed and clears after a single-character input. Arrows open a native popover; keys retain accessible labels.
- **Connection:** native Form and URL keyboard within a medium/large sheet. Invalid URLs show text and disable Save.
- **Paste:** native TextEditor in a medium/large sheet; Insert is disabled while empty. Rename/create use alerts; ending a sample uses a destructive confirmation dialog.
- **Terminal:** WKWebView hosts xterm, follows appearance and refits to available space. Connection state lives in the actions menu.

The spike intentionally retains WKWebView's system previous/next/Done accessory above the software keyboard, in addition to the custom quick-key strip. This costs a second row. A future input-proxy experiment may address it through public APIs; this design does not claim the limitation is resolved.

## Do's and Don'ts

- Do preserve native semantic colors, typography and presentation.
- Do keep status text primary and pair its colored symbol with a written label.
- Do keep terminal controls reachable with minimum 44-point targets.
- Don't introduce large titles on terminal detail or duplicate dashboard cards.
- Don't treat terminal pixel sizes as native text-style tokens.
- Don't remove keyboard accessories through private class swizzling.

Source of truth: `AgentboardSpike/*.swift` and `AgentboardSpike/Web/terminal.html`. Evidence lives in `evidence/`; older captures may precede the primary-status-text correction. Consult the source when those captures disagree.
