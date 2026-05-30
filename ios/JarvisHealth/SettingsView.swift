import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var hk: HealthKitManager

    var body: some View {
        NavigationStack {
            ZStack {
                JarvisPalette.background.ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(spacing: 16) {
                        serverCard
                        aboutCard
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 12)
                    .padding(.bottom, 32)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.large)
        }
    }

    private var serverCard: some View {
        JarvisCard {
            VStack(alignment: .leading, spacing: 16) {
                Label("Jarvis server", systemImage: "network")
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .tracking(1.5)
                    .foregroundStyle(JarvisPalette.cyan)

                Picker("Server", selection: Binding(
                    get: { hk.serverMode },
                    set: { hk.updateServerMode($0) }
                )) {
                    ForEach(JarvisServerMode.allCases) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                .pickerStyle(.segmented)

                if hk.serverMode == .production {
                    urlDisplayRow(label: "Production", value: hk.productionDisplayURL)
                }
                if hk.serverMode == .local {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Local API base URL")
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                            .foregroundStyle(JarvisPalette.secondaryText)
                        TextField("http://192.168.x.x:8000/api", text: Binding(
                            get: { hk.localBaseURL },
                            set: { hk.updateLocalBaseURL($0) }
                        ))
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .jarvisTextField()
                    }
                }
                if hk.serverMode == .custom {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Custom API base URL")
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                            .foregroundStyle(JarvisPalette.secondaryText)
                        TextField("https://jarvis.yourdomain.com/api", text: Binding(
                            get: { hk.customBaseURL },
                            set: { hk.updateCustomBaseURL($0) }
                        ))
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .jarvisTextField()
                    }
                }

                urlDisplayRow(label: "Active target", value: hk.selectedBaseURL)
            }
        }
    }

    private var aboutCard: some View {
        JarvisCard {
            VStack(alignment: .leading, spacing: 10) {
                Label("About", systemImage: "info.circle")
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .tracking(1.5)
                    .foregroundStyle(JarvisPalette.subtleText)

                Text("Jarvis iOS")
                    .font(.system(size: 18, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)

                Text("Personal AI companion app. Syncs Apple Health, tracks movement, logs nutrition, and talks to your Jarvis server.")
                    .font(.system(size: 13, design: .rounded))
                    .foregroundStyle(JarvisPalette.secondaryText)
            }
        }
    }

    private func urlDisplayRow(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased())
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .tracking(1.5)
                .foregroundStyle(JarvisPalette.subtleText)
            Text(value)
                .font(.system(size: 13, weight: .medium, design: .rounded))
                .foregroundStyle(.white)
                .textSelection(.enabled)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.05)))
    }
}
