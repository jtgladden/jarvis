import SwiftUI

@MainActor
final class TasksViewModel: ObservableObject {
    @Published var tasks: [TaskItem] = []
    @Published var isLoading = false
    @Published var error: String?
    @Published var showAddSheet = false
    @Published var newTitle = ""
    @Published var newDetail = ""
    @Published var newDueText = ""
    @Published var newPriority = "medium"

    func load(baseURL: String) async {
        isLoading = true; error = nil
        do { tasks = try await JarvisAPIClient.getTasks(baseURL: baseURL).tasks }
        catch { self.error = error.localizedDescription }
        isLoading = false
    }

    func addTask(baseURL: String) async {
        guard !newTitle.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        do {
            let task = try await JarvisAPIClient.createTask(
                baseURL: baseURL, title: newTitle, detail: newDetail,
                dueText: newDueText.isEmpty ? nil : newDueText, priority: newPriority)
            tasks.insert(task, at: 0)
            newTitle = ""; newDetail = ""; newDueText = ""; newPriority = "medium"
            showAddSheet = false
        } catch { self.error = error.localizedDescription }
    }

    func toggleComplete(_ task: TaskItem, baseURL: String) async {
        do {
            let updated = try await JarvisAPIClient.updateTask(baseURL: baseURL, taskId: task.id, completed: !task.completed)
            if let idx = tasks.firstIndex(where: { $0.id == task.id }) { tasks[idx] = updated }
        } catch { self.error = error.localizedDescription }
    }

    func deleteTask(id: String, baseURL: String) async {
        do {
            try await JarvisAPIClient.deleteTask(baseURL: baseURL, taskId: id)
            tasks.removeAll { $0.id == id }
        } catch { self.error = error.localizedDescription }
    }
}

struct TasksView: View {
    @EnvironmentObject private var hk: HealthKitManager
    @StateObject private var vm = TasksViewModel()
    @State private var filter: TaskFilter = .active

    enum TaskFilter: String, CaseIterable { case active = "Active"; case completed = "Done"; case all = "All" }

    private var filtered: [TaskItem] {
        switch filter {
        case .active: return vm.tasks.filter { !$0.completed }
        case .completed: return vm.tasks.filter { $0.completed }
        case .all: return vm.tasks
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                JarvisPalette.background.ignoresSafeArea()
                VStack(spacing: 0) {
                    Picker("Filter", selection: $filter) {
                        ForEach(TaskFilter.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 18).padding(.vertical, 10)

                    if let err = vm.error {
                        Text(err).font(.system(size: 13, design: .rounded)).foregroundStyle(.white)
                            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 14).fill(Color.red.opacity(0.22)))
                            .padding(.horizontal, 18).padding(.bottom, 8)
                    }

                    if vm.isLoading {
                        Spacer()
                        ProgressView().tint(JarvisPalette.cyan)
                        Spacer()
                    } else if filtered.isEmpty {
                        emptyState
                    } else {
                        ScrollView(showsIndicators: false) {
                            LazyVStack(spacing: 8) {
                                ForEach(filtered) { task in taskRow(task) }
                            }
                            .padding(.horizontal, 18).padding(.bottom, 32)
                        }
                    }
                }
            }
            .navigationTitle("Tasks")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { vm.showAddSheet = true } label: {
                        Image(systemName: "plus.circle.fill").foregroundStyle(JarvisPalette.cyan).font(.system(size: 22))
                    }
                }
            }
            .task { await vm.load(baseURL: hk.selectedBaseURL) }
            .refreshable { await vm.load(baseURL: hk.selectedBaseURL) }
            .sheet(isPresented: $vm.showAddSheet) { addSheet }
        }
    }

    private func taskRow(_ task: TaskItem) -> some View {
        HStack(spacing: 12) {
            Button {
                Task { await vm.toggleComplete(task, baseURL: hk.selectedBaseURL) }
            } label: {
                Image(systemName: task.completed ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(task.completed ? JarvisPalette.emerald : JarvisPalette.subtleText)
                    .font(.system(size: 22))
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 3) {
                Text(task.title)
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .foregroundStyle(task.completed ? JarvisPalette.subtleText : .white)
                    .strikethrough(task.completed)
                    .lineLimit(2)

                if let detail = task.detail, !detail.isEmpty {
                    Text(detail).font(.system(size: 12, design: .rounded))
                        .foregroundStyle(JarvisPalette.secondaryText).lineLimit(2)
                }

                if let due = task.due_text, !due.isEmpty {
                    Label(due, systemImage: "clock")
                        .font(.system(size: 11, design: .rounded)).foregroundStyle(JarvisPalette.subtleText)
                }
            }

            Spacer(minLength: 0)
            priorityDot(task.priority)
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 16)
            .fill(.white.opacity(0.04)).stroke(.white.opacity(0.07), lineWidth: 1))
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) {
                Task { await vm.deleteTask(id: task.id, baseURL: hk.selectedBaseURL) }
            } label: { Label("Delete", systemImage: "trash") }
        }
    }

    @ViewBuilder
    private func priorityDot(_ priority: String) -> some View {
        Circle()
            .fill(priority == "high" ? JarvisPalette.orange : priority == "medium" ? JarvisPalette.cyan : JarvisPalette.subtleText)
            .frame(width: 8, height: 8)
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Spacer()
            Image(systemName: "checklist").font(.system(size: 40)).foregroundStyle(JarvisPalette.subtleText)
            Text(filter == .completed ? "No completed tasks yet" : "No open tasks — tap + to add one")
                .font(.system(size: 14, design: .rounded)).foregroundStyle(JarvisPalette.subtleText)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    private var addSheet: some View {
        NavigationStack {
            ZStack {
                JarvisPalette.background.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        sectionLabel("Title")
                        TextField("What needs to be done?", text: $vm.newTitle)
                            .jarvisTextField()

                        sectionLabel("Notes (optional)")
                        TextField("Details…", text: $vm.newDetail, axis: .vertical)
                            .lineLimit(3...5).jarvisTextField()

                        sectionLabel("Due (optional)")
                        TextField("e.g. tomorrow, Friday, June 5", text: $vm.newDueText)
                            .jarvisTextField()

                        sectionLabel("Priority")
                        Picker("Priority", selection: $vm.newPriority) {
                            Text("Low").tag("low")
                            Text("Medium").tag("medium")
                            Text("High").tag("high")
                        }
                        .pickerStyle(.segmented)
                    }
                    .padding(18)
                }
            }
            .navigationTitle("New Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { vm.showAddSheet = false }.foregroundStyle(JarvisPalette.secondaryText)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { Task { await vm.addTask(baseURL: hk.selectedBaseURL) } }
                        .foregroundStyle(JarvisPalette.cyan)
                        .disabled(vm.newTitle.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .semibold, design: .rounded))
            .tracking(1.5).foregroundStyle(JarvisPalette.subtleText)
    }
}
