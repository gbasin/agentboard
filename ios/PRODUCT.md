# Agentboard iPhone live-session slice
<!-- impeccable:product-schema 1 -->
## Platform
ios
## Purpose and confirmed scope
An Apple-native iPhone interface for Agentboard. The current slice continues in SwiftUI and opens existing live sessions over the user's existing Tailscale connection. The default catalog groups sessions by project, supports search, and shows connection and attachment states. Sleeping sessions and remote sessions that the server disallows attaching to remain visible but cannot be opened.

Terminal reading and input are central. A native keyboard proxy and a single quick-key row surround xterm output. Native create, rename and end actions extend this slice. History and media features remain outside it. Explicit demo mode retains local sample management and the older isolated shell fixture.
## Stack
SwiftUI navigation, lists and sheets; UIKit `TerminalInputView` for keyboard input; WKWebView for bundled xterm.js rendering and the input bridge. `BoardConnection` owns the native URLSession WebSocket, catalog, attachment, heartbeat and reconnect behavior. `SessionActions` uses a separate one-request socket for management confirmations and errors, with a timeout and no automatic replay. The connection sheet accepts the browser's base HTTP(S) URL. The socket uses `/ws?catalog=2`, including an optional proxy prefix. Tailscale setup and authentication onboarding are not implemented in the app.
## Lifecycle contract
Suspend the socket in the background. Reconnect and restore the selected session in the foreground. Only accept input after terminal readiness; never replay disconnected input. Open a fresh socket for each selection to isolate stale responses, including a later visit to the same session ID.
## Evidence and limits
Source: `AgentboardSpike/LiveSessionListView.swift`, `BoardConnection.swift`, `TerminalScreen.swift`, `TerminalInputView.swift` and `Web/terminal.html`. Tests cover connection lifecycle, real-backend shell interaction and the legacy keyboard fixture; see README.md for setup and validation history. A separate read-only smoke test attached to an existing production session over Tailscale. Physical iPhone/signing, IME, VoiceOver and multiline paste parity remain unverified. Earlier visual-spike captures are historical evidence, not proof of the live slice's current state.
