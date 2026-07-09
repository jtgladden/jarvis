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
    var startPage: Int = 0   // 0-based page the entry began on within the scan
    var skip: Bool = false
    // A leading undated fragment — the tail of an earlier entry that isn't part
    // of this scan (appears above the first dated entry). Auto-skipped, but kept
    // visible so the user can restore it if the date was simply missed.
    var isContinuation: Bool = false
    // The heading had a month/day but no year, so the year came from the scan's
    // default year — these are the entries a bulk year change re-applies to.
    var usedDefaultYear: Bool = false
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
    // Base64 JPEGs of the pages from the current scan, in order — retained
    // through review so each saved entry can be linked to its source page(s).
    private var scannedPages: [String] = []

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
        } catch {
            entry = nil
            journalText = ""; gratitudeText = ""; accomplishmentsText = ""
            scriptureText = ""; spiritualText = ""
        }
        await loadPhotoOfTheDay()
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

    /// Transcribe one or more ordered scanned pages. Passing every page in a
    /// single call lets the server recognize entries that continue across page
    /// boundaries (a page with no date heading is merged into the prior entry
    /// rather than becoming a new, undated one).
    func extractFromImages(baseURL: String, images: [UIImage], scanTarget: ScanTarget, defaultYear: Int) async {
        let pages = images.compactMap { $0.jpegData(compressionQuality: 0.85)?.base64EncodedString() }
        guard !pages.isEmpty else {
            extractError = "Could not encode the scanned pages."; return
        }
        scannedPages = pages
        isExtracting = true; extractError = nil
        do {
            let result = try await JarvisAPIClient.extractJournalFromImages(
                baseURL: baseURL, pagesBase64: pages, mediaType: "image/jpeg",
                scanTarget: scanTarget == .scripture ? "scripture" : "journal")
            var entries = result.entries.compactMap { e -> ScanEntry? in
                guard !e.text.isEmpty else { return nil }
                let r = Self.resolveScanDate(e.detected_date, fallback: selectedDate, defaultYear: defaultYear)
                return ScanEntry(date: r.date, dateDetected: r.detected, text: e.text,
                                 startPage: max(0, e.start_page ?? 0),
                                 usedDefaultYear: r.usedDefaultYear)
            }
            // A leading undated entry is the tail of an earlier entry that isn't
            // in this scan (e.g. the page's first entry started before it).
            // Auto-skip that run, but only when a real dated entry follows — a
            // wholly undated scan is a genuine addition to the selected day.
            if let firstDated = entries.firstIndex(where: { $0.dateDetected }), firstDated > 0 {
                for i in 0..<firstDated where !entries[i].dateDetected {
                    entries[i].skip = true
                    entries[i].isContinuation = true
                }
            }
            pendingEntries = entries
            if !pendingEntries.isEmpty { showScanConfirmation = true }
            else { extractError = "No text could be extracted from the scan." }
        } catch {
            extractError = "Scan failed: \(error.localizedDescription)"
        }
        isExtracting = false
    }

    /// Turn the server's `detected_date` into a concrete calendar date.
    ///
    /// The live extract endpoint returns either a full `YYYY-MM-DD`, a partial
    /// `MM-DD` (month/day written on the page but no year), or nil. For a
    /// partial date we attach `defaultYear` — the year the user chose for this
    /// scan — so month/day-only journals land on the right year instead of
    /// defaulting to the launch day.
    static func resolveScanDate(_ raw: String?, fallback: Date, defaultYear: Int)
        -> (date: Date, detected: Bool, usedDefaultYear: Bool) {
        guard let raw, !raw.isEmpty else { return (fallback, false, false) }
        let posix = Locale(identifier: "en_US_POSIX")

        let full = DateFormatter()
        full.locale = posix; full.dateFormat = "yyyy-MM-dd"
        if let parsed = full.date(from: raw) { return (parsed, true, false) }

        let partial = DateFormatter()
        partial.locale = posix; partial.dateFormat = "MM-dd"
        if let md = partial.date(from: raw) {
            let cal = Calendar.current
            let mdParts = cal.dateComponents([.month, .day], from: md)
            var parts = DateComponents()
            parts.year = defaultYear
            parts.month = mdParts.month
            parts.day = mdParts.day
            if let resolved = cal.date(from: parts) { return (resolved, true, true) }
        }
        return (fallback, false, false)
    }

    func savePendingEntries(baseURL: String, scanTarget: ScanTarget) async {
        isSavingEntries = true; extractError = nil
        let entries = pendingEntries   // keep original order/indices for page ranges
        let isoFmt: DateFormatter = {
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd"
            f.locale = Locale(identifier: "en_US_POSIX")
            return f
        }()
        var errors: [String] = []
        for (index, entry) in entries.enumerated() where !entry.skip {
            let dateStr = isoFmt.string(from: entry.date)
            do {
                let existing = (try? await JarvisAPIClient.getJournalEntry(baseURL: baseURL, date: dateStr))
                let scripture = scanTarget == .scripture ? entry.text : (existing?.scripture_study ?? "")
                let journal   = scanTarget == .journal   ? entry.text : (existing?.journal_entry ?? "")
                _ = try await JarvisAPIClient.saveJournalEntry(
                    baseURL: baseURL, date: dateStr,
                    journalEntry: journal,
                    accomplishments: existing?.accomplishments ?? "",
                    gratitudeEntry: existing?.gratitude_entry ?? "",
                    scriptureStudy: scripture,
                    spiritualNotes: existing?.spiritual_notes ?? "")
                // Link the source page image(s) this entry was transcribed from.
                let pages = sourcePages(forEntryAt: index, in: entries)
                if !pages.isEmpty {
                    try? await JarvisAPIClient.saveJournalSourcePages(
                        baseURL: baseURL, date: dateStr, pagesBase64: pages)
                }
            } catch {
                errors.append("\(dateStr): \(error.localizedDescription)")
            }
        }
        if !errors.isEmpty { extractError = "Some entries failed: \(errors.joined(separator: "; "))" }
        pendingEntries = []
        scannedPages = []
        showScanConfirmation = false
        isSavingEntries = false
        await load(baseURL: baseURL)
    }

    /// The scanned pages belonging to one entry: from its start page up to (but
    /// not including) the next entry's start page. Entries are in reading order,
    /// so this reconstructs the same per-entry page grouping the batch importer
    /// builds server-side.
    private func sourcePages(forEntryAt index: Int, in entries: [ScanEntry]) -> [String] {
        guard !scannedPages.isEmpty, entries.indices.contains(index) else { return [] }
        let last = scannedPages.count - 1
        let start = min(max(0, entries[index].startPage), last)
        let nextStart = index + 1 < entries.count ? entries[index + 1].startPage : last + 1
        let end = min(max(start, nextStart - 1), last)
        return Array(scannedPages[start...end])
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
    /// Hands back every scanned page in capture order. Pages are kept separate
    /// (not stitched into one image) so the server can detect entry
    /// continuation across page boundaries.
    let onScanned: ([UIImage]) -> Void
    let onDismiss: () -> Void

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let vc = VNDocumentCameraViewController()
        vc.delegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ uiViewController: VNDocumentCameraViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(onScanned: onScanned, onDismiss: onDismiss) }

    class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let onScanned: ([UIImage]) -> Void
        let onDismiss: () -> Void
        init(onScanned: @escaping ([UIImage]) -> Void, onDismiss: @escaping () -> Void) {
            self.onScanned = onScanned; self.onDismiss = onDismiss
        }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController,
                                          didFinishWith scan: VNDocumentCameraScan) {
            let images = (0..<scan.pageCount).map { scan.imageOfPage(at: $0) }
            onScanned(images)
        }
        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) { onDismiss() }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) { onDismiss() }
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
    @State private var scanPickerItems: [PhotosPickerItem] = []
    // Year applied to entries whose heading is month/day only (no year written).
    // Defaults to the year of the day the scan is launched from.
    @State private var scanDefaultYear = Calendar.current.component(.year, from: Date())
    // Same idea, adjustable in the review sheet so a wrong pick doesn't force a re-scan.
    @State private var reviewYear = Calendar.current.component(.year, from: Date())
    // When on, the journal card shows the scanned source page(s) instead of the text.
    @State private var showSourcePages = false
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
                    Button {
                        scanDefaultYear = Calendar.current.component(.year, from: vm.selectedDate)
                        showScanSheet = true
                    } label: {
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
                    onScanned: { images in
                        showDocScanner = false
                        let target = scanTarget
                        let year = scanDefaultYear
                        Task { await vm.extractFromImages(baseURL: hk.selectedBaseURL, images: images, scanTarget: target, defaultYear: year) }
                    },
                    onDismiss: { showDocScanner = false }
                )
                .ignoresSafeArea()
            }
            .onChange(of: scanPickerItems) { _, newItems in
                guard !newItems.isEmpty else { return }
                let target = scanTarget
                let year = scanDefaultYear
                Task {
                    // Load in selection order so page continuation is preserved.
                    var images: [UIImage] = []
                    for item in newItems {
                        if let data = try? await item.loadTransferable(type: Data.self),
                           let uiImage = UIImage(data: data) {
                            images.append(uiImage)
                        }
                    }
                    if !images.isEmpty {
                        await vm.extractFromImages(baseURL: hk.selectedBaseURL, images: images, scanTarget: target, defaultYear: year)
                    }
                    scanPickerItems = []
                }
            }
            .task { await vm.load(baseURL: hk.selectedBaseURL) }
            .onChange(of: vm.selectedDate) { _, _ in
                if dictation.isRecording { dictation.stop() }
                showSourcePages = false   // back to text when switching days
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
        let sources = vm.entry?.source_photos ?? []
        return JarvisCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Label("JOURNAL ENTRY", systemImage: "pencil.line")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .tracking(1.5)
                        .foregroundStyle(JarvisPalette.cyan)
                    Spacer()
                    if !sources.isEmpty {
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) { showSourcePages.toggle() }
                        } label: {
                            HStack(spacing: 5) {
                                Image(systemName: showSourcePages ? "text.alignleft" : "doc.text.image")
                                Text(showSourcePages ? "Text" : "Source")
                            }
                            .font(.system(size: 11, weight: .semibold, design: .rounded))
                            .foregroundStyle(JarvisPalette.cyan)
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .background(Capsule().fill(JarvisPalette.cyan.opacity(0.12)))
                        }
                    }
                }

                if showSourcePages, !sources.isEmpty {
                    sourcePagesView(sources)
                } else {
                    editorField(field: "journal",
                                text: $vm.journalText,
                                placeholder: "What's on your mind today?",
                                accent: JarvisPalette.cyan,
                                minHeight: 200)
                }
            }
        }
    }

    /// The scanned source page image(s) for the current entry, shown in place of
    /// the journal text when "Source" is toggled on.
    @ViewBuilder
    private func sourcePagesView(_ relativePaths: [String]) -> some View {
        VStack(spacing: 12) {
            ForEach(Array(relativePaths.enumerated()), id: \.offset) { _, path in
                if let url = sourceImageURL(path) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFit()
                                .frame(maxWidth: .infinity)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        case .failure:
                            sourceImagePlaceholder(icon: "exclamationmark.triangle", label: "Couldn't load page")
                        default:
                            sourceImagePlaceholder(icon: "photo", label: "Loading…")
                        }
                    }
                }
            }
        }
    }

    private func sourceImagePlaceholder(icon: String, label: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
            Text(label).font(.system(size: 12, design: .rounded))
        }
        .foregroundStyle(JarvisPalette.subtleText)
        .frame(maxWidth: .infinity, minHeight: 160)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.04)))
    }

    /// Build a full image URL from a root-relative source path. `selectedBaseURL`
    /// ends in `/api`, while source paths already include `/api`, so we strip the
    /// suffix to avoid `/api/api`.
    private func sourceImageURL(_ relativePath: String) -> URL? {
        var root = hk.selectedBaseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        if root.hasSuffix("/api") { root = String(root.dropLast(4)) }
        return URL(string: root + relativePath)
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
                Text(vm.isSaving ? "Saving…" : "Save Entry")
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .background(Capsule().fill(JarvisPalette.cyan))
            .foregroundStyle(.black)
        }
        .disabled(vm.isSaving)
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

    /// Selectable years for the default-year picker: this year back ~25 years,
    /// newest first (journals being scanned are usually recent-to-older).
    private var scanYearRange: [Int] {
        let thisYear = Calendar.current.component(.year, from: Date())
        return Array((thisYear - 25...thisYear).reversed())
    }

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
                    Text("Default year")
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .tracking(0.5)
                        .foregroundStyle(JarvisPalette.subtleText)
                        .padding(.horizontal, 4)

                    HStack(spacing: 14) {
                        Image(systemName: "calendar.badge.clock")
                            .font(.system(size: 16))
                            .foregroundStyle(JarvisPalette.cyan)
                            .frame(width: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Applied to month/day-only dates")
                                .font(.system(size: 14, weight: .medium, design: .rounded))
                                .foregroundStyle(.white)
                            Text("For entries with no year written")
                                .font(.system(size: 12, design: .rounded))
                                .foregroundStyle(JarvisPalette.subtleText)
                        }
                        Spacer()
                        Picker("Default year", selection: $scanDefaultYear) {
                            ForEach(scanYearRange, id: \.self) { year in
                                Text(String(year)).tag(year)
                            }
                        }
                        .pickerStyle(.menu)
                        .tint(JarvisPalette.cyan)
                    }
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.05)))
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

                    PhotosPicker(selection: $scanPickerItems,
                                 maxSelectionCount: 10,
                                 selectionBehavior: .ordered,
                                 matching: .images,
                                 photoLibrary: .shared()) {
                        scanSourceRow(icon: "photo.on.rectangle",
                                      title: "Choose from Library",
                                      subtitle: "Pick one or more photos of your notes, in order")
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
        .presentationDetents([.medium, .large])
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
                    let pageCount = (vm.pendingEntries.map { $0.startPage }.max() ?? 0) + 1

                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(total) \(total == 1 ? "entry" : "entries") detected"
                                 + (pageCount > 1 ? " across \(pageCount) pages" : ""))
                                .font(.system(size: 13, weight: .semibold, design: .rounded))
                                .foregroundStyle(.white)
                            Text("Review dates and text before saving.")
                                .font(.system(size: 12, design: .rounded))
                                .foregroundStyle(JarvisPalette.subtleText)
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 18).padding(.top, 4)

                    if vm.pendingEntries.contains(where: { $0.usedDefaultYear }) {
                        HStack(spacing: 12) {
                            Image(systemName: "calendar.badge.clock")
                                .font(.system(size: 14)).foregroundStyle(JarvisPalette.cyan)
                            VStack(alignment: .leading, spacing: 1) {
                                Text("Year for month/day entries")
                                    .font(.system(size: 13, weight: .medium, design: .rounded))
                                    .foregroundStyle(.white)
                                Text("No year was written on those pages")
                                    .font(.system(size: 11, design: .rounded))
                                    .foregroundStyle(JarvisPalette.subtleText)
                            }
                            Spacer()
                            Picker("Year", selection: $reviewYear) {
                                ForEach(scanYearRange, id: \.self) { Text(String($0)).tag($0) }
                            }
                            .pickerStyle(.menu)
                            .tint(JarvisPalette.cyan)
                            .onChange(of: reviewYear) { _, year in applyReviewYear(year) }
                        }
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(RoundedRectangle(cornerRadius: 14).fill(JarvisPalette.cyan.opacity(0.08)))
                        .padding(.horizontal, 18)
                    }

                    ForEach($vm.pendingEntries) { $entry in
                        scanEntryCard(entry: $entry, showPage: pageCount > 1)
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
            .scrollDismissesKeyboard(.interactively)
            .background(JarvisPalette.background.ignoresSafeArea())
            .navigationTitle("Review Scan")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { reviewYear = scanDefaultYear }
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
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    /// Re-stamp the year on every entry whose heading was month/day only, so a
    /// single change fixes them all without re-running the scan.
    private func applyReviewYear(_ year: Int) {
        let cal = Calendar.current
        for i in vm.pendingEntries.indices where vm.pendingEntries[i].usedDefaultYear {
            var comps = cal.dateComponents([.year, .month, .day], from: vm.pendingEntries[i].date)
            comps.year = year
            if let d = cal.date(from: comps) { vm.pendingEntries[i].date = d }
        }
    }

    @ViewBuilder
    private func scanEntryCard(entry: Binding<ScanEntry>, showPage: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "calendar")
                    .font(.system(size: 13)).foregroundStyle(JarvisPalette.cyan)
                DatePicker("", selection: entry.date, in: ...Date(), displayedComponents: .date)
                    .labelsHidden()
                    .tint(JarvisPalette.cyan)
                    .colorScheme(.dark)
                if showPage {
                    Text("Pg \(entry.startPage.wrappedValue + 1)")
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .foregroundStyle(JarvisPalette.subtleText)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Capsule().fill(Color.white.opacity(0.06)))
                }
                if entry.isContinuation.wrappedValue {
                    Text("Continuation")
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(JarvisPalette.subtleText)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Capsule().fill(Color.white.opacity(0.06)))
                } else if !entry.dateDetected.wrappedValue {
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

            // Full, editable transcription — grows to show the whole entry and
            // lets the user fix OCR mistakes before saving.
            TextField("Entry text", text: entry.text, axis: .vertical)
                .font(.system(size: 13, design: .rounded))
                .foregroundStyle(entry.skip.wrappedValue
                                 ? JarvisPalette.subtleText.opacity(0.35)
                                 : JarvisPalette.secondaryText)
                .tint(JarvisPalette.cyan)
                .disabled(entry.skip.wrappedValue)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.04)))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(Color.white.opacity(entry.skip.wrappedValue ? 0 : 0.08), lineWidth: 1)
                )
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
