import SwiftUI

struct RootView: View {
    @EnvironmentObject private var hk: HealthKitManager
    @EnvironmentObject private var mv: MovementManager
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView {
            DashboardView()
                .tabItem { Label("Home", systemImage: "house.fill") }

            TasksView()
                .tabItem { Label("Tasks", systemImage: "checklist") }

            JournalView()
                .tabItem { Label("Journal", systemImage: "book.closed.fill") }

            NutritionView()
                .tabItem { Label("Nutrition", systemImage: "fork.knife") }

            MailView()
                .tabItem { Label("Mail", systemImage: "envelope.fill") }

            LanguageView()
                .tabItem { Label("Language", systemImage: "character.bubble.fill") }

            AssistantView()
                .tabItem { Label("Assistant", systemImage: "bubble.left.and.bubble.right.fill") }

            ContentView()
                .tabItem { Label("Health", systemImage: "waveform.path.ecg") }

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
        }
        .tint(JarvisPalette.cyan)
        .preferredColorScheme(.dark)
        .task {
            hk.refreshAuthorizationStatus()
            hk.configureAutomaticSync(baseURL: hk.selectedBaseURL)
            hk.handleAppBecameActive()
            mv.configureSync(baseURL: hk.selectedBaseURL)
            mv.handleAppBecameActive()
        }
        .onChange(of: hk.selectedBaseURL) { _, newValue in
            hk.configureAutomaticSync(baseURL: newValue)
            mv.configureSync(baseURL: newValue)
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                hk.handleAppBecameActive()
                mv.handleAppBecameActive()
            } else if newPhase == .background {
                mv.handleAppMovedToBackground()
            }
        }
    }
}
