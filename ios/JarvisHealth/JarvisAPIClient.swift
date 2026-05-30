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

    // MARK: - Assistant

    static func ask(baseURL: String, question: String, threadId: String? = nil) async throws -> AssistantAskResponse {
        struct Body: Encodable { let question: String; let thread_id: String? }
        return try await post(AssistantAskResponse.self, baseURL: baseURL, path: "/assistant/ask", body: Body(question: question, thread_id: threadId))
    }

    // MARK: - Health summary

    static func getHealthSummary(baseURL: String) async throws -> HealthSummaryResponse {
        try await get(HealthSummaryResponse.self, baseURL: baseURL, path: "/health/summary")
    }

    // MARK: - Tasks

    static func getTasks(baseURL: String) async throws -> TaskListAPIResponse {
        try await get(TaskListAPIResponse.self, baseURL: baseURL, path: "/tasks")
    }
}
