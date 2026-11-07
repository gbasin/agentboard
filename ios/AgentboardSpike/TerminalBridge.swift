import SwiftUI
import WebKit

@MainActor
final class TerminalBridge: ObservableObject {
    @Published var connection = "Sample transcript"
    @Published var control = false
    @Published var fontSize = 13
    weak var webView: WKWebView?

    func call(_ method: String, _ arguments: [String: Any] = [:]) {
        guard let data = try? JSONSerialization.data(withJSONObject: arguments),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.agentboard?.\(method)(\(json))", completionHandler: nil)
    }
    func send(_ value: String) { call("send", ["data": value]) }
    func focus() { call("focus") }
    func hideKeyboard() { webView?.endEditing(true); call("blur") }
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

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(context.coordinator, name: "terminal")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .systemBackground
        view.scrollView.isScrollEnabled = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.isInspectable = true
        bridge.webView = view
        if let url = Bundle.main.url(forResource: "terminal", withExtension: "html", subdirectory: "Web") {
            view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.dark = colorScheme == .dark
        bridge.call("theme", ["dark": colorScheme == .dark])
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.evaluateJavaScript("window.agentboard?.dispose()", completionHandler: nil)
        view.configuration.userContentController.removeScriptMessageHandler(forName: "terminal")
        view.navigationDelegate = nil
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let bridge: TerminalBridge
        let session: BoardSession
        let endpoint: String
        var dark = false
        init(bridge: TerminalBridge, session: BoardSession, endpoint: String) {
            self.bridge = bridge; self.session = session; self.endpoint = endpoint
        }
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
