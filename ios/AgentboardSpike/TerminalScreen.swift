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

struct TerminalKeyBar: View {
    @ObservedObject var terminal: TerminalBridge
    @State private var showArrows = false
    @State private var showPaste = false
    @State private var pastedText = ""

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                key("Enter", symbol: "return", tint: true) { terminal.send("\r") }
                Button("esc") { terminal.send("\u{1b}") }.keyStyle().accessibilityLabel("Escape")
                key("Arrow keys", symbol: "arrow.up.and.down.and.arrow.left.and.right") { showArrows.toggle() }
                    .popover(isPresented: $showArrows) {
                        VStack(spacing: 4) {
                            key("Up", symbol: "arrow.up") { terminal.send("\u{1b}[A") }
                            HStack {
                                key("Left", symbol: "arrow.left") { terminal.send("\u{1b}[D") }
                                key("Down", symbol: "arrow.down") { terminal.send("\u{1b}[B") }
                                key("Right", symbol: "arrow.right") { terminal.send("\u{1b}[C") }
                            }
                        }.padding().presentationCompactAdaptation(.popover)
                    }
                key("Paste text", symbol: "document.on.clipboard") { terminal.hideKeyboard(); showPaste = true }
                Button("ctrl") { terminal.toggleControl() }.keyStyle(active: terminal.control)
                    .accessibilityLabel(terminal.control ? "Control on" : "Control")
                key("Keyboard", symbol: "keyboard") { terminal.focus() }
                key("Hide keyboard", symbol: "keyboard.chevron.compact.down") { terminal.hideKeyboard() }
                Button("tab") { terminal.send("\t") }.keyStyle().accessibilityLabel("Tab")
                key("Delete word", symbol: "delete.left") { terminal.send("\u{17}") }
                key("Interrupt", symbol: "stop") { terminal.send("\u{3}") }
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
        }
        .fixedSize(horizontal: false, vertical: true)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
        .sheet(isPresented: $showPaste) {
            NavigationStack {
                TextEditor(text: $pastedText).padding().accessibilityLabel("Text to paste")
                    .navigationTitle("Paste into terminal").navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showPaste = false } }
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Insert") { terminal.paste(pastedText); pastedText = ""; showPaste = false }
                                .disabled(pastedText.isEmpty)
                        }
                    }
            }.presentationDetents([.medium, .large])
        }
    }

    private func key(_ name: String, symbol: String, tint: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol) }
            .keyStyle(active: tint).accessibilityLabel(name)
    }
}

private extension View {
    func keyStyle(active: Bool = false) -> some View {
        self.font(.callout.weight(.medium))
            .frame(minWidth: 44, minHeight: 44)
            .foregroundStyle(active ? Color.accentColor : Color.primary)
            .background(active ? Color.accentColor.opacity(0.12) : Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10))
            .buttonStyle(.plain)
    }
}
