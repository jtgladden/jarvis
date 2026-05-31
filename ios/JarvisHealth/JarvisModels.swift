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

struct FoodLogHistoryResponse: Codable {
    let days: [DailyFoodLog]
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
    let chat_id: String?
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
    let detail: String?
    let due_text: String?
    let source: String
    let priority: String
    let completed: Bool
    let custom: Bool
    let updated_at: String?
}

struct TaskListAPIResponse: Codable {
    let tasks: [TaskItem]
    let generated_at: String?
}

// MARK: - Workouts

struct WorkoutEntry: Codable, Identifiable {
    let workout_id: String
    let date: String
    let activity_label: String
    let start_date: String
    let end_date: String
    let duration_minutes: Double
    let total_distance_km: Double?
    let active_energy_kcal: Double?
    let avg_heart_rate_bpm: Double?
    let max_heart_rate_bpm: Double?
    let source_name: String?
    var id: String { workout_id }
}

struct WorkoutListResponse: Codable {
    let workouts: [WorkoutEntry]
}

// MARK: - Calendar

struct CalendarAgendaItem: Codable, Identifiable {
    let event_id: String
    let title: String
    let start: String
    let end: String?
    let is_all_day: Bool
    let location: String?
    let html_link: String?
    let removed: Bool
    var id: String { event_id }
}

struct CalendarAgendaResponse: Codable {
    let calendar_id: String
    let items: [CalendarAgendaItem]
}

struct CalendarQuickAddResponse: Codable {
    let event_id: String
    let title: String
    let start: String
    let end: String?
    let html_link: String?
}

// MARK: - Mail

struct EmailLink: Codable {
    let url: String
    let label: String
}

struct EmailSummary: Codable, Identifiable {
    let id: String
    let thread_id: String
    let subject: String
    let sender: String
    let snippet: String
    let date: String?
    let labels: [String]
    let body: String?
    let links: [EmailLink]
}

struct EmailPageResponse: Codable {
    let items: [EmailSummary]
    let next_page_token: String?
}

struct EmailClassification: Codable {
    let category: String
    let importance_score: Int
    let needs_reply: Bool
    let urgency: String
    let suggested_action: String
    let short_summary: String
    let why_it_matters: String
    let action_items: [String]
    let deadline_hint: String?
    let suggested_reply: String?
}

struct ClassifiedEmailResponse: Codable {
    let email: EmailSummary
    let classification: EmailClassification
}

struct HandleEmailResponse: Codable {
    let message_id: String
    let status: String
}

struct DeleteEmailResponse: Codable {
    let message_id: String
    let status: String
}

// MARK: - Language

struct LanguageProfile: Codable {
    let target_languages: [String]
    let active_language: String
    let level: String
    let daily_goal_minutes: Int
    let correction_style: String
    let romanization: Bool
}

struct LanguageMetadata: Codable {
    let code: String
    let name: String
    let local_name: String
    let greeting: String
}

struct LanguagePracticePrompt: Codable, Identifiable {
    let id: String
    let mode: String
    let title: String
    let prompt: String
    let target_phrase: String
    let romanization: String
    let translation: String
    let notes: String
    let expected_answer: String
}

struct LanguageVocabItem: Codable, Identifiable {
    let id: String
    let language: String
    let phrase: String
    let translation: String
    let pronunciation: String
    let notes: String
    let tags: [String]
    let review_count: Int
    let last_reviewed_at: String?
    let next_review_at: String?
}

struct LanguagePracticeSession: Codable, Identifiable {
    let id: String
    let language: String
    let mode: String
    let minutes: Int
    let notes: String
    let created_at: String?
}

struct LanguageProgressSummary: Codable {
    let sessions_count: Int
    let minutes_practiced: Int
    let vocab_count: Int
    let due_reviews: Int
    let today_minutes: Int
}

struct LanguageProgressByLanguage: Codable {
    let language: String
    let today_minutes: Int
    let total_minutes: Int
    let sessions_count: Int
    let words_count: Int
    let due_reviews: Int
}

struct LanguageDashboardResponse: Codable {
    let profile: LanguageProfile
    let supported_languages: [LanguageMetadata]
    let daily_prompts: [LanguagePracticePrompt]
    let daily_focus_words: [LanguageVocabItem]
    let vocab: [LanguageVocabItem]
    let recent_sessions: [LanguagePracticeSession]
    let progress: LanguageProgressSummary
    let language_progress: [LanguageProgressByLanguage]
}

struct LanguageConversationMessage: Codable {
    let role: String
    let content: String
}

struct LanguageConversationResponse: Codable {
    let reply: String
    let reply_romanization: String
    let translation: String
    let correction: String
    let suggested_user_reply: String
    let suggested_user_reply_romanization: String
    let vocab: [LanguageVocabItem]
}

struct LanguageFeedbackResponse: Codable {
    let score: Int
    let corrected_text: String
    let feedback: String
    let strengths: [String]
    let fixes: [String]
}

// MARK: - Journal

struct JournalDayEntry: Codable {
    let date: String
    let date_label: String
    let calendar_summary: String
    let world_event_title: String?
    let world_event_summary: String
    let journal_entry: String
    let accomplishments: String
    let gratitude_entry: String
    let scripture_study: String
    let spiritual_notes: String
    let updated_at: String?
    let calendar_items: [CalendarAgendaItem]
}
