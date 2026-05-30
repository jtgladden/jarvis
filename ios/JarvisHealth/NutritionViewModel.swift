import Foundation

@MainActor
final class NutritionViewModel: ObservableObject {
    @Published var foodLog: DailyFoodLog?
    @Published var mealPrepItems: [MealPrepItem] = []
    @Published var isLoading = false
    @Published var error: String?

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

    // Workout form
    @Published var wType = "Chest + triceps"
    @Published var wDur = ""
    @Published var wNotes = ""

    let workoutTypes = ["Chest + triceps", "Rock climbing", "Handstand + shoulders", "Back + biceps", "Legs + abs", "Rest day", "Other"]
    let mealTypes = ["Breakfast", "Lunch", "Pre-workout", "Dinner", "Snack", "Other"]

    var totals: (cal: Double, pro: Double, carb: Double, fat: Double) {
        (foodLog?.entries ?? []).reduce((.zero, .zero, .zero, .zero)) { acc, e in
            (acc.0 + e.calories, acc.1 + e.protein_g, acc.2 + e.carbs_g, acc.3 + e.fat_g)
        }
    }

    func todayKey() -> String {
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.timeZone = .current
        return fmt.string(from: Date())
    }

    func load(baseURL: String, date: String? = nil) async {
        isLoading = true; error = nil
        let d = date ?? todayKey()
        do {
            async let log = JarvisAPIClient.getFoodLog(baseURL: baseURL, date: d)
            async let prep = JarvisAPIClient.getMealPrep(baseURL: baseURL)
            foodLog = try await log
            mealPrepItems = try await prep
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    func addFood(baseURL: String, date: String? = nil) async {
        guard !fName.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        let d = date ?? todayKey()
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
        let d = date ?? todayKey()
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
        let d = date ?? todayKey()
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
        let d = date ?? todayKey()
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
        let d = date ?? todayKey()
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
