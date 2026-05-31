import SwiftUI

@MainActor
final class LanguageViewModel: ObservableObject {
    @Published var dashboard: LanguageDashboardResponse?
    @Published var isLoading = false
    @Published var error: String?
    @Published var selectedTab: LanguageTab = .practice

    // Language selection (independent of backend active_language)
    @Published var selectedLanguage: String = ""

    // Vocab add form
    @Published var newPhrase = ""
    @Published var newTranslation = ""
    @Published var newPronunciation = ""
    @Published var addingVocab = false

    // Log session form
    @Published var sessionMode = "daily"
    @Published var sessionMinutes = ""
    @Published var sessionNotes = ""
    @Published var loggingSession = false

    // Conversation
    @Published var convoMessages: [LanguageConversationMessage] = []
    @Published var convoInput = ""
    @Published var convoLoading = false
    @Published var lastConvoResponse: LanguageConversationResponse?

    // Writing practice
    @Published var writingPromptText = ""
    @Published var writingResponse = ""
    @Published var writingFeedback: LanguageFeedbackResponse?
    @Published var writingLoading = false

    let sessionModes = ["daily", "conversation", "vocabulary", "writing", "grammar", "listening"]

    var activeLevel: String { dashboard?.profile.level ?? "beginner" }
    var correctionStyle: String { dashboard?.profile.correction_style ?? "gentle" }

    var targetLanguages: [String] {
        guard let d = dashboard else { return [] }
        return d.profile.target_languages.isEmpty
            ? (d.language_progress.isEmpty ? [d.profile.active_language] : d.language_progress.map { $0.language })
            : d.profile.target_languages
    }

    var filteredVocab: [LanguageVocabItem] {
        guard let d = dashboard else { return [] }
        if selectedLanguage.isEmpty { return d.vocab }
        return d.vocab.filter { $0.language == selectedLanguage }
    }

    var reviewDeck: [LanguageVocabItem] {
        // Prefer words that are due or never reviewed, fall back to full vocab
        let all = filteredVocab
        let due = all.filter { item in
            guard let next = item.next_review_at,
                  let date = ISO8601DateFormatter().date(from: next) else {
                return item.review_count == 0
            }
            return date <= Date()
        }
        return due.isEmpty ? all : due
    }

    var selectedLanguageProgress: LanguageProgressByLanguage? {
        dashboard?.language_progress.first { $0.language == selectedLanguage }
    }

    func languageName(_ code: String) -> String {
        dashboard?.supported_languages.first { $0.code == code }?.name ?? code.capitalized
    }

    func load(baseURL: String) async {
        isLoading = true; error = nil
        do {
            let d = try await JarvisAPIClient.getLanguageDashboard(baseURL: baseURL)
            dashboard = d
            if selectedLanguage.isEmpty {
                selectedLanguage = d.profile.active_language
            }
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    func addVocab(baseURL: String) async {
        guard !newPhrase.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        addingVocab = true
        do {
            _ = try await JarvisAPIClient.addVocab(
                baseURL: baseURL, language: selectedLanguage,
                phrase: newPhrase, translation: newTranslation, pronunciation: newPronunciation
            )
            newPhrase = ""; newTranslation = ""; newPronunciation = ""
            await load(baseURL: baseURL)
        } catch { self.error = error.localizedDescription }
        addingVocab = false
    }

    func reviewVocab(baseURL: String, vocabId: String, remembered: Bool) async {
        do {
            _ = try await JarvisAPIClient.reviewVocab(baseURL: baseURL, vocabId: vocabId, remembered: remembered)
            await load(baseURL: baseURL)
        } catch { self.error = error.localizedDescription }
    }

    func deleteVocab(baseURL: String, vocabId: String) async {
        do {
            try await JarvisAPIClient.deleteVocab(baseURL: baseURL, vocabId: vocabId)
            dashboard = dashboard.map { d in
                LanguageDashboardResponse(
                    profile: d.profile, supported_languages: d.supported_languages,
                    daily_prompts: d.daily_prompts, daily_focus_words: d.daily_focus_words,
                    vocab: d.vocab.filter { $0.id != vocabId },
                    recent_sessions: d.recent_sessions, progress: d.progress,
                    language_progress: d.language_progress
                )
            }
        } catch { self.error = error.localizedDescription }
    }

    func logSession(baseURL: String) async {
        guard let mins = Int(sessionMinutes), mins > 0 else { return }
        loggingSession = true
        do {
            _ = try await JarvisAPIClient.logSession(
                baseURL: baseURL, language: selectedLanguage,
                mode: sessionMode, minutes: mins, notes: sessionNotes
            )
            sessionMinutes = ""; sessionNotes = ""
            await load(baseURL: baseURL)
        } catch { self.error = error.localizedDescription }
        loggingSession = false
    }

    func sendConversationMessage(baseURL: String) async {
        let text = convoInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        convoInput = ""
        let userMsg = LanguageConversationMessage(role: "user", content: text)
        convoMessages.append(userMsg)
        convoLoading = true
        do {
            let result = try await JarvisAPIClient.getConversationReply(
                baseURL: baseURL, language: selectedLanguage, level: activeLevel,
                correctionStyle: correctionStyle, message: text, scenario: "",
                history: Array(convoMessages.dropLast())
            )
            lastConvoResponse = result
            convoMessages.append(LanguageConversationMessage(role: "assistant", content: result.reply))
        } catch { self.error = error.localizedDescription }
        convoLoading = false
    }

    func submitWriting(baseURL: String) async {
        guard !writingResponse.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        writingLoading = true; writingFeedback = nil
        do {
            writingFeedback = try await JarvisAPIClient.getWritingFeedback(
                baseURL: baseURL, language: selectedLanguage, level: activeLevel,
                prompt: writingPromptText, response: writingResponse, correctionStyle: correctionStyle
            )
        } catch { self.error = error.localizedDescription }
        writingLoading = false
    }
}

enum LanguageTab: String, CaseIterable {
    case practice = "Practice"
    case vocab = "Vocab"
    case convo = "Conversation"
    case log = "Log"
}

struct LanguageView: View {
    @EnvironmentObject private var hk: HealthKitManager
    @StateObject private var vm = LanguageViewModel()
    @FocusState private var convoFocused: Bool
    @State private var showFlashcards = false

    var body: some View {
        NavigationStack {
            ZStack {
                JarvisPalette.background.ignoresSafeArea()
                if vm.isLoading && vm.dashboard == nil {
                    ProgressView().tint(JarvisPalette.cyan)
                } else {
                    VStack(spacing: 0) {
                        if vm.targetLanguages.count > 1 {
                            languagePicker
                        }
                        tabBar
                        ScrollView(showsIndicators: false) {
                            VStack(spacing: 20) {
                                if let err = vm.error {
                                    Text(err)
                                        .font(.system(size: 13, design: .rounded))
                                        .foregroundStyle(.red.opacity(0.8))
                                        .padding(.horizontal)
                                }
                                switch vm.selectedTab {
                                case .practice: practiceContent
                                case .vocab:    vocabContent
                                case .convo:    convoContent
                                case .log:      logContent
                                }
                            }
                            .padding(.horizontal, 16)
                            .padding(.top, 20)
                            .padding(.bottom, 40)
                        }
                    }
                }
            }
            .navigationTitle(vm.selectedLanguage.isEmpty ? "Language" : vm.languageName(vm.selectedLanguage))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await vm.load(baseURL: hk.selectedBaseURL) } } label: {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(JarvisPalette.subtleText)
                    }
                }
            }
            .task { await vm.load(baseURL: hk.selectedBaseURL) }
            .onChange(of: vm.selectedLanguage) { _, _ in
                vm.convoMessages = []
                vm.lastConvoResponse = nil
                vm.writingFeedback = nil
            }
            .fullScreenCover(isPresented: $showFlashcards) {
                FlashcardSessionView(
                    deck: vm.reviewDeck,
                    languageName: vm.languageName(vm.selectedLanguage)
                ) { vocabId, remembered in
                    Task { await vm.reviewVocab(baseURL: hk.selectedBaseURL, vocabId: vocabId, remembered: remembered) }
                }
            }
        }
    }

    // MARK: - Pickers

    private var languagePicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(vm.targetLanguages, id: \.self) { code in
                    Button { vm.selectedLanguage = code } label: {
                        Text(vm.languageName(code))
                            .font(.system(size: 13, weight: vm.selectedLanguage == code ? .semibold : .regular, design: .rounded))
                            .foregroundStyle(vm.selectedLanguage == code ? .black : JarvisPalette.secondaryText)
                            .padding(.horizontal, 14).padding(.vertical, 7)
                            .background(Capsule().fill(vm.selectedLanguage == code ? JarvisPalette.cyan : Color.white.opacity(0.08)))
                    }
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
        }
    }

    private var tabBar: some View {
        HStack(spacing: 0) {
            ForEach(LanguageTab.allCases, id: \.self) { tab in
                Button { vm.selectedTab = tab } label: {
                    VStack(spacing: 4) {
                        Text(tab.rawValue)
                            .font(.system(size: 13, weight: vm.selectedTab == tab ? .semibold : .regular, design: .rounded))
                            .foregroundStyle(vm.selectedTab == tab ? .white : JarvisPalette.subtleText)
                        Rectangle()
                            .fill(vm.selectedTab == tab ? JarvisPalette.cyan : .clear)
                            .frame(height: 2)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                }
            }
        }
        .background(Color.white.opacity(0.03))
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.white.opacity(0.08)).frame(height: 1)
        }
    }

    // MARK: - Practice

    private var practiceContent: some View {
        VStack(spacing: 16) {
            if let d = vm.dashboard {
                progressSection(d)
                if !d.daily_focus_words.isEmpty {
                    focusWordsSection(d.daily_focus_words)
                }
                if !d.daily_prompts.isEmpty {
                    promptsSection(d.daily_prompts)
                }
            } else {
                emptyState("No data loaded.")
            }
        }
    }

    private func progressSection(_ d: LanguageDashboardResponse) -> some View {
        let lp = vm.selectedLanguageProgress
        let todayMins = lp?.today_minutes ?? d.progress.today_minutes
        let totalMins = lp?.total_minutes ?? d.progress.minutes_practiced
        let wordCount = lp?.words_count ?? d.progress.vocab_count
        let dueCount = lp?.due_reviews ?? d.progress.due_reviews

        return VStack(alignment: .leading, spacing: 14) {
            sectionHeader("Progress")
            HStack(spacing: 12) {
                statTile("\(todayMins)", "min today", JarvisPalette.cyan)
                statTile("\(totalMins)", "total min", Color.white.opacity(0.6))
                statTile("\(wordCount)", "words", Color.green.opacity(0.8))
                statTile("\(dueCount)", "due", dueCount > 0 ? Color.orange : Color.white.opacity(0.4))
            }
        }
    }

    private func statTile(_ value: String, _ label: String, _ color: Color) -> some View {
        VStack(spacing: 3) {
            Text(value)
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .foregroundStyle(color)
            Text(label)
                .font(.system(size: 10, weight: .medium, design: .rounded))
                .foregroundStyle(JarvisPalette.subtleText)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.06)))
    }

    private func focusWordsSection(_ words: [LanguageVocabItem]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader("Today's focus words")
            VStack(spacing: 0) {
                ForEach(words) { word in
                    HStack(alignment: .center, spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(word.phrase)
                                .font(.system(size: 16, weight: .semibold, design: .rounded))
                                .foregroundStyle(.white)
                            if !word.pronunciation.isEmpty {
                                Text(word.pronunciation)
                                    .font(.system(size: 12, design: .rounded))
                                    .foregroundStyle(JarvisPalette.cyan.opacity(0.8))
                            }
                            if !word.translation.isEmpty {
                                Text(word.translation)
                                    .font(.system(size: 13, design: .rounded))
                                    .foregroundStyle(JarvisPalette.secondaryText)
                            }
                        }
                        Spacer()
                        HStack(spacing: 10) {
                            reviewButton(vocabId: word.id, remembered: true)
                            reviewButton(vocabId: word.id, remembered: false)
                        }
                    }
                    .padding(.vertical, 12)
                    .padding(.horizontal, 16)
                    if word.id != words.last?.id {
                        Divider().background(Color.white.opacity(0.07)).padding(.horizontal, 16)
                    }
                }
            }
            .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.06)))
        }
    }

    private func reviewButton(vocabId: String, remembered: Bool) -> some View {
        Button {
            Task { await vm.reviewVocab(baseURL: hk.selectedBaseURL, vocabId: vocabId, remembered: remembered) }
        } label: {
            Image(systemName: remembered ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(.system(size: 24))
                .foregroundStyle(remembered ? Color.green.opacity(0.75) : Color.red.opacity(0.6))
        }
    }

    private func promptsSection(_ prompts: [LanguagePracticePrompt]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader("Daily prompts")
            VStack(spacing: 10) {
                ForEach(prompts) { p in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 8) {
                            modeBadge(p.mode)
                            Text(p.title)
                                .font(.system(size: 14, weight: .semibold, design: .rounded))
                                .foregroundStyle(.white)
                                .lineLimit(1)
                        }
                        Text(p.prompt)
                            .font(.system(size: 13, design: .rounded))
                            .foregroundStyle(JarvisPalette.secondaryText)
                        if !p.target_phrase.isEmpty {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(p.target_phrase)
                                    .font(.system(size: 15, weight: .bold, design: .rounded))
                                    .foregroundStyle(JarvisPalette.cyan)
                                if !p.romanization.isEmpty {
                                    Text(p.romanization)
                                        .font(.system(size: 12, design: .rounded))
                                        .foregroundStyle(JarvisPalette.subtleText)
                                }
                                if !p.translation.isEmpty {
                                    Text(p.translation)
                                        .font(.system(size: 12, design: .rounded))
                                        .foregroundStyle(JarvisPalette.subtleText).italic()
                                }
                            }
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 10).fill(JarvisPalette.cyan.opacity(0.07)))
                        }
                        if p.mode == "writing" {
                            Button {
                                vm.writingPromptText = p.prompt
                                vm.selectedTab = .log
                            } label: {
                                Text("Practice this →")
                                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                                    .foregroundStyle(JarvisPalette.cyan)
                            }
                        }
                    }
                    .padding(14)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.05)))
                }
            }
        }
    }

    // MARK: - Vocab

    private var vocabContent: some View {
        VStack(spacing: 20) {
            let vocab = vm.filteredVocab
            if !vocab.isEmpty {
                reviewBanner(vocab.count)
            }
            addVocabSection
            if !vocab.isEmpty {
                vocabListSection(vocab)
            } else if vm.dashboard != nil {
                emptyState("No words saved for \(vm.languageName(vm.selectedLanguage)) yet.")
            }
        }
    }

    private func reviewBanner(_ count: Int) -> some View {
        let dueCount = vm.reviewDeck.count
        return Button { showFlashcards = true } label: {
            HStack(spacing: 14) {
                ZStack {
                    Circle().fill(JarvisPalette.cyan.opacity(0.18)).frame(width: 46, height: 46)
                    Image(systemName: "rectangle.on.rectangle.angled")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(JarvisPalette.cyan)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Flashcard review")
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                    Text(dueCount == count
                         ? "\(count) words"
                         : "\(dueCount) due · \(count) total")
                        .font(.system(size: 12, design: .rounded))
                        .foregroundStyle(JarvisPalette.secondaryText)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(JarvisPalette.subtleText)
            }
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.07)))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(JarvisPalette.cyan.opacity(0.25), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private var addVocabSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader("Add word")
            VStack(spacing: 10) {
                inputField("Phrase in \(vm.languageName(vm.selectedLanguage))", text: $vm.newPhrase)
                inputField("English translation", text: $vm.newTranslation)
                inputField("Pronunciation (optional)", text: $vm.newPronunciation)
            }
            primaryButton("Save word", loading: vm.addingVocab, disabled: vm.newPhrase.isEmpty) {
                Task { await vm.addVocab(baseURL: hk.selectedBaseURL) }
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.06)))
    }

    private func vocabListSection(_ vocab: [LanguageVocabItem]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader("\(vocab.count) saved words")
            VStack(spacing: 0) {
                ForEach(vocab) { word in
                    HStack(alignment: .center, spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(word.phrase)
                                .font(.system(size: 15, weight: .semibold, design: .rounded))
                                .foregroundStyle(.white)
                            if !word.pronunciation.isEmpty {
                                Text(word.pronunciation)
                                    .font(.system(size: 12, design: .rounded))
                                    .foregroundStyle(JarvisPalette.cyan.opacity(0.7))
                            }
                            if !word.translation.isEmpty {
                                Text(word.translation)
                                    .font(.system(size: 13, design: .rounded))
                                    .foregroundStyle(JarvisPalette.secondaryText)
                            }
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 6) {
                            Text("×\(word.review_count)")
                                .font(.system(size: 11, weight: .medium, design: .rounded))
                                .foregroundStyle(JarvisPalette.subtleText)
                            Button {
                                Task { await vm.deleteVocab(baseURL: hk.selectedBaseURL, vocabId: word.id) }
                            } label: {
                                Image(systemName: "trash")
                                    .font(.system(size: 13))
                                    .foregroundStyle(Color.red.opacity(0.5))
                            }
                        }
                    }
                    .padding(.vertical, 12).padding(.horizontal, 16)
                    if word.id != vocab.last?.id {
                        Divider().background(Color.white.opacity(0.07)).padding(.horizontal, 16)
                    }
                }
            }
            .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.06)))
        }
    }

    // MARK: - Conversation

    private var convoContent: some View {
        VStack(spacing: 0) {
            convoHeader
            convoMessages
            convoInputBar
        }
        .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.07), lineWidth: 1))
    }

    private var convoHeader: some View {
        HStack {
            Text("Practicing \(vm.languageName(vm.selectedLanguage))")
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .foregroundStyle(JarvisPalette.subtleText)
            Spacer()
            if !vm.convoMessages.isEmpty {
                Button {
                    vm.convoMessages = []
                    vm.lastConvoResponse = nil
                } label: {
                    Text("Clear")
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(JarvisPalette.subtleText)
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.white.opacity(0.07)).frame(height: 1)
        }
    }

    private var convoMessages: some View {
        ScrollViewReader { proxy in
            ScrollView(showsIndicators: false) {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if vm.convoMessages.isEmpty {
                        VStack(spacing: 10) {
                            Image(systemName: "character.bubble.fill")
                                .font(.system(size: 36))
                                .foregroundStyle(JarvisPalette.cyan.opacity(0.4))
                            Text("Start speaking in \(vm.languageName(vm.selectedLanguage))")
                                .font(.system(size: 14, design: .rounded))
                                .foregroundStyle(JarvisPalette.subtleText)
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 50)
                    }
                    ForEach(Array(vm.convoMessages.enumerated()), id: \.offset) { _, msg in
                        convoBubble(msg)
                    }
                    if let resp = vm.lastConvoResponse,
                       !resp.reply_romanization.isEmpty || !resp.translation.isEmpty || !resp.correction.isEmpty {
                        convoMetaCard(resp)
                    }
                    if vm.convoLoading {
                        typingDots.padding(.horizontal, 4)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(14)
            }
            .frame(minHeight: 260)
            .onChange(of: vm.convoMessages.count) { _, _ in
                withAnimation { proxy.scrollTo("bottom") }
            }
        }
    }

    @ViewBuilder
    private func convoBubble(_ msg: LanguageConversationMessage) -> some View {
        HStack {
            if msg.role == "user" { Spacer(minLength: 44) }
            Text(msg.content)
                .font(.system(size: 14, design: .rounded))
                .foregroundStyle(msg.role == "user" ? .white : JarvisPalette.secondaryText)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(msg.role == "user" ? JarvisPalette.cyan.opacity(0.22) : Color.white.opacity(0.08)))
                .fixedSize(horizontal: false, vertical: true)
            if msg.role == "assistant" { Spacer(minLength: 44) }
        }
    }

    private func convoMetaCard(_ resp: LanguageConversationResponse) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if !resp.reply_romanization.isEmpty {
                Text(resp.reply_romanization)
                    .font(.system(size: 12, design: .rounded))
                    .foregroundStyle(JarvisPalette.cyan.opacity(0.7)).italic()
            }
            if !resp.translation.isEmpty {
                Text("\"\(resp.translation)\"")
                    .font(.system(size: 12, design: .rounded))
                    .foregroundStyle(JarvisPalette.subtleText)
            }
            if !resp.correction.isEmpty {
                HStack(alignment: .top, spacing: 5) {
                    Image(systemName: "lightbulb.fill").font(.system(size: 11)).foregroundStyle(.yellow.opacity(0.9))
                    Text(resp.correction).font(.system(size: 12, design: .rounded)).foregroundStyle(.yellow.opacity(0.9))
                }
            }
            if !resp.suggested_user_reply.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("You could say:")
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundStyle(JarvisPalette.subtleText)
                    Text(resp.suggested_user_reply)
                        .font(.system(size: 13, design: .rounded))
                        .foregroundStyle(JarvisPalette.secondaryText)
                    if !resp.suggested_user_reply_romanization.isEmpty {
                        Text(resp.suggested_user_reply_romanization)
                            .font(.system(size: 11, design: .rounded))
                            .foregroundStyle(JarvisPalette.subtleText).italic()
                    }
                }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(JarvisPalette.cyan.opacity(0.07)))
    }

    private var convoInputBar: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Color.white.opacity(0.07)).frame(height: 1)
            HStack(spacing: 8) {
                TextField("Say something…", text: $vm.convoInput, axis: .vertical)
                    .lineLimit(1...4)
                    .font(.system(size: 14, design: .rounded))
                    .foregroundStyle(.white).tint(JarvisPalette.cyan)
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 20).fill(Color.white.opacity(0.07)))
                    .focused($convoFocused)
                Button {
                    Task { await vm.sendConversationMessage(baseURL: hk.selectedBaseURL) }
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 30))
                        .foregroundStyle(vm.convoInput.trimmingCharacters(in: .whitespaces).isEmpty || vm.convoLoading
                                         ? JarvisPalette.subtleText : JarvisPalette.cyan)
                }
                .disabled(vm.convoInput.trimmingCharacters(in: .whitespaces).isEmpty || vm.convoLoading)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
        }
    }

    // MARK: - Log

    private var logContent: some View {
        VStack(spacing: 20) {
            logSessionSection
            writingSection
            if let d = vm.dashboard, !d.recent_sessions.isEmpty {
                recentSessionsSection(d.recent_sessions)
            }
        }
    }

    private var logSessionSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader("Log session")
            VStack(spacing: 10) {
                Picker("Mode", selection: $vm.sessionMode) {
                    ForEach(vm.sessionModes, id: \.self) { m in Text(m.capitalized).tag(m) }
                }
                .pickerStyle(.menu).tint(JarvisPalette.cyan)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.07)))

                inputField("Minutes", text: $vm.sessionMinutes).keyboardType(.numberPad)
                inputField("Notes (optional)", text: $vm.sessionNotes)
            }
            primaryButton("Log session", loading: vm.loggingSession, disabled: vm.sessionMinutes.isEmpty) {
                Task { await vm.logSession(baseURL: hk.selectedBaseURL) }
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.06)))
    }

    private var writingSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader("Writing practice")
            if !vm.writingPromptText.isEmpty {
                Text(vm.writingPromptText)
                    .font(.system(size: 13, design: .rounded))
                    .foregroundStyle(JarvisPalette.secondaryText)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 10).fill(JarvisPalette.cyan.opacity(0.07)))
            }
            TextField("Write your response in \(vm.languageName(vm.selectedLanguage))…",
                      text: $vm.writingResponse, axis: .vertical)
                .lineLimit(3...8)
                .font(.system(size: 14, design: .rounded))
                .foregroundStyle(.white).tint(JarvisPalette.cyan)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.07)))
            primaryButton("Get feedback", loading: vm.writingLoading, disabled: vm.writingResponse.isEmpty) {
                Task { await vm.submitWriting(baseURL: hk.selectedBaseURL) }
            }
            if let fb = vm.writingFeedback {
                writingFeedbackView(fb)
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.06)))
    }

    private func writingFeedbackView(_ fb: LanguageFeedbackResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Score: \(fb.score)/10")
                    .font(.system(size: 16, weight: .bold, design: .rounded))
                    .foregroundStyle(fb.score >= 7 ? .green : fb.score >= 4 ? .orange : .red)
                Spacer()
            }
            if !fb.corrected_text.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Corrected").font(.system(size: 11, weight: .semibold, design: .rounded)).foregroundStyle(JarvisPalette.subtleText)
                    Text(fb.corrected_text).font(.system(size: 13, design: .rounded)).foregroundStyle(JarvisPalette.secondaryText)
                }
            }
            if !fb.feedback.isEmpty {
                Text(fb.feedback).font(.system(size: 13, design: .rounded)).foregroundStyle(JarvisPalette.secondaryText)
            }
            if !fb.strengths.isEmpty { bulletList("Strengths", fb.strengths, .green) }
            if !fb.fixes.isEmpty { bulletList("Fixes", fb.fixes, .orange) }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.05)))
    }

    private func recentSessionsSection(_ sessions: [LanguagePracticeSession]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader("Recent sessions")
            VStack(spacing: 0) {
                ForEach(sessions.prefix(6)) { s in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                modeBadge(s.mode)
                                Text(vm.languageName(s.language))
                                    .font(.system(size: 12, design: .rounded))
                                    .foregroundStyle(JarvisPalette.subtleText)
                            }
                            if !s.notes.isEmpty {
                                Text(s.notes)
                                    .font(.system(size: 12, design: .rounded))
                                    .foregroundStyle(JarvisPalette.subtleText).lineLimit(1)
                            }
                        }
                        Spacer()
                        Text("\(s.minutes) min")
                            .font(.system(size: 13, weight: .medium, design: .rounded))
                            .foregroundStyle(JarvisPalette.secondaryText)
                    }
                    .padding(.vertical, 10).padding(.horizontal, 16)
                    if s.id != sessions.prefix(6).last?.id {
                        Divider().background(Color.white.opacity(0.07)).padding(.horizontal, 16)
                    }
                }
            }
            .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.06)))
        }
    }

    // MARK: - Shared components

    private var typingDots: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { i in
                Circle().fill(JarvisPalette.cyan.opacity(0.7)).frame(width: 6, height: 6)
                    .animation(.easeInOut(duration: 0.6).repeatForever().delay(Double(i) * 0.2), value: vm.convoLoading)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.07)))
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.system(size: 11, weight: .semibold, design: .rounded))
            .foregroundStyle(JarvisPalette.subtleText)
            .tracking(0.8)
    }

    private func modeBadge(_ mode: String) -> some View {
        Text(mode.capitalized)
            .font(.system(size: 10, weight: .bold, design: .rounded))
            .foregroundStyle(JarvisPalette.cyan)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(Capsule().fill(JarvisPalette.cyan.opacity(0.12)))
    }

    private func inputField(_ placeholder: String, text: Binding<String>) -> some View {
        TextField(placeholder, text: text)
            .font(.system(size: 14, design: .rounded))
            .foregroundStyle(.white).tint(JarvisPalette.cyan)
            .padding(.horizontal, 12).padding(.vertical, 11)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.07)))
    }

    private func primaryButton(_ label: String, loading: Bool, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if loading { ProgressView().scaleEffect(0.8).tint(.black) }
                Text(label)
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(.black)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 13)
            .background(Capsule().fill(disabled ? JarvisPalette.cyan.opacity(0.35) : JarvisPalette.cyan))
        }
        .disabled(disabled || loading)
    }

    private func bulletList(_ title: String, _ items: [String], _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 11, weight: .semibold, design: .rounded)).foregroundStyle(JarvisPalette.subtleText)
            ForEach(items, id: \.self) { item in
                HStack(alignment: .top, spacing: 6) {
                    Text("•").foregroundStyle(color)
                    Text(item).font(.system(size: 12, design: .rounded)).foregroundStyle(JarvisPalette.secondaryText)
                }
            }
        }
    }

    private func emptyState(_ message: String) -> some View {
        Text(message)
            .font(.system(size: 14, design: .rounded))
            .foregroundStyle(JarvisPalette.subtleText)
            .frame(maxWidth: .infinity).padding(20)
            .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.04)))
    }
}

// MARK: - Flashcard session

struct FlashcardSessionView: View {
    let deck: [LanguageVocabItem]
    let languageName: String
    let onReview: (String, Bool) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var currentIndex = 0
    @State private var isFlipped = false
    @State private var flipDegrees = 0.0
    @State private var remembered: [String: Bool] = [:]
    @State private var isDone = false

    private var current: LanguageVocabItem? { deck.indices.contains(currentIndex) ? deck[currentIndex] : nil }
    private var progress: Double { deck.isEmpty ? 1 : Double(currentIndex) / Double(deck.count) }

    var body: some View {
        ZStack {
            JarvisPalette.background.ignoresSafeArea()
            if isDone {
                summaryView
            } else if let card = current {
                VStack(spacing: 0) {
                    // Header
                    HStack {
                        Button { dismiss() } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(JarvisPalette.subtleText)
                                .padding(10)
                                .background(Circle().fill(Color.white.opacity(0.08)))
                        }
                        Spacer()
                        Text("\(currentIndex + 1) / \(deck.count)")
                            .font(.system(size: 14, weight: .medium, design: .rounded))
                            .foregroundStyle(JarvisPalette.subtleText)
                        Spacer()
                        // Balance the X button
                        Color.clear.frame(width: 36, height: 36)
                    }
                    .padding(.horizontal, 20).padding(.top, 16)

                    // Progress bar
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.white.opacity(0.08)).frame(height: 4)
                            Capsule().fill(JarvisPalette.cyan)
                                .frame(width: geo.size.width * progress, height: 4)
                                .animation(.easeInOut(duration: 0.3), value: progress)
                        }
                    }
                    .frame(height: 4)
                    .padding(.horizontal, 20).padding(.top, 14)

                    Spacer()

                    // Card
                    ZStack {
                        frontFace(card)
                            .opacity(isFlipped ? 0 : 1)
                            .rotation3DEffect(.degrees(flipDegrees), axis: (x: 0, y: 1, z: 0))

                        backFace(card)
                            .opacity(isFlipped ? 1 : 0)
                            .rotation3DEffect(.degrees(flipDegrees - 180), axis: (x: 0, y: 1, z: 0))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 24)
                    .onTapGesture { flipCard() }

                    Spacer()

                    // Action buttons — only shown after flip
                    if isFlipped {
                        HStack(spacing: 20) {
                            actionButton(label: "Forgot", icon: "xmark", color: .red) {
                                advance(remembered: false, for: card)
                            }
                            actionButton(label: "Got it", icon: "checkmark", color: .green) {
                                advance(remembered: true, for: card)
                            }
                        }
                        .padding(.horizontal, 32)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                    } else {
                        Button { flipCard() } label: {
                            Text("Tap to reveal")
                                .font(.system(size: 15, weight: .medium, design: .rounded))
                                .foregroundStyle(JarvisPalette.subtleText)
                                .padding(.horizontal, 24).padding(.vertical, 13)
                                .background(Capsule().fill(Color.white.opacity(0.07)))
                        }
                        .transition(.opacity)
                    }

                    Spacer().frame(height: 40)
                }
            }
        }
    }

    private func frontFace(_ card: LanguageVocabItem) -> some View {
        VStack(spacing: 16) {
            Text(languageName.uppercased())
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(JarvisPalette.cyan.opacity(0.7))
                .tracking(1)
            Text(card.phrase)
                .font(.system(size: 36, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
            if !card.pronunciation.isEmpty {
                Text(card.pronunciation)
                    .font(.system(size: 16, design: .rounded))
                    .foregroundStyle(JarvisPalette.cyan.opacity(0.8))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(32)
        .background(RoundedRectangle(cornerRadius: 24).fill(Color.white.opacity(0.07)))
        .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(Color.white.opacity(0.1), lineWidth: 1))
        .frame(minHeight: 220)
    }

    private func backFace(_ card: LanguageVocabItem) -> some View {
        VStack(spacing: 16) {
            Text("TRANSLATION")
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(JarvisPalette.subtleText)
                .tracking(1)
            Text(card.translation.isEmpty ? "—" : card.translation)
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
            if !card.pronunciation.isEmpty {
                Text(card.pronunciation)
                    .font(.system(size: 15, design: .rounded))
                    .foregroundStyle(JarvisPalette.cyan.opacity(0.7))
            }
            if !card.notes.isEmpty {
                Text(card.notes)
                    .font(.system(size: 13, design: .rounded))
                    .foregroundStyle(JarvisPalette.secondaryText)
                    .multilineTextAlignment(.center)
                    .padding(.top, 4)
            }
            if !card.tags.isEmpty {
                HStack(spacing: 6) {
                    ForEach(card.tags, id: \.self) { tag in
                        Text(tag)
                            .font(.system(size: 11, weight: .medium, design: .rounded))
                            .foregroundStyle(JarvisPalette.cyan)
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Capsule().fill(JarvisPalette.cyan.opacity(0.12)))
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(32)
        .background(RoundedRectangle(cornerRadius: 24).fill(JarvisPalette.cyan.opacity(0.09)))
        .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(JarvisPalette.cyan.opacity(0.2), lineWidth: 1))
        .frame(minHeight: 220)
    }

    private func actionButton(label: String, icon: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                ZStack {
                    Circle().fill(color.opacity(0.15)).frame(width: 56, height: 56)
                    Image(systemName: icon)
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(color)
                }
                Text(label)
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(color.opacity(0.9))
            }
            .frame(maxWidth: .infinity)
        }
    }

    private var summaryView: some View {
        VStack(spacing: 28) {
            Spacer()
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 60))
                .foregroundStyle(JarvisPalette.cyan)

            VStack(spacing: 8) {
                Text("Session complete!")
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                Text("\(deck.count) cards reviewed")
                    .font(.system(size: 15, design: .rounded))
                    .foregroundStyle(JarvisPalette.secondaryText)
            }

            HStack(spacing: 24) {
                let gotIt = remembered.values.filter { $0 }.count
                let forgot = remembered.values.filter { !$0 }.count
                summaryTile("\(gotIt)", "Got it", .green)
                summaryTile("\(forgot)", "Forgot", .red)
            }

            Spacer()

            Button { dismiss() } label: {
                Text("Done")
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                    .foregroundStyle(.black)
                    .frame(maxWidth: .infinity).padding(.vertical, 15)
                    .background(Capsule().fill(JarvisPalette.cyan))
            }
            .padding(.horizontal, 32)
            .padding(.bottom, 40)
        }
    }

    private func summaryTile(_ value: String, _ label: String, _ color: Color) -> some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.system(size: 36, weight: .bold, design: .rounded))
                .foregroundStyle(color)
            Text(label)
                .font(.system(size: 13, design: .rounded))
                .foregroundStyle(JarvisPalette.subtleText)
        }
        .frame(width: 110)
        .padding(.vertical, 20)
        .background(RoundedRectangle(cornerRadius: 16).fill(color.opacity(0.1)))
    }

    private func flipCard() {
        withAnimation(.easeInOut(duration: 0.35)) {
            flipDegrees += 180
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.175) {
            isFlipped.toggle()
        }
    }

    private func advance(remembered rem: Bool, for card: LanguageVocabItem) {
        remembered[card.id] = rem
        onReview(card.id, rem)

        let next = currentIndex + 1
        if next >= deck.count {
            withAnimation { isDone = true }
        } else {
            withAnimation(.easeInOut(duration: 0.2)) {
                flipDegrees = 0
                isFlipped = false
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                currentIndex = next
            }
        }
    }
}
