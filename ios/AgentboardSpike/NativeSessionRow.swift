import SwiftUI

/// Independent primary and metadata actions avoid nesting buttons inside a NavigationLink.
struct NativeSessionRow: View {
    let session: BoardSession
    @ObservedObject var preferences: NativePreferences
    let canOpen: Bool
    let onOpen: () -> Void
    let onPullRequests: () -> Void
    let onSubagents: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize
    @ObservedObject var pullRequests: BoardPullRequests

    private var rowLayout: AnyLayout {
        typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
    }
    private var visiblePRs: [PullRequestItem] { Array(session.prs.prefix(typeSize.isAccessibilitySize ? 2 : 4)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: 5) {
                    rowLayout {
                        HStack(spacing: 8) {
                            HarnessIcon(agent: session.agent)
                            Text(session.name).font(.headline).foregroundStyle(.primary)
                                .fixedSize(horizontal: false, vertical: typeSize.isAccessibilitySize)
                        }
                        if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
                        SessionStatus(status: session.status)
                    }
                    rowLayout {
                        if preferences.bool("showProjectName", true), !session.project.isEmpty {
                            ProjectChip(name: URL(fileURLWithPath: session.project).lastPathComponent)
                        }
                        if session.remote, let host = session.host, !host.isEmpty {
                            Text(host).font(.caption).foregroundStyle(.secondary)
                        }
                        if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
                        TimelineView(.periodic(from: .now, by: 60)) { context in
                            Text(BoardSession.relativeActivity(session.lastActivity, now: context.date))
                                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                        if preferences.bool("showSessionIdPrefix"), let id = session.shortAgentID {
                            Text(id).font(.caption.monospaced()).foregroundStyle(.secondary)
                                .accessibilityLabel("Session ID \(session.agentSessionID ?? id)")
                        }
                    }
                    if preferences.bool("showLastUserMessage", true), !session.summary.isEmpty {
                        Text(session.summary).font(.subheadline).foregroundStyle(.secondary)
                            .lineLimit(typeSize.isAccessibilitySize ? 4 : 1)
                    }
                    if !canOpen {
                        Text(session.status == .sleeping ? "Wake in Agentboard to open" : "Remote attachment disabled by server")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(!canOpen).accessibilityIdentifier("session-\(session.id)")

            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 0) { metadataActions }
            } else {
                HStack(spacing: 12) { metadataActions }

            }
        }.padding(.vertical, 2)
    }

    @ViewBuilder
    private var metadataActions: some View {
        if let activity = session.activity {
            Button(action: onSubagents) {
                HStack(spacing: 6) {
                    Image(systemName: "person.2")
                    Text("\(activity.running)").foregroundStyle(.primary).fixedSize()
                    if activity.blocked > 0 { Image(systemName: "hand.raised") }
                    if activity.unknown > 0 { Image(systemName: "questionmark.circle") }
                }.font(.caption.monospacedDigit())
                    .frame(minWidth: 44, minHeight: 44, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("Agent activity: \(activity.summary)")
                .accessibilityIdentifier("activity-\(session.id)")
        }
        if !session.prs.isEmpty {
            Button(action: onPullRequests) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) {
                    ForEach(visiblePRs) { pr in
                        let state = pullRequests[pr.url]
                        Label { Text("\(pr.number)").foregroundStyle(.primary).fixedSize() } icon: {
                            Image(systemName: state?.symbol ?? "questionmark.circle").foregroundStyle(state?.color ?? .secondary)
                        }.accessibilityLabel("\(pr.repo) pull request \(pr.number), \(state?.label ?? "State unavailable")")
                    }
                    if session.prs.count > visiblePRs.count { Text("+\(session.prs.count - visiblePRs.count)").fixedSize() }
                    }.fixedSize(horizontal: true, vertical: false)
                    Label("\(session.prs.count) pull requests", systemImage: "arrow.triangle.branch")
                }.font(.caption.monospacedDigit())
                    .frame(minWidth: 44, minHeight: 44, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityHint("Show pull requests and checks")
                .accessibilityIdentifier("pull-requests-\(session.id)")
        }
    }

}
