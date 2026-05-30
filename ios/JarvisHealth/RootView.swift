import SwiftUI

struct RootView: View {
    @EnvironmentObject private var hk: HealthKitManager
    @EnvironmentObject private var mv: MovementManager

    var body: some View {
        TabView {
            DashboardView()
                .tabItem { Label("Home", systemImage: "house.fill") }

            NutritionView()
                .tabItem { Label("Nutrition", systemImage: "fork.knife") }

            AssistantView()
                .tabItem { Label("Assistant", systemImage: "bubble.left.and.bubble.right.fill") }

            ContentView()
                .tabItem { Label("Health", systemImage: "waveform.path.ecg") }

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
        }
        .tint(JarvisPalette.cyan)
        .preferredColorScheme(.dark)
    }
}
