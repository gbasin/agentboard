import UIKit
import UniformTypeIdentifiers

extension NativePastePayload {
    /// Loads the representation chosen for each item without synchronous pasteboard reads.
    @MainActor static func load(_ providers: [NSItemProvider]) async throws -> Self {
        var result = Self()
        for provider in providers {
            try Task.checkCancellation()
            let preferred = [UTType.fileURL.identifier, UTType.png.identifier, UTType.jpeg.identifier,
                             UTType.gif.identifier, "org.webmproject.webp", UTType.utf8PlainText.identifier,
                             UTType.plainText.identifier, UTType.text.identifier, UTType.url.identifier]
            let declared = provider.registeredTypeIdentifiers
            let identifier = preferred.first(where: { declared.contains($0) }) ?? declared.first(where: {
                guard let type = UTType($0) else { return false }
                return type.conforms(to: .content)
            })
            guard let identifier else { throw SessionActionError(message: "This clipboard item is not available to paste. Use Attach file to choose it.") }
            let data: Data = try await withCheckedThrowingContinuation { continuation in
                provider.loadDataRepresentation(forTypeIdentifier: identifier) { data, error in
                    if let data { continuation.resume(returning: data) }
                    else { continuation.resume(throwing: error ?? SessionActionError(message: "The clipboard item could not be read. Copy it again or use Attach file.")) }
                }
            }
            try Task.checkCancellation()
            let item = try decode([[identifier: data]])
            result.text += item.text
            for file in item.files {
                let suggested = provider.suggestedName
                let name: String
                if let suggested, !suggested.isEmpty {
                    name = URL(fileURLWithPath: suggested).pathExtension.isEmpty
                        ? suggested + "." + URL(fileURLWithPath: file.name).pathExtension : suggested
                } else { name = file.name }
                result.files.append(.init(data: file.data, name: name, mime: file.mime))
            }
        }
        return result
    }
}
