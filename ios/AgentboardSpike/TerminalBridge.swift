import SwiftUI
import WebKit

@MainActor
final class TerminalBridge: ObservableObject {
    @Published var connection = "Sample transcript"
    @Published var control = false
    @Published var fontSize = 13
    @Published var inputFocused = false
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
    @Environment(\.colorScheme) private var colorScheme

    func makeCoordinator() -> Coordinator { Coordinator(bridge: bridge, session: session, endpoint: endpoint) }

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
        init(bridge: TerminalBridge, session: BoardSession, endpoint: String) {
            self.bridge = bridge; self.session = session; self.endpoint = endpoint
        }
        @objc func focusTerminal() {
            // WebKit takes first responder while finishing its tap. Hand off
            // only after its event has been processed, without a timed delay.
            bridge.webView?.evaluateJavaScript("window.agentboard.prepareInput()") { [weak self] result, _ in
                if result as? Bool == true { self?.bridge.focus() }
            }
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            bridge.call("start", ["name": session.name, "endpoint": endpoint, "dark": dark])
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            bridge.connection = "Terminal could not load"
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let data = message.body as? [String: Any] else { return }
            if let status = data["status"] as? String { bridge.connection = status }
            if let control = data["control"] as? Bool { bridge.control = control }
        }
    }
}
