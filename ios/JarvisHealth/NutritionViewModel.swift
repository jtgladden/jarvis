import Foundation

@MainActor
final class NutritionViewModel: ObservableObject {
    @Published var foodLog: DailyFoodLog?
    @Published var mealPrepItems: [MealPrepItem] = []
    @Published var isLoading = false
    @Published var error: String?

    // Selected date for browsing history
    @Published var selectedDate: Date = Date()

    // Log food form
    @Published var fName = ""
    @Published var fCal = ""
    @Published var fPro = ""
    @Published var fCarb = ""
    @Published var fFat = ""
    @Published var fMeal = "Other"

    // AI parse
    @Published var aiText = ""
    @Published var aiParsing = false

    // Inline edit
    @Published var editingEntryId: String?
    @Published var editName = ""
    @Published var editCal = ""
    @Published var editPro = ""
    @Published var editCarb = ""
    @Published var editFat = ""
    @Published var editMeal = "Other"

    // Apple Watch / HealthKit workouts (last 7 days, filtered in view)
    @Published var healthKitWorkouts: [WorkoutEntry] = []

    // Coaching chat
    @Published var coachingMessages: [ChatMessage] = []
    @Published var coachingInput: String = ""
    @Published var coachingLoading: Bool = false
    private var coachingChatId: String?  // tracks chat_id for conversation continuity

    // Workout form
    @Published var wType = "Chest + triceps"
    @Published var wDur = ""
    @Published var wNotes = ""

    let workoutTypes = ["Chest + triceps", "Rock climbing", "Handstand + shoulders", "Back + biceps", "Legs + abs", "Rest day", "Other"]
    let mealTypes = ["Breakfast", "Lunch", "Pre-workout", "Dinner", "Snack", "Other"]

    private let isoFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        return f
    }()

    var selectedDateKey: String { isoFormatter.string(from: selectedDate) }
    var isViewingToday: Bool { Calendar.current.isDateInToday(selectedDate) }

    var workoutsForSelectedDate: [WorkoutEntry] {
        healthKitWorkouts.filter { String($0.date.prefix(10)) == selectedDateKey }
    }

    var totals: (cal: Double, pro: Double, carb: Double, fat: Double) {
        (foodLog?.entries ?? []).reduce((.zero, .zero, .zero, .zero)) { acc, e in
            (acc.0 + e.calories, acc.1 + e.protein_g, acc.2 + e.carbs_g, acc.3 + e.fat_g)
        }
    }

    func getCoachingFeedback(baseURL: String) async {
        coachingLoading = true
        coachingMessages = []
        coachingChatId = nil
        do {
            let history = try await JarvisAPIClient.getNutritionHistory(baseURL: baseURL, days: 3)

            // Always use the already-loaded foodLog for the selected date — avoids server-side
            // date calculation mismatches where history returns empty entries for "today".
            var days = history.days.filter { $0.date != selectedDateKey }
            if let currentLog = foodLog {
                days.insert(currentLog, at: 0)
            }
            days.sort { $0.date > $1.date }

            func summarise(_ day: DailyFoodLog) -> String {
                let tot = day.entries.reduce((cal: 0.0, pro: 0.0, carb: 0.0, fat: 0.0)) { a, e in
                    (a.cal + e.calories, a.pro + e.protein_g, a.carb + e.carbs_g, a.fat + e.fat_g)
                }
                let t = day.targets
                let dateLabel = day.date == selectedDateKey ? "\(day.date) (selected day)" : day.date
                let entries = day.entries.isEmpty ? "  Nothing logged" :
                    day.entries.map { "  - \($0.name) (\(Int($0.calories)) cal, \(Int($0.protein_g))g P, \(Int($0.carbs_g))g C, \(Int($0.fat_g))g F) — \($0.meal)" }.joined(separator: "\n")
                let workout = day.manual_workout.map { "  Workout: \($0.type)\($0.duration_minutes > 0 ? " — \($0.duration_minutes) min" : "")" } ?? "  No workout logged"
                return "\(dateLabel)\n  Totals: \(Int(tot.cal))/\(Int(t.calories)) cal · \(Int(tot.pro))/\(Int(t.protein_g))g P · \(Int(tot.carb))/\(Int(t.carbs_g))g C · \(Int(tot.fat))/\(Int(t.fat_g))g F\n\(entries)\n\(workout)"
            }

            let dayBlock = days.map { summarise($0) }.joined(separator: "\n\n")
            let recentWorkouts = healthKitWorkouts.prefix(6).map {
                "- \($0.activity_label): \(Int($0.duration_minutes)) min\($0.active_energy_kcal.map { ", \(Int($0)) cal burned" } ?? "")\($0.avg_heart_rate_bpm.map { ", avg \(Int($0)) bpm" } ?? "")"
            }.joined(separator: "\n")
            let question = "Here's my nutrition and training data for the last \(days.count) day(s):\n\n\(dayBlock)\(recentWorkouts.isEmpty ? "" : "\n\nRecent Apple Watch workouts (training load context):\n\(recentWorkouts)")\n\nGive me specific, actionable coaching feedback. Look for patterns across the days — what I'm doing consistently well, where I'm falling short of targets, and give me 2–3 concrete things to focus on tomorrow. Be direct and practical."

            let result = try await JarvisAPIClient.ask(baseURL: baseURL, question: question)
            coachingChatId = result.chat_id
            coachingMessages = [ChatMessage(role: .assistant, content: result.answer)]
        } catch {
            coachingMessages = [ChatMessage(role: .assistant, content: "Could not get feedback: \(error.localizedDescription)")]
        }
        coachingLoading = false
    }

    func sendCoachingMessage(baseURL: String) async {
        let text = coachingInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        coachingInput = ""
        coachingMessages.append(ChatMessage(role: .user, content: text))
        coachingLoading = true
        do {
            let result = try await JarvisAPIClient.ask(baseURL: baseURL, question: text, chatId: coachingChatId)
            coachingChatId = result.chat_id
            coachingMessages.append(ChatMessage(role: .assistant, content: result.answer))
        } catch {
            coachingMessages.append(ChatMessage(role: .assistant, content: "Error: \(error.localizedDescription)"))
        }
        coachingLoading = false
    }

    func previousDay() {
        selectedDate = Calendar.current.date(byAdding: .day, value: -1, to: selectedDate) ?? selectedDate
        coachingMessages = []; coachingChatId = nil; coachingInput = ""
    }

    func nextDay() {
        selectedDate = Calendar.current.date(byAdding: .day, value: 1, to: selectedDate) ?? selectedDate
        coachingMessages = []; coachingChatId = nil; coachingInput = ""
    }

    func load(baseURL: String, date: String? = nil) async {
        isLoading = true; error = nil
        foodLog = nil
        let d = date ?? selectedDateKey
        async let log = JarvisAPIClient.getFoodLog(baseURL: baseURL, date: d)
        async let prep = JarvisAPIClient.getMealPrep(baseURL: baseURL)
        async let workouts = JarvisAPIClient.getWorkouts(baseURL: baseURL, days: 7)
        do { foodLog = try await log } catch { self.error = error.localizedDescription }
        do { mealPrepItems = try await prep } catch {}
        do {
            healthKitWorkouts = (try await workouts).workouts
        } catch {}
        isLoading = false
    }

    func addFood(baseURL: String, date: String? = nil) async {
        guard !fName.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        let d = date ?? selectedDateKey
        do {
            _ = try await JarvisAPIClient.addFoodEntry(
                baseURL: baseURL, date: d,
                name: fName,
                calories: Double(fCal) ?? 0,
                protein: Double(fPro) ?? 0,
                carbs: Double(fCarb) ?? 0,
                fat: Double(fFat) ?? 0,
                meal: fMeal
            )
            fName = ""; fCal = ""; fPro = ""; fCarb = ""; fFat = ""
            await load(baseURL: baseURL, date: d)
        } catch { self.error = error.localizedDescription }
    }

    func quickAdd(baseURL: String, item: MealPrepItem, date: String? = nil) async {
        let d = date ?? selectedDateKey
        do {
            _ = try await JarvisAPIClient.addFoodEntry(
                baseURL: baseURL, date: d,
                name: item.name,
                calories: item.calories,
                protein: item.protein_g,
                carbs: item.carbs_g,
                fat: item.fat_g,
                meal: "Meal prep"
            )
            await load(baseURL: baseURL, date: d)
        } catch { self.error = error.localizedDescription }
    }

    func deleteFood(baseURL: String, entryId: String, date: String? = nil) async {
        let d = date ?? selectedDateKey
        do {
            try await JarvisAPIClient.deleteFoodEntry(baseURL: baseURL, date: d, entryId: entryId)
            await load(baseURL: baseURL, date: d)
        } catch { self.error = error.localizedDescription }
    }

    func startEdit(_ entry: FoodLogEntry) {
        editingEntryId = entry.id
        editName = entry.name
        editCal = String(entry.calories)
        editPro = String(entry.protein_g)
        editCarb = String(entry.carbs_g)
        editFat = String(entry.fat_g)
        editMeal = entry.meal
    }

    func saveEdit(baseURL: String, date: String? = nil) async {
        guard let id = editingEntryId else { return }
        let d = date ?? selectedDateKey
        do {
            _ = try await JarvisAPIClient.updateFoodEntry(
                baseURL: baseURL, date: d, entryId: id,
                name: editName,
                calories: Double(editCal) ?? 0,
                protein: Double(editPro) ?? 0,
                carbs: Double(editCarb) ?? 0,
                fat: Double(editFat) ?? 0,
                meal: editMeal
            )
            editingEntryId = nil
            await load(baseURL: baseURL, date: d)
        } catch { self.error = error.localizedDescription }
    }

    func parseFood(baseURL: String) async {
        guard !aiText.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        aiParsing = true
        do {
            let result = try await JarvisAPIClient.parseFood(baseURL: baseURL, text: aiText)
            fName = result.name
            fCal = result.calories == 0 ? "" : String(format: "%.0f", result.calories)
            fPro = result.protein_g == 0 ? "" : String(format: "%.1f", result.protein_g)
            fCarb = result.carbs_g == 0 ? "" : String(format: "%.1f", result.carbs_g)
            fFat = result.fat_g == 0 ? "" : String(format: "%.1f", result.fat_g)
            fMeal = result.meal
            aiText = ""
        } catch { self.error = error.localizedDescription }
        aiParsing = false
    }

    func logWorkout(baseURL: String, date: String? = nil) async {
        let d = date ?? selectedDateKey
        do {
            _ = try await JarvisAPIClient.logWorkout(
                baseURL: baseURL, date: d,
                type: wType,
                durationMinutes: Int(wDur) ?? 0,
                notes: wNotes
            )
            wDur = ""; wNotes = ""
            await load(baseURL: baseURL, date: d)
        } catch { self.error = error.localizedDescription }
    }
}
