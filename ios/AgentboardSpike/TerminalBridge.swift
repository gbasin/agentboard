import SwiftUI
import WebKit
import Combine

@MainActor
final class TerminalBridge: ObservableObject {
    @Published var connection = "Sample transcript"
    @Published var control = false
    @Published var fontSize = 13
    @Published var inputFocused = false
    @Published var ready = false
    @Published var liveSession: BoardSession?
    weak var inputView: TerminalInputView?
    weak var webView: WKWebView?

    func call(_ method: String, _ arguments: [String: Any] = [:]) {
        guard let data = try? JSONSerialization.data(withJSONObject: arguments),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.agentboard?.\(method)(\(json))", completionHandler: nil)
    }
    func send(_ value: String) { call("send", ["data": value]) }
    func focus() { inputView?.becomeFirstResponder() }
    func hideKeyboard() { inputView?.resignFirstResponder() }
    func toggleControl() { control.toggle(); call("control", ["active": control]) }
    func paste(_ value: String) { call("paste", ["data": value]) }
    func setFont(_ size: Int) { fontSize = size; call("font", ["size": size]) }
}

struct TerminalWebView: UIViewRepresentable {
    @ObservedObject var bridge: TerminalBridge
    let session: BoardSession
    let endpoint: String
    var live: BoardConnection? = nil
    @Environment(\.colorScheme) private var colorScheme

    func makeCoordinator() -> Coordinator { Coordinator(bridge: bridge, session: session, endpoint: endpoint, live: live) }

    func makeUIView(context: Context) -> TerminalContainerView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(context.coordinator, name: "terminal")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .systemBackground
        view.scrollView.isScrollEnabled = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.isInspectable = true
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.focusTerminal))
        tap.cancelsTouchesInView = false
        tap.delegate = context.coordinator
        view.addGestureRecognizer(tap)
        bridge.webView = view
        if let url = Bundle.main.url(forResource: "terminal", withExtension: "html", subdirectory: "Web") {
            view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        let input = TerminalInputView(terminal: bridge)
        bridge.inputView = input
        return TerminalContainerView(webView: view, input: input)
    }

    func updateUIView(_ view: TerminalContainerView, context: Context) {
        context.coordinator.dark = colorScheme == .dark
        bridge.call("theme", ["dark": colorScheme == .dark])
    }

    static func dismantleUIView(_ container: TerminalContainerView, coordinator: Coordinator) {
        coordinator.active = false
        coordinator.live?.deselect(owner: coordinator.owner)
        coordinator.subscription?.cancel()
        container.input.resignFirstResponder()
        let view = container.webView
        view.evaluateJavaScript("window.agentboard?.dispose()", completionHandler: nil)
        view.configuration.userContentController.removeScriptMessageHandler(forName: "terminal")
        view.navigationDelegate = nil
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler, UIGestureRecognizerDelegate {
        let bridge: TerminalBridge
        let session: BoardSession
        let endpoint: String
        var dark = false
        let live: BoardConnection?
        let owner = UUID()
        var active = true
        var bound = false
        var subscription: AnyCancellable?
        init(bridge: TerminalBridge, session: BoardSession, endpoint: String, live: BoardConnection?) {
            self.bridge = bridge; self.session = session; self.endpoint = endpoint; self.live = live
            super.init()
            subscription = live?.$sessions.sink { [weak bridge] sessions in
                bridge?.liveSession = sessions.first { $0.id == session.id }
            }
        }
        @objc func focusTerminal() {
            // WebKit takes first responder while finishing its tap. Hand off
            // only after its event has been processed, without a timed delay.
            bridge.webView?.evaluateJavaScript("window.agentboard.prepareInput()") { [weak self] result, _ in
                if result as? Bool == true, let self, self.active, self.live == nil || self.bridge.ready { self.bridge.focus() }
            }
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            bridge.call("start", ["name": session.name, "endpoint": endpoint, "dark": dark, "native": live != nil])
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            bridge.connection = "Terminal could not load"
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let data = message.body as? [String: Any] else { return }
            if let live, active, let type = data["type"] as? String {
                if type == "viewport", let cols = data["cols"] as? Int, let rows = data["rows"] as? Int {
                    let size = TerminalSize(cols: cols, rows: rows)
                    if !bound {
                        bound = true
                        live.select(session.id, owner: owner, size: size,
                                    output: { [weak bridge] value in bridge?.call("write", ["data": value]) },
                                    reset: { [weak bridge] in bridge?.call("reset") },
                                    status: { [weak bridge] state in
                                        bridge?.connection = state.label
                                        bridge?.ready = state == .ready
                                        if state != .ready { bridge?.hideKeyboard() }
                                    })
                    } else { live.resize(size, owner: owner) }
                } else if let value = data["data"] as? String, type == "input" || type == "paste" {
                    live.input(value, owner: owner, paste: type == "paste")
                }
            }
            if let status = data["status"] as? String { bridge.connection = status }
            if let control = data["control"] as? Bool { bridge.control = control }
        }
    }
}
