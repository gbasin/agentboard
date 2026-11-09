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

Use the user-approved Apple-native direction: San Francisco, semantic iOS surfaces, system blue actions, SF Symbols, native navigation and sheets. The terminal owns the detail screen. The approved Native precision direction adds native glass to the session catalog, saved-session rows and terminal controls while preserving the terminal palette. Supplemental workflows retain native lists, forms, sheets and navigation destinations. This is an implementation checkpoint; the earlier visual verdicts below do not approve the new glass treatment. See [NATIVE-GLASS.md](NATIVE-GLASS.md) for its scope and limits.

**Key Characteristics:**
- Native controls and system typography.
- Dense terminal content with compact surrounding controls.
- Adaptive light and dark appearance.

## Colors

Native colors remain semantic SwiftUI/UIKit values, not frozen hex approximations. `Color.accentColor` supplies system action tint. `.primary` is the foreground for session names and status text; `.secondary` is for summaries, agent names and secondary information. Status symbols use `.green` for Working, `.orange` for Waiting and `.secondary` for Sleeping. Each status also has text and a distinct SF Symbol.

Terminal surfaces use `.systemBackground`. Quick keys use transparent inactive backgrounds; Enter and armed Control or Shift use accent text over accent fill at 12% opacity. The strip uses the shared native glass surface. Live connection validation and session-action errors use `.primary` body text with a `.red` `exclamationmark.circle` symbol. The legacy demo retains red validation text. Destructive actions use the native destructive role.

The frontmatter records the explicit xterm light/dark palette only. It does not replace native adaptive colors. Unspecified ANSI slots retain xterm defaults.

## Typography

Native text uses system San Francisco with SwiftUI semantic styles and Dynamic Type. Session names use `.headline`, summaries `.subheadline`, agent and status labels `.caption`, and terminal keys `.caption.weight(.medium)`. Do not hard-code point sizes for these roles. Quick-key glyphs and text stop scaling at `.xxxLarge` and stay on one line, preserving terminal space and 44-point minimum targets. The compact session-overview and media-summary labels also cap at `.xxxLarge`; both pills provide Large Content Viewer content with their full summary labels. The surrounding catalog and native sheets retain uncapped Dynamic Type, apart from the separately documented number-grid glyphs.

System large titles belong only on the session list. Terminal detail and sheet navigation titles are inline. The detail principal item combines a one-line session headline and a caption row with the project directory name and status, separated by 2-point vertical spacing. Long directory names truncate in the middle; accessibility retains the full path. Xterm uses the frontmatter terminal role. The parity extension also uses semantic native monospace for session ID/data text, saved terminal previews and raw transcript Events; these remain data-reading roles, not general interface labels. Terminal text does not inherit native Dynamic Type. The current Settings stepper exposes 6–24 CSS pixels; the frontmatter remains the default, not a minimum-size guarantee.

## Layout

`NavigationStack` contains a system `List` with connection state, recovery notices, search and a flat session catalog. Each session has an independent primary open action and sibling activity/PR actions, avoiding nested buttons inside navigation links. A caption combines the provider, optional project name and remote host. Optional IDs use a three-character prefix and suffix; recency refreshes each minute. Native Edit and move handles preserve shared manual order. Filters and sorting remain in a native form.

Live session surfaces have 14-point horizontal and 8-point vertical padding, 16-point horizontal list insets and 2-point vertical list insets. Native row backgrounds and separators are clear. Session content uses compact 3–5-point spacing. Names and recency stack at accessibility text sizes; summaries expand from one to four lines. Saved-session rows retain 14-point padding and 5-point vertical list insets, with state, provider, project and errors. Empty, connecting, unavailable and no-search-result states retain native views. The explicit demo remains a separate presentation.

The detail terminal fills available space with 8-point horizontal native padding and 8 CSS pixels of top inset inside the web view. A bottom `safeAreaInset` holds the horizontal quick-key strip, following the software keyboard. The strip is one 44-point-high horizontal `ScrollView` with hidden indicators and no wrapping. Keys have minimum 44-by-44-point targets and intrinsic horizontal widths so labels such as Ctrl C remain complete. Each visible key face is at least 38 points wide and 32 points high. The row has zero inter-key spacing and 2-point horizontal content padding; the glass strip has 4-point outer horizontal and bottom padding. Scroll horizontally to reach later controls; the dismissal key appears only while terminal input has focus.

Compact session-overview and media-summary pills occupy the top safe-area inset with 12-point horizontal and 4-point vertical padding. In compact vertical size they move into the top toolbar. Their glass faces use 6-point vertical padding inside minimum 44-point-high hit targets; horizontal padding is 8 points for overview and 10 points for media.

## Elevation & Depth

Use native navigation, sheet and popover presentation. `nativeGlassSurface` applies real `.glassEffect(.regular)` on iOS 26 and later, `.regularMaterial` on iOS 18–25, and an opaque `.secondarySystemGroupedBackground` when Reduce Transparency is enabled. Interactive saved rows, the session overview and the media button request interactive glass. Terminal content stays on a solid system background. There are no custom shadows or custom animation curves. Preserve system transitions and accessibility behavior.

## Shapes

Quick-key active fills use a 10-point radius. Shared glass surfaces, including the session-overview and media-summary pills, use 18-point corners; the quick-key strip uses 16-point corners. List groups, forms, sheets, alerts and menus retain native system shapes. Do not copy their current OS geometry into custom containers.

## Components

- **Session row:** name, provider/project/remote-host caption, optional short ID, latest message and recency. Status text stays primary and its symbol carries color. Sleeping and server-restricted sessions disable only terminal opening and explain why. PR chips show up to four requests, or two at accessibility sizes, plus overflow; their shared action opens a PR-only destination. States come from `/api/pr-info`; unavailable states remain explicit. Optional `session.activity` adds a count and a read-only activity sheet. Missing activity is unavailable, never a fabricated zero.
- **Navigation:** Sessions uses system large-title behavior, search, pull-to-refresh and a Connection action. New session is available in the live catalog toolbar while connected. The bottom toolbar opens Library, Filter and sort, Edit and Settings. Detail uses native back navigation, a compact name/project/status session-switcher menu and a session-actions menu. Applicable rename, duplicate, hibernate and end actions are also available from catalog context menus. Remote Rename, Duplicate and End appear only when the server permits control and the source is managed; remote Hibernate is omitted.
- **Quick keys:** the first ten controls follow PWA order: Enter, Escape, arrows, Paste, Select text, Delete word, Number keys, Tab, Shift and Control. Copy selection, Interrupt (Ctrl C), Insert newline and Attach file follow in the same scrolling row, with Hide keyboard last and only while terminal input has focus. Tapping the terminal opens the keyboard; there is no show-keyboard button. Control highlights while armed and clears after a single-character input. Arrows open a native popover that also offers Shift; Shift additionally has its own quick key. Shift is a one-shot modifier: Shift+Tab emits ESC `[Z`, and Shift+Enter emits LF without submitting CR. It clears after input, keyboard dismissal or leaving the active scene. This preserves the modified key output, not the PWA’s held-button interaction. Keys retain accessible labels. Existing session-actions menu equivalents remain available. Select text and Attach file disable when their callbacks are unavailable; attachment also remains unavailable for remote sessions.
- **Connection:** native Form and URL keyboard within a medium/large sheet. The live sheet accepts the browser's base HTTP(S) URL. Invalid URLs show text and disable Connect. The catalog shows connection state and Retry in place.
- **Paste:** native TextEditor in a medium/large sheet with system autocorrection and sentence capitalization enabled, independent of the direct-terminal keyboard preference. Insert is disabled while empty. The explicit Paste from clipboard action uses the public UIKit `UIPasteControl`, which authorizes access and delivers item providers asynchronously. Native edit-menu paste retains the operating system paste path. Both accept public text/image/file representations. Upload progress, Cancel and recoverable error/Retry appear only while needed above the existing single key row. Repeated pastes queue in order; a failed request pauses later requests until Retry or Dismiss, and explicit Cancel clears the queue. Unsupported clipboard representations explain the Attach file fallback. Text/document insertion and agent-specific image input never add Enter. Current agent metadata is resolved at delivery; changing terminal ownership cancels pending work.
- **Editable form fields:** `FormField` keeps a persistent primary-color caption above the native TextField, with 6-point spacing and 2-point vertical padding. Create/duplicate project, command, optional name and remote host, Settings default directory and terminal font, and preset label/command use this pattern so populated values remain identifiable. The duplicate visual caption is accessibility-hidden; the TextField retains its original native label. This source-level arrangement does not establish VoiceOver validation.
- **Session actions:** `SessionActionSheet` presents a native Form with an inline navigation title. Create requires a project directory and command, with optional name and configured remote host; field footers explain where the command runs. Rename starts with the current name and requires a nonempty value. End names the session, explains that its terminal and running processes will stop, and requires an explicit destructive End session button. Errors appear above the fields as primary text with a red symbol. When a server error arrives, the form scrolls to its identified error row so failure remains visible after submission from lower fields, including at accessibility text sizes. Submission dismisses the keyboard and preserves the draft on failure. While awaiting the server, a progress indicator appears and the form, confirmation, Cancel and swipe dismissal are disabled to prevent duplicate requests. Cancel is available before submission or after a failure; backgrounding or leaving the sheet cancels an in-flight request.
- **Action results:** `SessionActions` uses a separate one-request socket with a timeout and no automatic replay. An unconfirmed sent request tells the user to check the session list before retrying because the server may have completed it; failure before sending asks the user to check the connection. Acknowledged create clears search and opens the new session; acknowledged rename refreshes the catalog; confirmed removal returns to the catalog. These live actions extend the native world; explicit demo mode retains its local sample actions.
- **Create and duplicate:** extend the existing action form with a command-preset picker, command and permission controls, configured host, directory browsing and recent paths. Directory browsing uses its own native navigation stack, parent-directory action and Choose confirmation. Duplicate starts with the source session's values.
- **Catalog filters and attention:** the filter toolbar reports the active selection count. Project and host choices include live sessions, dormant conversations, configured hosts and retained selections. Search narrows options without removing selected choices; unavailable hosts show Offline and their server error. Selection switches disable while shared settings save. A written hidden-approval notice clears the obscuring filters and search when tapped. Its text explicitly uses `Color.primary` inside the button, with orange confined to the warning symbol.
- **Recovery notice:** the catalog shows interrupted-session counts or recovery-error text with an orange symbol and primary body text. A single item-based Library route carries the selected scope into sheet construction; Review opens Library in Recovery scope; a separate dismissal action records only the current IDs/error for that server. Polling belongs to the always-mounted catalog, runs only in the foreground and refreshes on library changes. New interruption IDs or errors reappear after a prior dismissal.
- **Library and history:** Recovery, Saved and History categories use searchable native lists. Saved-state and pinned filters live in a sheet. Recovery rows offer Resume and Details. Project/host selections also filter hibernating conversations and conversation history, including their displayed counts; Library search further narrows conversation names and projects. Saved rows use semantic secondary metadata. Saved detail leads with identity, state and Resume; rename and lifecycle details use disclosures. Pin, confirmed archive, terminal preview and conversations remain available. Archive is omitted for already archived sessions. Hibernating conversations offer Wake and Move to history; historical conversations offer Resume.
- **Transcript:** an inline detail destination with a Messages/Events segmented picker. Role sections hold readable messages; disclosure groups contain tool calls, results and raw events. Text supports selection. Load earlier stays in the toolbar so pagination remains reachable above a long transcript.
- **Media and pull requests:** a compact glass terminal button uses caption-sized, monospaced-digit labels for image, link and file counts, with a compact total when the full row cannot fit. Its full counts remain in its accessibility label and Large Content Viewer. The companion session-overview menu uses caption-sized status counts with semantic colored symbols and primary count text, falling back to the total when needed; its accessibility value and Large Content Viewer retain the full status summary. Indexed servers supply catalog totals and discovery state; older servers retain explicitly labeled available-snapshot counts. The button remains available for a pending index even before any media is found. Catalog browsing retains one bounded page, with search/type filters and a persistent glass previous/page/next bar. Identity and revision changes require refresh before further paging. A native list opens image, document and link sheets or pull-request detail. Images support pinch zoom and scrolling. Indexed image arrows use server neighbors across page boundaries; legacy lists retain positional navigation. Share/browser actions prefer an original external link when supplied. Documents download to a bounded private temporary file for native Quick Look and file sharing. HTML attachments show a bounded source preview, not an executable page; unsupported formats retain save/open sharing. Web links and live previews use the document web view. Loading and failure states appear in place with Retry. Pull-request checks use written status labels and links, not color alone. State, draft and author metadata share a secondary subheadline; empty values and the entire empty metadata row are omitted.
- **Settings and presets:** a searchable native Form groups shared settings and device terminal rendering controls. Use native pickers, toggles, steppers and sliders. Preset rows explicitly use primary text for both label and command so button tint does not reduce subtitle contrast. Preset editing is a focused form with Cancel and Save.
- **Upload:** a native Form opens multi-selection system file/photo pickers and adds selections to attachment review. Insert attachments uploads and inserts in one explicit action. Its footer explains the 40 MB per-file limit and that insertion does not press Enter. Documents use quoted server paths; supported images use the PWA's agent-specific attachment input. Selection controls disable while reading/uploading. Cancel or leaving the sheet cancels pending work. The same upload controller handles clipboard and picker delivery, retry and ownership checks.
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

**Observed title behavior:** Library explicitly uses inline title mode. Conversation history and command-preset destinations retain their existing title behavior. This documents their implementation without changing source or replacing the incumbent compact-detail guidance. The existing `.impeccable/design.json` still describes the earlier live-session slice and is not refreshed by this scoped extension.

Source of truth: `AgentboardSpike/*.swift` and `AgentboardSpike/Web/terminal.html`. Evidence lives in `evidence/`. Earlier spike and keyboard captures are historical and may precede the primary-status-text correction or live catalog. Historical session-action evidence in `evidence/session-actions/` includes ten reviewed captures and end-to-end checks in light appearance at standard text size and dark appearance at maximum Dynamic Type. That slice passed six action tests and six connection tests. Physical-device, remote-host and VoiceOver action behavior remain unverified. See README.md for the validation scope; consult current source when older captures disagree.

Historical pre-glass parity captures are in `evidence/parity-light/` and `evidence/parity-dark/`. The evidence index records final light and dark workflow results, recaptures and scoped review verdicts. Number-key layout, preset contrast and server-error visibility were each scored resolved; the ship verdicts apply to those corrections. See PARITY.md for the complete Simulator validation boundary. Earlier slice verdicts do not certify the parity extension.

The historical pre-glass native design polish pass preserves these tokens and the Apple-native identity. Current affected-screen captures are indexed under `evidence/design-light/` and `evidence/design-dark/`; the evidence index distinguishes this pass from the earlier parity validation. A fresh reviewer inspected all 12 light/standard-text and dark/maximum-text captures and returned **ship this scoped polish**, with no required corrections. This verdict covers the reviewed visual changes, not full PWA parity or physical-device, VoiceOver, IME, SSH-host or live GitHub certification.

The historical pre-glass parity-gap pass preserves the native design and has 18 light captures plus 20 dark/maximum-text captures from passing workflows. All eight affected UI workflows passed in both appearances across separate runs, with 43 unit/integration tests passed. Review of all 18 light captures found no new issues and scored both contrast corrections resolved. Dark reruns corrected test navigation without product changes. The reviewer inspected all 18 light and 20 dark captures and returned **ship this scoped parity-fix UI**, with both contrast corrections resolved and no further correction required. This verdict does not certify full PWA parity or physical-device behavior. Five diagnostic captures from the failed initial dark run remain separate in `evidence/gaps-dark-initial/`. The evidence index records exact bundle results and provenance.

## Approved flow refinement (2026-11-08)

The user approved the session-density, recovery-first, and unified-attachment studies, then requested an easy recovery dismissal.

- Retain native Liquid Glass and semantic typography. Reduce catalog row padding to 14 points horizontally and 8 vertically, with 2-point vertical list insets and 12-point corners. Keep independent PR/activity hit targets, manual ordering and accessibility text expansion. Summaries use one line at standard sizes and up to four at accessibility sizes.
- Keep the recovery reminder close control at 44 × 44 points. Dismiss only reminders for the interruptions already seen, scoped to the connected server and persisted across launches. Library remains accessible. A newly interrupted session may show a new reminder.
- Put Recovery, Saved and History in a native category picker. Recovery rows lead with Resume and Details. Move saved-state and pinned filters to an explicit filters sheet. Keep history search, pagination and conversation actions.
- Lead saved-session details with identity, state and Resume. Disclose rename and technical lifecycle details. Do not offer Archive for an already archived session.
- File, photo and clipboard attachments share review and explicit insertion semantics. Adding files preserves the existing review. Insertion uploads then adds to the terminal draft without Enter; cancellation and upload failures retain existing safety checks. The file/photo sheet closes after successful insertion. During attachment review, its toolbar supplies the single Cancel action; inline Cancel remains in clipboard review. Photos starts each new selection empty so previous picks are not appended again.

The web studies are review artifacts, not literal SwiftUI component specifications. Native session rows retain separate glass surfaces so existing list reordering and metadata controls remain intact.

At accessibility text sizes, recovery actions stack vertically and Resume labels wrap without truncation. The attachment primary action uses the available width and a 16-point rounded rectangle; system text can still hyphenate long labels at the largest size. Standard-size controls keep native automatic shapes.

The single-row terminal refinement records the implemented control order, intrinsic key widths and compact glass pills. The reviewer inspected all ten corrected light/standard and dark/maximum-text Simulator captures and returned **ship this scoped compact-controls UI**, resolving both the truncated Interrupt label and oversized pills. This verdict does not certify physical-device ergonomics, VoiceOver or Large Content Viewer interaction. Running observations are recorded in [PARITY-NOTES.md](PARITY-NOTES.md).
