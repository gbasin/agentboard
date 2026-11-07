# iPhone UI spike
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
