import SwiftUI

@MainActor
final class JournalViewModel: ObservableObject {
    @Published var entry: JournalDayEntry?
    @Published var isLoading = false
    @Published var isSaving = false
    @Published var error: String?
    @Published var selectedDate = Date()

    @Published var journalText = ""
    @Published var gratitudeText = ""
    @Published var accomplishmentsText = ""
    @Published var scriptureText = ""
    @Published var spiritualText = ""

    var isoDate: String {
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.timeZone = .current
        return fmt.string(from: selectedDate)
    }

    var isToday: Bool { Calendar.current.isDateInToday(selectedDate) }

    func load(baseURL: String) async {
        isLoading = true; error = nil
        do {
            let e = try await JarvisAPIClient.getJournalEntry(baseURL: baseURL, date: isoDate)
            populateFields(from: e)
        } catch {
            entry = nil
            journalText = ""; gratitudeText = ""; accomplishmentsText = ""
            scriptureText = ""; spiritualText = ""
        }
        isLoading = false
    }

    func save(baseURL: String) async {
        isSaving = true; error = nil
        do {
            let updated = try await JarvisAPIClient.saveJournalEntry(
                baseURL: baseURL, date: isoDate,
                journalEntry: journalText, accomplishments: accomplishmentsText,
                gratitudeEntry: gratitudeText, scriptureStudy: scriptureText,
                spiritualNotes: spiritualText)
            populateFields(from: updated)
        } catch { self.error = error.localizedDescription }
        isSaving = false
    }

    func previousDay(baseURL: String) {
        selectedDate = Calendar.current.date(byAdding: .day, value: -1, to: selectedDate) ?? selectedDate
        Task { await load(baseURL: baseURL) }
    }

    func nextDay(baseURL: String) {
        guard !isToday else { return }
        selectedDate = Calendar.current.date(byAdding: .day, value: 1, to: selectedDate) ?? selectedDate
        Task { await load(baseURL: baseURL) }
    }

    private func populateFields(from e: JournalDayEntry) {
        entry = e
        journalText = e.journal_entry
        gratitudeText = e.gratitude_entry
        accomplishmentsText = e.accomplishments
        scriptureText = e.scripture_study
        spiritualText = e.spiritual_notes
    }
}

struct JournalView: View {
    @EnvironmentObject private var hk: HealthKitManager
    @StateObject private var vm = JournalViewModel()

    var body: some View {
        NavigationStack {
            ZStack {
                JarvisPalette.background.ignoresSafeArea()
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 14) {
                        dateNavBar
                        if vm.isLoading {
                            ProgressView().tint(JarvisPalette.cyan).frame(maxWidth: .infinity).padding(.top, 60)
                        } else {
                            contextCard
                            journalSection("Journal", icon: "pencil.line", text: $vm.journalText,
                                           placeholder: "How was your day?")
                            journalSection("Gratitude", icon: "heart", text: $vm.gratitudeText,
                                           placeholder: "What are you grateful for?")
                            journalSection("Accomplishments", icon: "star", text: $vm.accomplishmentsText,
                                           placeholder: "What did you accomplish?")
                            journalSection("Scripture Study", icon: "book.closed", text: $vm.scriptureText,
                                           placeholder: "Notes from study…")
                            journalSection("Spiritual Notes", icon: "moon.stars", text: $vm.spiritualText,
                                           placeholder: "Spiritual impressions…")
                            saveButton
                        }

                        if let err = vm.error {
                            Text(err).font(.system(size: 13, design: .rounded)).foregroundStyle(.white)
                                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                                .background(RoundedRectangle(cornerRadius: 14).fill(Color.red.opacity(0.22)))
                                .padding(.horizontal, 18)
                        }
                    }
                    .padding(.bottom, 40)
                }
            }
            .navigationTitle("Journal")
            .navigationBarTitleDisplayMode(.large)
            .task { await vm.load(baseURL: hk.selectedBaseURL) }
        }
    }

    // MARK: - Date navigation

    private var dateNavBar: some View {
        HStack(spacing: 0) {
            Button { vm.previousDay(baseURL: hk.selectedBaseURL) } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(JarvisPalette.cyan)
                    .padding(12)
            }
            Spacer()
            VStack(spacing: 2) {
                Text(formattedDate())
                    .font(.system(size: 15, weight: .semibold, design: .rounded)).foregroundStyle(.white)
                if let label = vm.entry?.date_label, !label.isEmpty {
                    Text(label).font(.system(size: 11, design: .rounded)).foregroundStyle(JarvisPalette.subtleText)
                }
            }
            Spacer()
            Button { vm.nextDay(baseURL: hk.selectedBaseURL) } label: {
                Image(systemName: "chevron.right")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(vm.isToday ? JarvisPalette.subtleText.opacity(0.4) : JarvisPalette.cyan)
                    .padding(12)
            }
            .disabled(vm.isToday)
        }
        .padding(.horizontal, 10).padding(.top, 4)
    }

    // MARK: - Context card (calendar + world event)

    @ViewBuilder
    private var contextCard: some View {
        if let entry = vm.entry, (!entry.calendar_summary.isEmpty || entry.world_event_title != nil) {
            JarvisCard {
                VStack(alignment: .leading, spacing: 12) {
                    if !entry.calendar_summary.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Label("Calendar", systemImage: "calendar")
                                .font(.system(size: 10, weight: .semibold, design: .rounded))
                                .tracking(1.5).foregroundStyle(JarvisPalette.cyan)
                            Text(entry.calendar_summary)
                                .font(.system(size: 13, design: .rounded))
                                .foregroundStyle(JarvisPalette.secondaryText)
                        }
                    }
                    if let headline = entry.world_event_title {
                        VStack(alignment: .leading, spacing: 4) {
                            Label("World", systemImage: "globe")
                                .font(.system(size: 10, weight: .semibold, design: .rounded))
                                .tracking(1.5).foregroundStyle(JarvisPalette.subtleText)
                            Text(headline)
                                .font(.system(size: 13, weight: .medium, design: .rounded)).foregroundStyle(.white)
                            if !entry.world_event_summary.isEmpty {
                                Text(entry.world_event_summary)
                                    .font(.system(size: 12, design: .rounded))
                                    .foregroundStyle(JarvisPalette.secondaryText)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 18)
        }
    }

    // MARK: - Editable section

    private func journalSection(_ title: String, icon: String, text: Binding<String>, placeholder: String) -> some View {
        JarvisCard {
            VStack(alignment: .leading, spacing: 10) {
                Label(title.uppercased(), systemImage: icon)
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .tracking(1.5).foregroundStyle(JarvisPalette.subtleText)
                ZStack(alignment: .topLeading) {
                    if text.wrappedValue.isEmpty {
                        Text(placeholder)
                            .font(.system(size: 14, design: .rounded))
                            .foregroundStyle(JarvisPalette.subtleText.opacity(0.55))
                            .padding(.top, 8).padding(.leading, 4)
                            .allowsHitTesting(false)
                    }
                    TextEditor(text: text)
                        .font(.system(size: 14, design: .rounded))
                        .foregroundStyle(.white)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 80)
                }
            }
        }
        .padding(.horizontal, 18)
    }

    // MARK: - Save

    private var saveButton: some View {
        Button {
            Task { await vm.save(baseURL: hk.selectedBaseURL) }
        } label: {
            HStack(spacing: 8) {
                if vm.isSaving { ProgressView().tint(.black).scaleEffect(0.75) }
                Text(vm.isSaving ? "Saving…" : "Save Entry")
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
            }
            .frame(maxWidth: .infinity).padding(.vertical, 14)
            .background(JarvisPalette.cyan).cornerRadius(18)
            .foregroundStyle(.black)
        }
        .padding(.horizontal, 18)
        .disabled(vm.isSaving)
    }

    private func formattedDate() -> String {
        let fmt = DateFormatter()
        fmt.dateFormat = "EEEE, MMM d"
        return fmt.string(from: vm.selectedDate)
    }
}
