import SwiftUI
import SafariServices
import WebKit

struct SessionContentView: View {
    let server: String
    let media: [MediaItem]
    let prs: [PullRequestItem]
    var showsMedia = true
    var sessionID: String? = nil
    var catalog: MediaCatalogSummary? = nil
    @StateObject private var pages = MediaCatalogModel()
    @State private var selected: MediaItem?
    @State private var search = ""
    @State private var kind = ""
    @Environment(\.scenePhase) private var scenePhase
    private var paginated: Bool { catalog != nil && sessionID != nil && showsMedia }
    private var items: [MediaItem] { paginated ? pages.page?.items ?? [] : media }
    private var requestKey: String { "\(server)|\(sessionID ?? "")|\(catalog?.identity ?? "")|\(kind)|\(search)" }
    var body: some View {
        List {
            if !prs.isEmpty {
                Section("Pull requests") {
                    ForEach(prs) { pr in NavigationLink("\(pr.repo) #\(pr.number)") { PullRequestView(server: server, item: pr) } }
                }
            }
            if paginated {
                Section {
                    Picker("Show", selection: $kind) {
                        Text("All").tag(""); Text("Images and files").tag("media")
                        Text("Links").tag("links"); Text("Previews").tag("previews")
                    }
                    if let discovery = pages.summary?.discovery, discovery.running {
                        ProgressView("Discovering media…")
                        if let read = discovery.bytesRead, let total = discovery.bytesTotal, total > 0 {
                            ProgressView(value: Double(read), total: Double(total)).accessibilityLabel("Transcript indexing progress")
                        }
                        if !pages.loading { Button("Continue discovery") { pages.refresh() } }
                    }
                    if let discovery = pages.summary?.discovery, discovery.status == "failed" {
                        Text(discovery.message ?? "Media discovery failed.")
                        Button("Retry discovery") { pages.refresh() }
                    }
                    if pages.changed { Button("Media changed · Refresh") { selected = nil; pages.refresh() }.accessibilityIdentifier("refresh-changed-media") }
                    if case .failed(let message) = pages.state {
                        Text(message).foregroundStyle(.secondary)
                        Button("Retry media") { pages.refresh() }
                    }
                    let omitted = (pages.summary?.omittedRecords ?? 0) + (pages.summary?.omittedItems ?? 0)
                    if omitted > 0 { Text("Some transcript entries or media items could not be indexed (\(omitted)).").font(.footnote) }
                }
            }
            if showsMedia { Section {
                ForEach(items) { item in
                    Button { selected = item } label: { MediaCatalogRow(item: item, server: server) }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("media-item-\(item.id)")
                }
                if pages.loading { ProgressView("Loading media…") }
                if items.isEmpty && !pages.loading {
                    Text(paginated ? "No matching media found." : "No media available in this session snapshot.").foregroundStyle(.secondary)
                }
            } header: {
                Text(paginated ? "Media and links · \(pages.page?.total ?? catalog?.total ?? 0)" : "Media and links")
            } footer: {
                if !paginated { Text("Showing media available in the session snapshot. Older servers may limit this list.") }
            } }

        }
        .safeAreaInset(edge: .bottom) {
            if paginated && pages.page != nil {
                HStack {
                    Button { selected = nil; pages.previous() } label: {
                        Image(systemName: "chevron.left").frame(width: 44, height: 44).contentShape(Rectangle())
                    }.accessibilityLabel("Previous page").disabled(!pages.canPrevious)
                    Spacer()
                    Menu {
                        Button("Back to first page") { selected = nil; pages.refresh() }
                    } label: { Text("Page \(pages.pageNumber + 1)").font(.callout).monospacedDigit().frame(minHeight: 44) }
                        .disabled(pages.loading)
                    Spacer()
                    Button { selected = nil; pages.next() } label: {
                        Image(systemName: "chevron.right").frame(width: 44, height: 44).contentShape(Rectangle())
                    }.accessibilityLabel("Next page").disabled(!pages.canNext)
                }.buttonStyle(.plain).padding(.horizontal, 12).nativeGlassSurface(cornerRadius: 24).padding(.horizontal)
            }
        }
        .navigationTitle(showsMedia ? "Media and links" : "Pull requests").navigationBarTitleDisplayMode(.inline)
        .modifier(MediaSearch(enabled: paginated, text: $search))
        .task(id: requestKey) {
            guard paginated, let catalog, let sessionID else { return }
            pages.cancel(); selected = nil
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            pages.configure(source: .init(server: server, sessionID: sessionID, identity: catalog.identity), summary: catalog, kind: kind, search: search)
        }
        .onChange(of: catalog) { _, value in if let value { pages.observe(value) } }
        .onChange(of: scenePhase) { _, phase in if phase == .active { pages.resume() } else { pages.cancel() } }
        .onDisappear { pages.cancel() }
        .refreshable { if paginated { selected = nil; pages.refresh() } }
        .sheet(item: $selected) { item in MediaDetailView(server: server, items: items, initial: item, source: pages.source) }
    }
}

private struct MediaCatalogRow: View {
    let item: MediaItem
    let server: String
    var body: some View {
        HStack {
            if item.kind == "image", let url = thumbnailURL {
                AsyncImage(url: url) { image in image.resizable().scaledToFit() } placeholder: { Image(systemName: "photo") }
                    .frame(width: 64, height: 64)
            } else { Image(systemName: item.kind == "link" ? "link" : "doc").frame(width: 44, height: 44) }
            VStack(alignment: .leading) {
                Text(item.label ?? item.mediaType ?? item.kind.capitalized).foregroundStyle(.primary)
                if let text = item.sourceText { Text(text).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                if let bytes = item.bytes { Text(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)).font(.caption) }
            }
        }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
    }
    private var thumbnailURL: URL? {
        guard let url = resolved(item.url, server: server) else { return nil }
        if item.url.hasPrefix("/api/session-media/"), var parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
           parts.queryItems?.contains(where: { $0.name == "digest" }) == true {
            parts.queryItems = (parts.queryItems ?? []) + [.init(name: "thumbnail", value: "1")]
            return parts.url
        }
        guard let bytes = item.bytes, bytes >= 0, bytes <= 64 * 1024 else { return nil }
        return url
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
    var source: MediaCatalogSource? = nil
    @StateObject private var imageNavigation = MediaImageNavigation()
    @State private var navigated: MediaItem?
    @State private var index = 0
    @State private var scale = 1.0
    @State private var gestureStartScale = 1.0
    @Environment(\.dismiss) private var dismiss
    private var item: MediaItem { navigated ?? (items.indices.contains(index) ? items[index] : initial) }
    private var indexedImage: Bool { source != nil && item.kind == "image" && item.url.contains("digest=") }
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
                    } else if item.kind == "document" { NativeDocumentPreview(url: url, mediaType: item.mediaType) }
                    else { DocumentWebView(url: url) }
                } else { ContentUnavailableView("Unsupported link", systemImage: "link") }
            }
            .navigationTitle(item.label ?? "Media").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItemGroup(placement: .bottomBar) {
                    if indexedImage {
                        Button("Previous", systemImage: "chevron.left") { navigate(imageNavigation.neighbors?.previous) }
                            .disabled(imageNavigation.loading || imageNavigation.neighbors?.previous == nil)
                        Button("Next", systemImage: "chevron.right") { navigate(imageNavigation.neighbors?.next) }
                            .disabled(imageNavigation.loading || imageNavigation.neighbors?.next == nil)
                    } else {
                        Button("Previous", systemImage: "chevron.left") { index -= 1; scale = 1; gestureStartScale = 1 }.disabled(index == 0)
                        Text("\(index + 1)/\(items.count)").monospacedDigit().fixedSize().accessibilityLabel("\(index + 1) of \(items.count)")
                        Button("Next", systemImage: "chevron.right") { index += 1; scale = 1; gestureStartScale = 1 }.disabled(index + 1 >= items.count)
                    }
                    if let url = resolved(item.externalUrl ?? item.url, server: server) {
                        if item.kind != "document" { ShareLink(item: url) { Image(systemName: "square.and.arrow.up") }.accessibilityLabel("Share media") }
                        Link(destination: url) { Image(systemName: "safari") }.accessibilityLabel("Open in browser") }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if let error = imageNavigation.error {
                    VStack { Text(error).font(.caption); Button("Retry image navigation") {
                        Task { if let source { await imageNavigation.load(source: source, item: item) } }
                    } }.padding().nativeGlassSurface()
                }
            }
            .task(id: item.url) { if indexedImage, let source { await imageNavigation.load(source: source, item: item) } }
            .onDisappear { imageNavigation.clear() }
            .onAppear { index = items.firstIndex(of: initial) ?? 0 }
        }
    }
    private func navigate(_ target: MediaItem?) {
        guard let target else { return }
        imageNavigation.clear(); navigated = target; scale = 1; gestureStartScale = 1
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

private struct MediaSearch: ViewModifier {
    let enabled: Bool
    @Binding var text: String
    @ViewBuilder func body(content: Content) -> some View {
        if enabled { content.searchable(text: $text, prompt: "Search media and links") }
        else { content }
    }
}
