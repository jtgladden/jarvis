import SwiftUI
import Photos
import PhotosUI
import VisionKit
import Speech
import AVFoundation

// MARK: - Dictation

@MainActor
final class DictationManager: ObservableObject {
    @Published var isRecording = false
    @Published var activeField: String? = nil
    @Published var error: String? = nil

    private let recognizer = SFSpeechRecognizer(locale: .current)
    private var audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var tapInstalled = false

    func toggle(field: String, currentText: String, onUpdate: @escaping (String) -> Void) {
        if isRecording && activeField == field {
            stop()
        } else {
            if isRecording { stop() }
            activeField = field
            requestAuthAndStart(baseText: currentText, onUpdate: onUpdate)
        }
    }

    private func requestAuthAndStart(baseText: String, onUpdate: @escaping (String) -> Void) {
        SFSpeechRecognizer.requestAuthorization { status in
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard status == .authorized else {
                    self.error = "Speech recognition not authorized. Enable it in Settings > Privacy."
                    return
                }
                do { try self.startEngine(baseText: baseText, onUpdate: onUpdate) }
                catch { self.error = "Microphone error: \(error.localizedDescription)" }
            }
        }
    }

    private func startEngine(baseText: String, onUpdate: @escaping (String) -> Void) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        request = SFSpeechAudioBufferRecognitionRequest()
        guard let req = request else { return }
        req.shouldReportPartialResults = true
        if #available(iOS 16, *) { req.addsPunctuation = true }

        let inputNode = audioEngine.inputNode
        task = recognizer?.recognitionTask(with: req) { [weak self] result, err in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let result {
                    let spoken = result.bestTranscription.formattedString
                    onUpdate(baseText.isEmpty ? spoken : baseText + " " + spoken)
                }
                if err != nil || result?.isFinal == true { self.stop() }
            }
        }

        let fmt = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: fmt) { buf, _ in req.append(buf) }
        tapInstalled = true
        audioEngine.prepare()
        try audioEngine.start()
        isRecording = true
        error = nil
    }

    func stop() {
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        audioEngine.stop()
        request?.endAudio()
        request = nil
        task?.cancel()
        task = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        isRecording = false
        activeField = nil
    }
}

// MARK: - Scan types

struct ScanEntry: Identifiable {
    let id = UUID()
    var date: Date
    var dateDetected: Bool
    var text: String
    var skip: Bool = false
}

enum ScanTarget: String, CaseIterable, Identifiable {
    case scripture = "Scripture Study"
    case journal   = "Journal Entry"

    var id: String { rawValue }
    var icon: String {
        switch self {
        case .scripture: return "book.closed.fill"
        case .journal:   return "pencil.line"
        }
    }
}

// MARK: - ViewModel

@MainActor
final class JournalViewModel: ObservableObject {
    @Published var entry: JournalDayEntry?
    @Published var isLoading = false
    @Published var isSaving = false
    @Published var error: String?
    @Published var selectedDate = Date()
    /// True when the last load(day) failed. Saving is blocked while set: the
    /// text fields are cleared on a failed load (so the previous day's text is
    /// never attributed to this one), and journal prose now lives in the
    /// journal-api service, where a save of those empty fields would replace
    /// the real entry rather than merge with it.
    @Published var loadFailed = false

    @Published var journalText = ""
    @Published var gratitudeText = ""
    @Published var accomplishmentsText = ""
    @Published var scriptureText = ""
    @Published var spiritualText = ""

    @Published var photoOfTheDay: UIImage? = nil
    @Published var photoAssetId: String? = nil

    @Published var isExtracting = false
    @Published var extractError: String?
    @Published var pendingEntries: [ScanEntry] = []
    @Published var showScanConfirmation = false
    @Published var isSavingEntries = false

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
        photoOfTheDay = nil; photoAssetId = nil
        do {
            let e = try await JarvisAPIClient.getJournalEntry(baseURL: baseURL, date: isoDate)
            populateFields(from: e)
            loadFailed = false
        } catch {
            // Clear the fields so the previously-loaded day's text can't be
            // saved onto this date, and flag the failure so save() refuses --
            // writing these empties would erase the day's real entry.
            entry = nil
            journalText = ""; gratitudeText = ""; accomplishmentsText = ""
            scriptureText = ""; spiritualText = ""
            loadFailed = true
            self.error = "Couldn't load this day (\(error.localizedDescription)). Saving is disabled until it loads."
        }
        await loadPhotoOfTheDay()
        isLoading = false
    }

    func save(baseURL: String) async {
        guard !loadFailed else {
            error = "Not saving: this day never loaded, so saving would overwrite it with empty text."
            return
        }
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

    private func loadPhotoOfTheDay() async {
        guard PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized ||
              PHPhotoLibrary.authorizationStatus(for: .readWrite) == .limited else { return }

        let calendar = Calendar.current
        guard let start = calendar.date(bySettingHour: 0, minute: 0, second: 0, of: selectedDate),
              let end   = calendar.date(bySettingHour: 23, minute: 59, second: 59, of: selectedDate) else { return }

        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.predicate = NSPredicate(format: "creationDate >= %@ AND creationDate <= %@",
                                        start as NSDate, end as NSDate)
        options.fetchLimit = 1

        let result = PHAsset.fetchAssets(with: .image, options: options)
        guard let asset = result.firstObject else { return }
        photoAssetId = asset.localIdentifier

        let manager = PHImageManager.default()
        let reqOptions = PHImageRequestOptions()
        reqOptions.deliveryMode = .opportunistic
        reqOptions.isNetworkAccessAllowed = true
        reqOptions.isSynchronous = false

        await withCheckedContinuation { continuation in
            manager.requestImage(for: asset,
                                 targetSize: CGSize(width: 800, height: 600),
                                 contentMode: .aspectFill,
                                 options: reqOptions) { [weak self] image, _ in
                Task { @MainActor in self?.photoOfTheDay = image }
                continuation.resume()
            }
        }
    }

    func extractFromImage(baseURL: String, image: UIImage, scanTarget: ScanTarget) async {
        guard let jpeg = image.jpegData(compressionQuality: 0.85) else {
            extractError = "Could not encode image."; return
        }
        isExtracting = true; extractError = nil
        let b64 = jpeg.base64EncodedString()
        let isoFmt: DateFormatter = {
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd"
            f.locale = Locale(identifier: "en_US_POSIX")
            return f
        }()
        do {
            let result = try await JarvisAPIClient.extractJournalFromImage(
                baseURL: baseURL, imageBase64: b64, mediaType: "image/jpeg",
                scanTarget: scanTarget == .scripture ? "scripture" : "journal")
            pendingEntries = result.entries.compactMap { e in
                guard !e.text.isEmpty else { return nil }
                let date: Date
                let detected: Bool
                if let ds = e.detected_date, let parsed = isoFmt.date(from: ds) {
                    date = parsed; detected = true
                } else {
                    date = selectedDate; detected = false
                }
                return ScanEntry(date: date, dateDetected: detected, text: e.text)
            }
            if !pendingEntries.isEmpty { showScanConfirmation = true }
            else { extractError = "No text could be extracted from the image." }
        } catch {
            extractError = "Scan failed: \(error.localizedDescription)"
        }
        isExtracting = false
    }

    func savePendingEntries(baseURL: String, scanTarget: ScanTarget) async {
        isSavingEntries = true; extractError = nil
        let toSave = pendingEntries.filter { !$0.skip }
        let isoFmt: DateFormatter = {
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd"
            f.locale = Locale(identifier: "en_US_POSIX")
            return f
        }()
        var errors: [String] = []
        for entry in toSave {
            let dateStr = isoFmt.string(from: entry.date)
            do {
                // The save replaces BOTH sections, so the untouched one has to be
                // carried over from the stored entry. A failed read must abort this
                // date -- substituting "" would erase the section we aren't scanning.
                let existing: JournalDayEntry
                do {
                    existing = try await JarvisAPIClient.getJournalEntry(baseURL: baseURL, date: dateStr)
                } catch {
                    errors.append("\(dateStr): couldn't read the existing entry, so it was skipped rather than risk overwriting it")
                    continue
                }
                let scripture = scanTarget == .scripture ? entry.text : existing.scripture_study
                let journal   = scanTarget == .journal   ? entry.text : existing.journal_entry
                _ = try await JarvisAPIClient.saveJournalEntry(
                    baseURL: baseURL, date: dateStr,
                    journalEntry: journal,
                    accomplishments: existing.accomplishments,
                    gratitudeEntry: existing.gratitude_entry,
                    scriptureStudy: scripture,
                    spiritualNotes: existing.spiritual_notes)
            } catch {
                errors.append("\(dateStr): \(error.localizedDescription)")
            }
        }
        if !errors.isEmpty { extractError = "Some entries failed: \(errors.joined(separator: "; "))" }
        pendingEntries = []
        showScanConfirmation = false
        isSavingEntries = false
        await load(baseURL: baseURL)
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

// MARK: - Document scanner wrapper

struct DocumentScannerView: UIViewControllerRepresentable {
    let onScanned: (UIImage) -> Void
    let onDismiss: () -> Void

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let vc = VNDocumentCameraViewController()
        vc.delegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ uiViewController: VNDocumentCameraViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(onScanned: onScanned, onDismiss: onDismiss) }

    class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let onScanned: (UIImage) -> Void
        let onDismiss: () -> Void
        init(onScanned: @escaping (UIImage) -> Void, onDismiss: @escaping () -> Void) {
            self.onScanned = onScanned; self.onDismiss = onDismiss
        }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController,
                                          didFinishWith scan: VNDocumentCameraScan) {
            let images = (0..<scan.pageCount).map { scan.imageOfPage(at: $0) }
            onScanned(combineVertically(images))
        }
        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) { onDismiss() }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) { onDismiss() }

        private func combineVertically(_ images: [UIImage]) -> UIImage {
            guard !images.isEmpty else { return UIImage() }
            guard images.count > 1 else { return images[0] }
            let width  = images.map { $0.size.width  }.max() ?? 0
            let height = images.map { $0.size.height }.reduce(0, +)
            let format = UIGraphicsImageRendererFormat()
            format.scale = images[0].scale
            return UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { _ in
                var y: CGFloat = 0
                for img in images {
                    img.draw(in: CGRect(x: 0, y: y, width: img.size.width, height: img.size.height))
                    y += img.size.height
                }
            }
        }
    }
}

// MARK: - View

struct JournalView: View {
    @EnvironmentObject private var hk: HealthKitManager
    @StateObject private var vm = JournalViewModel()
    @StateObject private var dictation = DictationManager()
    @State private var showContext = false

    @State private var showScanSheet  = false
    @State private var scanTarget: ScanTarget = .journal
    @State private var showDocScanner = false
    @State private var scanPickerItem: PhotosPickerItem?
    @State private var showDatePicker = false
    @State private var pickerDate     = Date()

    var body: some View {
        NavigationStack {
            ZStack {
                JarvisPalette.background.ignoresSafeArea()
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 0) {
                        photoHeader
                        VStack(spacing: 14) {
                            dateNavBar
                            if vm.isLoading {
                                ProgressView().tint(JarvisPalette.cyan)
                                    .frame(maxWidth: .infinity)
                                    .padding(.top, 60)
                            } else {
                                scriptureCard
                                journalCard
                            }
                            if vm.isExtracting {
                                extractingBanner
                            }
                            if let err = vm.extractError {
                                inlineBanner(err, color: JarvisPalette.orange, icon: "exclamationmark.triangle.fill")
                            }
                            if let err = vm.error {
                                inlineBanner(err, color: Color.red, icon: "exclamationmark.circle.fill")
                            }
                            if !vm.isLoading {
                                saveButton
                            }
                        }
                        .padding(.horizontal, 18)
                        .padding(.top, 8)
                        .padding(.bottom, 48)
                    }
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .navigationTitle("Journal")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") {
                        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder),
                                                        to: nil, from: nil, for: nil)
                    }
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(JarvisPalette.cyan)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showScanSheet = true } label: {
                        if vm.isExtracting {
                            ProgressView().tint(JarvisPalette.cyan)
                        } else {
                            Image(systemName: "doc.viewfinder")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(JarvisPalette.cyan)
                        }
                    }
                    .disabled(vm.isExtracting)
                }
            }
            .sheet(isPresented: $showScanSheet) { scanOptionsSheet }
            .sheet(isPresented: $vm.showScanConfirmation) { scanConfirmationSheet }
            .fullScreenCover(isPresented: $showDocScanner) {
                DocumentScannerView(
                    onScanned: { image in
                        showDocScanner = false
                        let target = scanTarget
                        Task { await vm.extractFromImage(baseURL: hk.selectedBaseURL, image: image, scanTarget: target) }
                    },
                    onDismiss: { showDocScanner = false }
                )
                .ignoresSafeArea()
            }
            .onChange(of: scanPickerItem) { _, newItem in
                guard let newItem else { return }
                let target = scanTarget
                Task {
                    if let data = try? await newItem.loadTransferable(type: Data.self),
                       let uiImage = UIImage(data: data) {
                        await vm.extractFromImage(baseURL: hk.selectedBaseURL, image: uiImage, scanTarget: target)
                    }
                    scanPickerItem = nil
                }
            }
            .task { await vm.load(baseURL: hk.selectedBaseURL) }
            .onChange(of: vm.selectedDate) { _, _ in
                if dictation.isRecording { dictation.stop() }
            }
        }
    }

    // MARK: - Photo header

    @ViewBuilder
    private var photoHeader: some View {
        if let photo = vm.photoOfTheDay {
            Image(uiImage: photo)
                .resizable()
                .scaledToFill()
                .frame(maxWidth: .infinity)
                .frame(height: 220)
                .clipped()
                .overlay(alignment: .bottomLeading) {
                    Text("Photo of the day")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white.opacity(0.75))
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .background(.ultraThinMaterial)
                        .clipShape(Capsule())
                        .padding(14)
                }
                .overlay(alignment: .bottom) {
                    LinearGradient(colors: [.clear, JarvisPalette.background],
                                   startPoint: .top, endPoint: .bottom)
                        .frame(height: 60)
                }
        }
    }

    // MARK: - Date nav

    private var dateNavBar: some View {
        VStack(spacing: 8) {
            HStack {
                Button { vm.previousDay(baseURL: hk.selectedBaseURL) } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(JarvisPalette.cyan)
                        .frame(width: 36, height: 36)
                        .background(Circle().fill(JarvisPalette.cyan.opacity(0.1)))
                }

                Spacer()

                Button {
                    pickerDate = vm.selectedDate
                    showDatePicker = true
                } label: {
                    VStack(spacing: 3) {
                        HStack(spacing: 6) {
                            Text(formattedDate())
                                .font(.system(size: 17, weight: .bold, design: .rounded))
                                .foregroundStyle(.white)
                            Image(systemName: "calendar")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(JarvisPalette.cyan.opacity(0.8))
                        }
                        if let label = vm.entry?.date_label, !label.isEmpty {
                            Text(label)
                                .font(.system(size: 11, design: .rounded))
                                .foregroundStyle(JarvisPalette.subtleText)
                        }
                    }
                }
                .buttonStyle(.plain)

                Spacer()

                Button { vm.nextDay(baseURL: hk.selectedBaseURL) } label: {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(vm.isToday ? JarvisPalette.cyan.opacity(0.2) : JarvisPalette.cyan)
                        .frame(width: 36, height: 36)
                        .background(Circle().fill(vm.isToday ? Color.clear : JarvisPalette.cyan.opacity(0.1)))
                }
                .disabled(vm.isToday)
            }
            .padding(.horizontal, 4)

            if !vm.isToday {
                Button {
                    vm.selectedDate = Date()
                    Task { await vm.load(baseURL: hk.selectedBaseURL) }
                } label: {
                    Text("Today")
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .foregroundStyle(.black)
                        .padding(.horizontal, 16).padding(.vertical, 6)
                        .background(Capsule().fill(JarvisPalette.cyan))
                }
                .transition(.opacity.combined(with: .scale(scale: 0.9)))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: vm.isToday)
        .sheet(isPresented: $showDatePicker) { datePicker }
    }

    private var datePicker: some View {
        NavigationStack {
            VStack {
                DatePicker("", selection: $pickerDate, in: ...Date(), displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .tint(JarvisPalette.cyan)
                    .padding(.horizontal)
                Spacer()
            }
            .background(JarvisPalette.background.ignoresSafeArea())
            .navigationTitle("Go to date")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { showDatePicker = false }
                        .foregroundStyle(JarvisPalette.subtleText)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Go") {
                        showDatePicker = false
                        vm.selectedDate = pickerDate
                        Task { await vm.load(baseURL: hk.selectedBaseURL) }
                    }
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(JarvisPalette.cyan)
                }
            }
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }

    // MARK: - Context card

    @ViewBuilder
    private var contextCard: some View {
        if let entry = vm.entry,
           (!entry.calendar_summary.isEmpty || entry.world_event_title != nil) {
            JarvisCard {
                VStack(alignment: .leading, spacing: 0) {
                    Button {
                        withAnimation(.easeInOut(duration: 0.22)) { showContext.toggle() }
                    } label: {
                        HStack(spacing: 10) {
                            HStack(spacing: 6) {
                                if !entry.calendar_summary.isEmpty {
                                    Image(systemName: "calendar")
                                        .font(.system(size: 12))
                                        .foregroundStyle(JarvisPalette.cyan)
                                }
                                if entry.world_event_title != nil {
                                    Image(systemName: "globe")
                                        .font(.system(size: 12))
                                        .foregroundStyle(JarvisPalette.subtleText)
                                }
                            }
                            Text(contextSummaryLine(entry))
                                .font(.system(size: 13, weight: .medium, design: .rounded))
                                .foregroundStyle(JarvisPalette.secondaryText)
                                .lineLimit(1)
                            Spacer()
                            Image(systemName: showContext ? "chevron.up" : "chevron.down")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(JarvisPalette.subtleText.opacity(0.6))
                        }
                    }
                    .buttonStyle(.plain)

                    if showContext {
                        VStack(alignment: .leading, spacing: 12) {
                            Divider().background(Color.white.opacity(0.08)).padding(.top, 12)

                            if !entry.calendar_summary.isEmpty {
                                VStack(alignment: .leading, spacing: 4) {
                                    Label("TODAY", systemImage: "calendar")
                                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                                        .tracking(1.5)
                                        .foregroundStyle(JarvisPalette.cyan)
                                    Text(entry.calendar_summary)
                                        .font(.system(size: 13, design: .rounded))
                                        .foregroundStyle(JarvisPalette.secondaryText)
                                }
                            }

                            if let headline = entry.world_event_title {
                                VStack(alignment: .leading, spacing: 4) {
                                    Label("WORLD", systemImage: "globe")
                                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                                        .tracking(1.5)
                                        .foregroundStyle(JarvisPalette.subtleText)
                                    Text(headline)
                                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                                        .foregroundStyle(.white)
                                    if !entry.world_event_summary.isEmpty {
                                        Text(entry.world_event_summary)
                                            .font(.system(size: 13, design: .rounded))
                                            .foregroundStyle(JarvisPalette.secondaryText)
                                    }
                                }
                            }
                        }
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                }
            }
        }
    }

    // MARK: - Scripture card  (orange — scripture_study + spiritual_notes)

    private var scriptureCard: some View {
        JarvisCard {
            VStack(alignment: .leading, spacing: 14) {
                Label("SCRIPTURE & STUDY", systemImage: "book.closed.fill")
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .tracking(1.5)
                    .foregroundStyle(JarvisPalette.orange)

                editorField(field: "scripture",
                            text: $vm.scriptureText,
                            placeholder: "What did you read? What stood out?",
                            accent: JarvisPalette.orange,
                            minHeight: 120)
            }
        }
    }

    // MARK: - Journal card  (cyan — journal_entry)

    private var journalCard: some View {
        JarvisCard {
            VStack(alignment: .leading, spacing: 14) {
                Label("JOURNAL ENTRY", systemImage: "pencil.line")
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .tracking(1.5)
                    .foregroundStyle(JarvisPalette.cyan)

                editorField(field: "journal",
                            text: $vm.journalText,
                            placeholder: "What's on your mind today?",
                            accent: JarvisPalette.cyan,
                            minHeight: 200)
            }
        }
    }

    // MARK: - Reflection card  (emerald — gratitude + accomplishments)

    private var reflectionCard: some View {
        JarvisCard {
            VStack(alignment: .leading, spacing: 14) {
                Label("GRATITUDE", systemImage: "heart.fill")
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .tracking(1.5)
                    .foregroundStyle(JarvisPalette.emerald)

                editorField(field: "gratitude",
                            text: $vm.gratitudeText,
                            placeholder: "What are you grateful for today?",
                            accent: JarvisPalette.emerald,
                            minHeight: 80)

                Divider().background(Color.white.opacity(0.07))

                Label("ACCOMPLISHMENTS", systemImage: "checkmark.seal.fill")
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .tracking(1.5)
                    .foregroundStyle(JarvisPalette.emerald.opacity(0.8))

                editorField(field: "accomplishments",
                            text: $vm.accomplishmentsText,
                            placeholder: "What did you accomplish today?",
                            accent: JarvisPalette.emerald,
                            minHeight: 80)
            }
        }
    }

    // MARK: - Editor field

    private func editorField(
        field: String,
        text: Binding<String>,
        placeholder: String,
        accent: Color,
        minHeight: CGFloat
    ) -> some View {
        let isActive = dictation.isRecording && dictation.activeField == field
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 0) {
                if isActive {
                    HStack(spacing: 5) {
                        Circle().fill(Color.red).frame(width: 5, height: 5)
                        Text("Listening…")
                            .font(.system(size: 11, design: .rounded))
                            .foregroundStyle(Color.red.opacity(0.85))
                    }
                    .transition(.opacity)
                }
                Spacer()
                Button {
                    dictation.toggle(field: field, currentText: text.wrappedValue) { newText in
                        text.wrappedValue = newText
                    }
                } label: {
                    ZStack {
                        Circle()
                            .fill(isActive ? Color.red.opacity(0.12) : accent.opacity(0.1))
                            .frame(width: 28, height: 28)
                        Image(systemName: isActive ? "mic.fill" : "mic")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(isActive ? Color.red : accent.opacity(0.7))
                    }
                }
                .buttonStyle(.plain)
            }
            .frame(height: 28)

            ZStack(alignment: .topLeading) {
                if text.wrappedValue.isEmpty {
                    Text(placeholder)
                        .font(.system(size: 15, design: .rounded))
                        .foregroundStyle(JarvisPalette.subtleText.opacity(0.38))
                        .padding(.top, 10).padding(.leading, 6)
                        .allowsHitTesting(false)
                }
                TextEditor(text: text)
                    .font(.system(size: 15, design: .rounded))
                    .foregroundStyle(.white)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: minHeight)
                    .padding(.horizontal, 2)
            }
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(.white.opacity(0.04))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(isActive ? Color.red.opacity(0.4) : accent.opacity(0.08), lineWidth: 1)
                    )
            )

            if isActive, let err = dictation.error {
                Text(err)
                    .font(.system(size: 11, design: .rounded))
                    .foregroundStyle(Color.red.opacity(0.8))
            }
        }
        .animation(.easeInOut(duration: 0.15), value: isActive)
    }

    // MARK: - Save button

    private var saveButton: some View {
        Button { Task { await vm.save(baseURL: hk.selectedBaseURL) } } label: {
            HStack(spacing: 8) {
                if vm.isSaving { ProgressView().tint(.black).scaleEffect(0.75) }
                Text(vm.isSaving ? "Saving…" : vm.loadFailed ? "Unavailable" : "Save Entry")
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .background(Capsule().fill(vm.loadFailed ? Color.gray.opacity(0.4) : JarvisPalette.cyan))
            .foregroundStyle(.black)
        }
        // Blocked while the day failed to load -- the fields are empty in that
        // state, and saving them would replace the stored entry with nothing.
        .disabled(vm.isSaving || vm.loadFailed)
    }

    // MARK: - Inline banners

    private var extractingBanner: some View {
        HStack(spacing: 10) {
            ProgressView().tint(JarvisPalette.cyan).scaleEffect(0.85)
            Text("Reading your notes…")
                .font(.system(size: 13, weight: .medium, design: .rounded))
                .foregroundStyle(JarvisPalette.subtleText)
            Spacer()
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(JarvisPalette.cyan.opacity(0.08))
        )
    }

    private func inlineBanner(_ text: String, color: Color, icon: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).foregroundStyle(color)
            Text(text)
                .font(.system(size: 13, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.9))
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(color.opacity(0.12))
        )
    }

    // MARK: - Scan options sheet

    private var scanOptionsSheet: some View {
        NavigationStack {
            VStack(spacing: 24) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("What are you scanning?")
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .tracking(0.5)
                        .foregroundStyle(JarvisPalette.subtleText)
                        .padding(.horizontal, 4)

                    VStack(spacing: 8) {
                        ForEach(ScanTarget.allCases) { target in
                            Button { scanTarget = target } label: {
                                HStack(spacing: 14) {
                                    Image(systemName: target.icon)
                                        .font(.system(size: 16))
                                        .foregroundStyle(JarvisPalette.cyan)
                                        .frame(width: 24)
                                    Text(target.rawValue)
                                        .font(.system(size: 15, design: .rounded))
                                        .foregroundStyle(.white)
                                    Spacer()
                                    if scanTarget == target {
                                        Image(systemName: "checkmark.circle.fill")
                                            .foregroundStyle(JarvisPalette.cyan)
                                    }
                                }
                                .padding(.horizontal, 16).padding(.vertical, 14)
                                .background(
                                    RoundedRectangle(cornerRadius: 14)
                                        .fill(scanTarget == target
                                              ? JarvisPalette.cyan.opacity(0.12)
                                              : Color.white.opacity(0.05))
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("Source")
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .tracking(0.5)
                        .foregroundStyle(JarvisPalette.subtleText)
                        .padding(.horizontal, 4)

                    Button {
                        showScanSheet = false
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { showDocScanner = true }
                    } label: {
                        scanSourceRow(icon: "doc.viewfinder.fill",
                                      title: "Scan Document",
                                      subtitle: "Use the iPhone camera with edge detection")
                    }
                    .buttonStyle(.plain)

                    PhotosPicker(selection: $scanPickerItem, matching: .images, photoLibrary: .shared()) {
                        scanSourceRow(icon: "photo.on.rectangle",
                                      title: "Choose from Library",
                                      subtitle: "Pick an existing photo of your notes")
                    }
                    .buttonStyle(.plain)
                    .simultaneousGesture(TapGesture().onEnded { showScanSheet = false })
                }

                Spacer()
            }
            .padding(20)
            .background(JarvisPalette.background.ignoresSafeArea())
            .navigationTitle("Scan Notes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Cancel") { showScanSheet = false }
                        .foregroundStyle(JarvisPalette.cyan)
                }
            }
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }

    private func scanSourceRow(icon: String, title: String, subtitle: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 16))
                .foregroundStyle(JarvisPalette.cyan)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
                Text(subtitle)
                    .font(.system(size: 12, design: .rounded))
                    .foregroundStyle(JarvisPalette.subtleText)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(JarvisPalette.subtleText.opacity(0.5))
        }
        .padding(.horizontal, 16).padding(.vertical, 14)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.05)))
    }

    // MARK: - Scan confirmation sheet

    private var scanConfirmationSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    let total   = vm.pendingEntries.count
                    let skipped = vm.pendingEntries.filter { $0.skip }.count
                    let saving  = total - skipped

                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(total) \(total == 1 ? "entry" : "entries") detected")
                                .font(.system(size: 13, weight: .semibold, design: .rounded))
                                .foregroundStyle(.white)
                            Text("Review dates and text before saving.")
                                .font(.system(size: 12, design: .rounded))
                                .foregroundStyle(JarvisPalette.subtleText)
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 18).padding(.top, 4)

                    ForEach($vm.pendingEntries) { $entry in
                        scanEntryCard(entry: $entry)
                    }

                    VStack(spacing: 10) {
                        Button {
                            Task { await vm.savePendingEntries(baseURL: hk.selectedBaseURL, scanTarget: scanTarget) }
                        } label: {
                            HStack(spacing: 8) {
                                if vm.isSavingEntries { ProgressView().tint(.black).scaleEffect(0.8) }
                                Text(vm.isSavingEntries ? "Saving…" : "Save \(saving) \(saving == 1 ? "entry" : "entries")")
                                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                            }
                            .frame(maxWidth: .infinity).padding(.vertical, 14)
                            .background(Capsule().fill(saving > 0 ? JarvisPalette.cyan : JarvisPalette.subtleText.opacity(0.3)))
                            .foregroundStyle(.black)
                        }
                        .disabled(saving == 0 || vm.isSavingEntries)
                        .padding(.horizontal, 18)

                        Button("Cancel") {
                            vm.pendingEntries = []
                            vm.showScanConfirmation = false
                        }
                        .font(.system(size: 14, design: .rounded))
                        .foregroundStyle(JarvisPalette.subtleText)
                    }
                    .padding(.bottom, 24)
                }
                .padding(.top, 8)
            }
            .background(JarvisPalette.background.ignoresSafeArea())
            .navigationTitle("Review Scan")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private func scanEntryCard(entry: Binding<ScanEntry>) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "calendar")
                    .font(.system(size: 13)).foregroundStyle(JarvisPalette.cyan)
                DatePicker("", selection: entry.date, in: ...Date(), displayedComponents: .date)
                    .labelsHidden()
                    .tint(JarvisPalette.cyan)
                    .colorScheme(.dark)
                if !entry.dateDetected.wrappedValue {
                    Text("Date not detected")
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(Color.orange.opacity(0.85))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Capsule().fill(Color.orange.opacity(0.12)))
                }
                Spacer()
                Button { entry.skip.wrappedValue.toggle() } label: {
                    Text(entry.skip.wrappedValue ? "Skipped" : "Skip")
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(entry.skip.wrappedValue ? JarvisPalette.subtleText : Color.red.opacity(0.7))
                }
            }

            Text(entry.text.wrappedValue)
                .font(.system(size: 13, design: .rounded))
                .foregroundStyle(entry.skip.wrappedValue
                                 ? JarvisPalette.subtleText.opacity(0.35)
                                 : JarvisPalette.secondaryText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .lineLimit(6)
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(entry.skip.wrappedValue ? Color.white.opacity(0.02) : Color.white.opacity(0.06))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(entry.skip.wrappedValue ? Color.clear : JarvisPalette.cyan.opacity(0.15), lineWidth: 1)
        )
        .padding(.horizontal, 18)
        .animation(.easeInOut(duration: 0.15), value: entry.skip.wrappedValue)
    }

    // MARK: - Helpers

    private func contextSummaryLine(_ entry: JournalDayEntry) -> String {
        var parts: [String] = []
        if !entry.calendar_summary.isEmpty { parts.append("Calendar") }
        if let title = entry.world_event_title { parts.append(title) }
        return parts.joined(separator: " · ")
    }

    private func formattedDate() -> String {
        let fmt = DateFormatter()
        fmt.dateFormat = "EEEE, MMM d"
        return fmt.string(from: vm.selectedDate)
    }
}
