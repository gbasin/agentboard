import SwiftUI
import Inject

struct TerminalScreen: View {
    @ObserveInjection var inject
    @Binding var session: BoardSession
    let endpoint: String
    var live: BoardConnection? = nil
    var serverURL: String = ""
    let onEnd: () -> Void
    var onSwitch: ((BoardSession) -> Void)? = nil
    var onManage: ((SessionActionRoute) -> Void)? = nil
    @StateObject private var terminal = TerminalBridge()
    @AppStorage("showMobileSessionPeek") private var showOverview = true
    @State private var showEnd = false
    @State private var showContent = false
    @State private var showTranscript = false
    @State private var showUpload = false
    @State private var showNumbers = false
    @State private var showRename = false
    @State private var showSelection = false
    @State private var name = ""
    @State private var appearance = "System"
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    private var currentSession: BoardSession { terminal.liveSession ?? session }
    private var mediaSummary: NativeMediaSummary {
        currentSession.mediaSummary.map(NativeMediaSummary.init(catalog:)) ?? NativeMediaSummary(items: currentSession.media)
    }

    var body: some View {
        TerminalWebView(bridge: terminal, session: session, endpoint: endpoint, live: live)
            .padding(.horizontal, 8)
            .background(Color(uiColor: .systemBackground))
            .safeAreaInset(edge: .top, spacing: 0) {
                if verticalSizeClass != .compact, let live, mediaSummary.canBrowse || showOverview {
                    HStack {
                        if showOverview, let onSwitch {
                            NativeSessionOverview(board: live, selectedID: session.id, select: onSwitch)
                        }
                        Spacer(minLength: 8)
                        if mediaSummary.canBrowse { mediaButton }
                    }.padding(.horizontal, 12).padding(.vertical, 4)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    if live != nil && !terminal.ready {
                        HStack {
                            Text(terminal.connection).font(.caption)
                            Spacer()
                            Button("Reconnect") { live?.reconnect() }.font(.caption)
                        }.padding(.horizontal, 12).padding(.vertical, 8)
                            .nativeGlassSurface().padding(.horizontal, 4).accessibilityIdentifier("terminal-connection")
                    }
                    TerminalKeyBar(
                        terminal: terminal, showPasteStatus: !showUpload,
                        selectText: live == nil ? nil : { terminal.hideKeyboard(); terminal.readingSnapshot = true; showSelection = true },
                        numberKeys: { terminal.hideKeyboard(); showNumbers = true },
                        attachFile: live == nil || session.remote ? nil : { terminal.hideKeyboard(); showUpload = true }
                    ).disabled(live != nil && !terminal.ready)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if verticalSizeClass == .compact, let live {
                        if showOverview, let onSwitch {
                            NativeSessionOverview(board: live, selectedID: session.id, select: onSwitch)
                                .labelStyle(.titleAndIcon)
                        }
                        if mediaSummary.canBrowse { mediaButton.labelStyle(.titleAndIcon) }
                    }
                }
                ToolbarItem(placement: .principal) {
                    if let live, onSwitch != nil {
                        Menu {
                            ForEach(live.sessions) { item in
                                Button(item.name) { onSwitch?(item) }.disabled(!live.canOpen(item))
                            }
                        } label: { sessionTitle(showDisclosure: true) }
                        .accessibilityLabel("Switch session, \(terminal.liveSession?.name ?? session.name)")
                        .accessibilityValue("\(currentSession.project), \(currentSession.status.rawValue)")
                    } else { sessionTitle(showDisclosure: false) }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    StableMenuButton(makeItems: makeSessionMenuItems)
                        .frame(width: 44, height: 44)
                }
            }
            .sheet(isPresented: $showContent) { NavigationStack {
                SessionContentView(server: serverURL, media: (terminal.liveSession ?? session).media, prs: (terminal.liveSession ?? session).prs, sessionID: (terminal.liveSession ?? session).agentSessionID, catalog: (terminal.liveSession ?? session).mediaSummary)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showContent = false } } }
            } }
            .sheet(isPresented: $showTranscript) { NavigationStack {
                TranscriptView(server: serverURL, sessionID: (terminal.liveSession ?? session).agentSessionID ?? "", title: session.name)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showTranscript = false } } }
            } }
            .sheet(isPresented: $showSelection, onDismiss: { terminal.readingSnapshot = false }) {
                if let live { TerminalSelectionView(board: live, session: terminal.liveSession ?? session) }
            }
            .sheet(isPresented: $showUpload) { FileUploadSheet(server: serverURL, terminal: terminal) }
            .sheet(isPresented: $showNumbers) { NumberKeys(terminal: terminal) }
            .preferredColorScheme(live != nil || appearance == "System" ? nil : appearance == "Dark" ? .dark : .light)
            .confirmationDialog("End this sample session?", isPresented: $showEnd, titleVisibility: .visible) {
                Button("End sample session", role: .destructive, action: onEnd)
            } message: { Text("This removes the sample from the list. No live agent is affected.") }
            .alert("Rename sample", isPresented: $showRename) {
                TextField("Name", text: $name)
                Button("Cancel", role: .cancel) {}
                Button("Save") { session.name = name.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .enableInjection()
            .onChange(of: scenePhase, initial: true) { _, phase in
                if phase == .active && live == nil { terminal.call("resume") }
                terminal.setSceneActive(phase == .active)
            }
    }
    /// Metadata may change while this snapshot is open. Resolve the current
    /// session/capabilities again inside actions before handing off management.
    private func makeSessionMenuItems() -> [UIMenuElement] {
        func action(_ title: String, _ icon: String, enabled: Bool = true,
                    destructive: Bool = false, state: UIMenuElement.State = .off,
                    perform: @escaping () -> Void) -> UIAction {
            var attributes: UIMenuElement.Attributes = []
            if !enabled { attributes.insert(.disabled) }
            if destructive { attributes.insert(.destructive) }
            return UIAction(title: title, image: icon.isEmpty ? nil : UIImage(systemName: icon), attributes: attributes, state: state) { _ in perform() }
        }
        var items: [UIMenuElement] = [UIMenu(options: .displayInline, children: [
            action(terminal.connection, endpoint.isEmpty ? "doc.text" : "network", enabled: false) {}
        ])]
        if let live {
            items.append(UIMenu(title: "Switch session", children: live.sessions.map { item in
                action(item.name, "", enabled: live.canOpen(item)) {
                    if let latest = live.sessions.first(where: { $0.id == item.id }), live.canOpen(latest) { onSwitch?(latest) }
                }
            }))
            if canControlSession {
                items.append(action("Duplicate session", "plus.square.on.square") { if canControlSession { onManage?(.duplicate(currentSession)) } })
            }
            if SessionCapabilities.canHibernate(currentSession) {
                items.append(action("Hibernate session", "moon") { if SessionCapabilities.canHibernate(currentSession) { onManage?(.hibernate(currentSession)) } })
            }
            items.append(action("Media and links", "photo.on.rectangle") { terminal.hideKeyboard(); showContent = true })
            items.append(action("Transcript", "text.bubble", enabled: currentSession.agentSessionID != nil) {
                if currentSession.agentSessionID != nil { terminal.hideKeyboard(); showTranscript = true }
            })
            items.append(action("Attach file", "paperclip", enabled: terminal.ready && !session.remote) {
                if terminal.ready && !currentSession.remote { terminal.hideKeyboard(); showUpload = true }
            })
            if canControlSession {
                items.append(action("Rename session", "pencil") { if canControlSession { onManage?(.rename(currentSession)) } })
            }
        } else {
            items.append(action("Rename sample", "pencil") { name = session.name; showRename = true })
            items.append(action(session.status == .sleeping ? "Wake sample" : "Sleep sample", "moon") {
                session.status = session.status == .sleeping ? .waiting : .sleeping
            })
        }
        var controls: [UIMenuElement] = [action("Number keys", "number") { terminal.hideKeyboard(); showNumbers = true }]
        if live != nil {
            let select = action("Select text", "text.cursor", enabled: terminal.ready) {
                if terminal.ready { terminal.hideKeyboard(); terminal.readingSnapshot = true; showSelection = true }
            }
            select.accessibilityIdentifier = "terminal-select-text"
            controls.append(select)
        }
        controls.append(action("Copy selection", "doc.on.doc") { terminal.call("copySelection") })
        if let live {
            controls.append(action("Copy server selection", "clipboard", enabled: live.clipboardOffer != nil) {
                if let text = live.clipboardOffer { UIPasteboard.general.string = text }
            })
            controls.append(action("Exit copy mode", "escape") { terminal.exitCopyMode() })
        }
        controls += [
            action("Interrupt", "stop") { terminal.send("\u{3}") },
            action("Delete word", "delete.left") { terminal.send("\u{17}") },
            action("Insert newline", "arrow.turn.down.left") { terminal.send("\n") },
            action("Larger text", "textformat.size.larger") { terminal.setFont(min(24, terminal.fontSize + 1)) },
            action("Smaller text", "textformat.size.smaller") { terminal.setFont(max(6, terminal.fontSize - 1)) },
            action("Scroll to bottom", "arrow.down.to.line") { terminal.call("bottom") },
        ]
        if let live { controls.append(action("Reconnect", "arrow.clockwise") { live.reconnect() }) }
        else if !endpoint.isEmpty { controls.append(action("Reconnect shell", "arrow.clockwise") { terminal.call("reconnect") }) }
        items.append(UIMenu(title: "Terminal", options: .displayInline, children: controls))
        let selected = live?.preferences.string("theme", "system") ?? appearance.lowercased()
        items.append(UIMenu(title: "Appearance", options: .singleSelection, children: ["System", "Light", "Dark"].map { title in
            action(title, "", state: selected == title.lowercased() ? .on : .off) {
                if let live { live.preferences.set("theme", .string(title.lowercased())) }
                else { appearance = title }
            }
        }))
        if live != nil, canControlSession {
            items.append(action("End session", "xmark.circle", destructive: true) { if canControlSession { onManage?(.end(currentSession)) } })
        } else if live == nil {
            items.append(action("End sample session", "xmark.circle", destructive: true) { showEnd = true })
        }
        return items
    }

    private var canControlSession: Bool {
        guard let live else { return false }
        return SessionCapabilities.canControl(currentSession, remoteAllowed: live.remoteAllowControl)
    }

    private var mediaButton: some View {
        NativeMediaSummaryButton(summary: mediaSummary) { terminal.hideKeyboard(); showContent = true }
    }
    private func sessionTitle(showDisclosure: Bool) -> some View {
        VStack(spacing: 2) {
            HStack(spacing: 4) {
                Text(terminal.liveSession?.name ?? session.name).font(.headline).lineLimit(1)
                if showDisclosure { Image(systemName: "chevron.down").font(.caption2.weight(.semibold)) }
            }
            HStack(spacing: 4) {
                if !currentSession.project.isEmpty {
                    Text((currentSession.project as NSString).lastPathComponent)
                        .font(.caption).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                        .accessibilityLabel(currentSession.project)
                    Text("·").font(.caption).foregroundStyle(.secondary).accessibilityHidden(true)
                }
                SessionStatus(status: currentSession.status).fixedSize()
            }
        }.frame(minHeight: 44).foregroundStyle(.primary)
            .accessibilityElement(children: .combine)
    }

}
