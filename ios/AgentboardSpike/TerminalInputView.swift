import UIKit
import WebKit

/// Public-API keyboard proxy. WKWebView renders and selects terminal output;
/// this text view owns text input, so WebKit's form accessory never appears.
final class TerminalInputView: UITextView, UITextViewDelegate {
    private let sentinel = "\u{200B}"
    weak var terminal: TerminalBridge?

    init(terminal: TerminalBridge) {
        self.terminal = terminal
        super.init(frame: .zero, textContainer: nil)
        delegate = self
        backgroundColor = .clear
        textColor = .clear
        tintColor = .clear
        isScrollEnabled = false
        autocorrectionType = .no
        autocapitalizationType = .none
        spellCheckingType = .no
        smartQuotesType = .no
        smartDashesType = .no
        smartInsertDeleteType = .no
        keyboardType = .default
        textContentType = .none
        inputAssistantItem.leadingBarButtonGroups = []
        inputAssistantItem.trailingBarButtonGroups = []
        // The SwiftUI safe-area inset is the sole accessory row.
        inputAccessoryView = nil
        isAccessibilityElement = false
        resetBuffer()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    private func resetBuffer() {
        text = sentinel
        selectedRange = NSRange(location: sentinel.utf16.count, length: 0)
    }

    func textViewDidBeginEditing(_ textView: UITextView) { terminal?.inputFocused = true }
    func textViewDidEndEditing(_ textView: UITextView) { terminal?.inputFocused = false }

    func textViewDidChange(_ textView: UITextView) {
        // Keep composition in UIKit until the input method commits it. Never
        // forward intermediate marked text or reset the IME's editing buffer.
        guard markedTextRange == nil else { return }
        let committed = text.hasPrefix(sentinel) ? String(text.dropFirst()) : text ?? ""
        if !committed.isEmpty {
            terminal?.send(committed.replacingOccurrences(of: "\n", with: "\r"))
        }
        resetBuffer()
    }

    override func deleteBackward() {
        if markedTextRange != nil || text != sentinel {
            super.deleteBackward()
        } else {
            terminal?.send("\u{7f}")
        }
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)) {
            // UIKit's default text view excludes image-only/file-only clipboard items.
            // Reading the item count checks availability without reading clipboard content.
            return terminal != nil && UIPasteboard.general.numberOfItems > 0
        }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        terminal?.clipboard.pasteClipboard()
    }

    override var keyCommands: [UIKeyCommand]? {
        let arrows = [UIKeyCommand.inputUpArrow, UIKeyCommand.inputDownArrow,
                      UIKeyCommand.inputLeftArrow, UIKeyCommand.inputRightArrow]
        let plain = (arrows + ["\t", UIKeyCommand.inputEscape]).map {
            UIKeyCommand(input: $0, modifierFlags: [], action: #selector(terminalKey(_:)))
        }
        let control = "abcdefghijklmnopqrstuvwxyz".map {
            UIKeyCommand(input: String($0), modifierFlags: .control, action: #selector(terminalKey(_:)))
        }
        let shifted = UIKeyCommand(input: "\t", modifierFlags: .shift, action: #selector(terminalKey(_:)))
        return (plain + control + [shifted]).map {
            $0.wantsPriorityOverSystemBehavior = true
            return $0
        }
    }

    @objc private func terminalKey(_ command: UIKeyCommand) {
        guard let input = command.input else { return }
        if command.modifierFlags.contains(.control), let scalar = input.uppercased().unicodeScalars.first {
            terminal?.send(String(UnicodeScalar(scalar.value - 64)!))
            return
        }
        let sequences = [UIKeyCommand.inputUpArrow: "\u{1b}[A", UIKeyCommand.inputDownArrow: "\u{1b}[B",
                         UIKeyCommand.inputRightArrow: "\u{1b}[C", UIKeyCommand.inputLeftArrow: "\u{1b}[D",
                         UIKeyCommand.inputEscape: "\u{1b}"]
        terminal?.send(command.modifierFlags.contains(.shift) && input == "\t" ? "\u{1b}[Z" : sequences[input] ?? input)
    }
}

/// Keeps input in the responder hierarchy without covering the web view's
/// touch surface. Text and caret stay in xterm; this one-point view is a proxy.
final class TerminalContainerView: UIView {
    let webView: WKWebView
    let input: TerminalInputView

    init(webView: WKWebView, input: TerminalInputView) {
        self.webView = webView
        self.input = input
        super.init(frame: .zero)
        addSubview(input)
        addSubview(webView)
        input.clipsToBounds = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layoutSubviews() {
        super.layoutSubviews()
        webView.frame = bounds
        input.frame = CGRect(x: 0, y: max(0, bounds.height - 1), width: 1, height: 1)
    }
}
