# Agentboard iPhone spike
<!-- impeccable:product-schema 1 -->
## Platform
ios
## Purpose and confirmed scope
An iPhone interface with the existing Agentboard PWA's capabilities. The user wants an Apple-native visual spike before committing to SwiftUI versus React Native. Terminal interaction is central, including the software keyboard. xterm.js in a web view is acceptable initially. The eventual client connects over the user's existing Tailscale setup. This spike uses explicitly labeled sample sessions and an isolated shell; it is not the production client.
## Stack
SwiftUI for the visual spike, WKWebView for xterm.js. Final framework undecided.
## Evidence
User-supplied terminal screenshot; src/client/components/Terminal.tsx, TerminalControls.tsx and SessionDrawer.tsx.
