import SwiftUI
import Inject

struct TerminalScreen: View {
    @ObserveInjection var inject
    @Binding var session: BoardSession
    let endpoint: String
    let onEnd: () -> Void
    @StateObject private var terminal = TerminalBridge()
    @State private var showEnd = false
    @State private var showRename = false
    @State private var name = ""
    @State private var appearance = "System"
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TerminalWebView(bridge: terminal, session: session, endpoint: endpoint)
            .padding(.horizontal, 8)
            .background(Color(uiColor: .systemBackground))
            .safeAreaInset(edge: .bottom, spacing: 0) {
                TerminalKeyBar(terminal: terminal)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 2) {
                        Text(session.name).font(.headline).lineLimit(1)
                        SessionStatus(status: session.status)
                    }
                    .accessibilityElement(children: .combine)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Section {
                            Label(terminal.connection, systemImage: endpoint.isEmpty ? "doc.text" : "network")
                        }
                        Button("Rename sample", systemImage: "pencil") { name = session.name; showRename = true }
                        Button(session.status == .sleeping ? "Wake sample" : "Sleep sample", systemImage: "moon") {
                            session.status = session.status == .sleeping ? .waiting : .sleeping
                        }
                        Section("Terminal") {
                            Button("Interrupt", systemImage: "stop") { terminal.send("\u{3}") }
                            Button("Delete word", systemImage: "delete.left") { terminal.send("\u{17}") }
                            Button("Insert newline", systemImage: "arrow.turn.down.left") { terminal.send("\n") }
                            Button("Larger text", systemImage: "textformat.size.larger") { terminal.setFont(min(22, terminal.fontSize + 1)) }
                            Button("Smaller text", systemImage: "textformat.size.smaller") { terminal.setFont(max(11, terminal.fontSize - 1)) }
                            Button("Scroll to bottom", systemImage: "arrow.down.to.line") { terminal.call("bottom") }
                            if !endpoint.isEmpty {
                                Button("Reconnect shell", systemImage: "arrow.clockwise") { terminal.call("reconnect") }
                            }
                        }
                        Picker("Appearance", selection: $appearance) {
                            Text("System").tag("System")
                            Text("Light").tag("Light")
                            Text("Dark").tag("Dark")
                        }
                        Button("End sample session", systemImage: "xmark.circle", role: .destructive) { showEnd = true }
                    } label: {
                        Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel("Session actions")
                }
            }
            .preferredColorScheme(appearance == "System" ? nil : appearance == "Dark" ? .dark : .light)
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
                if phase == .active { terminal.call("resume") }
            }
    }
}
