import SwiftUI
import UserNotifications

struct SettingsView: View {
    @EnvironmentObject private var hk: HealthKitManager
    @StateObject private var notif = NotificationManager.shared
    @State private var notifPermissionDenied = false

    var body: some View {
        NavigationStack {
            ZStack {
                JarvisPalette.background.ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(spacing: 16) {
                        serverCard
                        remindersCard
                        aboutCard
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 12)
                    .padding(.bottom, 32)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.large)
            .alert("Notifications Disabled", isPresented: $notifPermissionDenied) {
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Enable notifications in Settings to receive journal and scripture reminders.")
            }
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

    private var remindersCard: some View {
        JarvisCard {
            VStack(alignment: .leading, spacing: 16) {
                Label("Reminders", systemImage: "bell")
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .tracking(1.5)
                    .foregroundStyle(JarvisPalette.cyan)

                reminderRow(
                    icon: "book.closed.fill",
                    iconColor: .orange,
                    label: "Journal",
                    enabled: $notif.journalEnabled,
                    hour: $notif.journalHour,
                    minute: $notif.journalMinute,
                    onSave: {
                        Task {
                            let granted = await notif.requestPermission()
                            if granted { notif.saveJournalReminder() }
                            else { notifPermissionDenied = true; notif.journalEnabled = false }
                        }
                    }
                )

                Divider().background(Color.white.opacity(0.08))

                reminderRow(
                    icon: "text.book.closed.fill",
                    iconColor: .yellow,
                    label: "Scripture Study",
                    enabled: $notif.scriptureEnabled,
                    hour: $notif.scriptureHour,
                    minute: $notif.scriptureMinute,
                    onSave: {
                        Task {
                            let granted = await notif.requestPermission()
                            if granted { notif.saveScriptureReminder() }
                            else { notifPermissionDenied = true; notif.scriptureEnabled = false }
                        }
                    }
                )
            }
        }
    }

    private func reminderRow(
        icon: String,
        iconColor: Color,
        label: String,
        enabled: Binding<Bool>,
        hour: Binding<Int>,
        minute: Binding<Int>,
        onSave: @escaping () -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: icon)
                    .foregroundStyle(iconColor)
                    .frame(width: 22)
                Text(label)
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
                Spacer()
                Toggle("", isOn: enabled)
                    .labelsHidden()
                    .tint(JarvisPalette.cyan)
                    .onChange(of: enabled.wrappedValue) { _ in onSave() }
            }

            if enabled.wrappedValue {
                HStack(spacing: 4) {
                    Text("Daily at")
                        .font(.system(size: 12, design: .rounded))
                        .foregroundStyle(JarvisPalette.secondaryText)
                    timePicker(hour: hour, minute: minute, onChange: onSave)
                }
            }
        }
    }

    private func timePicker(hour: Binding<Int>, minute: Binding<Int>, onChange: @escaping () -> Void) -> some View {
        let binding = Binding<Date>(
            get: {
                var c = Calendar.current.dateComponents([.year, .month, .day], from: Date())
                c.hour = hour.wrappedValue
                c.minute = minute.wrappedValue
                return Calendar.current.date(from: c) ?? Date()
            },
            set: { newDate in
                let c = Calendar.current.dateComponents([.hour, .minute], from: newDate)
                hour.wrappedValue   = c.hour   ?? hour.wrappedValue
                minute.wrappedValue = c.minute ?? minute.wrappedValue
                onChange()
            }
        )
        return DatePicker("", selection: binding, displayedComponents: .hourAndMinute)
            .labelsHidden()
            .colorScheme(.dark)
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
