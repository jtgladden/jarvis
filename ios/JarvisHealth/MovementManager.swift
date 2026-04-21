import CoreLocation
import Foundation
import SwiftUI

struct MovementVisitPayload: Codable {
    let arrival: String?
    let departure: String?
    let latitude: Double
    let longitude: Double
    let horizontal_accuracy_m: Double?
    let label: String?
}

struct MovementRoutePointPayload: Codable {
    let timestamp: String
    let latitude: Double
    let longitude: Double
    let horizontal_accuracy_m: Double?
}

struct MovementDailySyncPayload: Encodable {
    let date: String
    let source: String
    let total_distance_km: Double
    let time_away_minutes: Int?
    let visited_places_count: Int
    let movement_story: String
    let home_label: String?
    let commute_start: String?
    let commute_end: String?
    let visits: [MovementVisitPayload]
    let route_points: [MovementRoutePointPayload]
    let place_labels: [String]
}

struct LocalMovementVisit: Codable {
    let arrival: String?
    let departure: String?
    let latitude: Double
    let longitude: Double
    let horizontalAccuracyMeters: Double?
    let label: String?
}

struct LocalMovementRoutePoint: Codable {
    let timestamp: String
    let latitude: Double
    let longitude: Double
    let horizontalAccuracyMeters: Double?
}

struct LocalMovementDayJournal: Codable {
    let date: String
    var totalDistanceMeters: Double
    var visits: [LocalMovementVisit]
    var routePoints: [LocalMovementRoutePoint]
    var timeAwayMinutes: Int?
    var movementStory: String
}

struct StoredPlaceCluster: Codable {
    let id: String
    var label: String
    var latitude: Double
    var longitude: Double
    var visitCount: Int
    var lastResolvedAt: String?
}

@MainActor
final class MovementManager: NSObject, ObservableObject {
    private enum StorageKeys {
        static let movementJournal = "jarvis_movement_journal"
        static let movementSyncBaseURL = "jarvis_movement_sync_base_url"
        static let movementPlaceClusters = "jarvis_movement_place_clusters"
        static let legacyMovementPlaceLabelCache = "jarvis_movement_place_label_cache"
    }

    private enum PlaceLabeling {
        static let clusterMatchRadiusMeters: CLLocationDistance = 100
        static let coordinateMatchThreshold = 0.0001
    }

    @Published var authorizationStatus: CLAuthorizationStatus
    @Published var isTracking = false
    @Published var syncMessage: String?
    @Published var errorMessage: String?
    @Published var todaySummary: String?

    private let locationManager = CLLocationManager()
    private let geocoder = CLGeocoder()
    private let userDefaults: UserDefaults
    private var lastRecordedLocation: CLLocation?
    private var syncTask: Task<Void, Never>?
    private var lastSyncAttemptAt: Date?
    private var configuredBaseURL: String?
    private var isForegroundLocationUpdatesActive = false
    private var placeClusters: [StoredPlaceCluster]
    private var labelRequestsInFlight: Set<String> = []

    init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
        self.authorizationStatus = locationManager.authorizationStatus
        self.configuredBaseURL = userDefaults.string(forKey: StorageKeys.movementSyncBaseURL)
        self.placeClusters = Self.loadPlaceClusters(from: userDefaults)
        super.init()
        locationManager.delegate = self
        locationManager.activityType = .fitness
        locationManager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        locationManager.distanceFilter = 50
        locationManager.pausesLocationUpdatesAutomatically = true
        locationManager.allowsBackgroundLocationUpdates = true
        refreshSummary()
        resumeAutomaticTrackingIfAuthorized()
    }

    var authorizationMessage: String {
        switch authorizationStatus {
        case .authorizedAlways:
            return "Location access is allowed in the background for movement journaling."
        case .authorizedWhenInUse:
            return "Location access is limited to when the app is open. Background movement capture will be incomplete."
        case .notDetermined:
            return "Location access has not been requested yet."
        case .denied, .restricted:
            return "Location access is unavailable. Enable Always access in Settings for day-long movement tracking."
        @unknown default:
            return "Location authorization state is unknown."
        }
    }

    func requestAuthorization() {
        errorMessage = nil
        syncMessage = nil
        locationManager.requestAlwaysAuthorization()
    }

    func configureSync(baseURL: String) {
        let normalized = normalizedBaseURL(baseURL)
        configuredBaseURL = normalized
        userDefaults.set(normalized, forKey: StorageKeys.movementSyncBaseURL)
        scheduleAutomaticSync(reason: "server updated")
    }

    func handleAppBecameActive() {
        resumeAutomaticTrackingIfAuthorized()
        startForegroundLocationUpdatesIfNeeded()
        resolveMissingLabelsForToday()
        scheduleAutomaticSync(reason: "app active")
    }

    func handleAppMovedToBackground() {
        stopForegroundLocationUpdates()
        scheduleAutomaticSync(reason: "app backgrounded")
    }

    func startTracking() {
        guard authorizationStatus == .authorizedAlways || authorizationStatus == .authorizedWhenInUse else {
            errorMessage = "Grant location access before starting movement tracking."
            return
        }

        activateTracking(includeForegroundLiveUpdates: true)
    }

    func stopTracking() {
        isTracking = false
        isForegroundLocationUpdatesActive = false
        locationManager.stopMonitoringVisits()
        locationManager.stopMonitoringSignificantLocationChanges()
        locationManager.stopUpdatingLocation()
        syncMessage = "Movement monitoring stopped."
    }

    func syncTodayToJarvis(baseURL: String) async {
        errorMessage = nil
        syncMessage = nil
        configureSync(baseURL: baseURL)

        do {
            let journal = loadTodayJournal()
            let payload = buildSyncPayload(from: journal)
            try await postMovementPayload(payload, baseURL: baseURL)
            lastSyncAttemptAt = Date()
            syncMessage = "Synced movement journal via \(baseURL)."
            refreshSummary()
        } catch {
            errorMessage = "Movement sync failed: \(error.localizedDescription)"
        }
    }

    func refreshSummary() {
        let journal = loadTodayJournal()
        todaySummary = buildSummaryText(from: journal)
    }

    private func buildSummaryText(from journal: LocalMovementDayJournal) -> String {
        let distanceMiles = Self.miles(fromMeters: journal.totalDistanceMeters)
        let awayText = journal.timeAwayMinutes.map { "\($0) minutes away from home" } ?? "home time not set yet"
        return String(
            format: "Today: %.1f mi traveled, %d visits, %@.",
            distanceMiles,
            journal.visits.count,
            awayText
        )
    }

    private func buildSyncPayload(from journal: LocalMovementDayJournal) -> MovementDailySyncPayload {
        let labels = Array(Set(journal.visits.compactMap(\.label))).sorted()
        let commuteStart = journal.visits.first?.departure
        let commuteEnd = journal.visits.last?.arrival

        return MovementDailySyncPayload(
            date: journal.date,
            source: "ios_core_location",
            total_distance_km: journal.totalDistanceMeters / 1000,
            time_away_minutes: journal.timeAwayMinutes,
            visited_places_count: journal.visits.count,
            movement_story: journal.movementStory,
            home_label: nil,
            commute_start: commuteStart,
            commute_end: commuteEnd,
            visits: journal.visits.map {
                MovementVisitPayload(
                    arrival: $0.arrival,
                    departure: $0.departure,
                    latitude: $0.latitude,
                    longitude: $0.longitude,
                    horizontal_accuracy_m: $0.horizontalAccuracyMeters,
                    label: $0.label
                )
            },
            route_points: simplifiedRoutePoints(journal.routePoints).map {
                MovementRoutePointPayload(
                    timestamp: $0.timestamp,
                    latitude: $0.latitude,
                    longitude: $0.longitude,
                    horizontal_accuracy_m: $0.horizontalAccuracyMeters
                )
            },
            place_labels: labels
        )
    }

    private func postMovementPayload(_ payload: MovementDailySyncPayload, baseURL: String) async throws {
        guard let url = URL(string: baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/movement/daily") else {
            throw URLError(.badURL)
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 20
        request.httpBody = try JSONEncoder().encode(payload)

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            throw NSError(
                domain: "JarvisMovementSync",
                code: httpResponse.statusCode,
                userInfo: [NSLocalizedDescriptionKey: "Jarvis returned status \(httpResponse.statusCode)."]
            )
        }
    }

    private func loadTodayJournal() -> LocalMovementDayJournal {
        let today = Self.isoDateString(for: Date())
        let journals = loadAllJournals()
        return journals[today] ?? LocalMovementDayJournal(
            date: today,
            totalDistanceMeters: 0,
            visits: [],
            routePoints: [],
            timeAwayMinutes: nil,
            movementStory: "No movement summary yet."
        )
    }

    private func saveTodayJournal(_ journal: LocalMovementDayJournal) {
        var journals = loadAllJournals()
        journals[journal.date] = journal
        if let data = try? JSONEncoder().encode(journals) {
            userDefaults.set(data, forKey: StorageKeys.movementJournal)
        }
    }

    private func loadAllJournals() -> [String: LocalMovementDayJournal] {
        guard
            let data = userDefaults.data(forKey: StorageKeys.movementJournal),
            let decoded = try? JSONDecoder().decode([String: LocalMovementDayJournal].self, from: data)
        else {
            return [:]
        }
        return decoded
    }

    private func updateTodayJournal(_ update: (inout LocalMovementDayJournal) -> Void) {
        var journal = loadTodayJournal()
        update(&journal)
        journal.movementStory = generateMovementStory(for: journal)
        saveTodayJournal(journal)
        refreshSummary()
    }

    private func generateMovementStory(for journal: LocalMovementDayJournal) -> String {
        let distanceMiles = Self.miles(fromMeters: journal.totalDistanceMeters)
        if journal.visits.isEmpty && journal.routePoints.isEmpty {
            return "No visits recorded yet today."
        }

        if let firstArrival = journal.visits.first?.arrival, let lastDeparture = journal.visits.last?.departure {
            return String(
                format: "You traveled about %.1f mi today, recorded %d visits, and moved between %@ and %@.",
                distanceMiles,
                journal.visits.count,
                firstArrival,
                lastDeparture
            )
        }

        return String(
            format: "You traveled about %.1f mi today and recorded %d visit events.",
            distanceMiles,
            journal.visits.count
        )
    }

    private func simplifiedRoutePoints(_ points: [LocalMovementRoutePoint]) -> [LocalMovementRoutePoint] {
        guard points.count > 20 else {
            return points
        }

        return points.enumerated().compactMap { index, point in
            if index == 0 || index == points.count - 1 || index % 5 == 0 {
                return point
            }
            return nil
        }
    }

    private func resumeAutomaticTrackingIfAuthorized() {
        guard authorizationStatus == .authorizedAlways || authorizationStatus == .authorizedWhenInUse else {
            return
        }

        if !isTracking {
            activateTracking(includeForegroundLiveUpdates: false)
        }
    }

    private func resolveMissingLabelsForToday() {
        let journal = loadTodayJournal()
        for visit in journal.visits where (visit.label?.isEmpty ?? true) {
            let location = CLLocation(latitude: visit.latitude, longitude: visit.longitude)
            resolvePlaceLabel(
                for: location,
                arrival: visit.arrival,
                departure: visit.departure
            )
        }
    }

    private func resolvePlaceLabel(for location: CLLocation, arrival: String?, departure: String?) {
        if let existingCluster = nearestPlaceCluster(to: location) {
            applyResolvedLabel(
                existingCluster.label,
                arrival: arrival,
                departure: departure,
                latitude: location.coordinate.latitude,
                longitude: location.coordinate.longitude
            )
            return
        }

        let requestKey = Self.requestKey(for: location.coordinate.latitude, longitude: location.coordinate.longitude)
        guard !labelRequestsInFlight.contains(requestKey) else {
            return
        }

        labelRequestsInFlight.insert(requestKey)

        Task { @MainActor in
            defer { self.labelRequestsInFlight.remove(requestKey) }

            do {
                let placemarks = try await geocoder.reverseGeocodeLocation(location)
                guard let label = Self.bestPlaceLabel(from: placemarks.first), !label.isEmpty else {
                    return
                }

                self.upsertPlaceCluster(label: label, at: location)
                self.applyResolvedLabel(
                    self.bestStoredLabel(near: location) ?? label,
                    arrival: arrival,
                    departure: departure,
                    latitude: location.coordinate.latitude,
                    longitude: location.coordinate.longitude
                )
            } catch {
            }
        }
    }

    private func nearestPlaceCluster(to location: CLLocation) -> StoredPlaceCluster? {
        placeClusters
            .compactMap { cluster -> (StoredPlaceCluster, CLLocationDistance)? in
                let clusterLocation = CLLocation(latitude: cluster.latitude, longitude: cluster.longitude)
                let distance = clusterLocation.distance(from: location)
                guard distance <= PlaceLabeling.clusterMatchRadiusMeters else {
                    return nil
                }
                return (cluster, distance)
            }
            .min(by: { $0.1 < $1.1 })?
            .0
    }

    private func bestStoredLabel(near location: CLLocation) -> String? {
        nearestPlaceCluster(to: location)?.label
    }

    private func upsertPlaceCluster(label: String, at location: CLLocation) {
        let resolvedAt = Self.isoTimestampString(for: Date())

        if let existingIndex = nearestPlaceClusterIndex(to: location) {
            var cluster = placeClusters[existingIndex]
            let nextCount = max(cluster.visitCount, 0) + 1
            cluster.latitude = ((cluster.latitude * Double(cluster.visitCount)) + location.coordinate.latitude) / Double(nextCount)
            cluster.longitude = ((cluster.longitude * Double(cluster.visitCount)) + location.coordinate.longitude) / Double(nextCount)
            cluster.visitCount = nextCount
            cluster.lastResolvedAt = resolvedAt
            cluster.label = Self.preferredPlaceLabel(existing: cluster.label, candidate: label)
            placeClusters[existingIndex] = cluster
        } else {
            placeClusters.append(
                StoredPlaceCluster(
                    id: UUID().uuidString,
                    label: label,
                    latitude: location.coordinate.latitude,
                    longitude: location.coordinate.longitude,
                    visitCount: 1,
                    lastResolvedAt: resolvedAt
                )
            )
        }

        savePlaceClusters()
    }

    private func nearestPlaceClusterIndex(to location: CLLocation) -> Int? {
        placeClusters
            .enumerated()
            .compactMap { index, cluster -> (Int, CLLocationDistance)? in
                let clusterLocation = CLLocation(latitude: cluster.latitude, longitude: cluster.longitude)
                let distance = clusterLocation.distance(from: location)
                guard distance <= PlaceLabeling.clusterMatchRadiusMeters else {
                    return nil
                }
                return (index, distance)
            }
            .min(by: { $0.1 < $1.1 })?
            .0
    }

    private func applyResolvedLabel(
        _ label: String,
        arrival: String?,
        departure: String?,
        latitude: Double,
        longitude: Double
    ) {
        updateTodayJournal { journal in
            guard let index = journal.visits.firstIndex(where: {
                Self.coordinatesMatch(lhsLatitude: $0.latitude, lhsLongitude: $0.longitude, rhsLatitude: latitude, rhsLongitude: longitude)
                    && $0.arrival == arrival
                    && $0.departure == departure
            }) else {
                return
            }

            let visit = journal.visits[index]
            journal.visits[index] = LocalMovementVisit(
                arrival: visit.arrival,
                departure: visit.departure,
                latitude: visit.latitude,
                longitude: visit.longitude,
                horizontalAccuracyMeters: visit.horizontalAccuracyMeters,
                label: label
            )
        }

        scheduleAutomaticSync(reason: "place labeled")
    }

    private func activateTracking(includeForegroundLiveUpdates: Bool) {
        isTracking = true
        errorMessage = nil
        syncMessage = "Movement monitoring started."
        locationManager.startMonitoringVisits()
        locationManager.startMonitoringSignificantLocationChanges()

        if includeForegroundLiveUpdates {
            startForegroundLocationUpdatesIfNeeded()
        }
    }

    private func startForegroundLocationUpdatesIfNeeded() {
        guard isTracking, !isForegroundLocationUpdatesActive else {
            return
        }

        locationManager.startUpdatingLocation()
        isForegroundLocationUpdatesActive = true
    }

    private func stopForegroundLocationUpdates() {
        guard isForegroundLocationUpdatesActive else {
            return
        }

        locationManager.stopUpdatingLocation()
        isForegroundLocationUpdatesActive = false
    }

    private func scheduleAutomaticSync(reason: String) {
        guard let baseURL = configuredBaseURL, !baseURL.isEmpty else {
            return
        }

        if let lastSyncAttemptAt, Date().timeIntervalSince(lastSyncAttemptAt) < 120 {
            return
        }

        syncTask?.cancel()
        syncTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(8))

            guard !Task.isCancelled else {
                return
            }

            await performAutomaticSync(baseURL: baseURL, reason: reason)
        }
    }

    private func performAutomaticSync(baseURL: String, reason: String) async {
        lastSyncAttemptAt = Date()

        do {
            let journal = loadTodayJournal()
            let payload = buildSyncPayload(from: journal)
            try await postMovementPayload(payload, baseURL: baseURL)
            syncMessage = "Auto-synced movement journal (\(reason))."
            errorMessage = nil
        } catch {
            errorMessage = "Automatic movement sync failed: \(error.localizedDescription)"
        }
    }

    private func normalizedBaseURL(_ rawValue: String) -> String {
        rawValue.trimmingCharacters(in: CharacterSet(charactersIn: "/ \n\t"))
    }

    private static func isoDateString(for date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private static func isoTimestampString(for date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }

    private static func miles(fromMeters meters: Double) -> Double {
        meters / 1609.344
    }

    private static func loadPlaceClusters(from userDefaults: UserDefaults) -> [StoredPlaceCluster] {
        if
            let data = userDefaults.data(forKey: StorageKeys.movementPlaceClusters),
            let decoded = try? JSONDecoder().decode([StoredPlaceCluster].self, from: data)
        {
            return decoded
        }

        if
            let legacyData = userDefaults.data(forKey: StorageKeys.legacyMovementPlaceLabelCache),
            let legacyCache = try? JSONDecoder().decode([String: String].self, from: legacyData)
        {
            return legacyCache.compactMap { key, value in
                let parts = key.split(separator: ",")
                guard
                    parts.count == 2,
                    let latitude = Double(parts[0]),
                    let longitude = Double(parts[1]),
                    !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                else {
                    return nil
                }

                return StoredPlaceCluster(
                    id: UUID().uuidString,
                    label: value,
                    latitude: latitude,
                    longitude: longitude,
                    visitCount: 1,
                    lastResolvedAt: nil
                )
            }
        }

        return []
    }

    private func savePlaceClusters() {
        guard let data = try? JSONEncoder().encode(placeClusters) else {
            return
        }

        userDefaults.set(data, forKey: StorageKeys.movementPlaceClusters)
    }

    private static func requestKey(for latitude: Double, longitude: Double) -> String {
        String(format: "%.4f,%.4f", latitude, longitude)
    }

    private static func coordinatesMatch(
        lhsLatitude: Double,
        lhsLongitude: Double,
        rhsLatitude: Double,
        rhsLongitude: Double
    ) -> Bool {
        abs(lhsLatitude - rhsLatitude) < PlaceLabeling.coordinateMatchThreshold &&
            abs(lhsLongitude - rhsLongitude) < PlaceLabeling.coordinateMatchThreshold
    }

    private static func bestPlaceLabel(from placemark: CLPlacemark?) -> String? {
        guard let placemark else {
            return nil
        }

        let candidates: [String?] = [
            placemark.name,
            [placemark.subLocality, placemark.locality].compactMap { $0 }.joined(separator: ", "),
            placemark.locality,
            placemark.subAdministrativeArea,
            placemark.administrativeArea
        ]

        for candidate in candidates {
            let trimmed = (candidate ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return trimmed
            }
        }

        return nil
    }

    private static func preferredPlaceLabel(existing: String, candidate: String) -> String {
        let existingTrimmed = existing.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidateTrimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !candidateTrimmed.isEmpty else {
            return existingTrimmed
        }
        guard !existingTrimmed.isEmpty else {
            return candidateTrimmed
        }

        let existingScore = placeLabelQualityScore(existingTrimmed)
        let candidateScore = placeLabelQualityScore(candidateTrimmed)

        if candidateScore > existingScore {
            return candidateTrimmed
        }

        return existingTrimmed
    }

    private static func placeLabelQualityScore(_ label: String) -> Int {
        let lowered = label.lowercased()
        var score = 0

        if label.contains(",") {
            score += 2
        }
        if lowered.rangeOfCharacter(from: .decimalDigits) != nil {
            score -= 2
        }
        if label.count <= 28 {
            score += 2
        }
        if label.split(separator: " ").count <= 4 {
            score += 1
        }

        return score
    }
}

extension MovementManager: CLLocationManagerDelegate {
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            self.authorizationStatus = manager.authorizationStatus
            self.resumeAutomaticTrackingIfAuthorized()
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        Task { @MainActor in
            self.updateTodayJournal { journal in
                journal.visits.append(
                    LocalMovementVisit(
                        arrival: visit.arrivalDate == .distantPast ? nil : Self.isoTimestampString(for: visit.arrivalDate),
                        departure: visit.departureDate == .distantFuture ? nil : Self.isoTimestampString(for: visit.departureDate),
                        latitude: visit.coordinate.latitude,
                        longitude: visit.coordinate.longitude,
                        horizontalAccuracyMeters: visit.horizontalAccuracy,
                        label: nil
                    )
                )
            }

            self.resolvePlaceLabel(
                for: CLLocation(latitude: visit.coordinate.latitude, longitude: visit.coordinate.longitude),
                arrival: visit.arrivalDate == .distantPast ? nil : Self.isoTimestampString(for: visit.arrivalDate),
                departure: visit.departureDate == .distantFuture ? nil : Self.isoTimestampString(for: visit.departureDate)
            )
            self.scheduleAutomaticSync(reason: "visit recorded")
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in
            self.updateTodayJournal { journal in
                for location in locations {
                    if let previous = self.lastRecordedLocation {
                        journal.totalDistanceMeters += location.distance(from: previous)
                    }

                    self.lastRecordedLocation = location
                    journal.routePoints.append(
                        LocalMovementRoutePoint(
                            timestamp: Self.isoTimestampString(for: location.timestamp),
                            latitude: location.coordinate.latitude,
                            longitude: location.coordinate.longitude,
                            horizontalAccuracyMeters: location.horizontalAccuracy
                        )
                    )
                }
            }

            self.scheduleAutomaticSync(reason: "location updated")
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            self.errorMessage = "Location error: \(error.localizedDescription)"
        }
    }
}
