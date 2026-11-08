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
    @State private var showEnd = false
    @State private var showContent = false
    @State private var showTranscript = false
    @State private var showUpload = false
    @State private var showNumbers = false
    @State private var showRename = false
    @State private var name = ""
    @State private var appearance = "System"
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TerminalWebView(bridge: terminal, session: session, endpoint: endpoint, live: live)
            .padding(.horizontal, 8)
            .background(Color(uiColor: .systemBackground))
            .safeAreaInset(edge: .top, spacing: 0) {
                let summary = NativeMediaSummary(items: (terminal.liveSession ?? session).media)
                if live != nil && summary.total > 0 {
                    HStack {
                        Spacer()
                        NativeMediaSummaryButton(summary: summary) { terminal.hideKeyboard(); showContent = true }
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
                    TerminalKeyBar(terminal: terminal).disabled(live != nil && !terminal.ready)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    if let live, onSwitch != nil {
                        Menu {
                            ForEach(live.sessions) { item in
                                Button(item.name) { onSwitch?(item) }.disabled(!live.canOpen(item))
                            }
                        } label: { sessionTitle(showDisclosure: true) }
                        .accessibilityLabel("Switch session, \(terminal.liveSession?.name ?? session.name)")
                        .accessibilityValue((terminal.liveSession ?? session).status.rawValue)
                    } else { sessionTitle(showDisclosure: false) }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Section {
                            Label(terminal.connection, systemImage: endpoint.isEmpty ? "doc.text" : "network")
                        }
                        if let live {
                            Menu("Switch session") {
                                ForEach(live.sessions) { item in
                                    Button(item.name) { onSwitch?(item) }.disabled(!live.canOpen(item))
                                }
                            }
                            if SessionCapabilities.canControl(terminal.liveSession ?? session, remoteAllowed: live.remoteAllowControl) {
                                Button("Duplicate session", systemImage: "plus.square.on.square") { onManage?(.duplicate(terminal.liveSession ?? session)) }
                            }
                            if SessionCapabilities.canHibernate(terminal.liveSession ?? session) {
                                Button("Hibernate session", systemImage: "moon") { onManage?(.hibernate(terminal.liveSession ?? session)) }
                            }
                            Button("Media and links", systemImage: "photo.on.rectangle") { terminal.hideKeyboard(); showContent = true }
                            Button("Transcript", systemImage: "text.bubble") { terminal.hideKeyboard(); showTranscript = true }
                                .disabled((terminal.liveSession ?? session).agentSessionID == nil)
                            Button("Attach file", systemImage: "paperclip") { terminal.hideKeyboard(); showUpload = true }.disabled(!terminal.ready || session.remote)
                            if SessionCapabilities.canControl(terminal.liveSession ?? session, remoteAllowed: live.remoteAllowControl) {
                                Button("Rename session", systemImage: "pencil") { onManage?(.rename(terminal.liveSession ?? session)) }
                            }
                        }
                        if live == nil {
                        Button("Rename sample", systemImage: "pencil") { name = session.name; showRename = true }
                        Button(session.status == .sleeping ? "Wake sample" : "Sleep sample", systemImage: "moon") {
                            session.status = session.status == .sleeping ? .waiting : .sleeping
                        }
                        }
                        Section("Terminal") {
                            Button("Number keys", systemImage: "number") { terminal.hideKeyboard(); showNumbers = true }
                            Button("Copy selection", systemImage: "doc.on.doc") { terminal.call("copySelection") }
                            if let live {
                                Button("Copy server selection", systemImage: "clipboard") {
                                    if let text = live.clipboardOffer { UIPasteboard.general.string = text }
                                }.disabled(live.clipboardOffer == nil)
                                Button("Exit copy mode", systemImage: "escape") { live.exitCopyMode() }
                            }
                            Button("Interrupt", systemImage: "stop") { terminal.send("\u{3}") }
                            Button("Delete word", systemImage: "delete.left") { terminal.send("\u{17}") }
                            Button("Insert newline", systemImage: "arrow.turn.down.left") { terminal.send("\n") }
                            Button("Larger text", systemImage: "textformat.size.larger") { terminal.setFont(min(24, terminal.fontSize + 1)) }
                            Button("Smaller text", systemImage: "textformat.size.smaller") { terminal.setFont(max(6, terminal.fontSize - 1)) }
                            Button("Scroll to bottom", systemImage: "arrow.down.to.line") { terminal.call("bottom") }
                            if let live {
                                Button("Reconnect", systemImage: "arrow.clockwise") { live.reconnect() }
                            } else if !endpoint.isEmpty {
                                Button("Reconnect shell", systemImage: "arrow.clockwise") { terminal.call("reconnect") }
                            }
                        }
                        if let live {
                            Picker("Appearance", selection: live.preferences.selection("theme", fallback: "system")) {
                                Text("System").tag("system")
                                Text("Light").tag("light")
                                Text("Dark").tag("dark")
                            }
                        } else {
                            Picker("Appearance", selection: $appearance) {
                                Text("System").tag("System")
                                Text("Light").tag("Light")
                                Text("Dark").tag("Dark")
                            }
                        }
                        if let live, SessionCapabilities.canControl(terminal.liveSession ?? session, remoteAllowed: live.remoteAllowControl) {
                            Button("End session", systemImage: "xmark.circle", role: .destructive) {
                                onManage?(.end(terminal.liveSession ?? session))
                            }
                        }
                        if live == nil {
                            Button("End sample session", systemImage: "xmark.circle", role: .destructive) { showEnd = true }
                        }
                    } label: {
                        Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel("Session actions")
                }
            }
            .sheet(isPresented: $showContent) { NavigationStack {
                SessionContentView(server: serverURL, media: (terminal.liveSession ?? session).media, prs: (terminal.liveSession ?? session).prs)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showContent = false } } }
            } }
            .sheet(isPresented: $showTranscript) { NavigationStack {
                TranscriptView(server: serverURL, sessionID: (terminal.liveSession ?? session).agentSessionID ?? "", title: session.name)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showTranscript = false } } }
            } }
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
            .onChange(of: scenePhase) { _, phase in
                if phase == .active && live == nil { terminal.call("resume") }
                if phase != .active { terminal.shift = false }
            }
    }
    private func sessionTitle(showDisclosure: Bool) -> some View {
        VStack(spacing: 2) {
            HStack(spacing: 4) {
                Text(terminal.liveSession?.name ?? session.name).font(.headline).lineLimit(1)
                if showDisclosure { Image(systemName: "chevron.down").font(.caption2.weight(.semibold)) }
            }
            SessionStatus(status: terminal.liveSession?.status ?? session.status)
        }.frame(minHeight: 44).foregroundStyle(.primary)
            .accessibilityElement(children: .combine)
    }

}
