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
            .onChange(of: vm.selectedDate) { _, _ in
                Task { await vm.load(baseURL: hk.selectedBaseURL) }
            }
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
            datePicker
            if vm.isLoading {
                ProgressView().tint(JarvisPalette.orange)
            }
            macroRings
            workoutsForDayCard
            foodLogList
            coachingCard
        }
    }

    @FocusState private var coachInputFocused: Bool

    private var coachingCard: some View {
        JarvisCard {
            VStack(alignment: .leading, spacing: 12) {
                Label("Health coach", systemImage: "sparkles")
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .tracking(1.5)
                    .foregroundStyle(JarvisPalette.cyan)

                if vm.coachingMessages.isEmpty {
                    Text("Analyzes the last 3 days of nutrition and recent workouts.")
                        .font(.system(size: 12, design: .rounded))
                        .foregroundStyle(JarvisPalette.secondaryText)
                    Button {
                        Task { await vm.getCoachingFeedback(baseURL: hk.selectedBaseURL) }
                    } label: {
                        HStack {
                            if vm.coachingLoading { ProgressView().tint(.white).scaleEffect(0.75) }
                            Text(vm.coachingLoading ? "Getting feedback…" : "Get coaching feedback →")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(JarvisPrimaryButtonStyle(color: JarvisPalette.cyan))
                    .disabled(vm.coachingLoading)
                } else {
                    // Message thread
                    ScrollViewReader { proxy in
                        ScrollView(showsIndicators: false) {
                            LazyVStack(alignment: .leading, spacing: 10) {
                                ForEach(vm.coachingMessages) { msg in
                                    coachBubble(msg).id(msg.id)
                                }
                                if vm.coachingLoading {
                                    HStack(spacing: 6) {
                                        ForEach(0..<3, id: \.self) { i in
                                            Circle().fill(JarvisPalette.cyan.opacity(0.6)).frame(width: 6, height: 6)
                                                .animation(.easeInOut(duration: 0.5).repeatForever().delay(Double(i) * 0.15), value: vm.coachingLoading)
                                        }
                                    }
                                    .padding(.leading, 8)
                                }
                                Color.clear.frame(height: 1).id("coachBottom")
                            }
                        }
                        .frame(maxHeight: 300)
                        .onChange(of: vm.coachingMessages.count) { _, _ in withAnimation { proxy.scrollTo("coachBottom") } }
                        .onChange(of: vm.coachingLoading) { _, _ in withAnimation { proxy.scrollTo("coachBottom") } }
                    }

                    // Input bar
                    HStack(alignment: .bottom, spacing: 8) {
                        TextField("Ask a follow-up…", text: $vm.coachingInput, axis: .vertical)
                            .lineLimit(1...4)
                            .jarvisTextField()
                            .focused($coachInputFocused)
                        Button {
                            Task { await vm.sendCoachingMessage(baseURL: hk.selectedBaseURL) }
                        } label: {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.system(size: 30))
                                .foregroundStyle(
                                    vm.coachingInput.trimmingCharacters(in: .whitespaces).isEmpty
                                    ? JarvisPalette.subtleText : JarvisPalette.cyan
                                )
                        }
                        .disabled(vm.coachingInput.trimmingCharacters(in: .whitespaces).isEmpty || vm.coachingLoading)
                    }
                }
            }
        }
    }

    private func coachBubble(_ msg: ChatMessage) -> some View {
        HStack(alignment: .top) {
            if msg.role == .user { Spacer(minLength: 40) }
            Text(msg.content)
                .font(.system(size: 13, design: .rounded))
                .foregroundStyle(msg.role == .user ? .white : JarvisPalette.secondaryText)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(msg.role == .user
                              ? JarvisPalette.cyan.opacity(0.2)
                              : Color.white.opacity(0.06))
                )
                .fixedSize(horizontal: false, vertical: true)
            if msg.role == .assistant { Spacer(minLength: 40) }
        }
    }

    private var datePicker: some View {
        HStack {
            Button { vm.previousDay() } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(JarvisPalette.secondaryText)
            }
            Spacer()
            Text(dateNavLabel)
                .font(.system(size: 14, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
            Spacer()
            Button { vm.nextDay() } label: {
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(vm.isViewingToday ? JarvisPalette.subtleText : JarvisPalette.secondaryText)
            }
            .disabled(vm.isViewingToday)
        }
        .padding(.horizontal, 4)
    }

    private var dateNavLabel: String {
        if vm.isViewingToday { return "Today" }
        if Calendar.current.isDateInYesterday(vm.selectedDate) { return "Yesterday" }
        let fmt = DateFormatter(); fmt.dateFormat = "EEE, MMM d"
        return fmt.string(from: vm.selectedDate)
    }

    @ViewBuilder
    private var workoutsForDayCard: some View {
        let workouts = vm.workoutsForSelectedDate
        let manual = vm.foodLog?.manual_workout
        if !workouts.isEmpty || manual != nil {
            JarvisCard {
                VStack(alignment: .leading, spacing: 12) {
                    Label("Workouts", systemImage: "figure.mixed.cardio")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .tracking(1.5)
                        .foregroundStyle(JarvisPalette.emerald)

                    if let manual {
                        HStack(spacing: 12) {
                            ZStack {
                                Circle().fill(JarvisPalette.emerald.opacity(0.15)).frame(width: 36, height: 36)
                                Image(systemName: "dumbbell")
                                    .font(.system(size: 14))
                                    .foregroundStyle(JarvisPalette.emerald)
                            }
                            VStack(alignment: .leading, spacing: 2) {
                                Text(manual.type)
                                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                                    .foregroundStyle(.white)
                                if manual.duration_minutes > 0 {
                                    Text("\(manual.duration_minutes) min · logged manually")
                                        .font(.system(size: 11, design: .rounded))
                                        .foregroundStyle(JarvisPalette.secondaryText)
                                }
                            }
                        }
                    }

                    ForEach(workouts) { workout in
                        HStack(spacing: 12) {
                            ZStack {
                                Circle().fill(Color.blue.opacity(0.15)).frame(width: 36, height: 36)
                                Image(systemName: workoutIcon(workout.activity_label))
                                    .font(.system(size: 14))
                                    .foregroundStyle(Color.blue)
                            }
                            VStack(alignment: .leading, spacing: 3) {
                                Text(workout.activity_label)
                                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                                    .foregroundStyle(.white)
                                HStack(spacing: 8) {
                                    if workout.duration_minutes > 0 {
                                        Label("\(Int(workout.duration_minutes)) min", systemImage: "clock")
                                            .font(.system(size: 11, design: .rounded))
                                            .foregroundStyle(JarvisPalette.secondaryText)
                                    }
                                    if let kcal = workout.active_energy_kcal {
                                        Label("\(Int(kcal)) cal", systemImage: "flame")
                                            .font(.system(size: 11, design: .rounded))
                                            .foregroundStyle(JarvisPalette.orange)
                                    }
                                    if let hr = workout.avg_heart_rate_bpm {
                                        Label("\(Int(hr)) bpm", systemImage: "heart")
                                            .font(.system(size: 11, design: .rounded))
                                            .foregroundStyle(Color.pink)
                                    }
                                }
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "applewatch")
                                .font(.system(size: 12))
                                .foregroundStyle(JarvisPalette.subtleText)
                        }
                    }
                }
            }
        }
    }

    private var macroRings: some View {
        let t = vm.totals
        let targets = vm.foodLog?.targets ?? MacroTargets(calories: 2600, protein_g: 155, carbs_g: 320, fat_g: 75)

        return JarvisCard {
            VStack(alignment: .leading, spacing: 14) {
                Text(vm.isViewingToday ? "Macros — today" : "Macros — \(vm.selectedDateKey)")
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .foregroundStyle(JarvisPalette.subtleText)

                HStack(spacing: 10) {
                    macroTile(label: "Calories", val: t.cal, target: targets.calories, unit: "kcal", color: JarvisPalette.cyan)
                    macroTile(label: "Protein",  val: t.pro, target: targets.protein_g, unit: "g", color: JarvisPalette.emerald)
                    macroTile(label: "Carbs",    val: t.carb, target: targets.carbs_g, unit: "g", color: JarvisPalette.orange)
                    macroTile(label: "Fat",      val: t.fat, target: targets.fat_g, unit: "g", color: Color(red: 1, green: 0.6, blue: 0.7))
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
                Text("Food log — \(vm.selectedDateKey)")
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
        VStack(spacing: 12) {
            // Apple Watch / HealthKit workouts
            if !vm.healthKitWorkouts.isEmpty {
                JarvisCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Apple Watch Workouts", systemImage: "applewatch.watchface")
                            .font(.system(size: 11, weight: .semibold, design: .rounded))
                            .tracking(1.5)
                            .foregroundStyle(JarvisPalette.emerald)

                        ForEach(vm.healthKitWorkouts) { workout in
                            HStack(spacing: 12) {
                                ZStack {
                                    Circle().fill(JarvisPalette.emerald.opacity(0.15)).frame(width: 40, height: 40)
                                    Image(systemName: workoutIcon(workout.activity_label))
                                        .font(.system(size: 16))
                                        .foregroundStyle(JarvisPalette.emerald)
                                }
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(workout.activity_label)
                                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                                        .foregroundStyle(.white)
                                    HStack(spacing: 8) {
                                        if workout.duration_minutes > 0 {
                                            Label("\(Int(workout.duration_minutes)) min", systemImage: "clock")
                                                .font(.system(size: 11, design: .rounded))
                                                .foregroundStyle(JarvisPalette.secondaryText)
                                        }
                                        if let kcal = workout.active_energy_kcal {
                                            Label("\(Int(kcal)) cal", systemImage: "flame")
                                                .font(.system(size: 11, design: .rounded))
                                                .foregroundStyle(JarvisPalette.orange)
                                        }
                                        if let hr = workout.avg_heart_rate_bpm {
                                            Label("\(Int(hr)) bpm", systemImage: "heart")
                                                .font(.system(size: 11, design: .rounded))
                                                .foregroundStyle(Color.pink)
                                        }
                                        if let km = workout.total_distance_km {
                                            Label(String(format: "%.1f km", km), systemImage: "arrow.right")
                                                .font(.system(size: 11, design: .rounded))
                                                .foregroundStyle(JarvisPalette.cyan)
                                        }
                                    }
                                    Text(workoutDateLabel(workout))
                                        .font(.system(size: 10, design: .rounded))
                                        .foregroundStyle(JarvisPalette.subtleText)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(12)
                            .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.04)))
                        }
                    }
                }
            }

            // Manual log form
            JarvisCard {
                VStack(alignment: .leading, spacing: 14) {
                    Label("Log manual workout", systemImage: "dumbbell")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .tracking(1.5)
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
    }

    private func workoutIcon(_ label: String) -> String {
        let l = label.lowercased()
        if l.contains("run") { return "figure.run" }
        if l.contains("walk") { return "figure.walk" }
        if l.contains("climb") || l.contains("hike") { return "mountain.2" }
        if l.contains("swim") { return "figure.pool.swim" }
        if l.contains("cycle") || l.contains("bike") || l.contains("ride") { return "figure.outdoor.cycle" }
        if l.contains("yoga") { return "figure.yoga" }
        if l.contains("strength") || l.contains("functional") { return "dumbbell" }
        if l.contains("core") || l.contains("abs") { return "figure.core.training" }
        if l.contains("hiit") || l.contains("interval") { return "bolt.heart" }
        return "figure.mixed.cardio"
    }

    private func workoutDateLabel(_ workout: WorkoutEntry) -> String {
        let fmt = DateFormatter(); fmt.dateFormat = "yyyy-MM-dd"
        fmt.locale = Locale(identifier: "en_US_POSIX")
        guard let d = fmt.date(from: String(workout.date.prefix(10))) else { return workout.date }
        if Calendar.current.isDateInToday(d) { return "Today" }
        if Calendar.current.isDateInYesterday(d) { return "Yesterday" }
        let out = DateFormatter(); out.dateFormat = "EEE MMM d"
        return out.string(from: d)
    }

    // MARK: - Meal Prep

    private var prepContent: some View {
        VStack(spacing: 14) {
            // Quick add
            JarvisCard {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Quick add")
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(JarvisPalette.subtleText)

                    if vm.mealPrepItems.isEmpty {
                        Text("No saved recipes yet.")
                            .font(.system(size: 13, design: .rounded))
                            .foregroundStyle(JarvisPalette.secondaryText)
                    } else {
                        ForEach(vm.mealPrepItems) { item in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.name).font(.system(size: 13, weight: .semibold, design: .rounded)).foregroundStyle(.white)
                                    Text("\(Int(item.calories)) cal · \(Int(item.protein_g))g P · \(Int(item.carbs_g))g C · \(Int(item.fat_g))g F")
                                        .font(.system(size: 11, design: .rounded)).foregroundStyle(JarvisPalette.secondaryText)
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

            // Saved recipes detail
            JarvisCard {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Nutrition details")
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
