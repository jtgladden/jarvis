import SwiftUI

@MainActor
final class DashboardViewModel: ObservableObject {
    @Published var healthSummary: HealthSummaryResponse?
    @Published var todayFoodLog: DailyFoodLog?
    @Published var tasks: [TaskItem] = []
    @Published var isLoading = false
    @Published var error: String?

    func load(baseURL: String) async {
        isLoading = true; error = nil
        let today = isoToday()
        do {
            async let health = JarvisAPIClient.getHealthSummary(baseURL: baseURL)
            async let food = JarvisAPIClient.getFoodLog(baseURL: baseURL, date: today)
            async let taskList = JarvisAPIClient.getTasks(baseURL: baseURL)
            healthSummary = try await health
            todayFoodLog = try await food
            tasks = (try await taskList).tasks.filter { $0.status != "done" }
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    private func isoToday() -> String {
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.timeZone = .current
        return fmt.string(from: Date())
    }
}

struct DashboardView: View {
    @EnvironmentObject private var hk: HealthKitManager
    @EnvironmentObject private var mv: MovementManager
    @StateObject private var vm = DashboardViewModel()

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        switch hour {
        case 0..<12: return "Good morning"
        case 12..<17: return "Good afternoon"
        default: return "Good evening"
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                JarvisPalette.background.ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 16) {
                        greetingHeader
                        if vm.isLoading { ProgressView().tint(JarvisPalette.cyan).frame(maxWidth: .infinity) }
                        if let err = vm.error { errorBanner(err) }
                        healthCard
                        nutritionCard
                        taskCard
                        movementCard
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 12)
                    .padding(.bottom, 32)
                }
            }
            .navigationBarHidden(true)
            .task { await vm.load(baseURL: hk.selectedBaseURL) }
            .refreshable { await vm.load(baseURL: hk.selectedBaseURL) }
        }
    }

    private var greetingHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(greeting)
                .font(.system(size: 28, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
            Text(formattedToday())
                .font(.system(size: 14, weight: .medium, design: .rounded))
                .foregroundStyle(JarvisPalette.subtleText)
        }
        .padding(.top, 8)
    }

    private var healthCard: some View {
        JarvisCard {
            VStack(alignment: .leading, spacing: 12) {
                Label("Body", systemImage: "waveform.path.ecg")
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .tracking(1.5)
                    .foregroundStyle(JarvisPalette.cyan)

                if let entry = vm.healthSummary?.today_entry {
                    HStack(spacing: 0) {
                        statCell(value: formatted(entry.steps), label: "Steps", color: JarvisPalette.cyan)
                        Divider().frame(height: 40).background(.white.opacity(0.1))
                        statCell(value: formatted(entry.active_energy_kcal) + " Cal", label: "Active", color: JarvisPalette.emerald)
                        Divider().frame(height: 40).background(.white.opacity(0.1))
                        statCell(value: formatted(entry.resting_heart_rate) + " bpm", label: "Resting HR", color: JarvisPalette.orange)
                    }
                } else if let summary = hk.todaySummary {
                    Text(summary)
                        .font(.system(size: 13, design: .rounded))
                        .foregroundStyle(JarvisPalette.secondaryText)
                } else {
                    Text("No health data — sync via the Health tab.")
                        .font(.system(size: 13, design: .rounded))
                        .foregroundStyle(JarvisPalette.secondaryText)
                }

                if let streak = vm.healthSummary?.streak_days, streak > 0 {
                    Label("\(streak)-day streak", systemImage: "flame.fill")
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .foregroundStyle(JarvisPalette.orange)
                }
            }
        }
    }

    private var nutritionCard: some View {
        JarvisCard {
            VStack(alignment: .leading, spacing: 12) {
                Label("Nutrition", systemImage: "fork.knife")
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .tracking(1.5)
                    .foregroundStyle(JarvisPalette.orange)

                if let log = vm.todayFoodLog {
                    let totals = log.entries.reduce((cal: 0.0, pro: 0.0), { ($0.cal + $1.calories, $0.pro + $1.protein_g) })
                    let pct = min(1.0, log.targets.calories > 0 ? totals.cal / log.targets.calories : 0)

                    HStack(spacing: 0) {
                        statCell(value: "\(Int(totals.cal))", label: "Calories", color: JarvisPalette.cyan)
                        Divider().frame(height: 40).background(.white.opacity(0.1))
                        statCell(value: "\(Int(totals.pro))g", label: "Protein", color: JarvisPalette.emerald)
                        Divider().frame(height: 40).background(.white.opacity(0.1))
                        statCell(value: "\(log.entries.count)", label: "Items", color: JarvisPalette.orange)
                    }

                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            RoundedRectangle(cornerRadius: 4).fill(.white.opacity(0.08)).frame(height: 6)
                            RoundedRectangle(cornerRadius: 4).fill(JarvisPalette.orange).frame(width: geo.size.width * pct, height: 6)
                        }
                    }
                    .frame(height: 6)

                    Text("\(Int(pct * 100))% of \(Int(log.targets.calories)) cal target")
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(JarvisPalette.subtleText)
                } else {
                    Text("No food logged today.")
                        .font(.system(size: 13, design: .rounded))
                        .foregroundStyle(JarvisPalette.secondaryText)
                }
            }
        }
    }

    private var taskCard: some View {
        Group {
            if !vm.tasks.isEmpty {
                JarvisCard {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("Open tasks", systemImage: "checklist")
                            .font(.system(size: 11, weight: .semibold, design: .rounded))
                            .tracking(1.5)
                            .foregroundStyle(JarvisPalette.cyan)

                        ForEach(vm.tasks.prefix(4)) { task in
                            HStack(spacing: 10) {
                                Circle()
                                    .stroke(JarvisPalette.subtleText, lineWidth: 1.5)
                                    .frame(width: 16, height: 16)
                                Text(task.title)
                                    .font(.system(size: 13, weight: .medium, design: .rounded))
                                    .foregroundStyle(.white)
                                    .lineLimit(1)
                                Spacer(minLength: 0)
                                if let due = task.due_date {
                                    Text(shortDate(due))
                                        .font(.system(size: 11, design: .rounded))
                                        .foregroundStyle(JarvisPalette.subtleText)
                                }
                            }
                        }

                        if vm.tasks.count > 4 {
                            Text("+\(vm.tasks.count - 4) more")
                                .font(.system(size: 12, design: .rounded))
                                .foregroundStyle(JarvisPalette.subtleText)
                        }
                    }
                }
            }
        }
    }

    private var movementCard: some View {
        JarvisCard {
            VStack(alignment: .leading, spacing: 8) {
                Label("Movement", systemImage: "figure.walk")
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .tracking(1.5)
                    .foregroundStyle(JarvisPalette.emerald)

                Text(mv.todaySummary ?? "No movement data yet.")
                    .font(.system(size: 13, design: .rounded))
                    .foregroundStyle(JarvisPalette.secondaryText)

                Label(mv.isTracking ? "Tracking active" : "Tracking paused", systemImage: mv.isTracking ? "location.fill" : "location.slash")
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundStyle(mv.isTracking ? JarvisPalette.emerald : JarvisPalette.subtleText)
            }
        }
    }

    private func statCell(value: String, label: String, color: Color) -> some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.system(size: 16, weight: .bold, design: .rounded))
                .foregroundStyle(color)
                .lineLimit(1).minimumScaleFactor(0.7)
            Text(label)
                .font(.system(size: 10, design: .rounded))
                .foregroundStyle(JarvisPalette.subtleText)
        }
        .frame(maxWidth: .infinity)
    }

    private func errorBanner(_ message: String) -> some View {
        Text(message)
            .font(.system(size: 13, design: .rounded)).foregroundStyle(.white)
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14).fill(Color.red.opacity(0.22)))
    }

    private func formattedToday() -> String {
        let fmt = DateFormatter()
        fmt.dateStyle = .full
        return fmt.string(from: Date())
    }

    private func formatted(_ val: Double?) -> String {
        guard let val else { return "—" }
        return val >= 1000 ? String(format: "%.0f", val) : String(format: "%.0f", val)
    }

    private func shortDate(_ iso: String) -> String {
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        guard let date = fmt.date(from: iso) else { return iso }
        let out = DateFormatter()
        out.dateFormat = "MMM d"
        return out.string(from: date)
    }
}
