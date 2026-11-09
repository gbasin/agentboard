import SwiftUI

/// Shared server settings and device-only terminal preferences use distinct storage.
struct NativeSettingsView: View {
    @ObservedObject var preferences: NativePreferences
    @AppStorage("terminalFont") private var font = "Menlo, monospace"
    @AppStorage("terminalFontSize") private var fontSize = 13
    @AppStorage("terminalLineHeight") private var lineHeight = 1.3
    @AppStorage("terminalLetterSpacing") private var letterSpacing = 0.0
    @AppStorage("terminalAutocorrect") private var autocorrect = true
    @AppStorage("terminalWebGL") private var webGL = false
    @AppStorage("showMobileSessionPeek") private var showOverview = true
    @State private var search = ""
    @State private var defaultPath = ""
    @State private var health: LibraryHealth?
    @State private var serverValues: [String: JSONValue] = [:]
    @State private var error: String?
    @State private var busy = false
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                if let error = error ?? preferences.error { ErrorRow(message: error) { Task { await load() } } }
                if preferences.saving || busy { ProgressView("Saving…") }
                newSessionSettings
                appearanceSettings
                catalogSettings
                terminalSettings
                soundSettings
                recoverySettings
            }
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Find a setting")
            .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { defaultPath = preferences.string("defaultProjectDir", "~"); await load() }
        }
    }
    @ViewBuilder private func row<Content: View>(_ words: String, @ViewBuilder content: () -> Content) -> some View {
        if matches(words) { content() }
    }
    private var newSessionSettings: some View {
        Section {
            row("new sessions default project directory") {
                FormField("Default project directory") { TextField("Default project directory", text: $defaultPath).textInputAutocapitalization(.never).autocorrectionDisabled() }
                Button("Save directory") { preferences.set("defaultProjectDir", .string(defaultPath)) }
            }
            row("new sessions command presets") { NavigationLink("Command presets") { PresetSettingsView(preferences: preferences) } }
        } header: { if matches("new sessions default project directory command presets") { Text("New sessions") } }
    }
    private var appearanceSettings: some View {
        Section {
            row("appearance theme") {
                Picker("Theme", selection: preferences.selection("theme", fallback: "system")) {
                    Text("System").tag("system"); Text("Light").tag("light"); Text("Dark").tag("dark")
                }
            }
            row("appearance terminal custom font family") { FormField("Terminal font family") { TextField("Terminal font family", text: $font).textInputAutocapitalization(.never).autocorrectionDisabled() } }
            row("appearance font size") { Stepper("Font size: \(fontSize)", value: $fontSize, in: 6...24) }
            row("appearance line height") { VStack(alignment: .leading) { Text("Line height: \(lineHeight, specifier: "%.1f")"); Slider(value: $lineHeight, in: 1...2, step: 0.1) } }
            row("appearance letter spacing") { VStack(alignment: .leading) { Text("Letter spacing: \(letterSpacing, specifier: "%.0f")"); Slider(value: $letterSpacing, in: -3...3, step: 1) } }
        } header: { if matches("appearance theme terminal custom font family size line height letter spacing") { Text("Appearance") } }
    }
    private var catalogSettings: some View {
        Section {
            row("session list overview status peek") { Toggle("Session status overview", isOn: $showOverview) }
            row("session list sort order") {
                Picker("Sort order", selection: preferences.selection("sessionSortMode", fallback: "created")) {
                    Text("Created").tag("created"); Text("Status").tag("status"); Text("Manual").tag("manual")
                }
            }
            row("session list sort direction") {
                Picker("Sort direction", selection: preferences.selection("sessionSortDirection", fallback: "desc")) {
                    Text("Newest first").tag("desc"); Text("Oldest first").tag("asc")
                }
            }
            row("session list desktop sidebar anchor") {
                Picker("Desktop sidebar anchor", selection: preferences.selection("sidebarAnchor", fallback: "top")) {
                    Text("Top").tag("top"); Text("Bottom").tag("bottom")
                }
            }
            row("session list project name") { Toggle("Project name", isOn: preferences.binding("showProjectName", fallback: true)) }
            row("session list last user message") { Toggle("Last user message", isOn: preferences.binding("showLastUserMessage", fallback: true)) }
            row("session list session id prefix") { Toggle("Session ID prefix", isOn: preferences.binding("showSessionIdPrefix")) }
            row("session list prefer window names") { serverToggle("Prefer window names", endpoint: "prefer-window-name") }
            row("session list history lookback hours") {
                Stepper("History lookback: \(hours) hours", value: Binding(get: { hours }, set: { write("history-max-age-hours", field: "hours", value: $0) }), in: 1...168)
                    .disabled(busy || serverValues["history-max-age-hours"] == nil)
            }
        } header: { if matches("session list overview status peek sort order direction desktop sidebar anchor project name last user message session id prefix prefer window names history lookback hours") { Text("Session list") } }
    }
    private var terminalSettings: some View {
        Section {
            row("terminal keyboard autocorrect") { Toggle("Keyboard autocorrect", isOn: $autocorrect) }
            row("terminal webgl acceleration") { Toggle("WebGL acceleration", isOn: $webGL) }
            row("terminal mouse mode") { serverToggle("Mouse mode", endpoint: "tmux-mouse-mode") }
            row("terminal colors") {
                serverToggle("Terminal colors", endpoint: "terminal-colors")
                Text("Hibernate and wake running agents after changing terminal colors.").font(.footnote).foregroundStyle(.secondary)
            }
        } header: { if matches("terminal keyboard autocorrect webgl acceleration mouse mode colors") { Text("Terminal") } }
    }
    private var soundSettings: some View {
        Section {
            row("notifications sounds permission") {
                Toggle("Permission sound", isOn: preferences.binding("soundOnPermission"))
                Button("Test permission sound") { NativePreferences.sound(permission: true) }
            }
            row("notifications sounds idle") {
                Toggle("Idle sound", isOn: preferences.binding("soundOnIdle"))
                Button("Test idle sound") { NativePreferences.sound(permission: false) }
            }
        } header: { if matches("notifications sounds permission idle") { Text("Sounds while the app is open") } }
    }
    private var recoverySettings: some View {
        Section {
            if let health {
                row("recovery automatically resume") { Toggle("Automatically resume", isOn: Binding(get: { health.settings.autoResume }, set: { persistence("autoResume", value: $0) })).disabled(busy) }
                row("recovery capture terminal previews") { Toggle("Capture terminal previews", isOn: Binding(get: { health.settings.capturePreviews }, set: { persistence("capturePreviews", value: $0) })).disabled(busy) }
                row("recovery interrupted sessions") { Text("\(health.interrupted) interrupted sessions") }
                if let reason = health.error ?? health.matchingError { Text(reason) }
            }
        } header: { if matches("recovery automatically resume capture terminal previews interrupted sessions") { Text("Recovery") } }
    }
    private func matches(_ text: String) -> Bool { search.split(whereSeparator: \.isWhitespace).allSatisfy { text.localizedCaseInsensitiveContains(String($0)) } }
    private var hours: Int { if case .number(let value) = serverValues["history-max-age-hours"] { Int(value) } else { 24 } }
    private func serverToggle(_ title: String, endpoint: String) -> some View {
        Toggle(title, isOn: Binding(get: { serverValues[endpoint]?.bool ?? false }, set: { write(endpoint, field: "enabled", value: $0) }))
            .disabled(busy || serverValues[endpoint] == nil)
    }
    private func load() async {
        do {
            let api = try BoardAPI(preferences.serverURL)
            for endpoint in ["tmux-mouse-mode", "terminal-colors", "prefer-window-name", "history-max-age-hours"] {
                let response: [String: JSONValue] = try await api.request("api/settings/\(endpoint)")
                serverValues[endpoint] = response[endpoint == "history-max-age-hours" ? "hours" : "enabled"]
            }
            health = try await api.request("api/library/health"); error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func write(_ endpoint: String, field: String, value: Any) {
        guard !busy else { return }; busy = true
        Task { defer { busy = false }; do {
            let result: [String: JSONValue] = try await BoardAPI(preferences.serverURL).request("api/settings/\(endpoint)", method: "PUT", body: [field: value])
            serverValues[endpoint] = result[field]; error = nil
        } catch { self.error = error.localizedDescription } }
    }
    private func persistence(_ key: String, value: Bool) {
        guard !busy else { return }; busy = true
        Task { defer { busy = false }; do {
            let _: EmptyResponse = try await BoardAPI(preferences.serverURL).request("api/library/settings", method: "PUT", body: [key: value]); await load()
        } catch { self.error = error.localizedDescription } }
    }
}

struct PresetSettingsView: View {
    @ObservedObject var preferences: NativePreferences
    @State private var editing: CommandPreset?
    var body: some View {
        List {
            if let error = preferences.error { ErrorRow(message: error) }
            Picker("Default command", selection: preferences.selection("defaultPresetId", fallback: preferences.presets.first?.id ?? "")) {
                ForEach(preferences.presets) { Text($0.label).tag($0.id) }
            }
            ForEach(preferences.presets) { preset in
                Button { editing = preset } label: {
                    VStack(alignment: .leading) { Text(preset.label).foregroundStyle(Color.primary); Text(preset.command).font(.caption).foregroundStyle(Color.primary) }
                }
            }.onDelete { indices in var presets = preferences.presets; presets.remove(atOffsets: indices); preferences.savePresets(presets) }
            Button("Add preset", systemImage: "plus") { editing = .init(id: UUID().uuidString, label: "", command: "", isBuiltIn: false) }.disabled(preferences.presets.count >= 50 || preferences.saving)
        }.navigationTitle("Command presets")
            .sheet(item: $editing) { preset in PresetEditor(preset: preset) { value in
                var presets = preferences.presets
                if let i = presets.firstIndex(where: { $0.id == value.id }) { presets[i] = value } else { presets.append(value) }
                preferences.savePresets(presets)
            } }
    }
}
struct PresetEditor: View {
    @State var preset: CommandPreset
    let save: (CommandPreset) -> Void
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack { Form {
            Picker("Agent icon", selection: Binding(get: { preset.agentType ?? "" }, set: { preset.agentType = $0.isEmpty ? nil : $0 })) {
                Text("Terminal").tag("")
                ForEach(["claude", "codex", "pi", "devin", "grok", "omp"], id: \.self) { Text($0.capitalized).tag($0) }
            }
            FormField("Label") { TextField("Label", text: $preset.label) }
            FormField("Command") { TextField("Command", text: $preset.command).textInputAutocapitalization(.never).autocorrectionDisabled() }
        }.navigationTitle("Command preset").navigationBarTitleDisplayMode(.inline).toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) { Button("Save") { preset.label = preset.label.trimmingCharacters(in: .whitespacesAndNewlines); preset.command = preset.command.trimmingCharacters(in: .whitespacesAndNewlines); save(preset); dismiss() }.disabled(preset.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || preset.command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || preset.label.count > 64 || preset.command.count > 1024) }
        } }
    }
}
