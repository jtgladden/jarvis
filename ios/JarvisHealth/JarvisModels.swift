import Foundation

// MARK: - Nutrition

struct FoodLogEntry: Codable, Identifiable {
    let id: String
    let date: String
    let name: String
    let calories: Double
    let protein_g: Double
    let carbs_g: Double
    let fat_g: Double
    let meal: String
    let logged_at: String
}

struct MacroTargets: Codable {
    let calories: Double
    let protein_g: Double
    let carbs_g: Double
    let fat_g: Double
}

struct ManualWorkoutLog: Codable, Identifiable {
    let id: String
    let date: String
    let type: String
    let duration_minutes: Int
    let notes: String
    let logged_at: String
}

struct DailyFoodLog: Codable {
    let date: String
    let entries: [FoodLogEntry]
    let manual_workout: ManualWorkoutLog?
    let targets: MacroTargets
}

struct MealPrepItem: Codable, Identifiable {
    let id: String
    let name: String
    let calories: Double
    let protein_g: Double
    let carbs_g: Double
    let fat_g: Double
    let notes: String
    let created_at: String
}

struct FoodParseResponse: Codable {
    let name: String
    let calories: Double
    let protein_g: Double
    let carbs_g: Double
    let fat_g: Double
    let meal: String
}

// MARK: - Assistant

struct AssistantAskResponse: Codable {
    let answer: String
    let thread_id: String?
}

struct ChatMessage: Identifiable {
    let id = UUID()
    let role: ChatRole
    let content: String

    enum ChatRole { case user, assistant }
}

// MARK: - Dashboard / Health summary

struct HealthSummaryResponse: Codable {
    let last_synced_at: String?
    let latest_date: String?
    let streak_days: Int
    let seven_day_avg_steps: Double?
    let seven_day_avg_sleep_hours: Double?
    let today_entry: HealthDayEntry?
    let recent_entries: [HealthDayEntry]
}

struct HealthDayEntry: Codable {
    let date: String
    let steps: Double?
    let active_energy_kcal: Double?
    let sleep_hours: Double?
    let resting_heart_rate: Double?
}

// MARK: - Tasks

struct TaskItem: Codable, Identifiable {
    let id: String
    let title: String
    let status: String
    let due_date: String?
    let priority: String?
}

struct TaskListAPIResponse: Codable {
    let tasks: [TaskItem]
    let generated_at: String?
}
