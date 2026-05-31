import Foundation
import UserNotifications

@MainActor
final class NotificationManager: ObservableObject {
    static let shared = NotificationManager()

    private let ud = UserDefaults.standard

    @Published var journalEnabled: Bool
    @Published var journalHour: Int
    @Published var journalMinute: Int

    @Published var scriptureEnabled: Bool
    @Published var scriptureHour: Int
    @Published var scriptureMinute: Int

    private init() {
        journalEnabled   = UserDefaults.standard.bool(forKey: "notif_journal_enabled")
        journalHour      = UserDefaults.standard.object(forKey: "notif_journal_hour")   != nil ? UserDefaults.standard.integer(forKey: "notif_journal_hour")   : 21
        journalMinute    = UserDefaults.standard.object(forKey: "notif_journal_minute") != nil ? UserDefaults.standard.integer(forKey: "notif_journal_minute") : 0

        scriptureEnabled = UserDefaults.standard.bool(forKey: "notif_scripture_enabled")
        scriptureHour    = UserDefaults.standard.object(forKey: "notif_scripture_hour")   != nil ? UserDefaults.standard.integer(forKey: "notif_scripture_hour")   : 7
        scriptureMinute  = UserDefaults.standard.object(forKey: "notif_scripture_minute") != nil ? UserDefaults.standard.integer(forKey: "notif_scripture_minute") : 0
    }

    func requestPermission() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        if settings.authorizationStatus == .authorized { return true }
        do {
            return try await center.requestAuthorization(options: [.alert, .sound, .badge])
        } catch {
            return false
        }
    }

    func saveJournalReminder() {
        ud.set(journalEnabled, forKey: "notif_journal_enabled")
        ud.set(journalHour,    forKey: "notif_journal_hour")
        ud.set(journalMinute,  forKey: "notif_journal_minute")
        reschedule(
            id: "jarvis_journal_reminder",
            enabled: journalEnabled,
            hour: journalHour,
            minute: journalMinute,
            title: "Journal Time",
            body: "Take a few minutes to write in your journal today."
        )
    }

    func saveScriptureReminder() {
        ud.set(scriptureEnabled, forKey: "notif_scripture_enabled")
        ud.set(scriptureHour,    forKey: "notif_scripture_hour")
        ud.set(scriptureMinute,  forKey: "notif_scripture_minute")
        reschedule(
            id: "jarvis_scripture_reminder",
            enabled: scriptureEnabled,
            hour: scriptureHour,
            minute: scriptureMinute,
            title: "Scripture Study",
            body: "Start your day with scripture study."
        )
    }

    private func reschedule(id: String, enabled: Bool, hour: Int, minute: Int, title: String, body: String) {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [id])
        guard enabled else { return }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body  = body
        content.sound = .default

        var components = DateComponents()
        components.hour   = hour
        components.minute = minute
        let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: true)
        let request = UNNotificationRequest(identifier: id, content: content, trigger: trigger)
        center.add(request)
    }
}
