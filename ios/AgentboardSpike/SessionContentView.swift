import SwiftUI
import SafariServices
import WebKit

struct SessionContentView: View {
    let server: String
    let media: [MediaItem]
    let prs: [PullRequestItem]
    @State private var selected: MediaItem?
    var body: some View {
        List {
            if !prs.isEmpty {
                Section("Pull requests") {
                    ForEach(prs) { pr in NavigationLink("\(pr.repo) #\(pr.number)") { PullRequestView(server: server, item: pr) } }
                }
            }
            Section("Media and links") {
                ForEach(media) { item in
                    Button { selected = item } label: {
                        HStack {
                            if item.kind == "image", let url = resolved(item.url, server: server) {
                                AsyncImage(url: url) { image in image.resizable().scaledToFit() } placeholder: { Image(systemName: "photo") }
                                    .frame(width: 64, height: 64)
                            } else { Image(systemName: item.kind == "link" ? "link" : "doc").frame(width: 44, height: 44) }
                            VStack(alignment: .leading) {
                                Text(item.label ?? item.mediaType ?? item.kind.capitalized).foregroundStyle(.primary)
                                if let bytes = item.bytes { Text(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)).font(.caption) }
                            }
                        }
                    }
                }
                if media.isEmpty { Text("No media found in this session.").foregroundStyle(.secondary) }
            }
        }.navigationTitle("Media and links").navigationBarTitleDisplayMode(.inline)
            .sheet(item: $selected) { item in MediaDetailView(server: server, items: media, initial: item) }
    }
}
func resolved(_ value: String, server: String) -> URL? {
    if let url = URL(string: value), ["https", "http"].contains(url.scheme ?? "") { return url }
    guard value.hasPrefix("/"), !value.hasPrefix("//"), let address = try? ServerAddress(server) else { return nil }
    return URL(string: address.baseURL.absoluteString + value)
}
struct MediaDetailView: View {
    let server: String
    let items: [MediaItem]
    let initial: MediaItem
    @State private var index = 0
    @State private var scale = 1.0
    @State private var gestureStartScale = 1.0
    @Environment(\.dismiss) private var dismiss
    private var item: MediaItem { items.indices.contains(index) ? items[index] : initial }
    var body: some View {
        NavigationStack {
            Group {
                if let url = resolved(item.url, server: server) {
                    if item.kind == "image" {
                        ScrollView([.horizontal, .vertical]) {
                            AsyncImage(url: url) { phase in
                                if let image = phase.image { image.resizable().scaledToFit().frame(width: UIScreen.main.bounds.width * scale).accessibilityElement(children: .ignore).accessibilityLabel(item.label ?? "Session image").accessibilityAddTraits(.isImage) }
                                else if phase.error != nil { ContentUnavailableView("Image unavailable", systemImage: "photo") }
                                else { ProgressView("Loading image…") }
                            }
                        }.simultaneousGesture(MagnifyGesture().onChanged { scale = min(5, max(1, gestureStartScale * $0.magnification)) }.onEnded { _ in gestureStartScale = scale })
                    } else { DocumentWebView(url: url) }
                } else { ContentUnavailableView("Unsupported link", systemImage: "link") }
            }
            .navigationTitle(item.label ?? "Media").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItemGroup(placement: .bottomBar) {
                    Button("Previous", systemImage: "chevron.left") { index -= 1; scale = 1; gestureStartScale = 1 }.disabled(index == 0)
                    Text("\(index + 1)/\(items.count)").monospacedDigit().fixedSize().accessibilityLabel("\(index + 1) of \(items.count)")
                    Button("Next", systemImage: "chevron.right") { index += 1; scale = 1; gestureStartScale = 1 }.disabled(index + 1 >= items.count)
                    if let url = resolved(item.url, server: server) { ShareLink(item: url) { Image(systemName: "square.and.arrow.up") }.accessibilityLabel("Share media"); Link(destination: url) { Image(systemName: "safari") }.accessibilityLabel("Open in browser") }
                }
            }
            .onAppear { index = items.firstIndex(of: initial) ?? 0 }
        }
    }
}
/// Keeps navigation state separate from the original URL so redirects do not reload forever.
struct DocumentWebView: View {
    let url: URL
    @StateObject private var state = DocumentState()
    var body: some View {
        ZStack {
            DocumentBrowser(url: url, state: state)
            if state.loading { ProgressView("Loading document…").padding().background(.regularMaterial) }
            if let error = state.error {
                ContentUnavailableView {
                    Label("Document unavailable", systemImage: "doc")
                } description: { Text(error) } actions: {
                    Button("Retry") { state.reload += 1 }
                    Link("Open in browser", destination: url)
                }.background(Color(uiColor: .systemBackground))
            }
        }
    }
}
@MainActor final class DocumentState: ObservableObject {
    @Published var loading = true
    @Published var error: String?
    @Published var reload = 0
}
struct DocumentBrowser: UIViewRepresentable {
    let url: URL
    @ObservedObject var state: DocumentState
    func makeCoordinator() -> Coordinator { Coordinator(state: state) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.addUserScript(WKUserScript(source: """
            if (document.head && !document.querySelector('meta[name=viewport]')) {
                const viewport = document.createElement('meta'); viewport.name = 'viewport';
                viewport.content = 'width=device-width, initial-scale=1'; document.head.appendChild(viewport);
            }
            """, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator; return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        guard context.coordinator.requested != url || context.coordinator.reload != state.reload else { return }
        context.coordinator.requested = url; context.coordinator.reload = state.reload
        view.load(URLRequest(url: url))
    }
    final class Coordinator: NSObject, WKNavigationDelegate {
        let state: DocumentState
        var requested: URL?
        var reload = -1
        init(state: DocumentState) { self.state = state }
        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { state.loading = true; state.error = nil }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { state.loading = false }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
        private func failed(_ error: Error) {
            guard (error as NSError).code != NSURLErrorCancelled else { return }
            state.loading = false; state.error = error.localizedDescription
        }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(["http", "https"].contains(action.request.url?.scheme ?? "") ? .allow : .cancel)
        }
    }
}
struct PullRequestInfo: Decodable {
    struct Check: Decodable {
        let name: String; let status: String; let conclusion: String?; let link: String?
        var label: String {
            switch conclusion ?? status {
            case "SUCCESS": "Passed"
            case "FAILURE", "ERROR": "Failed"
            case "IN_PROGRESS", "PENDING": "In progress"
            default: (conclusion ?? status).replacingOccurrences(of: "_", with: " ").capitalized
            }
        }
    }
    let title: String?; let state: String?; let author: String?; let isDraft: Bool?; let error: String?; let checks: [Check]?
}
struct PullRequestView: View {
    let server: String
    let item: PullRequestItem
    @State private var info: PullRequestInfo?
    @State private var error: String?
    var body: some View {
        List {
            if let error { ErrorRow(message: error) { Task { await load() } } }
            if let info {
                Section {
                    Text(info.title ?? "Pull request #\(item.number)").font(.headline)
                    let metadata = [info.state, info.isDraft == true ? "Draft" : nil, info.author].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                    if !metadata.isEmpty { Text(metadata).font(.subheadline).foregroundStyle(.secondary) }
                    if let error = info.error {
                        Text(error == "unavailable" ? "Pull request details are unavailable. Check GitHub access on the server." : error)
                        Button("Retry") { Task { await load() } }
                    }
                }
                if !(info.checks ?? []).isEmpty { Section("Checks") {
                    ForEach(Array((info.checks ?? []).enumerated()), id: \.offset) { _, check in
                        VStack(alignment: .leading) {
                            Text(check.name); Text(check.label).font(.caption)
                            if let link = check.link, let url = resolved(link, server: server) { Link("Open check", destination: url) }
                        }
                    }
                }
                }
            } else if error == nil { ProgressView("Loading pull request…") }
            if let url = resolved(item.url, server: server) { Link("Open pull request", destination: url); ShareLink(item: url) }
        }.navigationTitle("Pull request").navigationBarTitleDisplayMode(.inline).task { await load() }
    }
    private func load() async {
        do { info = try await BoardAPI(server).request("api/pr-checks", query: ["url": item.url]); error = nil }
        catch { self.error = error.localizedDescription }
    }
}
