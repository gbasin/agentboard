import SwiftUI

/// A single, non-scrolling row. Tapping the terminal opens the keyboard;
/// only dismissal needs a button, and only while input has focus.
struct TerminalKeyBar: View {
    @ObservedObject var terminal: TerminalBridge
    @State private var showArrows = false
    @State private var showPaste = false
    @State private var pastedText = ""
    @State private var restoreInput = false

    var body: some View {
        HStack(spacing: 4) {
            key("Enter", symbol: "return", tint: true) { terminal.send("\r") }
            Button("esc") { terminal.send("\u{1b}") }.terminalKey().accessibilityLabel("Escape")
            Button("tab") { terminal.send("\t") }.terminalKey().accessibilityLabel("Tab")
            key("Arrow keys", symbol: "arrow.up.and.down.and.arrow.left.and.right") { showArrows.toggle() }
                .popover(isPresented: $showArrows) {
                    VStack(spacing: 4) {
                        arrow("Up", symbol: "arrow.up", sequence: "\u{1b}[A")
                        HStack(spacing: 4) {
                            arrow("Left", symbol: "arrow.left", sequence: "\u{1b}[D")
                            arrow("Down", symbol: "arrow.down", sequence: "\u{1b}[B")
                            arrow("Right", symbol: "arrow.right", sequence: "\u{1b}[C")
                        }
                    }.padding().presentationCompactAdaptation(.popover)
                }
            key(terminal.control ? "Control on" : "Control", symbol: "control", tint: terminal.control) {
                terminal.toggleControl()
            }
            key("Paste text", symbol: "document.on.clipboard") {
                restoreInput = terminal.inputFocused
                terminal.hideKeyboard()
                showPaste = true
            }
            if terminal.inputFocused {
                key("Hide keyboard", symbol: "keyboard.chevron.compact.down") { terminal.hideKeyboard() }
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
        .sheet(isPresented: $showPaste, onDismiss: {
            if restoreInput { terminal.focus() }
        }) {
            NavigationStack {
                TextEditor(text: $pastedText).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .padding().accessibilityLabel("Text to paste")
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

    private func arrow(_ name: String, symbol: String, sequence: String) -> some View {
        Button { terminal.send(sequence) } label: { Image(systemName: symbol).frame(width: 44, height: 44) }
            .accessibilityLabel(name)
    }

    private func key(_ name: String, symbol: String, tint: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol) }
            .terminalKey(active: tint).accessibilityLabel(name)
    }
}

private extension View {
    func terminalKey(active: Bool = false) -> some View {
        // Match the keyboard's compact accessory geometry at accessibility
        // sizes; the surrounding catalog and sheets still scale without a cap.
        self.dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            .font(.callout.weight(.medium)).lineLimit(1)
            .frame(minWidth: 44, maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(active ? Color.accentColor : Color.primary)
            .background(active ? Color.accentColor.opacity(0.12) : Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10))
            .buttonStyle(.plain)
    }
}
