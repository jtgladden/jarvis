import SwiftUI

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var healthKitManager: HealthKitManager
    @EnvironmentObject private var movementManager: MovementManager

    var body: some View {
        NavigationStack {
            ZStack {
                JarvisPalette.background.ignoresSafeArea()
                backgroundGlow

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 18) {
                        heroCard
                        statusStrip
                        healthAtlasCard
                        movementAtlasCard
                        syncControlsCard
                        metricsCard
                        serverCard
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 12)
                    .padding(.bottom, 28)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 2) {
                        Text("Jarvis")
                            .font(.system(size: 18, weight: .semibold, design: .rounded))
                            .foregroundStyle(.white)
                        Text("Health Atlas")
                            .font(.system(size: 11, weight: .medium, design: .rounded))
                            .tracking(1.8)
                            .foregroundStyle(JarvisPalette.subtleText)
                    }
                }
            }
        }
        .preferredColorScheme(.dark)
        .task {
            healthKitManager.refreshAuthorizationStatus()
            healthKitManager.configureAutomaticSync(baseURL: healthKitManager.selectedBaseURL)
            healthKitManager.handleAppBecameActive()
            movementManager.configureSync(baseURL: healthKitManager.selectedBaseURL)
            movementManager.handleAppBecameActive()
        }
        .onChange(of: healthKitManager.selectedBaseURL) { _, newValue in
            healthKitManager.configureAutomaticSync(baseURL: newValue)
            movementManager.configureSync(baseURL: newValue)
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                healthKitManager.handleAppBecameActive()
                movementManager.handleAppBecameActive()
            } else if newPhase == .background {
                movementManager.handleAppMovedToBackground()
            }
        }
    }

    private var backgroundGlow: some View {
        ZStack {
            Circle()
                .fill(
                    RadialGradient(
                        colors: [JarvisPalette.cyan.opacity(0.28), .clear],
                        center: .center,
                        startRadius: 10,
                        endRadius: 240
                    )
                )
                .frame(width: 340, height: 340)
                .offset(x: 140, y: -250)

            Circle()
                .fill(
                    RadialGradient(
                        colors: [JarvisPalette.emerald.opacity(0.22), .clear],
                        center: .center,
                        startRadius: 10,
                        endRadius: 260
                    )
                )
                .frame(width: 360, height: 360)
                .offset(x: -150, y: 170)
        }
        .allowsHitTesting(false)
    }

    private var heroCard: some View {
        JarvisCard {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 10) {
                        JarvisBadge(
                            title: "Health Atlas",
                            systemImage: "waveform.path.ecg"
                        )

                        Text("Your Jarvis companion for Apple Health, workouts, and daily movement.")
                            .font(.system(size: 28, weight: .bold, design: .rounded))
                            .foregroundStyle(.white)
                            .fixedSize(horizontal: false, vertical: true)

                        Text("A calmer command deck for body signals, passive location journaling, and sync status.")
                            .font(.system(size: 14, weight: .medium, design: .rounded))
                            .foregroundStyle(JarvisPalette.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Spacer(minLength: 16)

                    ZStack {
                        RoundedRectangle(cornerRadius: 24, style: .continuous)
                            .fill(
                                LinearGradient(
                                    colors: [JarvisPalette.cyan.opacity(0.26), JarvisPalette.emerald.opacity(0.18)],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            )
                            .frame(width: 74, height: 74)
                        Image(systemName: "bolt.heart.fill")
                            .font(.system(size: 28, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                }

                Label(healthKitManager.authorizationMessage, systemImage: healthKitManager.authorizationIcon)
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .foregroundStyle(healthKitManager.authorizationColor)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(.white.opacity(0.06))
                    )
            }
        }
    }

    private var statusStrip: some View {
        HStack(spacing: 12) {
            atlasStat(title: "Target", value: activeTargetLabel, tone: JarvisPalette.cyan)
            atlasStat(title: "Health", value: healthKitManager.hasRequestedAuthorization ? "Connected" : "Pending", tone: JarvisPalette.emerald)
            atlasStat(title: "Movement", value: movementManager.isTracking ? "Live" : "Idle", tone: JarvisPalette.orange)
        }
    }

    private func atlasStat(title: String, value: String, tone: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .tracking(1.5)
                .foregroundStyle(JarvisPalette.subtleText)
            Text(value)
                .font(.system(size: 16, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(JarvisPalette.card)
                .overlay(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .stroke(tone.opacity(0.28), lineWidth: 1)
                )
        )
    }

    private var healthAtlasCard: some View {
        JarvisCard {
            VStack(alignment: .leading, spacing: 16) {
                sectionHeading(
                    eyebrow: "Daily baseline",
                    title: "Health signals in one glance",
                    detail: "Live authorization, summary text, and automatic sync status."
                )

                HStack(alignment: .top, spacing: 12) {
                    metricTile(
                        title: "Summary",
                        value: healthKitManager.todaySummary ?? "No sample loaded yet",
                        accent: JarvisPalette.cyan,
                        compact: false
                    )

                    VStack(spacing: 12) {
                        metricTile(
                            title: "Auto-sync",
                            value: healthKitManager.lastAutoSyncStatus ?? "Waiting",
                            accent: (healthKitManager.lastAutoSyncStatus == "Success") ? JarvisPalette.emerald : JarvisPalette.orange
                        )

                        metricTile(
                            title: "Last run",
                            value: healthKitManager.lastAutoSyncSummary,
                            accent: JarvisPalette.cyan,
                            compact: false
                        )
                    }
                }

                if let errorMessage = healthKitManager.errorMessage {
                    statusCallout(text: errorMessage, color: JarvisPalette.orange, icon: "exclamationmark.triangle.fill")
                }
            }
        }
    }

    private var movementAtlasCard: some View {
        JarvisCard {
            VStack(alignment: .leading, spacing: 16) {
                sectionHeading(
                    eyebrow: "Movement story",
                    title: "Passive tracking and daily route journaling",
                    detail: "Visits, significant movement, and background sync status."
                )

                HStack(alignment: .top, spacing: 12) {
                    metricTile(
                        title: "Tracking",
                        value: movementManager.isTracking ? "Monitoring is active" : "Tracking is paused",
                        accent: movementManager.isTracking ? JarvisPalette.emerald : JarvisPalette.orange,
                        compact: false
                    )

                    metricTile(
                        title: "Today",
                        value: movementManager.todaySummary ?? "No movement story yet",
                        accent: JarvisPalette.emerald,
                        compact: false
                    )
                }

                Text(movementManager.authorizationMessage)
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(JarvisPalette.secondaryText)

                if let errorMessage = movementManager.errorMessage {
                    statusCallout(text: errorMessage, color: JarvisPalette.orange, icon: "location.slash.fill")
                }

                if let syncMessage = movementManager.syncMessage {
                    statusCallout(text: syncMessage, color: JarvisPalette.emerald, icon: "checkmark.circle.fill")
                }
            }
        }
    }

    private var syncControlsCard: some View {
        JarvisCard {
            VStack(alignment: .leading, spacing: 16) {
                sectionHeading(
                    eyebrow: "Controls",
                    title: "Run syncs and grant permissions",
                    detail: "Everything still auto-runs, but these controls keep manual overrides close."
                )

                VStack(spacing: 12) {
                    actionButton(
                        title: healthKitManager.buttonTitle,
                        subtitle: "Grant Apple Health access for daily syncs",
                        systemImage: "heart.text.square.fill",
                        tint: JarvisPalette.cyan,
                        isBusy: healthKitManager.isRequestInFlight,
                        isDisabled: healthKitManager.isRequestInFlight || !healthKitManager.isHealthDataAvailable
                    ) {
                        Task {
                            await healthKitManager.requestAuthorization()
                        }
                    }

                    actionButton(
                        title: healthKitManager.isSyncInFlight ? "Syncing health..." : "Sync Health Snapshot",
                        subtitle: "Send today’s Apple Health summary to Jarvis",
                        systemImage: "arrow.triangle.2.circlepath.circle.fill",
                        tint: JarvisPalette.emerald,
                        isBusy: healthKitManager.isSyncInFlight,
                        isDisabled: !healthKitManager.hasRequestedAuthorization || healthKitManager.isSyncInFlight
                    ) {
                        Task {
                            await healthKitManager.syncTodayToJarvis()
                        }
                    }

                    actionButton(
                        title: healthKitManager.isHistorySyncInFlight ? "Syncing full history..." : "Backfill Health History",
                        subtitle: "Upload older daily Apple Health records",
                        systemImage: "clock.arrow.circlepath",
                        tint: JarvisPalette.orange,
                        isBusy: healthKitManager.isHistorySyncInFlight,
                        isDisabled: !healthKitManager.hasRequestedAuthorization || healthKitManager.isHistorySyncInFlight
                    ) {
                        Task {
                            await healthKitManager.syncAllAvailableHistoryToJarvis()
                        }
                    }

                    actionButton(
                        title: healthKitManager.isWorkoutSyncInFlight ? "Syncing workouts..." : "Sync Workout History",
                        subtitle: "Push workouts and route data to Jarvis",
                        systemImage: "figure.run.circle.fill",
                        tint: JarvisPalette.cyan,
                        isBusy: healthKitManager.isWorkoutSyncInFlight,
                        isDisabled: !healthKitManager.hasRequestedAuthorization || healthKitManager.isWorkoutSyncInFlight
                    ) {
                        Task {
                            do {
                                try await healthKitManager.syncWorkoutHistoryToJarvis()
                            } catch {
                            }
                        }
                    }

                    actionButton(
                        title: movementManager.isTracking ? "Pause Movement Tracking" : "Start Movement Tracking",
                        subtitle: "Enable or disable passive location journaling",
                        systemImage: movementManager.isTracking ? "pause.circle.fill" : "location.circle.fill",
                        tint: movementManager.isTracking ? JarvisPalette.orange : JarvisPalette.emerald,
                        isBusy: false,
                        isDisabled: false
                    ) {
                        if movementManager.isTracking {
                            movementManager.stopTracking()
                        } else {
                            movementManager.startTracking()
                        }
                    }

                    actionButton(
                        title: "Sync Movement Journal",
                        subtitle: "Send today’s movement summary to Jarvis",
                        systemImage: "map.circle.fill",
                        tint: JarvisPalette.emerald,
                        isBusy: false,
                        isDisabled: false
                    ) {
                        Task {
                            await movementManager.syncTodayToJarvis(baseURL: healthKitManager.selectedBaseURL)
                        }
                    }

                    actionButton(
                        title: "Enable Location Access",
                        subtitle: "Grant Always authorization for background movement",
                        systemImage: "location.fill.viewfinder",
                        tint: JarvisPalette.orange,
                        isBusy: false,
                        isDisabled: false
                    ) {
                        movementManager.requestAuthorization()
                    }
                }

                if let progress = healthKitManager.historySyncProgress {
                    statusCallout(text: progress, color: JarvisPalette.cyan, icon: "clock.fill")
                }

                if let progress = healthKitManager.workoutSyncProgress {
                    statusCallout(text: progress, color: JarvisPalette.cyan, icon: "figure.run")
                }
            }
        }
    }

    private var metricsCard: some View {
        JarvisCard {
            VStack(alignment: .leading, spacing: 14) {
                sectionHeading(
                    eyebrow: "Signals",
                    title: "Requested Apple Health metrics",
                    detail: "The companion app reads a wider wellness set than the original starter view."
                )

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 10)], spacing: 10) {
                    ForEach(healthKitManager.requestedMetricLabels, id: \.self) { label in
                        HStack(spacing: 10) {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(JarvisPalette.emerald)
                            Text(label)
                                .font(.system(size: 13, weight: .medium, design: .rounded))
                                .foregroundStyle(.white)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 12)
                        .background(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .fill(.white.opacity(0.05))
                        )
                    }
                }
            }
        }
    }

    private var serverCard: some View {
        JarvisCard {
            VStack(alignment: .leading, spacing: 16) {
                sectionHeading(
                    eyebrow: "Network",
                    title: "Jarvis sync target",
                    detail: "Switch between production, local, and custom endpoints without leaving the app."
                )

                Picker("Server", selection: Binding(
                    get: { healthKitManager.serverMode },
                    set: { healthKitManager.updateServerMode($0) }
                )) {
                    ForEach(JarvisServerMode.allCases) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .tint(JarvisPalette.cyan)

                if healthKitManager.serverMode == .production {
                    serverValueCard(label: "Production API", value: healthKitManager.productionDisplayURL)
                }

                if healthKitManager.serverMode == .local {
                    labeledField(
                        title: "Local API Base URL",
                        placeholder: "http://192.168.0.198:8000/api",
                        text: Binding(
                            get: { healthKitManager.localBaseURL },
                            set: { healthKitManager.updateLocalBaseURL($0) }
                        )
                    )
                }

                if healthKitManager.serverMode == .custom {
                    labeledField(
                        title: "Custom API Base URL",
                        placeholder: "https://jarvis.jarom.ink/api",
                        text: Binding(
                            get: { healthKitManager.customBaseURL },
                            set: { healthKitManager.updateCustomBaseURL($0) }
                        )
                    )
                }

                serverValueCard(label: "Current sync target", value: healthKitManager.selectedBaseURL)
            }
        }
    }

    private func sectionHeading(eyebrow: String, title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(eyebrow.uppercased())
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .tracking(2)
                .foregroundStyle(JarvisPalette.subtleText)
            Text(title)
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
            Text(detail)
                .font(.system(size: 13, weight: .medium, design: .rounded))
                .foregroundStyle(JarvisPalette.secondaryText)
        }
    }

    private func metricTile(title: String, value: String, accent: Color, compact: Bool = true) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased())
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .tracking(1.6)
                .foregroundStyle(accent.opacity(0.88))

            Text(value)
                .font(.system(size: compact ? 17 : 15, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(.white.opacity(0.05))
                .overlay(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(accent.opacity(0.18), lineWidth: 1)
                )
        )
    }

    private func statusCallout(text: String, color: Color, icon: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .foregroundStyle(color)
            Text(text)
                .font(.system(size: 13, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.92))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(color.opacity(0.12))
        )
    }

    private func actionButton(
        title: String,
        subtitle: String,
        systemImage: String,
        tint: Color,
        isBusy: Bool,
        isDisabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                ZStack {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(tint.opacity(0.18))
                        .frame(width: 44, height: 44)
                    if isBusy {
                        ProgressView()
                            .tint(.white)
                    } else {
                        Image(systemName: systemImage)
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.leading)
                    Text(subtitle)
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(JarvisPalette.secondaryText)
                        .multilineTextAlignment(.leading)
                }

                Spacer(minLength: 0)

                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(JarvisPalette.subtleText)
            }
            .padding(14)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(.white.opacity(0.045))
                    .overlay(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .stroke(tint.opacity(0.18), lineWidth: 1)
                    )
            )
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.55 : 1)
    }

    private func labeledField(title: String, placeholder: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .foregroundStyle(JarvisPalette.secondaryText)

            TextField(placeholder, text: text)
                .textInputAutocapitalization(.never)
                .keyboardType(.URL)
                .autocorrectionDisabled()
                .font(.system(size: 14, weight: .medium, design: .rounded))
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 14)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(.white.opacity(0.05))
                        .overlay(
                            RoundedRectangle(cornerRadius: 18, style: .continuous)
                                .stroke(JarvisPalette.cyan.opacity(0.15), lineWidth: 1)
                        )
                )
        }
    }

    private func serverValueCard(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label.uppercased())
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .tracking(1.5)
                .foregroundStyle(JarvisPalette.subtleText)
            Text(value)
                .font(.system(size: 13, weight: .medium, design: .rounded))
                .foregroundStyle(.white)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(.white.opacity(0.05))
        )
    }

    private var activeTargetLabel: String {
        switch healthKitManager.serverMode {
        case .production:
            return "Production"
        case .local:
            return "Local"
        case .custom:
            return "Custom"
        }
    }
}

private struct JarvisCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .fill(JarvisPalette.card)
                    .overlay(
                        RoundedRectangle(cornerRadius: 28, style: .continuous)
                            .stroke(.white.opacity(0.08), lineWidth: 1)
                    )
            )
            .shadow(color: .black.opacity(0.24), radius: 18, x: 0, y: 10)
    }
}

private struct JarvisBadge: View {
    let title: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage)
            Text(title)
        }
        .font(.system(size: 11, weight: .semibold, design: .rounded))
        .tracking(1.8)
        .foregroundStyle(.white)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            Capsule(style: .continuous)
                .fill(JarvisPalette.cyan.opacity(0.16))
                .overlay(
                    Capsule(style: .continuous)
                        .stroke(JarvisPalette.cyan.opacity(0.24), lineWidth: 1)
                )
        )
    }
}

private enum JarvisPalette {
    static let background = Color(red: 10 / 255, green: 14 / 255, blue: 25 / 255)
    static let card = Color(red: 22 / 255, green: 28 / 255, blue: 46 / 255).opacity(0.88)
    static let cyan = Color(red: 85 / 255, green: 197 / 255, blue: 255 / 255)
    static let emerald = Color(red: 52 / 255, green: 211 / 255, blue: 153 / 255)
    static let orange = Color(red: 251 / 255, green: 191 / 255, blue: 36 / 255)
    static let secondaryText = Color.white.opacity(0.72)
    static let subtleText = Color(red: 160 / 255, green: 174 / 255, blue: 198 / 255)
}
