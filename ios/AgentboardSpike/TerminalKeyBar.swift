import SwiftUI

/// A single horizontally scrolling row in the PWA control order. Tapping the terminal opens the keyboard;
/// only dismissal needs a button, and only while input has focus.
struct TerminalKeyBar: View {
    @ObservedObject var terminal: TerminalBridge
    var showPasteStatus = true
    var selectText: (() -> Void)? = nil
    var numberKeys: (() -> Void)? = nil
    var attachFile: (() -> Void)? = nil
    @State private var showArrows = false
    @State private var showPaste = false
    @State private var pastedText = ""
    @State private var restoreInput = false

    var body: some View {
        VStack(spacing: 0) {
        if showPasteStatus { NativePasteStatus(controller: terminal.clipboard, onReview: { terminal.hideKeyboard() }) }
        ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 0) {
            key("Enter", symbol: "return", tint: true) { terminal.send("\r") }
            Button("esc") { terminal.send("\u{1b}") }.terminalKey().accessibilityLabel("Escape")
            key("Arrow keys and Shift", symbol: terminal.shift ? "shift.fill" : "arrow.up.and.down.and.arrow.left.and.right", tint: terminal.shift) { showArrows.toggle() }
                .accessibilityIdentifier("Arrow keys")
                .popover(isPresented: $showArrows) {
                    VStack(spacing: 4) {
                        Button { terminal.toggleShift(); showArrows = false } label: {
                            Label(terminal.shift ? "Shift on" : "Shift", systemImage: "shift")
                                .frame(minHeight: 44)
                        }.accessibilityValue(terminal.shift ? "On, next key" : "Off")
                        Divider()
                        arrow("Up", symbol: "arrow.up", sequence: "\u{1b}[A")
                        HStack(spacing: 4) {
                            arrow("Left", symbol: "arrow.left", sequence: "\u{1b}[D")
                            arrow("Down", symbol: "arrow.down", sequence: "\u{1b}[B")
                            arrow("Right", symbol: "arrow.right", sequence: "\u{1b}[C")
                        }
                    }.padding().presentationCompactAdaptation(.popover)
                }
            key("Paste text", symbol: "document.on.clipboard") {
                restoreInput = terminal.inputFocused
                terminal.hideKeyboard()
                showPaste = true
            }
            key("Select text", symbol: "character.cursor.ibeam") { selectText?() }
                .disabled(selectText == nil)
            key("Delete word", symbol: "delete.left") { terminal.send("\u{17}") }
            Button("123") { numberKeys?() }.terminalKey().accessibilityLabel("Number keys")
                .disabled(numberKeys == nil)
            Button("tab") { terminal.send("\t") }.terminalKey().accessibilityLabel("Tab")
            Button("shift") { terminal.toggleShift() }.terminalKey(active: terminal.shift)
                .accessibilityLabel("Shift modifier").accessibilityValue(terminal.shift ? "On, next key" : "Off")
            Button("ctrl") { terminal.toggleControl() }.terminalKey(active: terminal.control)
                .accessibilityLabel(terminal.control ? "Control on" : "Control")
            key("Copy selection", symbol: "doc.on.doc") { terminal.call("copySelection") }
            Button("Ctrl C") { terminal.send("\u{3}") }.terminalKey().accessibilityLabel("Interrupt")
            key("Insert newline", symbol: "arrow.turn.down.left") { terminal.send("\n") }
            key("Attach file", symbol: "paperclip") { attachFile?() }.disabled(attachFile == nil)
            if terminal.inputFocused {
                key("Hide keyboard", symbol: "keyboard.chevron.compact.down") { terminal.hideKeyboard() }
            }
        }
        .padding(.horizontal, 2)
        }
        .frame(height: 44)
        .accessibilityIdentifier("terminal-quick-keys")
        .nativeGlassSurface(cornerRadius: 16)
        .padding(.horizontal, 4).padding(.bottom, 4)
        }
        .sheet(isPresented: $showPaste, onDismiss: {
            if restoreInput && terminal.clipboard.state == .idle { terminal.focus() }
        }) {
            NavigationStack {
                VStack(alignment: .leading) {
                    NativePasteControl(controller: terminal.clipboard) { showPaste = false }
                        .frame(width: 180, height: 48).padding(.horizontal).padding(.top)
                    TextEditor(text: $pastedText)
                        .textInputAutocapitalization(.sentences).autocorrectionDisabled(false)
                        .padding().accessibilityLabel("Text to paste")
                }
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
            .font(.caption.weight(.medium)).lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .frame(minWidth: 38, minHeight: 32, maxHeight: 32)
            .foregroundStyle(active ? Color.accentColor : Color.primary)
            .background(active ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 10))
            .frame(minWidth: 44, minHeight: 44, maxHeight: 44)
            .contentShape(Rectangle())
            .buttonStyle(.plain)
    }
}
