import Foundation

// Centralised HTTP client. All methods are static and take an explicit baseURL
// so they piggyback on HealthKitManager's server config without creating a
// second source of truth.

enum APIError: LocalizedError {
    case badURL
    case badResponse(Int)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .badURL: return "Invalid server URL."
        case .badResponse(let code): return "Server returned \(code)."
        case .decoding(let err): return "Decode error: \(err.localizedDescription)"
        }
    }
}

struct JarvisAPIClient {

    // MARK: - Helpers

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .useDefaultKeys
        return d
    }()

    private static func url(_ baseURL: String, path: String) throws -> URL {
        let normalised = baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        guard let url = URL(string: normalised + path) else { throw APIError.badURL }
        return url
    }

    private static func get<T: Decodable>(_ type: T.Type, baseURL: String, path: String) async throws -> T {
        let url = try url(baseURL, path: path)
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw APIError.badResponse((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        do { return try decoder.decode(T.self, from: data) }
        catch { throw APIError.decoding(error) }
    }

    private static func post<B: Encodable, T: Decodable>(_ type: T.Type, baseURL: String, path: String, body: B) async throws -> T {
        var request = URLRequest(url: try url(baseURL, path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw APIError.badResponse((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        do { return try decoder.decode(T.self, from: data) }
        catch { throw APIError.decoding(error) }
    }

    private static func put<B: Encodable, T: Decodable>(_ type: T.Type, baseURL: String, path: String, body: B) async throws -> T {
        var request = URLRequest(url: try url(baseURL, path: path))
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw APIError.badResponse((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        do { return try decoder.decode(T.self, from: data) }
        catch { throw APIError.decoding(error) }
    }

    private static func patch<B: Encodable, T: Decodable>(_ type: T.Type, baseURL: String, path: String, body: B) async throws -> T {
        var request = URLRequest(url: try url(baseURL, path: path))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw APIError.badResponse((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        do { return try decoder.decode(T.self, from: data) }
        catch { throw APIError.decoding(error) }
    }

    private static func delete(baseURL: String, path: String) async throws {
        var request = URLRequest(url: try url(baseURL, path: path))
        request.httpMethod = "DELETE"
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw APIError.badResponse((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
    }

    // MARK: - Nutrition

    static func getFoodLog(baseURL: String, date: String) async throws -> DailyFoodLog {
        try await get(DailyFoodLog.self, baseURL: baseURL, path: "/nutrition/log/\(date)")
    }

    static func addFoodEntry(baseURL: String, date: String, name: String, calories: Double, protein: Double, carbs: Double, fat: Double, meal: String) async throws -> FoodLogEntry {
        struct Body: Encodable { let name: String; let calories: Double; let protein_g: Double; let carbs_g: Double; let fat_g: Double; let meal: String }
        return try await post(FoodLogEntry.self, baseURL: baseURL, path: "/nutrition/log/\(date)/entries", body: Body(name: name, calories: calories, protein_g: protein, carbs_g: carbs, fat_g: fat, meal: meal))
    }

    static func updateFoodEntry(baseURL: String, date: String, entryId: String, name: String, calories: Double, protein: Double, carbs: Double, fat: Double, meal: String) async throws -> FoodLogEntry {
        struct Body: Encodable { let name: String; let calories: Double; let protein_g: Double; let carbs_g: Double; let fat_g: Double; let meal: String }
        return try await put(FoodLogEntry.self, baseURL: baseURL, path: "/nutrition/log/\(date)/entries/\(entryId)", body: Body(name: name, calories: calories, protein_g: protein, carbs_g: carbs, fat_g: fat, meal: meal))
    }

    static func deleteFoodEntry(baseURL: String, date: String, entryId: String) async throws {
        try await delete(baseURL: baseURL, path: "/nutrition/log/\(date)/entries/\(entryId)")
    }

    static func logWorkout(baseURL: String, date: String, type: String, durationMinutes: Int, notes: String) async throws -> ManualWorkoutLog {
        struct Body: Encodable { let type: String; let duration_minutes: Int; let notes: String }
        return try await post(ManualWorkoutLog.self, baseURL: baseURL, path: "/nutrition/log/\(date)/workout", body: Body(type: type, duration_minutes: durationMinutes, notes: notes))
    }

    static func getMealPrep(baseURL: String) async throws -> [MealPrepItem] {
        try await get([MealPrepItem].self, baseURL: baseURL, path: "/nutrition/meal-prep")
    }

    static func parseFood(baseURL: String, text: String) async throws -> FoodParseResponse {
        struct Body: Encodable { let text: String }
        return try await post(FoodParseResponse.self, baseURL: baseURL, path: "/nutrition/parse-food", body: Body(text: text))
    }

    static func getNutritionHistory(baseURL: String, days: Int = 3) async throws -> FoodLogHistoryResponse {
        try await get(FoodLogHistoryResponse.self, baseURL: baseURL, path: "/nutrition/history?days=\(days)")
    }

    // MARK: - Assistant

    static func ask(baseURL: String, question: String, chatId: String? = nil) async throws -> AssistantAskResponse {
        struct Body: Encodable { let question: String; let chat_id: String? }
        return try await post(AssistantAskResponse.self, baseURL: baseURL, path: "/assistant/ask", body: Body(question: question, chat_id: chatId))
    }

    // MARK: - Health summary

    static func getHealthSummary(baseURL: String) async throws -> HealthSummaryResponse {
        try await get(HealthSummaryResponse.self, baseURL: baseURL, path: "/health/summary")
    }

    // MARK: - Tasks

    static func getWorkouts(baseURL: String, days: Int = 30) async throws -> WorkoutListResponse {
        try await get(WorkoutListResponse.self, baseURL: baseURL, path: "/workouts?days=\(days)&limit=50")
    }

    static func getTasks(baseURL: String) async throws -> TaskListAPIResponse {
        try await get(TaskListAPIResponse.self, baseURL: baseURL, path: "/tasks")
    }

    static func createTask(baseURL: String, title: String, detail: String = "", dueText: String? = nil, priority: String = "medium") async throws -> TaskItem {
        struct Body: Encodable { let title: String; let detail: String; let due_text: String?; let priority: String; let source: String }
        return try await post(TaskItem.self, baseURL: baseURL, path: "/tasks",
            body: Body(title: title, detail: detail, due_text: dueText, priority: priority, source: "custom"))
    }

    static func updateTask(baseURL: String, taskId: String, completed: Bool? = nil, title: String? = nil, detail: String? = nil, dueText: String? = nil, priority: String? = nil) async throws -> TaskItem {
        struct Body: Encodable { let completed: Bool?; let title: String?; let detail: String?; let due_text: String?; let priority: String? }
        return try await patch(TaskItem.self, baseURL: baseURL, path: "/tasks/\(taskId)",
            body: Body(completed: completed, title: title, detail: detail, due_text: dueText, priority: priority))
    }

    static func deleteTask(baseURL: String, taskId: String) async throws {
        try await delete(baseURL: baseURL, path: "/tasks/\(taskId)")
    }

    // MARK: - Mail

    static func getEmails(baseURL: String, mailbox: String = "INBOX", limit: Int = 25) async throws -> EmailPageResponse {
        try await get(EmailPageResponse.self, baseURL: baseURL, path: "/emails?mailbox=\(mailbox)&limit=\(limit)")
    }

    static func classifyEmail(baseURL: String, messageId: String) async throws -> ClassifiedEmailResponse {
        try await get(ClassifiedEmailResponse.self, baseURL: baseURL, path: "/emails/\(messageId)/classified")
    }

    static func handleEmail(baseURL: String, messageId: String) async throws -> HandleEmailResponse {
        struct Body: Encodable {}
        return try await post(HandleEmailResponse.self, baseURL: baseURL, path: "/emails/\(messageId)/handle", body: Body())
    }

    static func deleteEmail(baseURL: String, messageId: String) async throws {
        try await delete(baseURL: baseURL, path: "/emails/\(messageId)")
    }

    // MARK: - Language

    static func getLanguageDashboard(baseURL: String) async throws -> LanguageDashboardResponse {
        try await get(LanguageDashboardResponse.self, baseURL: baseURL, path: "/languages")
    }

    static func addVocab(baseURL: String, language: String, phrase: String, translation: String, pronunciation: String = "", notes: String = "") async throws -> LanguageVocabItem {
        struct Body: Encodable { let language: String; let phrase: String; let translation: String; let pronunciation: String; let notes: String; let tags: [String] }
        return try await post(LanguageVocabItem.self, baseURL: baseURL, path: "/languages/vocab",
            body: Body(language: language, phrase: phrase, translation: translation, pronunciation: pronunciation, notes: notes, tags: []))
    }

    static func reviewVocab(baseURL: String, vocabId: String, remembered: Bool) async throws -> LanguageVocabItem {
        struct Body: Encodable { let remembered: Bool }
        return try await patch(LanguageVocabItem.self, baseURL: baseURL, path: "/languages/vocab/\(vocabId)/review", body: Body(remembered: remembered))
    }

    static func deleteVocab(baseURL: String, vocabId: String) async throws {
        try await delete(baseURL: baseURL, path: "/languages/vocab/\(vocabId)")
    }

    static func logSession(baseURL: String, language: String, mode: String, minutes: Int, notes: String = "") async throws -> LanguagePracticeSession {
        struct Body: Encodable { let language: String; let mode: String; let minutes: Int; let notes: String }
        return try await post(LanguagePracticeSession.self, baseURL: baseURL, path: "/languages/sessions",
            body: Body(language: language, mode: mode, minutes: minutes, notes: notes))
    }

    static func getConversationReply(baseURL: String, language: String, level: String, correctionStyle: String, message: String, scenario: String, history: [LanguageConversationMessage]) async throws -> LanguageConversationResponse {
        struct Body: Encodable { let language: String; let level: String; let correction_style: String; let message: String; let scenario: String; let history: [LanguageConversationMessage] }
        return try await post(LanguageConversationResponse.self, baseURL: baseURL, path: "/languages/conversation",
            body: Body(language: language, level: level, correction_style: correctionStyle, message: message, scenario: scenario, history: history))
    }

    static func getWritingFeedback(baseURL: String, language: String, level: String, prompt: String, response: String, correctionStyle: String) async throws -> LanguageFeedbackResponse {
        struct Body: Encodable { let language: String; let level: String; let prompt: String; let response: String; let correction_style: String }
        return try await post(LanguageFeedbackResponse.self, baseURL: baseURL, path: "/languages/feedback/writing",
            body: Body(language: language, level: level, prompt: prompt, response: response, correction_style: correctionStyle))
    }

    // MARK: - Journal

    static func getJournalEntry(baseURL: String, date: String) async throws -> JournalDayEntry {
        try await get(JournalDayEntry.self, baseURL: baseURL, path: "/journal/\(date)")
    }

    static func extractJournalFromImage(baseURL: String, imageBase64: String, mediaType: String = "image/jpeg", scanTarget: String = "both") async throws -> JournalImageExtractResponse {
        struct Body: Encodable { let image_base64: String; let media_type: String; let scan_target: String }
        let body = Body(image_base64: imageBase64, media_type: mediaType, scan_target: scanTarget)
        var request = URLRequest(url: try url(baseURL, path: "/journal/extract-from-image"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        request.timeoutInterval = 180  // GPT-4o vision on a full page can take 60–90s
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw APIError.badResponse((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        do { return try decoder.decode(JournalImageExtractResponse.self, from: data) }
        catch { throw APIError.decoding(error) }
    }

    static func saveJournalEntry(baseURL: String, date: String, journalEntry: String, accomplishments: String, gratitudeEntry: String, scriptureStudy: String, spiritualNotes: String) async throws -> JournalDayEntry {
        struct Body: Encodable {
            let journal_entry: String; let accomplishments: String; let gratitude_entry: String
            let scripture_study: String; let spiritual_notes: String; let calendar_items: [String]
        }
        return try await put(JournalDayEntry.self, baseURL: baseURL, path: "/journal/\(date)",
            body: Body(journal_entry: journalEntry, accomplishments: accomplishments,
                       gratitude_entry: gratitudeEntry, scripture_study: scriptureStudy,
                       spiritual_notes: spiritualNotes, calendar_items: []))
    }

    // MARK: - Calendar

    static func getCalendarSchedule(baseURL: String) async throws -> CalendarAgendaResponse {
        try await get(CalendarAgendaResponse.self, baseURL: baseURL, path: "/calendar/schedule")
    }

    static func quickAddCalendarEvent(baseURL: String, text: String) async throws -> CalendarQuickAddResponse {
        struct Body: Encodable { let text: String }
        return try await post(CalendarQuickAddResponse.self, baseURL: baseURL, path: "/calendar/quick-add", body: Body(text: text))
    }
}
