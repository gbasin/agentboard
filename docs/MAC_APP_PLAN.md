# Agentboard Mac App - Technical Specification

## Overview / Context

Native macOS application for Agentboard with menu bar presence, global hotkeys, native notifications, and remote access capabilities. The macOS app is the process manager and UX shell; the Bun server remains the primary session/terminal backend. Reuses existing React frontend and Bun backend with minimal changes.

## Goals and Non-Goals

### Goals
- Ship a native macOS app that starts and monitors the Bun server and renders the existing React UI in WKWebView
- Provide menu bar controls, global hotkeys, native notifications, and session badges
- Enable optional remote access via tunnel with explicit, enforced authentication
- Preserve existing server and client code paths with minimal changes

### Non-Goals
- Rewrite the React UI or replace tmux/PTY logic
- Support non-macOS platforms in this phase
- Provide offline usage or background automation beyond existing capabilities
- Mac App Store distribution (direct download first, App Store evaluated later)

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Agentboard.app (Swift)                       │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │  Menu Bar       │  │  Main Window    │  │  Preferences    │  │
│  │  (NSStatusItem) │  │  (WKWebView)    │  │  (SwiftUI)      │  │
│  │                 │  │                 │  │                 │  │
│  │  - Status icon  │  │  - React app    │  │  - Server port  │  │
│  │  - Quick menu   │  │  - xterm.js     │  │  - Hotkeys      │  │
│  │  - Session list │  │  - Full UI      │  │  - Tunnel setup │  │
│  └────────┬────────┘  └────────┬────────┘  └─────────────────┘  │
│           │                    │                                 │
│           │      ┌─────────────▼─────────────┐                  │
│           │      │  WebView Bridge (WKScript) │                  │
│           │      │  - Native ↔ JS messaging   │                  │
│           │      │  - Versioned API (v1)      │                  │
│           │      └─────────────┬─────────────┘                  │
│           │                    │                                 │
│  ┌────────▼────────────────────▼────────────────────────────┐   │
│  │              Server Manager (Swift)                       │   │
│  │  - Spawn/monitor Bun server process                       │   │
│  │  - Health checks, auto-restart with backoff               │   │
│  │  - Log capture to ~/Library/Application Support/          │   │
│  └──────────────────────┬───────────────────────────────────┘   │
│                         │                                        │
└─────────────────────────┼────────────────────────────────────────┘
                          │ spawns
┌─────────────────────────▼────────────────────────────────────────┐
│                 Bun Server (existing code)                       │
│  - Hono HTTP server bound to 127.0.0.1:{port}                   │
│  - WebSocket for terminal streaming                              │
│  - tmux session management                                       │
│  - Claude/Codex log parsing                                      │
│  - PTY management via node-pty                                   │
└──────────────────────────────────────────────────────────────────┘
```

## Component Design

### AppController

Owns app lifecycle and shared singletons.

```swift
@main
struct AgentboardApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
}

class AppDelegate: NSObject, NSApplicationDelegate {
    var preferencesStore: PreferencesStore!
    var serverManager: ServerManager!
    var webViewController: WebViewController!
    var statusItemManager: StatusItemManager!
    var hotkeyManager: HotkeyManager!
    var notificationManager: NotificationManager!
    var tunnelManager: TunnelManager!
    var updateManager: UpdateManager!

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Initialize in dependency order
    }
}
```

### ServerManager

Lifecycle management for bundled Bun server binary.

```swift
class ServerManager: ObservableObject {
    @Published var state: ServerState = .stopped
    @Published var port: Int = 4321

    private var process: Process?
    private var restartCount: Int = 0
    private let maxRestarts = 3
    private let restartWindow: TimeInterval = 300 // 5 minutes

    enum ServerState {
        case stopped, starting, running, failed(Error)
    }

    /// Spawns server with env: PORT, AGENTBOARD_TOKEN, AGENTBOARD_MODE=app
    func start() async throws {
        state = .starting

        // Find free port if default in use
        port = try await findAvailablePort(starting: 4321, maxAttempts: 10)

        // Spawn bundled binary
        let serverPath = Bundle.main.path(forResource: "agentboard-server", ofType: nil)!
        process = Process()
        process?.executableURL = URL(fileURLWithPath: serverPath)
        process?.environment = [
            "PORT": String(port),
            "AGENTBOARD_TOKEN": TokenManager.shared.token,
            "AGENTBOARD_MODE": "app"
        ]

        // Capture logs
        let logPipe = Pipe()
        process?.standardOutput = logPipe
        process?.standardError = logPipe
        LogManager.shared.captureOutput(from: logPipe)

        try process?.run()

        // Wait for health check
        try await waitForHealth(timeout: 5.0)
        state = .running
    }

    func stop() {
        process?.terminate()
        process = nil
        state = .stopped
    }

    func restart() async throws {
        stop()
        try await Task.sleep(nanoseconds: 500_000_000) // 500ms
        try await start()
    }

    /// Health check with exponential backoff
    func waitForHealth(timeout: TimeInterval) async throws {
        let start = Date()
        var delay: UInt64 = 100_000_000 // 100ms

        while Date().timeIntervalSince(start) < timeout {
            if let url = URL(string: "http://127.0.0.1:\(port)/api/v1/health"),
               let (_, response) = try? await URLSession.shared.data(from: url),
               (response as? HTTPURLResponse)?.statusCode == 200 {
                return
            }
            try await Task.sleep(nanoseconds: delay)
            delay = min(delay * 2, 1_000_000_000) // max 1s
        }
        throw ServerError.healthCheckFailed
    }
}
```

### WebViewController

Displays React frontend in WKWebView with native bridge.

```swift
class WebViewController: NSWindowController {
    var webView: WKWebView!
    private let bridgeVersion = "v1"

    func setupWebView(port: Int, token: String) {
        let config = WKWebViewConfiguration()

        // Inject native bridge
        let bridgeScript = WKUserScript(
            source: buildBridgeScript(token: token),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(bridgeScript)
        config.userContentController.add(self, name: "native")

        // Security: restrict navigation
        config.preferences.javaScriptCanOpenWindowsAutomatically = false

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)")!))

        // Persist window state
        window?.setFrameAutosaveName("MainWindow")
    }

    private func buildBridgeScript(token: String) -> String {
        """
        window.__agentboardToken = '\(token)';
        window.__agentboardBridgeVersion = '\(bridgeVersion)';
        window.native = {
            _callbacks: new Map(),
            _eventHandlers: new Map(),
            _nextId: 1,

            invoke: function(action, payload) {
                return new Promise((resolve, reject) => {
                    const id = String(this._nextId++);
                    this._callbacks.set(id, { resolve, reject });
                    window.webkit.messageHandlers.native.postMessage({
                        id, action, payload, version: '\(bridgeVersion)'
                    });
                });
            },

            on: function(event, handler) {
                if (!this._eventHandlers.has(event)) {
                    this._eventHandlers.set(event, new Set());
                }
                this._eventHandlers.get(event).add(handler);
                return () => this._eventHandlers.get(event).delete(handler);
            },

            _handleResponse: function(id, ok, data, error) {
                const cb = this._callbacks.get(id);
                if (cb) {
                    this._callbacks.delete(id);
                    ok ? cb.resolve(data) : cb.reject(new Error(error));
                }
            },

            _handleEvent: function(event, payload) {
                const handlers = this._eventHandlers.get(event);
                if (handlers) handlers.forEach(h => h(payload));
            }
        };
        """
    }
}

// Block external navigation
extension WebViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }

        // Allow only localhost
        if url.host == "127.0.0.1" || url.host == "localhost" {
            decisionHandler(.allow)
        } else {
            // Open external URLs in default browser
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        }
    }
}
```

### StatusItemManager

Menu bar presence with session list and status.

```swift
class StatusItemManager {
    private var statusItem: NSStatusItem!
    private var sessionsSubscription: AnyCancellable?

    @Published var waitingCount: Int = 0
    @Published var overallStatus: AgentStatus = .unknown

    func setup() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        updateIcon(status: .unknown)

        // Subscribe to session updates via WebSocket
        subscribeToEvents()
    }

    func updateIcon(status: AgentStatus) {
        let imageName: String
        switch status {
        case .unknown: imageName = "menubar-idle"
        case .working: imageName = "menubar-working"
        case .waiting: imageName = "menubar-waiting"
        case .error: imageName = "menubar-error"
        }
        statusItem.button?.image = NSImage(named: imageName)

        // Badge for waiting count
        if waitingCount > 0 {
            statusItem.button?.title = " \(waitingCount)"
        } else {
            statusItem.button?.title = ""
        }
    }

    func buildMenu(sessions: [SessionSummary]) -> NSMenu {
        let menu = NSMenu()

        // Sessions submenu
        let sessionsItem = NSMenuItem(title: "Sessions", action: nil, keyEquivalent: "")
        let sessionsMenu = NSMenu()
        for session in sessions {
            let item = NSMenuItem(
                title: "\(statusEmoji(session.status)) \(session.name)",
                action: #selector(focusSession(_:)),
                keyEquivalent: ""
            )
            item.representedObject = session.id
            sessionsMenu.addItem(item)
        }
        sessionsItem.submenu = sessionsMenu
        menu.addItem(sessionsItem)

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "New Session...", action: #selector(newSession), keyEquivalent: "n"))
        menu.addItem(.separator())

        // Tunnel status
        let tunnelItem = NSMenuItem(title: "Remote Access: Off", action: #selector(toggleTunnel), keyEquivalent: "")
        menu.addItem(tunnelItem)

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Preferences...", action: #selector(openPreferences), keyEquivalent: ","))
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))

        return menu
    }
}
```

### HotkeyManager

Global keyboard shortcuts with conflict detection.

```swift
class HotkeyManager {
    private var registeredHotkeys: [String: Any] = [:] // HotKey objects

    struct KeyCombo: Codable, Equatable {
        let key: String      // e.g., "a", "[", "]"
        let modifiers: UInt  // CGEventFlags

        var displayString: String {
            var parts: [String] = []
            if modifiers & CGEventFlags.maskCommand.rawValue != 0 { parts.append("⌘") }
            if modifiers & CGEventFlags.maskShift.rawValue != 0 { parts.append("⇧") }
            if modifiers & CGEventFlags.maskControl.rawValue != 0 { parts.append("⌃") }
            if modifiers & CGEventFlags.maskAlternate.rawValue != 0 { parts.append("⌥") }
            parts.append(key.uppercased())
            return parts.joined()
        }
    }

    /// Default hotkeys
    static let defaults: [String: KeyCombo] = [
        "toggleWindow": KeyCombo(key: "a", modifiers: 0x100108), // ⌘⇧A
        "nextSession": KeyCombo(key: "]", modifiers: 0x100108),  // ⌘⇧]
        "prevSession": KeyCombo(key: "[", modifiers: 0x100108),  // ⌘⇧[
        "newSession": KeyCombo(key: "n", modifiers: 0x100108),   // ⌘⇧N
    ]

    func register(name: String, combo: KeyCombo, action: @escaping () -> Void) throws {
        // Check for conflicts with system shortcuts
        if isConflicting(combo) {
            throw HotkeyError.conflict(combo.displayString)
        }

        // Using HotKey library or Carbon APIs
        // ...
    }

    func unregister(name: String) {
        registeredHotkeys.removeValue(forKey: name)
    }
}
```

### NotificationManager

Native macOS notifications for agent status changes.

```swift
class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    func requestPermission() async -> Bool {
        let center = UNUserNotificationCenter.current()
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            center.delegate = self
            return granted
        } catch {
            return false
        }
    }

    func notify(session: SessionSummary, event: NotificationEvent) {
        let content = UNMutableNotificationContent()

        switch event {
        case .waiting:
            content.title = "Agent Waiting"
            content.body = "\(session.name) needs your input"
            content.sound = .default
        case .completed:
            content.title = "Task Complete"
            content.body = "\(session.name) finished"
        case .error(let message):
            content.title = "Error"
            content.body = "\(session.name): \(message)"
            content.sound = .defaultCritical
        }

        content.userInfo = ["sessionId": session.id]

        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }

    // Handle notification click -> focus session
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let sessionId = response.notification.request.content.userInfo["sessionId"] as? String {
            NotificationCenter.default.post(name: .focusSession, object: sessionId)
        }
        completionHandler()
    }
}
```

### TunnelManager

Remote access via Tailscale (primary) or ngrok (optional).

```swift
class TunnelManager: ObservableObject {
    @Published var status: TunnelStatus = .disabled
    @Published var url: URL?

    enum TunnelStatus {
        case disabled, starting, active(URL), failed(Error)
    }

    enum TunnelProvider: String, CaseIterable {
        case tailscale, ngrok

        var command: String {
            switch self {
            case .tailscale: return "tailscale"
            case .ngrok: return "ngrok"
            }
        }

        func isInstalled() -> Bool {
            FileManager.default.isExecutableFile(atPath: "/usr/local/bin/\(command)") ||
            FileManager.default.isExecutableFile(atPath: "/opt/homebrew/bin/\(command)")
        }
    }

    private var tunnelProcess: Process?

    func startTunnel(provider: TunnelProvider, port: Int) async throws -> URL {
        guard provider.isInstalled() else {
            throw TunnelError.notInstalled(provider)
        }

        status = .starting

        switch provider {
        case .tailscale:
            // tailscale funnel {port}
            tunnelProcess = Process()
            tunnelProcess?.executableURL = URL(fileURLWithPath: "/usr/local/bin/tailscale")
            tunnelProcess?.arguments = ["funnel", String(port)]
            try tunnelProcess?.run()

            // Parse URL from tailscale status
            let url = try await getTailscaleFunnelURL()
            status = .active(url)
            return url

        case .ngrok:
            // ngrok http {port}
            tunnelProcess = Process()
            tunnelProcess?.executableURL = URL(fileURLWithPath: "/usr/local/bin/ngrok")
            tunnelProcess?.arguments = ["http", String(port)]
            try tunnelProcess?.run()

            // Parse URL from ngrok API
            try await Task.sleep(nanoseconds: 2_000_000_000)
            let url = try await getNgrokURL()
            status = .active(url)
            return url
        }
    }

    func stopTunnel() {
        tunnelProcess?.terminate()
        tunnelProcess = nil
        status = .disabled
        url = nil
    }
}
```

### PreferencesStore

Persistent storage for user preferences.

```swift
class PreferencesStore: ObservableObject {
    @Published var preferences: Preferences {
        didSet { save() }
    }

    private let defaults = UserDefaults.standard
    private let preferencesKey = "AgentboardPreferences"

    init() {
        if let data = defaults.data(forKey: preferencesKey),
           let prefs = try? JSONDecoder().decode(Preferences.self, from: data) {
            self.preferences = prefs
        } else {
            self.preferences = Preferences.default
        }
    }

    private func save() {
        if let data = try? JSONEncoder().encode(preferences) {
            defaults.set(data, forKey: preferencesKey)
        }
    }
}

class TokenManager {
    static let shared = TokenManager()

    var token: String {
        if let token = try? Keychain.get("AgentboardToken") {
            return token
        }
        let newToken = generateToken()
        try? Keychain.set("AgentboardToken", value: newToken)
        return newToken
    }

    func rotateToken() -> String {
        let newToken = generateToken()
        try? Keychain.set("AgentboardToken", value: newToken)
        return newToken
    }

    private func generateToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64EncodedString()
    }
}
```

## API Design (Server Additions)

Base URL: `http://127.0.0.1:{port}`
Versioning: `/api/v1`
Auth: `Authorization: Bearer <token>` required for all HTTP and WebSocket connections (except local requests in dev mode)
Content-Type: `application/json; charset=utf-8`

### Error Schema

```json
{
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "Session abc does not exist",
    "details": { "sessionId": "abc" }
  }
}
```

### Error Codes

| Code | HTTP | Description |
|------|------|-------------|
| `SERVER_NOT_READY` | 503 | Server still starting |
| `AUTH_REQUIRED` | 401 | Missing Authorization header |
| `AUTH_INVALID` | 401 | Invalid token |
| `SESSION_NOT_FOUND` | 404 | Session ID doesn't exist |
| `SESSION_EXISTS` | 409 | Session with name already exists |
| `INVALID_REQUEST` | 400 | Malformed request body |
| `TMUX_NOT_FOUND` | 500 | tmux not installed or not running |
| `PORT_IN_USE` | 500 | Server port unavailable |

### HTTP Endpoints

#### GET /api/v1/health

Health check for server readiness.

**Response 200:**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptimeSeconds": 123,
  "tmuxSession": "agentboard",
  "tmuxAvailable": true
}
```

#### GET /api/v1/sessions

List all active sessions.

**Response 200:**
```json
{
  "sessions": [
    {
      "id": "proj-1",
      "name": "proj-1",
      "status": "working",
      "lastActivityAt": "2024-01-01T00:00:00Z",
      "waitingCount": 0
    }
  ],
  "updatedAt": "2024-01-01T00:00:00Z"
}
```

#### POST /api/v1/sessions

Create a new session.

**Request:**
```json
{
  "name": "proj-2",
  "projectPath": "/Users/me/proj-2"
}
```

**Response 201:**
```json
{
  "session": {
    "id": "proj-2",
    "name": "proj-2",
    "status": "unknown",
    "lastActivityAt": "2024-01-01T00:00:00Z",
    "waitingCount": 0
  }
}
```

#### GET /api/v1/sessions/{id}

Get session details.

**Response 200:**
```json
{
  "session": {
    "id": "proj-1",
    "name": "proj-1",
    "status": "waiting",
    "lastActivityAt": "2024-01-01T00:00:00Z",
    "projectPath": "/Users/me/proj-1",
    "tmuxWindowId": "1",
    "waitingCount": 1
  }
}
```

#### POST /api/v1/sessions/{id}/terminate

Terminate a session.

**Response 202:**
```json
{ "ok": true }
```

### WebSocket Endpoints

#### ws://127.0.0.1:{port}/api/v1/ws/terminal?sessionId={id}

Terminal I/O streaming.

**Auth:** First message must be:
```json
{ "type": "auth", "token": "<token>" }
```

**Client → Server:**
```json
{ "type": "input", "data": "ls -la\n" }
{ "type": "resize", "cols": 120, "rows": 30 }
{ "type": "ping", "nonce": "uuid" }
```

**Server → Client:**
```json
{ "type": "output", "data": "..." }
{ "type": "status", "sessionId": "proj-1", "status": "waiting" }
{ "type": "pong", "nonce": "uuid" }
{ "type": "error", "code": "SESSION_NOT_FOUND", "message": "..." }
```

#### ws://127.0.0.1:{port}/api/v1/ws/events

Global event stream for menu bar and notifications.

**Server → Client:**
```json
{ "type": "sessions", "sessions": [ /* SessionSummary[] */ ] }
{ "type": "sessionUpdated", "session": { /* SessionSummary */ } }
{ "type": "badge", "waitingCount": 2 }
```

## Data Models

### TypeScript (Client/Server)

```typescript
type AgentStatus = "unknown" | "working" | "waiting" | "error";

interface SessionSummary {
  id: string;
  name: string;
  status: AgentStatus;
  lastActivityAt: string; // ISO 8601
  waitingCount: number;
}

interface SessionDetail extends SessionSummary {
  projectPath: string;
  tmuxWindowId: string;
}

interface ServerInfo {
  state: "stopped" | "starting" | "running" | "failed";
  port: number;
  lastRestartAt: string | null;
  restartCount: number;
}
```

### Swift (Mac App)

```swift
enum AgentStatus: String, Codable {
    case unknown, working, waiting, error
}

struct SessionSummary: Codable, Identifiable {
    let id: String
    let name: String
    let status: AgentStatus
    let lastActivityAt: Date
    let waitingCount: Int
}

struct Preferences: Codable {
    var port: Int = 4321
    var showDockIcon: Bool = true
    var launchAtLogin: Bool = false
    var hotkeys: HotkeyPreferences = .init()
    var notificationsEnabled: Bool = true
    var tunnel: TunnelPreferences = .init()

    static let `default` = Preferences()
}

struct HotkeyPreferences: Codable {
    var toggleWindow: String = "⌘⇧A"
    var nextSession: String = "⌘⇧]"
    var prevSession: String = "⌘⇧["
    var newSession: String = "⌘⇧N"
}

struct TunnelPreferences: Codable {
    var provider: String = "tailscale" // tailscale | ngrok | none
    var autoStart: Bool = false
}
```

## Native ↔ WebView Bridge

### JS API (v1)

```typescript
// src/client/utils/native.ts
interface NativeBridge {
  invoke(action: string, payload?: unknown): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void): () => void;
}

declare global {
  interface Window {
    native?: NativeBridge;
    __agentboardToken?: string;
    __agentboardBridgeVersion?: string;
  }
}

export function isNativeApp(): boolean {
  return typeof window.native !== 'undefined';
}

export async function showNotification(title: string, body: string): Promise<void> {
  await window.native?.invoke('showNotification', { title, body });
}

export async function setMenuBarStatus(status: AgentStatus): Promise<void> {
  await window.native?.invoke('setMenuBarStatus', { status });
}

export async function openTunnel(provider: 'tailscale' | 'ngrok'): Promise<string> {
  const result = await window.native?.invoke('openTunnel', { provider });
  return (result as { url: string }).url;
}

export async function closeTunnel(): Promise<void> {
  await window.native?.invoke('closeTunnel');
}
```

### Bridge Actions

| Action | Payload | Response |
|--------|---------|----------|
| `showNotification` | `{ title, body }` | `{ ok: true }` |
| `setMenuBarStatus` | `{ status }` | `{ ok: true }` |
| `openTunnel` | `{ provider }` | `{ url: string }` |
| `closeTunnel` | - | `{ ok: true }` |
| `getPreferences` | - | `Preferences` |
| `setPreferences` | `Partial<Preferences>` | `{ ok: true }` |
| `getAppInfo` | - | `{ version, bridgeVersion }` |

### Bridge Events (Native → JS)

| Event | Payload |
|-------|---------|
| `focusSession` | `{ sessionId: string }` |
| `tunnelStatusChanged` | `{ status, url? }` |
| `hotkeyTriggered` | `{ action: string }` |
| `preferencesChanged` | `Preferences` |

## Project Structure

```
agentboard/
├── macos/                              # New - Mac app
│   ├── Agentboard.xcodeproj
│   ├── Agentboard/
│   │   ├── App/
│   │   │   ├── AgentboardApp.swift     # @main entry point
│   │   │   ├── AppDelegate.swift       # Lifecycle, singletons
│   │   │   └── AppState.swift          # Global observable state
│   │   ├── MenuBar/
│   │   │   ├── StatusItemManager.swift
│   │   │   └── MenuBuilder.swift
│   │   ├── Window/
│   │   │   ├── WebViewController.swift
│   │   │   └── WebViewBridge.swift
│   │   ├── Server/
│   │   │   ├── ServerManager.swift
│   │   │   ├── HealthMonitor.swift
│   │   │   └── LogManager.swift
│   │   ├── Hotkeys/
│   │   │   └── HotkeyManager.swift
│   │   ├── Notifications/
│   │   │   └── NotificationManager.swift
│   │   ├── Tunnel/
│   │   │   ├── TunnelManager.swift
│   │   │   └── QRCodeGenerator.swift
│   │   ├── Preferences/
│   │   │   ├── PreferencesView.swift
│   │   │   ├── PreferencesStore.swift
│   │   │   └── TokenManager.swift
│   │   ├── Updates/
│   │   │   └── UpdateManager.swift
│   │   └── Resources/
│   │       ├── Assets.xcassets
│   │       ├── Info.plist
│   │       └── server/                 # Bundled server binary
│   │           └── agentboard-server
│   └── AgentboardTests/
│       ├── ServerManagerTests.swift
│       ├── HotkeyManagerTests.swift
│       └── TunnelManagerTests.swift
├── src/                                # Existing - minimal changes
│   ├── server/
│   │   └── index.ts                    # Add auth middleware, /api/v1 routes
│   └── client/
│       └── utils/
│           └── native.ts               # New - bridge utilities
├── scripts/
│   ├── build-server-binary.sh          # bun build --compile
│   ├── build-mac-app.sh                # xcodebuild
│   ├── create-dmg.sh                   # DMG packaging
│   └── notarize.sh                     # Apple notarization
└── docs/
    └── MAC_APP_PLAN.md                 # This document
```

## Security Considerations

### Server Binding
- Server binds only to `127.0.0.1`, never `0.0.0.0`
- Remote access only via explicit tunnel activation

### Authentication
- All HTTP and WebSocket requests require `Authorization: Bearer <token>`
- Token generated on first launch (32 bytes, SecRandomCopyBytes)
- Token stored in macOS Keychain, never logged or displayed in UI by default
- Token rotatable via preferences (invalidates all existing sessions)
- Local requests bypass auth only in development mode

### WebView Security
- Navigation restricted to `127.0.0.1` and `localhost` origins
- External URLs opened in default browser
- `window.open()` disabled
- No access to local files via `file://`

### CORS Policy
- Server allows only `http://127.0.0.1:*` and `http://localhost:*`
- Tunnel access requires token in Authorization header

### Input Validation
- Session IDs: alphanumeric, hyphens, underscores only
- Project paths: must be absolute, must exist, no symlink traversal
- Reject paths containing `..` or starting with `~` (expand first)

### Notification Privacy
- Notifications show session name only, not terminal content
- User can disable notifications entirely

### Tunnel Security
- Tunnels disabled by default
- Tailscale: relies on Tailscale auth (device must be on tailnet)
- ngrok: requires token auth on all requests
- Tunnel URL displayed with copy button, not auto-shared

## Error Handling Strategy

### Server Startup Failures

| Error | User-Facing Behavior |
|-------|---------------------|
| Binary not found | Show error dialog, offer to reinstall |
| Port in use | Auto-select next port (up to 10 attempts), persist selection |
| tmux not found | Show warning, offer to install via Homebrew |
| Health check timeout | Retry 3x with backoff, then show error with logs button |

### Runtime Errors

| Error | User-Facing Behavior |
|-------|---------------------|
| Server crash | Auto-restart with backoff, max 3 in 5 minutes |
| WebSocket disconnect | Show banner, auto-reconnect with backoff |
| Tunnel failure | Non-blocking alert, keep remote access disabled |
| Hotkey conflict | Mark shortcut invalid, prompt to reassign |
| Notification denied | Silent fallback to menu bar badge only |

### Graceful Degradation

| Missing Dependency | Behavior |
|--------------------|----------|
| tmux not installed | Show setup instructions, disable session features |
| tmux session gone | Offer to recreate, show last known state |
| Tailscale not installed | Hide tunnel option, show install link |
| ngrok not installed | Hide ngrok option if Tailscale available |

## Performance Requirements / SLAs

| Metric | Target | Measurement |
|--------|--------|-------------|
| App launch to menu bar icon | ≤ 1.0s | Cold start on M1 |
| Server health check pass | ≤ 1.0s | After process spawn |
| First UI render | ≤ 2.0s | DOMContentLoaded |
| Terminal input-to-output | ≤ 150ms | Localhost round-trip |
| Menu bar status update | ≤ 1.0s | After server event |
| Idle memory (app + server) | ≤ 200MB | Activity Monitor |
| Idle CPU | ≤ 5% | 5-minute average |
| Bundle size | ≤ 50MB | Signed .app |

## Observability

### Logging
- Structured JSON logs with timestamp, level, component
- Log levels: debug, info, warn, error
- Separate log files: app.log, server.log
- Location: `~/Library/Application Support/Agentboard/logs/`
- Rotation: 10MB max per file, 7-day retention

### Diagnostics Export
- Menu: Help → Export Diagnostics
- Creates ZIP with logs, preferences (redacted), system info
- Excludes auth tokens

### Crash Reporting (Optional)
- Opt-in during first launch
- Sentry or similar service
- Excludes terminal content and tokens

## Testing Strategy

### Swift Unit Tests
- `ServerManagerTests`: spawn, health check, restart logic
- `HotkeyManagerTests`: registration, conflict detection
- `TunnelManagerTests`: provider detection, start/stop
- `PreferencesStoreTests`: persistence, defaults

### Server Unit Tests
- Auth middleware enforcement
- API schema validation
- WebSocket message handling
- Error code responses

### Integration Tests
- Launch app → server starts → health passes
- Load WebView → bridge injects → can invoke actions
- Hotkey triggers → event reaches WebView

### UI Tests (XCUITest)
- Menu bar click → menu appears
- Preferences → save → persists
- Notification click → focuses session

### E2E Tests (Playwright)
- Full flow: launch, create session, type in terminal
- Remote access: enable tunnel, connect from browser

## Deployment Strategy

### Build Pipeline
1. Lint + typecheck + unit tests
2. Build server binary: `bun build --compile`
3. Build Mac app: `xcodebuild archive`
4. Sign with Developer ID
5. Notarize with Apple
6. Create DMG

### Distribution
- **Primary**: Signed DMG from GitHub releases
- **Secondary**: Homebrew cask (`brew install --cask agentboard`)
- **Future**: Mac App Store (requires sandbox evaluation)

### Auto-Updates
- Sparkle framework with appcast.xml
- Delta updates for faster downloads
- Rollback to previous version on failure
- Update check: daily, or manual

### Versioning
- Semantic versioning: MAJOR.MINOR.PATCH
- Bridge version independent: v1, v2, etc.
- Server API version: /api/v1, /api/v2, etc.

## Implementation Phases

### Phase 1: Foundation
**Goal**: App launches server and displays UI

- [ ] Create Xcode project with Swift 5.9, macOS 13+ target
- [ ] Implement ServerManager with spawn/health/restart
- [ ] Create WebViewController with WKWebView
- [ ] Inject basic native bridge (v1)
- [ ] Add menu bar status item (static icon)
- [ ] Build server binary script
- [ ] Basic Info.plist and app icon

**Deliverable**: App that opens, starts server, shows React UI

### Phase 2: Menu Bar
**Goal**: Dynamic menu bar with session list

- [ ] Subscribe to /api/v1/ws/events
- [ ] Update status icon based on session states
- [ ] Build dynamic session menu
- [ ] Implement badge count for waiting sessions
- [ ] Add show/hide window toggle
- [ ] Add dock icon preference

**Deliverable**: Functional menu bar with live session data

### Phase 3: Native Integrations
**Goal**: Hotkeys and notifications working

- [ ] Implement HotkeyManager with MASShortcut
- [ ] Register default hotkeys
- [ ] Add hotkey preferences UI
- [ ] Implement NotificationManager
- [ ] Connect notifications to session events
- [ ] Add notification click handling

**Deliverable**: Power-user features complete

### Phase 4: Tunnel Support
**Goal**: Remote access from phone

- [ ] Implement TunnelManager for Tailscale
- [ ] Add ngrok support (if installed)
- [ ] Display tunnel URL in menu bar
- [ ] Add QR code generation
- [ ] Implement server-side token auth
- [ ] Add tunnel preferences

**Deliverable**: Can access agentboard from mobile

### Phase 5: Distribution
**Goal**: Easy installation for users

- [ ] Set up code signing
- [ ] Implement notarization workflow
- [ ] Create DMG with installer
- [ ] Write Homebrew cask formula
- [ ] Integrate Sparkle for updates
- [ ] Create landing page

**Deliverable**: Downloadable, auto-updating app

### Phase 6: Polish
**Goal**: Production quality

- [ ] Launch at login option
- [ ] Opt-in crash reporting
- [ ] Performance profiling and optimization
- [ ] Accessibility audit (VoiceOver)
- [ ] Documentation and README
- [ ] Beta testing via TestFlight (optional)

## Open Questions

1. **Tunnel default**: Tailscale-only to start, or multi-provider from day one?
   - Recommendation: Tailscale-only for v1, add ngrok in v1.1

2. **App Store**: Direct download only, or pursue Mac App Store?
   - Recommendation: Direct first, evaluate App Store after v1 stability

3. **Token UX**: Show token in preferences, or keep fully hidden?
   - Recommendation: Hidden by default, "Show Token" button for advanced users

4. **Multi-window**: Allow multiple main windows?
   - Recommendation: Single window for v1, evaluate based on feedback

## Dependencies

### Swift Packages
- [HotKey](https://github.com/soffes/HotKey) - Global hotkeys
- [Sparkle](https://github.com/sparkle-project/Sparkle) - Auto-updates
- [KeychainAccess](https://github.com/kishikawakatsumi/KeychainAccess) - Keychain wrapper

### Build Requirements
- macOS 13+ (Ventura)
- Xcode 15+
- Swift 5.9+
- Bun 1.x

### Existing (unchanged)
- React 18, Vite, Tailwind
- Hono, node-pty, xterm.js
- Bun runtime

## Success Metrics

- [ ] App launches in < 2 seconds (cold start)
- [ ] Server ready in < 1 second
- [ ] Memory usage < 200MB idle
- [ ] Bundle size < 50MB
- [ ] Zero crashes in 1-week beta
- [ ] Tunnel connects in < 5 seconds
- [ ] Works on macOS 13+ (Intel and Apple Silicon)
