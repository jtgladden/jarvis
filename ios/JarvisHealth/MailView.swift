import SwiftUI

@MainActor
final class MailViewModel: ObservableObject {
    @Published var emails: [EmailSummary] = []
    @Published var isLoading = false
    @Published var error: String?
    @Published var selectedEmail: EmailSummary?
    @Published var classification: EmailClassification?
    @Published var classifyingId: String?
    @Published var actionInProgress: String?
    @Published var mailbox: String = "INBOX"

    let mailboxOptions = ["INBOX", "SENT", "SPAM", "TRASH"]

    func load(baseURL: String) async {
        isLoading = true; error = nil
        do {
            let page = try await JarvisAPIClient.getEmails(baseURL: baseURL, mailbox: mailbox, limit: 30)
            emails = page.items
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    func classify(baseURL: String, email: EmailSummary) async {
        classifyingId = email.id
        classification = nil
        selectedEmail = email
        do {
            let result = try await JarvisAPIClient.classifyEmail(baseURL: baseURL, messageId: email.id)
            classification = result.classification
        } catch {
            self.error = error.localizedDescription
        }
        classifyingId = nil
    }

    func handle(baseURL: String, emailId: String) async {
        actionInProgress = emailId
        do {
            _ = try await JarvisAPIClient.handleEmail(baseURL: baseURL, messageId: emailId)
            emails.removeAll { $0.id == emailId }
            if selectedEmail?.id == emailId { selectedEmail = nil; classification = nil }
        } catch {
            self.error = error.localizedDescription
        }
        actionInProgress = nil
    }

    func delete(baseURL: String, emailId: String) async {
        actionInProgress = emailId
        do {
            try await JarvisAPIClient.deleteEmail(baseURL: baseURL, messageId: emailId)
            emails.removeAll { $0.id == emailId }
            if selectedEmail?.id == emailId { selectedEmail = nil; classification = nil }
        } catch {
            self.error = error.localizedDescription
        }
        actionInProgress = nil
    }
}

struct MailView: View {
    @EnvironmentObject private var hk: HealthKitManager
    @StateObject private var vm = MailViewModel()

    var body: some View {
        NavigationStack {
            ZStack {
                JarvisPalette.background.ignoresSafeArea()
                VStack(spacing: 0) {
                    mailboxPicker
                    if vm.isLoading {
                        Spacer()
                        ProgressView().tint(JarvisPalette.cyan)
                        Spacer()
                    } else if let err = vm.error {
                        Spacer()
                        Text(err)
                            .font(.system(size: 14, design: .rounded))
                            .foregroundStyle(.red.opacity(0.8))
                            .padding()
                        Spacer()
                    } else if vm.emails.isEmpty {
                        emptyState
                    } else {
                        emailList
                    }
                }
            }
            .navigationTitle("Mail")
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
            .onChange(of: vm.mailbox) { _, _ in Task { await vm.load(baseURL: hk.selectedBaseURL) } }
            .sheet(item: $vm.selectedEmail) { email in
                emailDetailSheet(email: email)
            }
        }
    }

    private var mailboxPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(vm.mailboxOptions, id: \.self) { box in
                    Button {
                        vm.mailbox = box
                    } label: {
                        Text(box.capitalized)
                            .font(.system(size: 13, weight: vm.mailbox == box ? .semibold : .regular, design: .rounded))
                            .foregroundStyle(vm.mailbox == box ? .black : JarvisPalette.secondaryText)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 7)
                            .background(
                                Capsule().fill(vm.mailbox == box ? JarvisPalette.cyan : Color.white.opacity(0.08))
                            )
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
    }

    private var emailList: some View {
        List {
            ForEach(vm.emails) { email in
                emailRow(email)
                    .listRowBackground(Color.white.opacity(0.04))
                    .listRowSeparatorTint(Color.white.opacity(0.08))
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
    }

    @ViewBuilder
    private func emailRow(_ email: EmailSummary) -> some View {
        Button {
            Task { await vm.classify(baseURL: hk.selectedBaseURL, email: email) }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(email.sender)
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Spacer()
                    if let date = email.date {
                        Text(shortDate(date))
                            .font(.system(size: 11, design: .rounded))
                            .foregroundStyle(JarvisPalette.subtleText)
                    }
                }
                Text(email.subject)
                    .font(.system(size: 14, weight: .medium, design: .rounded))
                    .foregroundStyle(JarvisPalette.secondaryText)
                    .lineLimit(1)
                Text(email.snippet)
                    .font(.system(size: 12, design: .rounded))
                    .foregroundStyle(JarvisPalette.subtleText)
                    .lineLimit(2)
                if vm.classifyingId == email.id {
                    HStack(spacing: 6) {
                        ProgressView().scaleEffect(0.7).tint(JarvisPalette.cyan)
                        Text("Analyzing…")
                            .font(.system(size: 11, design: .rounded))
                            .foregroundStyle(JarvisPalette.cyan)
                    }
                    .padding(.top, 2)
                }
            }
            .padding(.vertical, 6)
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) {
                Task { await vm.delete(baseURL: hk.selectedBaseURL, emailId: email.id) }
            } label: { Label("Delete", systemImage: "trash") }

            Button {
                Task { await vm.handle(baseURL: hk.selectedBaseURL, emailId: email.id) }
            } label: { Label("Archive", systemImage: "archivebox") }
                .tint(JarvisPalette.cyan.opacity(0.8))
        }
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Spacer()
            Image(systemName: "tray.fill")
                .font(.system(size: 40))
                .foregroundStyle(JarvisPalette.cyan.opacity(0.5))
            Text("No emails")
                .font(.system(size: 18, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
            Text("Your \(vm.mailbox.lowercased()) is empty.")
                .font(.system(size: 14, design: .rounded))
                .foregroundStyle(JarvisPalette.secondaryText)
            Spacer()
        }
    }

    @ViewBuilder
    private func emailDetailSheet(email: EmailSummary) -> some View {
        NavigationStack {
            ZStack {
                JarvisPalette.background.ignoresSafeArea()
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 20) {
                        // Header
                        VStack(alignment: .leading, spacing: 6) {
                            Text(email.subject)
                                .font(.system(size: 18, weight: .bold, design: .rounded))
                                .foregroundStyle(.white)
                            HStack {
                                Text(email.sender)
                                    .font(.system(size: 13, design: .rounded))
                                    .foregroundStyle(JarvisPalette.cyan)
                                Spacer()
                                if let date = email.date {
                                    Text(date)
                                        .font(.system(size: 12, design: .rounded))
                                        .foregroundStyle(JarvisPalette.subtleText)
                                }
                            }
                        }

                        // AI Classification
                        if let cls = vm.classification {
                            classificationCard(cls)
                        } else if vm.classifyingId == email.id {
                            HStack(spacing: 8) {
                                ProgressView().tint(JarvisPalette.cyan)
                                Text("Analyzing email…")
                                    .font(.system(size: 13, design: .rounded))
                                    .foregroundStyle(JarvisPalette.secondaryText)
                            }
                            .padding()
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.06)))
                        }

                        // Body
                        if let body = email.body, !body.isEmpty {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Message")
                                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                                    .foregroundStyle(JarvisPalette.subtleText)
                                Text(body)
                                    .font(.system(size: 14, design: .rounded))
                                    .foregroundStyle(JarvisPalette.secondaryText)
                            }
                            .padding()
                            .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.05)))
                        }

                        // Actions
                        HStack(spacing: 12) {
                            Button {
                                Task {
                                    await vm.handle(baseURL: hk.selectedBaseURL, emailId: email.id)
                                    vm.selectedEmail = nil
                                }
                            } label: {
                                Label("Archive", systemImage: "archivebox")
                                    .font(.system(size: 14, weight: .medium, design: .rounded))
                                    .foregroundStyle(.black)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 12)
                                    .background(Capsule().fill(JarvisPalette.cyan))
                            }
                            .disabled(vm.actionInProgress == email.id)

                            Button {
                                Task {
                                    await vm.delete(baseURL: hk.selectedBaseURL, emailId: email.id)
                                    vm.selectedEmail = nil
                                }
                            } label: {
                                Label("Delete", systemImage: "trash")
                                    .font(.system(size: 14, weight: .medium, design: .rounded))
                                    .foregroundStyle(.red)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 12)
                                    .background(Capsule().fill(.red.opacity(0.15)))
                            }
                            .disabled(vm.actionInProgress == email.id)
                        }
                    }
                    .padding(20)
                }
            }
            .navigationTitle("Email")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { vm.selectedEmail = nil }
                        .font(.system(size: 14, weight: .medium, design: .rounded))
                        .foregroundStyle(JarvisPalette.subtleText)
                }
            }
        }
    }

    @ViewBuilder
    private func classificationCard(_ cls: EmailClassification) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                urgencyBadge(cls.urgency)
                categoryBadge(cls.category)
                Spacer()
                Text("Score: \(cls.importance_score)/5")
                    .font(.system(size: 12, design: .rounded))
                    .foregroundStyle(JarvisPalette.subtleText)
            }
            if !cls.short_summary.isEmpty {
                Text(cls.short_summary)
                    .font(.system(size: 14, design: .rounded))
                    .foregroundStyle(.white)
            }
            if !cls.why_it_matters.isEmpty {
                Text(cls.why_it_matters)
                    .font(.system(size: 13, design: .rounded))
                    .foregroundStyle(JarvisPalette.secondaryText)
            }
            if !cls.action_items.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Action items")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(JarvisPalette.subtleText)
                    ForEach(cls.action_items, id: \.self) { item in
                        HStack(alignment: .top, spacing: 6) {
                            Text("•").foregroundStyle(JarvisPalette.cyan)
                            Text(item)
                                .font(.system(size: 13, design: .rounded))
                                .foregroundStyle(JarvisPalette.secondaryText)
                        }
                    }
                }
            }
            if let reply = cls.suggested_reply, !reply.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Suggested reply")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(JarvisPalette.subtleText)
                    Text(reply)
                        .font(.system(size: 13, design: .rounded))
                        .foregroundStyle(JarvisPalette.secondaryText)
                        .italic()
                }
            }
        }
        .padding()
        .background(RoundedRectangle(cornerRadius: 14).fill(JarvisPalette.cyan.opacity(0.07)))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(JarvisPalette.cyan.opacity(0.2), lineWidth: 1))
    }

    private func urgencyBadge(_ urgency: String) -> some View {
        let color: Color = urgency == "high" ? .red : urgency == "medium" ? .orange : .green
        return Text(urgency.uppercased())
            .font(.system(size: 10, weight: .bold, design: .rounded))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(color.opacity(0.15)))
    }

    private func categoryBadge(_ category: String) -> some View {
        Text(category.replacingOccurrences(of: "_", with: " ").capitalized)
            .font(.system(size: 10, weight: .semibold, design: .rounded))
            .foregroundStyle(JarvisPalette.cyan)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(JarvisPalette.cyan.opacity(0.12)))
    }

    private func shortDate(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) {
            let out = DateFormatter()
            out.dateFormat = Calendar.current.isDateInToday(d) ? "h:mm a" : "MMM d"
            return out.string(from: d)
        }
        return String(iso.prefix(10))
    }
}
