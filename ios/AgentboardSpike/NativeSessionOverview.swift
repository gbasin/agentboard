import SwiftUI

/// Native equivalent of the PWA's optional cross-session status peek.
struct NativeSessionOverview: View {
    @ObservedObject var board: BoardConnection
    let selectedID: String
    let select: (BoardSession) -> Void
    private var statuses: [BoardSession.Status] { BoardSession.Status.allCases.filter { status in board.sessions.contains { $0.status == status } } }
    private var summary: String { statuses.map { status in "\(board.sessions.filter { $0.status == status }.count) \(status.rawValue.lowercased())" }.joined(separator: ", ") }
    var body: some View {
        Menu {
            ForEach(board.sessions) { session in
                Button { select(session) } label: {
                    Label("\(session.name) · \(session.status.rawValue)\(session.id == selectedID ? " · Current" : "")", systemImage: session.status.symbol)
                }.disabled(!board.canOpen(session))
            }
        } label: {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    ForEach(statuses, id: \.self) { status in
                        Label {
                            Text("\(board.sessions.filter { $0.status == status }.count)").foregroundStyle(.primary)
                        } icon: { Image(systemName: status.symbol).foregroundStyle(status.color) }
                    }
                }
                Label("\(board.sessions.count)", systemImage: "rectangle.stack")
            }.font(.caption).dynamicTypeSize(...DynamicTypeSize.xxxLarge).padding(.horizontal, 8).padding(.vertical, 6)
                .nativeGlassSurface(cornerRadius: 18, interactive: true)
                .frame(minHeight: 44).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityLabel("Session overview").accessibilityValue(summary)
            .accessibilityShowsLargeContentViewer { Text("Session overview: " + summary) }
            .accessibilityIdentifier("session-overview")
    }
}
