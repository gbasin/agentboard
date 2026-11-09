import UIKit
import UniformTypeIdentifiers

/// Public clipboard representations only. Alternative encodings of one item are not duplicated.
struct NativePasteFile: Equatable {
    let data: Data
    let name: String
    let mime: String
    var isImage: Bool { ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(mime) }
    static func read(_ url: URL) throws -> Self {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard values.isRegularFile == true else { throw SessionActionError(message: "Choose a file, not a folder.") }
        guard (values.fileSize ?? 0) <= 40 * 1024 * 1024 else { throw SessionActionError(message: "\(url.lastPathComponent) exceeds the 40 MB limit.") }
        return .init(data: try Data(contentsOf: url), name: url.lastPathComponent,
                     mime: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream")
    }
}
struct NativePastePayload: Equatable {
    var text = ""
    var files: [NativePasteFile] = []
    var isEmpty: Bool { text.isEmpty && files.isEmpty }
    func validate() throws {
        for file in files {
            if file.data.count > 40 * 1024 * 1024 { throw SessionActionError(message: "\(file.name) exceeds the 40 MB limit.") }
            if file.mime.hasPrefix("image/") && file.data.isEmpty { throw SessionActionError(message: "\(file.name) contains no image data. Choose the file to upload it.") }
        }
    }
    @MainActor static func read(_ board: UIPasteboard = .general) throws -> Self { try decode(board.items) }
    @MainActor static func decode(_ items: [[String: Any]]) throws -> Self {
        var result = Self()
        for item in items {
            if let value = item[UTType.fileURL.identifier], let url = fileURL(value) {
                result.files.append(try .read(url)); continue
            }
            let imageTypes = [UTType.png.identifier, UTType.jpeg.identifier, UTType.gif.identifier, "org.webmproject.webp"]
            if let type = imageTypes.first(where: { item[$0] is Data }), let data = item[type] as? Data {
                let uniform = UTType(type)
                result.files.append(.init(data: data, name: "clipboard.\(uniform?.preferredFilenameExtension ?? "png")", mime: uniform?.preferredMIMEType ?? "image/png")); continue
            }
            if let image = item.values.compactMap({ $0 as? UIImage }).first, let data = image.pngData() {
                result.files.append(.init(data: data, name: "clipboard.png", mime: "image/png")); continue
            }
            if let type = item.keys.sorted().first(where: { UTType($0)?.conforms(to: .image) == true }),
               let data = item[type] as? Data, let image = UIImage(data: data), let png = image.pngData() {
                result.files.append(.init(data: png, name: "clipboard.png", mime: "image/png")); continue
            }
            let textTypes = [UTType.utf8PlainText.identifier, UTType.plainText.identifier, UTType.text.identifier, UTType.url.identifier]
            if let type = textTypes.first(where: { item[$0] != nil }), let value = item[type] {
                if let text = value as? String { result.text += text }
                else if let url = value as? URL { result.text += url.absoluteString }
                else if let data = value as? Data, let text = String(data: data, encoding: .utf8) { result.text += text }
                continue
            }
            if let type = item.keys.sorted().first(where: {
                guard let uniform = UTType($0) else { return false }
                return uniform.conforms(to: .content) && !uniform.conforms(to: .text) && item[$0] is Data
            }), let data = item[type] as? Data {
                let uniform = UTType(type)
                result.files.append(.init(data: data, name: "clipboard.\(uniform?.preferredFilenameExtension ?? "bin")", mime: uniform?.preferredMIMEType ?? "application/octet-stream")); continue
            }
            if !item.isEmpty { throw SessionActionError(message: "This clipboard item is not available to paste. Use Attach file to choose it.") }
        }
        return result
    }
    private static func fileURL(_ value: Any) -> URL? {
        let url: URL?
        if let value = value as? URL { url = value }
        else if let value = value as? String { url = URL(string: value) }
        else if let value = value as? Data, let string = String(data: value, encoding: .utf8) { url = URL(string: string) }
        else { url = nil }
        return url?.isFileURL == true ? url : nil
    }
}
struct NativePasteDelivery: Equatable {
    let value: String
    let bracketed: Bool
    static func cleanPath(_ path: String) -> String { String(path.unicodeScalars.filter { $0.value >= 32 && $0.value != 127 }) }
    static func make(_ payload: NativePastePayload, paths: [String], agent: String?) -> [Self] {
        guard paths.count == payload.files.count else { return [] }
        let uploads = Array(zip(payload.files, paths))
        let documents = uploads.filter { !$0.0.isImage }.map { BoardAPI.shellQuote(cleanPath($0.1)) }
        let text = ([payload.text] + documents).filter { !$0.isEmpty }.joined(separator: "\n")
        var result: [Self] = text.isEmpty ? [] : [.init(value: text + (paths.isEmpty ? "" : " "), bracketed: true)]
        for (file, path) in uploads where file.isImage {
            let clean = cleanPath(path)
            result.append(.init(value: (agent == "codex" ? clean : "\u{1b}[200~\(clean)\u{1b}[201~") + " ", bracketed: false))
        }
        return result
    }
}
