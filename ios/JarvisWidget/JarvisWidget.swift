import WidgetKit
import SwiftUI

// MARK: - Shared helpers

private let sharedDefaults = UserDefaults(suiteName: "group.com.jtgladden.JarvisHealth")

private func widgetBaseURL() -> String {
    sharedDefaults?.string(forKey: "jarvis_widget_api_url")
        ?? "https://jarvis.jarom.ink/api"
}

// MARK: - Journal Reminder Widget

struct JournalReminderEntry: TimelineEntry {
    let date: Date
    let journalEnabled: Bool
    let journalHour: Int
    let journalMinute: Int
    let scriptureEnabled: Bool
    let scriptureHour: Int
    let scriptureMinute: Int
}

struct JournalReminderProvider: TimelineProvider {
    func placeholder(in context: Context) -> JournalReminderEntry {
        JournalReminderEntry(date: Date(), journalEnabled: true, journalHour: 21, journalMinute: 0,
                             scriptureEnabled: true, scriptureHour: 7, scriptureMinute: 0)
    }

    func getSnapshot(in context: Context, completion: @escaping (JournalReminderEntry) -> Void) {
        completion(entry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<JournalReminderEntry>) -> Void) {
        let next = Calendar.current.date(byAdding: .hour, value: 1, to: Date()) ?? Date()
        completion(Timeline(entries: [entry()], policy: .after(next)))
    }

    private func entry() -> JournalReminderEntry {
        let ud = UserDefaults.standard
        return JournalReminderEntry(
            date: Date(),
            journalEnabled:   ud.bool(forKey: "notif_journal_enabled"),
            journalHour:      ud.object(forKey: "notif_journal_hour")   != nil ? ud.integer(forKey: "notif_journal_hour")   : 21,
            journalMinute:    ud.object(forKey: "notif_journal_minute") != nil ? ud.integer(forKey: "notif_journal_minute") : 0,
            scriptureEnabled: ud.bool(forKey: "notif_scripture_enabled"),
            scriptureHour:    ud.object(forKey: "notif_scripture_hour")   != nil ? ud.integer(forKey: "notif_scripture_hour")   : 7,
            scriptureMinute:  ud.object(forKey: "notif_scripture_minute") != nil ? ud.integer(forKey: "notif_scripture_minute") : 0
        )
    }
}

struct JournalReminderWidgetView: View {
    let entry: JournalReminderEntry
    @Environment(\.widgetFamily) var family

    var body: some View {
        ZStack {
            Color(red: 0.07, green: 0.07, blue: 0.10)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "pencil.line")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.cyan)
                    Text("Jarvis")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .foregroundStyle(.cyan)
                }

                Text(dayLabel())
                    .font(.system(size: family == .systemSmall ? 16 : 20, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .lineLimit(1)

                if entry.journalEnabled {
                    reminderRow(icon: "book.closed.fill", color: .orange,
                                label: "Journal", hour: entry.journalHour, minute: entry.journalMinute)
                }
                if entry.scriptureEnabled {
                    reminderRow(icon: "text.book.closed.fill", color: .yellow,
                                label: "Scripture", hour: entry.scriptureHour, minute: entry.scriptureMinute)
                }
                if !entry.journalEnabled && !entry.scriptureEnabled {
                    Text("No reminders set")
                        .font(.system(size: 12, design: .rounded))
                        .foregroundStyle(Color.white.opacity(0.4))
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private func dayLabel() -> String {
        let f = DateFormatter()
        f.dateFormat = "EEEE, MMM d"
        return f.string(from: entry.date)
    }

    private func reminderRow(icon: String, color: Color, label: String, hour: Int, minute: Int) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.system(size: 10))
                .foregroundStyle(color)
            Text("\(label) · \(timeString(hour: hour, minute: minute))")
                .font(.system(size: 11, design: .rounded))
                .foregroundStyle(Color.white.opacity(0.75))
        }
    }

    private func timeString(hour: Int, minute: Int) -> String {
        let h = hour % 12 == 0 ? 12 : hour % 12
        let m = String(format: "%02d", minute)
        let ampm = hour < 12 ? "AM" : "PM"
        return "\(h):\(m) \(ampm)"
    }
}

struct JournalReminderWidget: Widget {
    let kind = "JournalReminderWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: JournalReminderProvider()) { entry in
            JournalReminderWidgetView(entry: entry)
        }
        .configurationDisplayName("Journal Reminders")
        .description("Shows your daily journal and scripture reminder times.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

// MARK: - Nutrition Summary Widget

struct NutritionEntry: TimelineEntry {
    let date: Date
    let calories: Double
    let calTarget: Double
    let protein: Double
    let proteinTarget: Double
    let carbs: Double
    let carbTarget: Double
    let fat: Double
    let fatTarget: Double
}

struct NutritionProvider: TimelineProvider {
    func placeholder(in context: Context) -> NutritionEntry {
        NutritionEntry(date: Date(), calories: 1200, calTarget: 2000, protein: 80, proteinTarget: 150,
                       carbs: 130, carbTarget: 200, fat: 40, fatTarget: 65)
    }

    func getSnapshot(in context: Context, completion: @escaping (NutritionEntry) -> Void) {
        completion(placeholder(in: context))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<NutritionEntry>) -> Void) {
        Task {
            let entry = await fetchEntry()
            let next = Calendar.current.date(byAdding: .minute, value: 30, to: Date()) ?? Date()
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }

    private func fetchEntry() async -> NutritionEntry {
        let base = widgetBaseURL()
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.locale = Locale(identifier: "en_US_POSIX")
        let today = f.string(from: Date())
        guard let url = URL(string: "\(base)/nutrition/log/\(today)") else {
            return emptyEntry()
        }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let log = try JSONDecoder().decode(DailyFoodLogWidget.self, from: data)
            let cals = log.entries.reduce(0.0) { $0 + $1.calories }
            let prot = log.entries.reduce(0.0) { $0 + $1.protein_g }
            let carb = log.entries.reduce(0.0) { $0 + $1.carbs_g }
            let fat  = log.entries.reduce(0.0) { $0 + $1.fat_g }
            return NutritionEntry(date: Date(),
                                  calories: cals, calTarget: log.targets.calories,
                                  protein: prot,  proteinTarget: log.targets.protein_g,
                                  carbs: carb,    carbTarget: log.targets.carbs_g,
                                  fat: fat,       fatTarget: log.targets.fat_g)
        } catch {
            return emptyEntry()
        }
    }

    private func emptyEntry() -> NutritionEntry {
        NutritionEntry(date: Date(), calories: 0, calTarget: 2000, protein: 0, proteinTarget: 150,
                       carbs: 0, carbTarget: 200, fat: 0, fatTarget: 65)
    }
}

// Minimal decodable types for the widget (no dependency on main app module)
private struct DailyFoodLogWidget: Decodable {
    struct Entry: Decodable { let calories: Double; let protein_g: Double; let carbs_g: Double; let fat_g: Double }
    struct Targets: Decodable { let calories: Double; let protein_g: Double; let carbs_g: Double; let fat_g: Double }
    let entries: [Entry]
    let targets: Targets
}

struct NutritionSummaryWidgetView: View {
    let entry: NutritionEntry
    @Environment(\.widgetFamily) var family

    var body: some View {
        ZStack {
            Color(red: 0.07, green: 0.07, blue: 0.10)
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "fork.knife")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.cyan)
                    Text("Nutrition")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .foregroundStyle(.cyan)
                    Spacer()
                    Text(dayLabel())
                        .font(.system(size: 10, design: .rounded))
                        .foregroundStyle(Color.white.opacity(0.4))
                }

                calorieRow

                if family != .systemSmall {
                    HStack(spacing: 8) {
                        macroBar(label: "P", value: entry.protein, target: entry.proteinTarget, color: .green)
                        macroBar(label: "C", value: entry.carbs,   target: entry.carbTarget,    color: .blue)
                        macroBar(label: "F", value: entry.fat,     target: entry.fatTarget,     color: .orange)
                    }
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private var calorieRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text("\(Int(entry.calories))")
                    .font(.system(size: 28, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                Text("/ \(Int(entry.calTarget)) kcal")
                    .font(.system(size: 12, design: .rounded))
                    .foregroundStyle(Color.white.opacity(0.45))
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3).fill(Color.white.opacity(0.12)).frame(height: 5)
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color.cyan)
                        .frame(width: geo.size.width * min(entry.calories / max(entry.calTarget, 1), 1.0), height: 5)
                }
            }
            .frame(height: 5)
        }
    }

    private func macroBar(label: String, value: Double, target: Double, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text("\(Int(value))g")
                    .font(.system(size: 13, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                Text(label)
                    .font(.system(size: 10, design: .rounded))
                    .foregroundStyle(Color.white.opacity(0.4))
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2).fill(Color.white.opacity(0.10)).frame(height: 4)
                    RoundedRectangle(cornerRadius: 2)
                        .fill(color)
                        .frame(width: geo.size.width * min(value / max(target, 1), 1.0), height: 4)
                }
            }
            .frame(height: 4)
        }
        .frame(maxWidth: .infinity)
    }

    private func dayLabel() -> String {
        let f = DateFormatter(); f.dateFormat = "MMM d"; return f.string(from: entry.date)
    }
}

struct NutritionSummaryWidget: Widget {
    let kind = "NutritionSummaryWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: NutritionProvider()) { entry in
            NutritionSummaryWidgetView(entry: entry)
        }
        .configurationDisplayName("Nutrition Summary")
        .description("Shows today's calorie and macro progress.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
