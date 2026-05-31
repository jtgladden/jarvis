import SwiftUI

@MainActor
final class AssistantViewModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var input = ""
    @Published var isLoading = false
    @Published var error: String?

    private var chatId: String?

    func send(baseURL: String) async {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        input = ""
        messages.append(ChatMessage(role: .user, content: text))
        isLoading = true; error = nil
        do {
            let response = try await JarvisAPIClient.ask(baseURL: baseURL, question: text, chatId: chatId)
            chatId = response.chat_id
            messages.append(ChatMessage(role: .assistant, content: response.answer))
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    func clear() {
        messages = []
        chatId = nil
    }
}

struct AssistantView: View {
    @EnvironmentObject private var hk: HealthKitManager
    @StateObject private var vm = AssistantViewModel()
    @FocusState private var inputFocused: Bool

    var body: some View {
        NavigationStack {
            ZStack {
                JarvisPalette.background.ignoresSafeArea()

                VStack(spacing: 0) {
                    messageList
                    inputBar
                }
            }
            .navigationTitle("Assistant")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Clear") { vm.clear() }
                        .font(.system(size: 14, weight: .medium, design: .rounded))
                        .foregroundStyle(JarvisPalette.subtleText)
                }
            }
        }
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView(showsIndicators: false) {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if vm.messages.isEmpty {
                        emptyState
                    }
                    ForEach(vm.messages) { msg in
                        messageBubble(msg)
                            .id(msg.id)
                    }
                    if vm.isLoading {
                        typingIndicator
                    }
                    if let err = vm.error {
                        Text(err)
                            .font(.system(size: 13, design: .rounded))
                            .foregroundStyle(Color.red.opacity(0.8))
                            .padding(.horizontal, 18)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 18)
                .padding(.top, 16)
                .padding(.bottom, 8)
            }
            .onChange(of: vm.messages.count) { _, _ in
                withAnimation { proxy.scrollTo("bottom") }
            }
            .onChange(of: vm.isLoading) { _, _ in
                withAnimation { proxy.scrollTo("bottom") }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "bubble.left.and.bubble.right.fill")
                .font(.system(size: 40))
                .foregroundStyle(JarvisPalette.cyan.opacity(0.6))
            Text("Ask Jarvis anything")
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
            Text("Your AI assistant has context on your health, nutrition, tasks, and more.")
                .font(.system(size: 14, design: .rounded))
                .foregroundStyle(JarvisPalette.secondaryText)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 60)
    }

    @ViewBuilder
    private func messageBubble(_ msg: ChatMessage) -> some View {
        HStack {
            if msg.role == .user { Spacer(minLength: 40) }
            Text(msg.content)
                .font(.system(size: 15, design: .rounded))
                .foregroundStyle(msg.role == .user ? .white : JarvisPalette.secondaryText)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .fill(msg.role == .user
                              ? JarvisPalette.cyan.opacity(0.22)
                              : Color.white.opacity(0.07))
                )
                .fixedSize(horizontal: false, vertical: true)
            if msg.role == .assistant { Spacer(minLength: 40) }
        }
    }

    private var typingIndicator: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(JarvisPalette.cyan.opacity(0.7))
                    .frame(width: 7, height: 7)
                    .animation(.easeInOut(duration: 0.6).repeatForever().delay(Double(i) * 0.2), value: vm.isLoading)
            }
        }
        .padding(.horizontal, 18).padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 20).fill(.white.opacity(0.07)))
    }

    private var inputBar: some View {
        VStack(spacing: 0) {
            Divider().background(Color.white.opacity(0.08))
            HStack(spacing: 10) {
                TextField("Message Jarvis…", text: $vm.input, axis: .vertical)
                    .lineLimit(1...5)
                    .font(.system(size: 15, design: .rounded))
                    .foregroundStyle(.white)
                    .tint(JarvisPalette.cyan)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(RoundedRectangle(cornerRadius: 22).fill(.white.opacity(0.07)))
                    .focused($inputFocused)
                    .onSubmit {
                        Task { await vm.send(baseURL: hk.selectedBaseURL) }
                    }

                Button {
                    Task { await vm.send(baseURL: hk.selectedBaseURL) }
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 32))
                        .foregroundStyle(vm.input.trimmingCharacters(in: .whitespaces).isEmpty || vm.isLoading
                                         ? JarvisPalette.subtleText
                                         : JarvisPalette.cyan)
                }
                .disabled(vm.input.trimmingCharacters(in: .whitespaces).isEmpty || vm.isLoading)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(JarvisPalette.background)
        }
    }
}
