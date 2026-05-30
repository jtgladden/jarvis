import SwiftUI

struct NutritionView: View {
    @EnvironmentObject private var hk: HealthKitManager
    @StateObject private var vm = NutritionViewModel()
    @State private var tab: NutritionTab = .today

    enum NutritionTab: String, CaseIterable {
        case today = "Today"
        case log = "Log Food"
        case workout = "Workout"
        case prep = "Meal Prep"
    }

    var body: some View {
        NavigationStack {
            ZStack {
                JarvisPalette.background.ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(spacing: 16) {
                        tabPicker
                        if let err = vm.error {
                            errorBanner(err)
                        }
                        switch tab {
                        case .today:   todayContent
                        case .log:     logContent
                        case .workout: workoutContent
                        case .prep:    prepContent
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 12)
                    .padding(.bottom, 32)
                }
            }
            .navigationTitle("Nutrition")
            .navigationBarTitleDisplayMode(.large)
            .task { await vm.load(baseURL: hk.selectedBaseURL) }
        }
    }

    // MARK: - Tab picker

    private var tabPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(NutritionTab.allCases, id: \.self) { t in
                    Button(t.rawValue) { tab = t }
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(
                            Capsule()
                                .fill(tab == t ? JarvisPalette.orange.opacity(0.22) : Color.white.opacity(0.06))
                                .overlay(Capsule().stroke(tab == t ? JarvisPalette.orange.opacity(0.5) : Color.white.opacity(0.1), lineWidth: 1))
                        )
                        .foregroundStyle(tab == t ? JarvisPalette.orange : JarvisPalette.secondaryText)
                }
            }
        }
    }

    // MARK: - Today

    private var todayContent: some View {
        VStack(spacing: 14) {
            if vm.isLoading {
                ProgressView().tint(JarvisPalette.orange)
            }
            macroRings
            foodLogList
        }
    }

    private var macroRings: some View {
        let t = vm.totals
        let targets = vm.foodLog?.targets ?? MacroTargets(calories: 2600, protein_g: 155, carbs_g: 320, fat_g: 75)

        return JarvisCard {
            VStack(alignment: .leading, spacing: 14) {
                Text("Macros — today")
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .foregroundStyle(JarvisPalette.subtleText)

                HStack(spacing: 10) {
                    macroTile(label: "Calories", val: t.cal, target: targets.calories, unit: "kcal", color: JarvisPalette.cyan)
                    macroTile(label: "Protein",  val: t.pro, target: targets.protein_g, unit: "g", color: JarvisPalette.emerald)
                    macroTile(label: "Carbs",    val: t.carb, target: targets.carbs_g, unit: "g", color: JarvisPalette.orange)
                    macroTile(label: "Fat",      val: t.fat, target: targets.fat_g, unit: "g", color: Color(red: 1, green: 0.6, blue: 0.7))
                }

                if let workout = vm.foodLog?.manual_workout {
                    HStack(spacing: 8) {
                        Image(systemName: "figure.strengthtraining.traditional")
                            .foregroundStyle(JarvisPalette.emerald)
                        Text("\(workout.type)\(workout.duration_minutes > 0 ? " · \(workout.duration_minutes) min" : "")")
                            .font(.system(size: 13, weight: .medium, design: .rounded))
                            .foregroundStyle(.white)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 14).fill(JarvisPalette.emerald.opacity(0.12)))
                }
            }
        }
    }

    private func macroTile(label: String, val: Double, target: Double, unit: String, color: Color) -> some View {
        let pct = min(1.0, target > 0 ? val / target : 0)
        return VStack(spacing: 6) {
            ZStack {
                Circle().stroke(color.opacity(0.15), lineWidth: 5)
                Circle().trim(from: 0, to: pct)
                    .stroke(color, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text("\(Int(val))")
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
            }
            .frame(width: 60, height: 60)
            Text(label)
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .foregroundStyle(JarvisPalette.subtleText)
            Text("\(unit)")
                .font(.system(size: 9, design: .rounded))
                .foregroundStyle(color.opacity(0.8))
        }
        .frame(maxWidth: .infinity)
    }

    private var foodLogList: some View {
        JarvisCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Food log")
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .foregroundStyle(JarvisPalette.subtleText)

                if vm.foodLog?.entries.isEmpty ?? true {
                    Text("Nothing logged yet — use Log Food to add entries.")
                        .font(.system(size: 13, design: .rounded))
                        .foregroundStyle(JarvisPalette.secondaryText)
                } else {
                    ForEach(vm.foodLog?.entries ?? []) { entry in
                        if vm.editingEntryId == entry.id {
                            editRow(for: entry)
                        } else {
                            entryRow(entry)
                        }
                    }
                }
            }
        }
    }

    private func entryRow(_ entry: FoodLogEntry) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.name)
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
                Text("\(entry.meal) · \(Int(entry.calories)) cal · \(Int(entry.protein_g))g P · \(Int(entry.carbs_g))g C · \(Int(entry.fat_g))g F")
                    .font(.system(size: 11, design: .rounded))
                    .foregroundStyle(JarvisPalette.secondaryText)
            }
            Spacer(minLength: 0)
            Button { vm.startEdit(entry) } label: {
                Image(systemName: "pencil").foregroundStyle(JarvisPalette.subtleText)
            }
            Button {
                Task { await vm.deleteFood(baseURL: hk.selectedBaseURL, entryId: entry.id) }
            } label: {
                Image(systemName: "xmark").foregroundStyle(JarvisPalette.subtleText)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.04)))
    }

    private func editRow(for entry: FoodLogEntry) -> some View {
        VStack(spacing: 8) {
            TextField("Food name", text: $vm.editName)
                .jarvisTextField()
            HStack(spacing: 8) {
                TextField("Cal", text: $vm.editCal).keyboardType(.decimalPad).jarvisTextField()
                TextField("P g", text: $vm.editPro).keyboardType(.decimalPad).jarvisTextField()
                TextField("C g", text: $vm.editCarb).keyboardType(.decimalPad).jarvisTextField()
                TextField("F g", text: $vm.editFat).keyboardType(.decimalPad).jarvisTextField()
            }
            Picker("Meal", selection: $vm.editMeal) {
                ForEach(vm.mealTypes, id: \.self) { Text($0) }
            }
            .pickerStyle(.menu)
            .tint(JarvisPalette.orange)
            HStack(spacing: 8) {
                Button("Save") {
                    Task { await vm.saveEdit(baseURL: hk.selectedBaseURL) }
                }
                .buttonStyle(JarvisPrimaryButtonStyle(color: JarvisPalette.orange))
                Button("Cancel") { vm.editingEntryId = nil }
                .buttonStyle(JarvisSecondaryButtonStyle())
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14).fill(JarvisPalette.orange.opacity(0.08)))
    }

    // MARK: - Log Food

    private var logContent: some View {
        VStack(spacing: 14) {
            // AI parse
            JarvisCard {
                VStack(alignment: .leading, spacing: 12) {
                    Label("AI Parse", systemImage: "sparkles")
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(JarvisPalette.cyan)

                    TextField("Describe what you ate…", text: $vm.aiText, axis: .vertical)
                        .lineLimit(2...4)
                        .jarvisTextField()

                    Button {
                        Task { await vm.parseFood(baseURL: hk.selectedBaseURL) }
                    } label: {
                        HStack {
                            if vm.aiParsing { ProgressView().tint(.white).scaleEffect(0.8) }
                            Text(vm.aiParsing ? "Parsing…" : "Parse → fill form below")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(JarvisPrimaryButtonStyle(color: JarvisPalette.cyan))
                    .disabled(vm.aiParsing || vm.aiText.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }

            // Meal prep quick add
            if !vm.mealPrepItems.isEmpty {
                JarvisCard {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Quick add from meal prep")
                            .font(.system(size: 13, weight: .semibold, design: .rounded))
                            .foregroundStyle(JarvisPalette.subtleText)
                        ForEach(vm.mealPrepItems) { item in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.name).font(.system(size: 13, weight: .semibold, design: .rounded)).foregroundStyle(.white)
                                    Text("\(Int(item.calories)) cal · \(Int(item.protein_g))g P").font(.system(size: 11, design: .rounded)).foregroundStyle(JarvisPalette.secondaryText)
                                }
                                Spacer()
                                Button("Add") {
                                    Task { await vm.quickAdd(baseURL: hk.selectedBaseURL, item: item) }
                                }
                                .font(.system(size: 12, weight: .semibold, design: .rounded))
                                .padding(.horizontal, 12).padding(.vertical, 6)
                                .background(Capsule().fill(JarvisPalette.cyan.opacity(0.18)))
                                .foregroundStyle(JarvisPalette.cyan)
                            }
                        }
                    }
                }
            }

            // Manual form
            JarvisCard {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Custom entry")
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(JarvisPalette.subtleText)

                    TextField("Food name", text: $vm.fName).jarvisTextField()

                    HStack(spacing: 8) {
                        TextField("Cal", text: $vm.fCal).keyboardType(.decimalPad).jarvisTextField()
                        TextField("Protein g", text: $vm.fPro).keyboardType(.decimalPad).jarvisTextField()
                    }
                    HStack(spacing: 8) {
                        TextField("Carbs g", text: $vm.fCarb).keyboardType(.decimalPad).jarvisTextField()
                        TextField("Fat g", text: $vm.fFat).keyboardType(.decimalPad).jarvisTextField()
                    }

                    Picker("Meal", selection: $vm.fMeal) {
                        ForEach(vm.mealTypes, id: \.self) { Text($0) }
                    }
                    .pickerStyle(.menu)
                    .tint(JarvisPalette.orange)

                    Button("Log food") {
                        Task { await vm.addFood(baseURL: hk.selectedBaseURL) }
                    }
                    .frame(maxWidth: .infinity)
                    .buttonStyle(JarvisPrimaryButtonStyle(color: JarvisPalette.orange))
                    .disabled(vm.fName.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    // MARK: - Workout

    private var workoutContent: some View {
        JarvisCard {
            VStack(alignment: .leading, spacing: 14) {
                Text("Log workout")
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .foregroundStyle(JarvisPalette.subtleText)

                Picker("Type", selection: $vm.wType) {
                    ForEach(vm.workoutTypes, id: \.self) { Text($0) }
                }
                .pickerStyle(.menu)
                .tint(JarvisPalette.emerald)

                TextField("Duration (min)", text: $vm.wDur).keyboardType(.numberPad).jarvisTextField()
                TextField("Sets, reps, notes…", text: $vm.wNotes, axis: .vertical)
                    .lineLimit(3...6)
                    .jarvisTextField()

                Button("Log workout") {
                    Task { await vm.logWorkout(baseURL: hk.selectedBaseURL) }
                }
                .frame(maxWidth: .infinity)
                .buttonStyle(JarvisPrimaryButtonStyle(color: JarvisPalette.emerald))
            }
        }
    }

    // MARK: - Meal Prep

    private var prepContent: some View {
        JarvisCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Saved recipes")
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .foregroundStyle(JarvisPalette.subtleText)

                if vm.mealPrepItems.isEmpty {
                    Text("No saved recipes yet.")
                        .font(.system(size: 13, design: .rounded))
                        .foregroundStyle(JarvisPalette.secondaryText)
                } else {
                    ForEach(vm.mealPrepItems) { item in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(item.name).font(.system(size: 14, weight: .semibold, design: .rounded)).foregroundStyle(.white)
                            Text("\(Int(item.calories)) cal · \(Int(item.protein_g))g P · \(Int(item.carbs_g))g C · \(Int(item.fat_g))g F")
                                .font(.system(size: 11, design: .rounded)).foregroundStyle(JarvisPalette.secondaryText)
                            if !item.notes.isEmpty {
                                Text(item.notes).font(.system(size: 11, design: .rounded)).foregroundStyle(JarvisPalette.subtleText)
                            }
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.04)))
                    }
                }
            }
        }
    }

    private func errorBanner(_ message: String) -> some View {
        Text(message)
            .font(.system(size: 13, design: .rounded))
            .foregroundStyle(.white)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14).fill(Color.red.opacity(0.22)))
    }
}

// MARK: - Shared button styles

struct JarvisPrimaryButtonStyle: ButtonStyle {
    let color: Color
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .semibold, design: .rounded))
            .foregroundStyle(.white)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
            .background(RoundedRectangle(cornerRadius: 18).fill(color.opacity(configuration.isPressed ? 0.4 : 0.22)).overlay(RoundedRectangle(cornerRadius: 18).stroke(color.opacity(0.5), lineWidth: 1)))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

struct JarvisSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .semibold, design: .rounded))
            .foregroundStyle(JarvisPalette.secondaryText)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
            .background(RoundedRectangle(cornerRadius: 18).fill(.white.opacity(0.06)))
    }
}

// MARK: - TextField modifier

extension View {
    func jarvisTextField() -> some View {
        self
            .font(.system(size: 14, design: .rounded))
            .foregroundStyle(.white)
            .tint(JarvisPalette.cyan)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 16)
                    .fill(.white.opacity(0.06))
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.1), lineWidth: 1))
            )
    }
}
