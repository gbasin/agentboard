# Agentboard iPhone direction
Mode: Operate. User-approved direction: native Apple controls around the current PWA terminal, preserving density. Code-first, using the confirmed scope from the conversation.
## Current-state audit
The PWA has a mobile header with session name/status and session actions, a session drawer, a full-height terminal, and a horizontal quick-key strip. The supplied screenshot shows these already exist. This spike changes their presentation, not their purpose. Large titles belong only on the session list; terminal detail stays compact. No duplicate dashboard or summary cards.
## Direction contract
THESIS: A native iPhone window onto working agents; the terminal owns the detail screen.
OWN-WORLD: San Francisco, semantic iOS surfaces, system blue actions, SF Symbols, native navigation and sheets. Monospaced text belongs inside xterm only.
STORY: Scan sessions, open one, read and type, switch sessions without losing context.
FIRST VIEWPORT: Inline session name/status between native back and action controls; edge-to-edge terminal; one 44-point touch-target key strip above the safe area or software keyboard.
FORM: User-pinned Apple-native direction and supplied terminal composition; no randomized visual direction needed.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Keyboard iteration

The user approved a single integrated key row and clarified that tapping the terminal should open the keyboard. Remove the redundant show-keyboard button. Use only public APIs. Keep xterm output and scrolling; route keyboard input through a native UIKit text view. Show Enter, Escape, Tab, arrows, Control, paste, and (only while focused) dismissal without horizontal scrolling. Extra terminal actions remain in the session menu. Verify shell bytes, backspace, Unicode input, safe paste, and repeated keyboard transitions before judging the visual result.

## Live-session slice

Continue in SwiftUI, reusing the existing Agentboard protocol over the user's Tailscale connection. Replace the default sample catalog with live sessions grouped by project. Use the existing native connection sheet for the browser's base HTTP(S) URL. Show connecting, empty, retry, and terminal attachment errors in place. Preserve terminal density and the single keyboard row. The slice opens existing sessions only; sample management actions stay in explicit demo mode. Prove typing, paste, switching, background/resume and stale-socket suppression before expanding management features.

## Session management extension

Extend the existing native world with New session in the catalog toolbar and Rename session / End session in the terminal menu. Use native forms with preserved drafts, inline server errors and explicit destructive confirmation. Create opens the acknowledged session; end returns to the catalog after removal. Each request has its own socket and runs once; uncertain outcomes direct the user to check the catalog before retrying. This slice accepts a project directory, explicit command, optional name and optional configured remote host. Preset synchronization and directory browsing remain future parity work.

## Full parity implementation

The user superseded the slice-by-slice plan with full PWA capability parity. Preserve the Apple-native direction. Keep the terminal compact and give supplemental workflows native destinations: settings, filters, library, conversations, transcripts, media, pull requests and uploads. A flat session list supports manual reordering; project labels retain context without duplicating groups. Keep conversation navigation near the top of Library, ahead of paginated saved rows. Put older-transcript loading in the toolbar so a long transcript cannot bury it. Shared settings use the existing server contract; terminal typography and renderer settings stay on-device. Validate complete workflows against a private backend and inspect light, dark and accessibility text captures before declaring completion.

## Approved Native precision glass checkpoint

The user selected Native precision with glass throughout interface chrome. Use real Liquid Glass on iOS 26+, regular system material on earlier supported systems, and an opaque semantic surface under Reduce Transparency. Keep terminal output solid and readable. Use compact native navigation, plain lists with glass session surfaces, and semantic typography. Monospace is also appropriate for short identifiers and counts.

Sessions, keyboard-open Terminal and Library are the first native review checkpoint. Preserve every existing action while adding recency, PR state chips, optional backend-reported subagent activity and one-shot Shift. Healthy connection status belongs in the toolbar. Full media totals and pagination remain a separate backend-contract integration. See NATIVE-GLASS.md for current evidence and limits; earlier slice restrictions above are historical.
