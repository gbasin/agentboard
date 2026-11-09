import SwiftUI

@main
struct AgentboardSpikeApp: App {
    var body: some Scene {
        WindowGroup {
            if ProcessInfo.processInfo.arguments.contains("-demo") || ProcessInfo.processInfo.arguments.contains("-spikeEndpoint") {
                SessionListView()
            } else {
                LiveSessionListView()
            }
        }
    }
}
