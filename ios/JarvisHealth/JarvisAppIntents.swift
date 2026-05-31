import AppIntents
import Foundation

// MARK: - Server URL helper (mirrors HealthKitManager.selectedBaseURL logic)

enum JarvisIntentConfig {
    static var baseURL: String {
        let d = UserDefaults.standard
        switch d.string(forKey: "jarvis_server_mode") ?? "production" {
        case "local":
            let url = d.string(forKey: "jarvis_local_base_url") ?? ""
            return url.isEmpty ? productionURL : url
        case "custom":
            let url = d.string(forKey: "jarvis_custom_base_url") ?? ""
            return url.isEmpty ? productionURL : url
        default:
            return productionURL
        }
    }

    static var productionURL: String {
        (Bundle.main.object(forInfoDictionaryKey: "JarvisProductionAPIBaseURL") as? String)
            ?? "https://jarvis.jarom.ink/api"
    }

    static var todayISO: String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f.string(from: Date())
    }
}

// MARK: - Intent error helper

struct JarvisIntentError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

// MARK: - Meal type

enum MealEntity: String, AppEnum {
    case breakfast, lunch, dinner, snack
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Meal"
    static var caseDisplayRepresentations: [MealEntity: DisplayRepresentation] = [
        .breakfast: "Breakfast",
        .lunch: "Lunch",
        .dinner: "Dinner",
        .snack: "Snack",
    ]
}

// MARK: - Log Food

struct LogFoodIntent: AppIntent {
    static var title: LocalizedStringResource = "Log Food"
    static var description = IntentDescription(
        "Log a meal or food item to Jarvis", categoryName: "Logging")
    static var openAppWhenRun = false

    @Parameter(title: "What did you eat?",
               description: "Describe the food, e.g. 'chicken burrito with rice and beans'")
    var foodDescription: String

    @Parameter(title: "Meal", default: .lunch)
    var meal: MealEntity

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let baseURL = JarvisIntentConfig.baseURL
        let parsed: FoodParseResponse
        do {
            parsed = try await JarvisAPIClient.parseFood(baseURL: baseURL, text: foodDescription)
        } catch {
            throw JarvisIntentError("Couldn't parse that food. Try being more specific.")
        }
        do {
            _ = try await JarvisAPIClient.addFoodEntry(
                baseURL: baseURL, date: JarvisIntentConfig.todayISO,
                name: parsed.name, calories: parsed.calories,
                protein: parsed.protein_g, carbs: parsed.carbs_g,
                fat: parsed.fat_g, meal: meal.rawValue)
        } catch {
            throw JarvisIntentError("Logged the food but couldn't save it. Check your server connection.")
        }
        return .result(dialog: "Logged \(parsed.name): \(Int(parsed.calories)) calories, \(Int(parsed.protein_g))g protein.")
    }
}

// MARK: - Log Workout

struct LogWorkoutIntent: AppIntent {
    static var title: LocalizedStringResource = "Log Workout"
    static var description = IntentDescription(
        "Log a workout to Jarvis", categoryName: "Logging")
    static var openAppWhenRun = false

    @Parameter(title: "Workout type",
               description: "E.g. run, swim, lift, bike, walk, yoga")
    var workoutType: String

    @Parameter(title: "Duration in minutes")
    var durationMinutes: Int

    @Parameter(title: "Notes", default: "")
    var notes: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard durationMinutes > 0 else {
            throw JarvisIntentError("Duration must be at least 1 minute.")
        }
        let baseURL = JarvisIntentConfig.baseURL
        do {
            _ = try await JarvisAPIClient.logWorkout(
                baseURL: baseURL, date: JarvisIntentConfig.todayISO,
                type: workoutType, durationMinutes: durationMinutes, notes: notes)
        } catch {
            throw JarvisIntentError("Couldn't save the workout. Check your server connection.")
        }
        return .result(dialog: "Logged \(durationMinutes)-minute \(workoutType).")
    }
}

