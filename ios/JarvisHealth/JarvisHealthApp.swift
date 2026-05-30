import SwiftUI

@main
struct JarvisHealthApp: App {
    @StateObject private var healthKitManager = HealthKitManager()
    @StateObject private var movementManager = MovementManager()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(healthKitManager)
                .environmentObject(movementManager)
        }
    }
}
