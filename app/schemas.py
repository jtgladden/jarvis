from pydantic import BaseModel, Field
from typing import Any, Optional, List, Literal


class EmailLink(BaseModel):
    url: str
    label: str
    kind: Literal["link", "button"] = "link"


class EmailSummary(BaseModel):
    id: str
    thread_id: str
    subject: str
    sender: str
    snippet: str
    date: Optional[str] = None
    labels: List[str] = Field(default_factory=list)
    body: Optional[str] = None
    links: List[EmailLink] = Field(default_factory=list)


class GmailLabel(BaseModel):
    id: str
    name: str
    type: Literal["system", "user"]
    messages_total: int = 0
    messages_unread: int = 0


class EmailClassification(BaseModel):
    category: Literal[
        "action_required",
        "meeting",
        "reference",
        "newsletter",
        "promotion",
        "receipt",
        "spam",
    ] = "reference"
    importance_score: int = 3
    needs_reply: bool = False
    urgency: Literal["low", "medium", "high"] = "low"
    suggested_action: Literal["keep", "archive", "label"] = "keep"
    short_summary: str = ""
    why_it_matters: str = ""
    action_items: List[str] = Field(default_factory=list)
    deadline_hint: Optional[str] = None
    suggested_reply: Optional[str] = None
    calendar_relevant: bool = False
    calendar_title: Optional[str] = None
    calendar_start: Optional[str] = None
    calendar_end: Optional[str] = None
    calendar_is_all_day: bool = False
    calendar_location: Optional[str] = None
    calendar_notes: Optional[str] = None
    reason: str = ""
    raw: Optional[str] = None


class CleanupDecision(BaseModel):
    action: Literal["keep", "archive", "label"]
    label_name: Optional[str] = None
    archive: bool = False
    reason: str


class CleanupItem(BaseModel):
    email: EmailSummary
    classification: EmailClassification
    decision: CleanupDecision


class CleanupSummary(BaseModel):
    total_processed: int
    archived: int
    labeled_only: int
    kept: int


class CleanupResponse(BaseModel):
    dry_run: bool
    summary: CleanupSummary
    items: List[CleanupItem]


class CleanupJobStartResponse(BaseModel):
    job_id: str
    status: Literal["queued", "running"]


class CleanupJobStatus(BaseModel):
    job_id: str
    status: Literal["queued", "running", "completed", "failed"]
    dry_run: bool
    processed: int = 0
    total: int = 0
    current_subject: Optional[str] = None
    result: Optional[CleanupResponse] = None
    error: Optional[str] = None


class RuleDecision(BaseModel):
    label_name: str
    archive: bool = True
    matched_rule: str
    source: Literal["rule", "ai_fallback"] = "rule"
    reason: str


class RuleItem(BaseModel):
    email: EmailSummary
    decision: RuleDecision


class RuleSummary(BaseModel):
    total_processed: int
    archived: int
    by_label: dict[str, int] = Field(default_factory=dict)


class RuleProcessResponse(BaseModel):
    dry_run: bool
    unread_only: bool
    summary: RuleSummary
    items: List[RuleItem]


class HandleEmailResponse(BaseModel):
    message_id: str
    removed_label: str
    added_label: str
    status: str


class HandleEmailRequest(BaseModel):
    thread_id: Optional[str] = None


class DeleteEmailResponse(BaseModel):
    message_id: str
    status: str


class EmailUpdateRequest(BaseModel):
    add_label_names: List[str] = Field(default_factory=list)
    remove_label_names: List[str] = Field(default_factory=list)
    archive: Optional[bool] = None
    unread: Optional[bool] = None


class EmailUpdateResponse(BaseModel):
    email: EmailSummary


class ClassifiedEmailResponse(BaseModel):
    email: EmailSummary
    classification: EmailClassification


class EmailPageResponse(BaseModel):
    items: List[EmailSummary]
    next_page_token: Optional[str] = None


class SenderOverview(BaseModel):
    sender: str
    count: int


class OverviewLinkedItem(BaseModel):
    message_id: str
    subject: str
    sender: str
    text: str
    count: int = 1


class ClassificationOverviewResponse(BaseModel):
    mailbox: str
    total_cached: int
    needs_reply: int
    action_item_count: int = 0
    deadlines_found: int = 0
    categories: dict[str, int] = Field(default_factory=dict)
    urgency: dict[str, int] = Field(default_factory=dict)
    top_senders: List[SenderOverview] = Field(default_factory=list)
    top_action_items: List[OverviewLinkedItem] = Field(default_factory=list)
    deadline_highlights: List[OverviewLinkedItem] = Field(default_factory=list)


class ClassificationGuidanceRequest(BaseModel):
    text: str = ""


class ClassificationGuidanceResponse(BaseModel):
    text: str = ""
    updated_at: Optional[str] = None
    version: str


class CalendarEventPreview(BaseModel):
    message_id: str
    thread_id: str
    relevant: bool = False
    title: Optional[str] = None
    start: Optional[str] = None
    end: Optional[str] = None
    is_all_day: bool = False
    location: Optional[str] = None
    notes: Optional[str] = None
    reason: Optional[str] = None


class CalendarEventCreateResponse(BaseModel):
    created: bool
    event_id: Optional[str] = None
    html_link: Optional[str] = None
    preview: CalendarEventPreview


class CalendarQuickAddRequest(BaseModel):
    description: str


class CalendarQuickAddResponse(BaseModel):
    created: bool
    event_id: Optional[str] = None
    html_link: Optional[str] = None
    title: Optional[str] = None
    start: Optional[str] = None
    end: Optional[str] = None
    is_all_day: bool = False
    location: Optional[str] = None
    notes: Optional[str] = None
    source_text: str = ""


class CalendarAgendaItem(BaseModel):
    event_id: str
    title: str
    start: str
    end: Optional[str] = None
    is_all_day: bool = False
    location: Optional[str] = None
    description: Optional[str] = None
    html_link: Optional[str] = None
    removed: bool = False


class CalendarAgendaResponse(BaseModel):
    calendar_id: str
    time_min: str
    time_max: str
    items: List[CalendarAgendaItem] = Field(default_factory=list)


class PlanningRequest(BaseModel):
    goals: str
    days: int = Field(default=7, ge=1, le=14)


class PlanningItem(BaseModel):
    id: str
    title: str
    start: str
    end: str
    day_label: str
    priority: Literal["high", "medium", "low"] = "medium"
    kind: Literal["focus", "meeting_prep", "admin", "personal", "buffer"] = "focus"
    rationale: str


class PlanningResponse(BaseModel):
    summary: str
    strategy: str
    priorities: List[str] = Field(default_factory=list)
    items: List[PlanningItem] = Field(default_factory=list)


class PlanningJobStartResponse(BaseModel):
    job_id: str
    status: Literal["queued", "running"]


class PlanningJobStatus(BaseModel):
    job_id: str
    status: Literal["queued", "running", "completed", "failed"]
    goals: str = ""
    days: int = 7
    result: Optional[PlanningResponse] = None
    error: Optional[str] = None


class PlanningCalendarCreateRequest(BaseModel):
    item: PlanningItem


class PlanningCalendarCreateResponse(BaseModel):
    created: bool
    event_id: Optional[str] = None
    html_link: Optional[str] = None
    item: PlanningItem


class PlanningCalendarBulkCreateRequest(BaseModel):
    items: List[PlanningItem] = Field(default_factory=list)


class PlanningCalendarBulkCreateResponse(BaseModel):
    created_count: int = 0
    items: List[PlanningCalendarCreateResponse] = Field(default_factory=list)


class DashboardMailItem(BaseModel):
    message_id: str
    subject: str
    sender: str
    summary: str = ""
    why_it_matters: str = ""
    urgency: Literal["low", "medium", "high"] = "low"
    needs_reply: bool = False
    deadline_hint: Optional[str] = None
    action_items: List[str] = Field(default_factory=list)


class DashboardNewsItem(BaseModel):
    title: str
    source: Optional[str] = None
    link: Optional[str] = None
    published_at: Optional[str] = None


class DashboardTaskItem(BaseModel):
    id: str
    title: str
    detail: Optional[str] = None
    due_text: Optional[str] = None
    source: Literal["mail", "calendar", "news", "planning", "custom"] = "mail"
    priority: Literal["high", "medium", "low"] = "medium"
    related_message_id: Optional[str] = None
    related_event_id: Optional[str] = None
    completed: bool = False
    updated_at: Optional[str] = None
    custom: bool = False


class HealthDailyEntry(BaseModel):
    date: str
    source: str = "ios_healthkit"
    steps: int = 0
    active_energy_kcal: Optional[float] = None
    sleep_hours: Optional[float] = None
    workouts: int = 0
    resting_heart_rate: Optional[float] = None
    extra_metrics: dict[str, float | int | str | None] = Field(default_factory=dict)
    synced_at: Optional[str] = None


class DashboardHealthSummary(BaseModel):
    latest_date: Optional[str] = None
    last_synced_at: Optional[str] = None
    today_entry: Optional[HealthDailyEntry] = None
    recent_entries: List[HealthDailyEntry] = Field(default_factory=list)
    seven_day_avg_steps: Optional[int] = None
    seven_day_avg_sleep_hours: Optional[float] = None
    streak_days: int = 0


class DashboardResponse(BaseModel):
    generated_at: str
    date_label: str
    overview: str = ""
    mail_summary: str = ""
    news_summary: str = ""
    tasks_summary: str = ""
    health_summary: Optional[DashboardHealthSummary] = None
    calendar_items: List[CalendarAgendaItem] = Field(default_factory=list)
    important_emails: List[DashboardMailItem] = Field(default_factory=list)
    news_items: List[DashboardNewsItem] = Field(default_factory=list)
    tasks: List[DashboardTaskItem] = Field(default_factory=list)
    google_error: Optional[str] = None


class TaskCreateRequest(BaseModel):
    title: str
    detail: str = ""
    due_text: Optional[str] = None
    priority: Literal["high", "medium", "low"] = "medium"
    source: Literal["mail", "calendar", "news", "planning", "custom"] = "custom"
    related_message_id: Optional[str] = None
    related_event_id: Optional[str] = None


class TaskUpdateRequest(BaseModel):
    title: Optional[str] = None
    detail: Optional[str] = None
    due_text: Optional[str] = None
    priority: Optional[Literal["high", "medium", "low"]] = None
    completed: Optional[bool] = None


class TaskListResponse(BaseModel):
    generated_at: str
    tasks: List[DashboardTaskItem] = Field(default_factory=list)


class JournalDayNoteUpdateRequest(BaseModel):
    journal_entry: str = ""
    accomplishments: str = ""
    gratitude_entry: str = ""
    scripture_study: str = ""
    spiritual_notes: str = ""
    photo_data_url: Optional[str] = None
    calendar_items: List[CalendarAgendaItem] = Field(default_factory=list)


class JournalNewsArticle(BaseModel):
    title: str
    source: Optional[str] = None
    link: Optional[str] = None
    published_at: Optional[str] = None


class JournalStudyLink(BaseModel):
    label: str
    url: str
    confidence: Literal["exact", "likely"] = "exact"
    matched_text: Optional[str] = None


class JournalDayEntry(BaseModel):
    date: str
    date_label: str
    calendar_summary: str = ""
    world_event_title: Optional[str] = None
    world_event_summary: str = ""
    world_event_source: Optional[str] = None
    world_event_articles: List[JournalNewsArticle] = Field(default_factory=list)
    journal_entry: str = ""
    accomplishments: str = ""
    gratitude_entry: str = ""
    scripture_study: str = ""
    spiritual_notes: str = ""
    study_links: List[JournalStudyLink] = Field(default_factory=list)
    photo_data_url: Optional[str] = None
    calendar_items: List[CalendarAgendaItem] = Field(default_factory=list)
    language_sessions: List["LanguagePracticeSession"] = Field(default_factory=list)
    updated_at: Optional[str] = None


class JournalResponse(BaseModel):
    generated_at: str
    entries: List[JournalDayEntry] = Field(default_factory=list)
    total_entries: int = 0
    has_more: bool = False
    next_before: Optional[str] = None
    saved_only: bool = False
    query: str = ""


class JournalEntryDateCount(BaseModel):
    date: str
    words: int = 0


class JournalEntryDatesResponse(BaseModel):
    generated_at: str
    days: List[JournalEntryDateCount] = Field(default_factory=list)


class JournalImageExtractRequest(BaseModel):
    image_base64: str
    media_type: str = "image/jpeg"
    scan_target: Literal["scripture", "journal"] = "journal"


class JournalImagesExtractRequest(BaseModel):
    """Batch extraction over an ORDERED list of consecutive journal pages."""

    pages: List[str] = Field(default_factory=list)  # ordered base64 images
    # A single media type applied to every page, or one per page (aligned to `pages`).
    media_type: str | List[str] = "image/jpeg"
    scan_target: Literal["scripture", "journal"] = "journal"


class JournalScanStageRequest(BaseModel):
    """Extract one uploaded image/PDF and stage the results for review.

    Used by the web "Scan notes" button: instead of merging everything into the
    open day, results become dated fragments in a scan batch the user reviews.
    """

    image_base64: str
    media_type: str = "image/jpeg"
    scan_target: Literal["scripture", "journal"] = "journal"
    source_name: Optional[str] = None  # display name for the batch (e.g. filename)
    # Date to assign to any fragment the model couldn't date (still flagged for
    # review). Typically the journal day the scan was launched from.
    fallback_date: Optional[str] = None
    # Seeds year resolution for partial (MM-DD) dates. Defaults to fallback_date's year.
    default_year: Optional[int] = None


class JournalDayExtract(BaseModel):
    detected_date: Optional[str] = None  # ISO yyyy-mm-dd or null
    date_text: Optional[str] = None  # the date heading exactly as written (year may be missing)
    text: str = ""  # markdown body (no date heading inside)
    start_page: int = 0  # 0-based page index within the batch where the entry begins


class JournalImageExtractResponse(BaseModel):
    entries: List[JournalDayExtract] = Field(default_factory=list)
    confidence: Literal["high", "medium", "low"] = "medium"
    notes: str = ""


# --- Journal import / staged batch review ------------------------------------


class JournalScanFragment(BaseModel):
    id: int
    batch_id: int
    page_index: int
    detected_date: Optional[str] = None  # full YYYY-MM-DD or partial MM-DD as written
    date_text: Optional[str] = None  # raw date heading as written (useful when year is missing)
    date_detected: bool = False  # True when the model detected a date (vs. defaulted)
    text_markdown: str = ""
    confidence: Literal["high", "medium", "low"] = "medium"
    status: Literal["pending", "reviewed", "committed", "discarded"] = "pending"
    source_model: str = ""  # which model produced this transcription
    anomalies: List[str] = Field(default_factory=list)  # review-triage flags
    resolved_date: Optional[str] = None  # full date the year-resolver would commit
    year_inferred: bool = False  # True when the resolver supplied a year the page lacked
    year_rollover: bool = False  # True when a Dec->Jan rollover bumped the inferred year
    created_at: Optional[str] = None


class JournalScanBatch(BaseModel):
    id: int
    source_file: str
    page_count: int
    scan_target: Literal["scripture", "journal"] = "journal"
    model: str = ""
    status: Literal["pending", "extracted", "committed", "error"] = "pending"
    error: Optional[str] = None
    created_at: Optional[str] = None
    # Summary counts, populated by list/detail endpoints.
    fragment_count: int = 0
    pending_count: int = 0
    committed_count: int = 0
    low_confidence_count: int = 0
    failed_group_count: int = 0
    default_year: Optional[int] = None  # seeds year resolution before any full date


class JournalScanBatchListResponse(BaseModel):
    batches: List[JournalScanBatch] = Field(default_factory=list)


class JournalScanBatchDetail(BaseModel):
    batch: JournalScanBatch
    fragments: List[JournalScanFragment] = Field(default_factory=list)
    # Resolved dates in this batch that already have a real journal_entries row.
    existing_dates: List[str] = Field(default_factory=list)
    anomaly_summary: List[str] = Field(default_factory=list)


class JournalImportSpendResponse(BaseModel):
    total_cost_usd: float = 0.0
    total_tokens: int = 0
    total_calls: int = 0
    budget_usd: float = 0.0
    tokens_today: int = 0
    daily_token_cap: int = 0
    by_model: List[dict] = Field(default_factory=list)


class JournalTriageRequest(BaseModel):
    model: Optional[str] = None  # defaults to the premium vision model
    threshold: Optional[Literal["low", "medium", "high"]] = None


class JournalTriageResponse(BaseModel):
    batch_id: int
    candidates: int = 0
    reviewed: int = 0
    upgraded: int = 0
    cost_usd: float = 0.0


class JournalFragmentUpdateRequest(BaseModel):
    detected_date: Optional[str] = None
    text_markdown: Optional[str] = None
    status: Optional[Literal["pending", "reviewed", "committed", "discarded"]] = None


class JournalBatchUpdateRequest(BaseModel):
    default_year: Optional[int] = None  # re-seeds year resolution for the batch


class JournalBatchCommitRequest(BaseModel):
    # When true, overwrite journal_entries rows that already exist for a resolved
    # date. Default false: a pre-existing date is reported as a conflict instead.
    overwrite_existing: bool = False


class JournalDateConflict(BaseModel):
    entry_date: str
    fragment_ids: List[int] = Field(default_factory=list)


class JournalBatchCommitResponse(BaseModel):
    batch_id: int
    committed_dates: List[str] = Field(default_factory=list)
    committed_fragment_ids: List[int] = Field(default_factory=list)
    conflicts: List[JournalDateConflict] = Field(default_factory=list)
    skipped_undated: List[int] = Field(default_factory=list)
    # Partial-date fragments whose year couldn't be resolved — left pending.
    unresolved_years: List[int] = Field(default_factory=list)


class HealthDailySyncRequest(BaseModel):
    date: Optional[str] = None
    source: str = "ios_healthkit"
    steps: int = 0
    active_energy_kcal: Optional[float] = None
    sleep_hours: Optional[float] = None
    workouts: int = 0
    resting_heart_rate: Optional[float] = None
    extra_metrics: dict[str, float | int | str | None] = Field(default_factory=dict)


class HealthDailySyncResponse(BaseModel):
    saved: bool = True
    entry: HealthDailyEntry


class HealthListResponse(BaseModel):
    entries: List[HealthDailyEntry] = Field(default_factory=list)


class WorkoutRoutePoint(BaseModel):
    timestamp: str
    latitude: float
    longitude: float
    altitude_m: Optional[float] = None
    horizontal_accuracy_m: Optional[float] = None
    vertical_accuracy_m: Optional[float] = None


class WorkoutSetEntry(BaseModel):
    exercise: str
    sets: str = ""
    reps: str = ""
    weight: str = ""
    notes: str = ""


class WorkoutEntry(BaseModel):
    workout_id: str
    date: str
    source: str = "ios_healthkit_workout"
    activity_type: str = "other"
    activity_label: str = "Other"
    override_label: Optional[str] = None
    exercise_log: List[WorkoutSetEntry] = Field(default_factory=list)
    start_date: str
    end_date: str
    duration_minutes: float = 0
    total_distance_km: Optional[float] = None
    active_energy_kcal: Optional[float] = None
    avg_heart_rate_bpm: Optional[float] = None
    max_heart_rate_bpm: Optional[float] = None
    source_name: Optional[str] = None
    route_points: List[WorkoutRoutePoint] = Field(default_factory=list)
    synced_at: Optional[str] = None


class WorkoutSyncRequest(BaseModel):
    workout_id: str
    date: str
    source: str = "ios_healthkit_workout"
    activity_type: str = "other"
    activity_label: str = "Other"
    start_date: str
    end_date: str
    duration_minutes: float = 0
    total_distance_km: Optional[float] = None
    active_energy_kcal: Optional[float] = None
    avg_heart_rate_bpm: Optional[float] = None
    max_heart_rate_bpm: Optional[float] = None
    source_name: Optional[str] = None
    route_points: List[WorkoutRoutePoint] = Field(default_factory=list)


class WorkoutBatchSyncRequest(BaseModel):
    workouts: List[WorkoutSyncRequest] = Field(default_factory=list)


class WorkoutSyncResponse(BaseModel):
    saved: bool = True
    workout: WorkoutEntry


class WorkoutBatchSyncResponse(BaseModel):
    saved: int = 0
    workouts: List[WorkoutEntry] = Field(default_factory=list)


class WorkoutListResponse(BaseModel):
    workouts: List[WorkoutEntry] = Field(default_factory=list)


class MovementVisit(BaseModel):
    arrival: Optional[str] = None
    departure: Optional[str] = None
    latitude: float
    longitude: float
    horizontal_accuracy_m: Optional[float] = None
    label: Optional[str] = None


class MovementRoutePoint(BaseModel):
    timestamp: str
    latitude: float
    longitude: float
    horizontal_accuracy_m: Optional[float] = None


class MovementDailyEntry(BaseModel):
    date: str
    source: str = "ios_core_location"
    total_distance_km: float = 0
    time_away_minutes: Optional[int] = None
    visited_places_count: int = 0
    movement_story: str = ""
    home_label: Optional[str] = None
    commute_start: Optional[str] = None
    commute_end: Optional[str] = None
    visits: List[MovementVisit] = Field(default_factory=list)
    route_points: List[MovementRoutePoint] = Field(default_factory=list)
    place_labels: List[str] = Field(default_factory=list)
    synced_at: Optional[str] = None


class MovementDailySyncRequest(BaseModel):
    date: str
    source: str = "ios_core_location"
    total_distance_km: float = 0
    time_away_minutes: Optional[int] = None
    visited_places_count: int = 0
    movement_story: str = ""
    home_label: Optional[str] = None
    commute_start: Optional[str] = None
    commute_end: Optional[str] = None
    visits: List[MovementVisit] = Field(default_factory=list)
    route_points: List[MovementRoutePoint] = Field(default_factory=list)
    place_labels: List[str] = Field(default_factory=list)


class MovementDailySyncResponse(BaseModel):
    saved: bool = True
    entry: MovementDailyEntry


class MovementListResponse(BaseModel):
    entries: List[MovementDailyEntry] = Field(default_factory=list)


class TrailPoint(BaseModel):
    latitude: float
    longitude: float


class TrailSearchItem(BaseModel):
    id: str
    name: str
    source: Literal["usgs", "nps", "osm_relation", "osm_way"] = "usgs"
    trail_type: str = "hiking"
    ref: Optional[str] = None
    operator: Optional[str] = None
    network: Optional[str] = None
    distance_from_center_m: Optional[float] = None
    length_m: Optional[float] = None
    points: List[TrailPoint] = Field(default_factory=list)
    osm_url: Optional[str] = None


class TrailSearchResponse(BaseModel):
    provider: str = "openstreetmap_overpass"
    count: int = 0
    source_counts: dict[str, int] = Field(default_factory=dict)
    debug: dict[str, Any] = Field(default_factory=dict)
    items: List[TrailSearchItem] = Field(default_factory=list)


class AssistantChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = ""


class AssistantStoredMessage(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    content: str = ""
    bullets: List[str] = Field(default_factory=list)
    follow_ups: List[str] = Field(default_factory=list)
    sources: List["AssistantSource"] = Field(default_factory=list)
    created_at: Optional[str] = None


class AssistantAskRequest(BaseModel):
    question: str = ""
    chat_id: Optional[str] = None
    history: List[AssistantChatMessage] = Field(default_factory=list)


class AssistantSource(BaseModel):
    id: str
    label: str
    kind: Literal["dashboard", "mail", "tasks", "calendar", "health", "movement", "workout", "journal", "nutrition", "news", "web", "system"] = "system"
    detail: Optional[str] = None
    url: Optional[str] = None


class AssistantAskResponse(BaseModel):
    chat_id: str
    answer: str = ""
    bullets: List[str] = Field(default_factory=list)
    follow_ups: List[str] = Field(default_factory=list)
    sources: List[AssistantSource] = Field(default_factory=list)
    context_summary: str = ""
    model: Optional[str] = None


class AssistantChatSummary(BaseModel):
    id: str
    title: str = ""
    preview: str = ""
    message_count: int = 0
    archived: bool = False
    updated_at: Optional[str] = None


class AssistantChatListResponse(BaseModel):
    chats: List[AssistantChatSummary] = Field(default_factory=list)


class AssistantChatThread(BaseModel):
    id: str
    title: str = ""
    archived: bool = False
    messages: List[AssistantStoredMessage] = Field(default_factory=list)
    updated_at: Optional[str] = None


LanguageCode = Literal["tagalog", "hiligaynon", "japanese", "spanish"]
LanguageLevel = Literal["beginner", "elementary", "intermediate", "advanced"]


class LanguageMetadata(BaseModel):
    code: LanguageCode
    name: str
    local_name: str
    script_hint: str = ""
    greeting: str = ""
    focus_topics: List[str] = Field(default_factory=list)


class LanguageProfile(BaseModel):
    target_languages: List[LanguageCode] = Field(default_factory=list)
    active_language: LanguageCode = "tagalog"
    level: LanguageLevel = "beginner"
    daily_goal_minutes: int = 15
    correction_style: Literal["gentle", "strict", "immersion"] = "gentle"
    romanization: bool = True
    updated_at: Optional[str] = None


class LanguageProfileUpdateRequest(BaseModel):
    target_languages: List[LanguageCode] = Field(default_factory=list)
    active_language: LanguageCode = "tagalog"
    level: LanguageLevel = "beginner"
    daily_goal_minutes: int = Field(default=15, ge=1, le=240)
    correction_style: Literal["gentle", "strict", "immersion"] = "gentle"
    romanization: bool = True


class LanguagePracticePrompt(BaseModel):
    id: str
    mode: Literal["vocabulary", "conversation", "writing", "grammar", "listening"]
    title: str
    prompt: str
    target_phrase: str = ""
    romanization: str = ""
    translation: str = ""
    notes: str = ""
    expected_answer: str = ""


class LanguageVocabItem(BaseModel):
    id: str
    language: LanguageCode
    phrase: str
    translation: str = ""
    pronunciation: str = ""
    notes: str = ""
    tags: List[str] = Field(default_factory=list)
    review_count: int = 0
    last_reviewed_at: Optional[str] = None
    next_review_at: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class LanguageVocabCreateRequest(BaseModel):
    language: LanguageCode
    phrase: str
    translation: str = ""
    pronunciation: str = ""
    notes: str = ""
    tags: List[str] = Field(default_factory=list)


class LanguageVocabReviewRequest(BaseModel):
    remembered: bool = True


class LanguageVocabUpdateRequest(BaseModel):
    phrase: str = ""
    translation: str = ""
    pronunciation: str = ""
    notes: str = ""
    tags: List[str] = Field(default_factory=list)


class LanguageVocabNormalizeResponse(BaseModel):
    normalized_count: int = 0
    skipped_count: int = 0
    items: List[LanguageVocabItem] = Field(default_factory=list)


class LanguagePracticeSession(BaseModel):
    id: str
    language: LanguageCode
    mode: Literal["daily", "conversation", "vocabulary", "writing", "grammar", "listening"]
    minutes: int = 0
    notes: str = ""
    created_at: Optional[str] = None


class LanguagePracticeSessionCreateRequest(BaseModel):
    language: LanguageCode
    mode: Literal["daily", "conversation", "vocabulary", "writing", "grammar", "listening"] = "daily"
    minutes: int = Field(default=10, ge=0, le=240)
    notes: str = ""


class LanguagePracticeSessionUpdateRequest(BaseModel):
    language: Optional[LanguageCode] = None
    mode: Optional[
        Literal["daily", "conversation", "vocabulary", "writing", "grammar", "listening"]
    ] = None
    minutes: Optional[int] = Field(default=None, ge=0, le=240)
    notes: Optional[str] = None


class LanguageProgressSummary(BaseModel):
    sessions_count: int = 0
    minutes_practiced: int = 0
    vocab_count: int = 0
    due_reviews: int = 0
    today_minutes: int = 0
    language_minutes: int = 0
    language_sessions_count: int = 0


class LanguageProgressByLanguage(BaseModel):
    language: LanguageCode
    today_minutes: int = 0
    total_minutes: int = 0
    sessions_count: int = 0
    words_count: int = 0
    phrases_count: int = 0
    due_reviews: int = 0


class LanguageDashboardResponse(BaseModel):
    profile: LanguageProfile
    supported_languages: List[LanguageMetadata] = Field(default_factory=list)
    daily_prompts: List[LanguagePracticePrompt] = Field(default_factory=list)
    daily_focus_words: List[LanguageVocabItem] = Field(default_factory=list)
    vocab: List[LanguageVocabItem] = Field(default_factory=list)
    recent_sessions: List[LanguagePracticeSession] = Field(default_factory=list)
    progress: LanguageProgressSummary = Field(default_factory=LanguageProgressSummary)
    language_progress: List[LanguageProgressByLanguage] = Field(default_factory=list)


class LanguagePracticeGenerateRequest(BaseModel):
    language: LanguageCode
    level: LanguageLevel = "beginner"
    mode: Literal["daily", "conversation", "vocabulary", "writing", "grammar", "listening"] = "daily"
    focus: str = ""
    include_saved_vocab: bool = True


class LanguagePracticeGenerateResponse(BaseModel):
    language: LanguageCode
    level: LanguageLevel
    title: str = ""
    overview: str = ""
    prompts: List[LanguagePracticePrompt] = Field(default_factory=list)
    suggested_minutes: int = 15


class LanguageWritingFeedbackRequest(BaseModel):
    language: LanguageCode
    level: LanguageLevel = "beginner"
    prompt: str = ""
    response: str = ""
    correction_style: Literal["gentle", "strict", "immersion"] = "gentle"


class LanguageFeedbackResponse(BaseModel):
    transcript: str = ""
    target_text: str = ""
    score: int = 0
    corrected_text: str = ""
    feedback: str = ""
    strengths: List[str] = Field(default_factory=list)
    fixes: List[str] = Field(default_factory=list)
    drills: List[str] = Field(default_factory=list)


class LanguageSpeechRequest(BaseModel):
    language: LanguageCode
    text: str
    speed: Literal["slow", "normal"] = "normal"


class LanguageConversationMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = ""


class LanguageConversationRequest(BaseModel):
    language: LanguageCode
    level: LanguageLevel = "beginner"
    correction_style: Literal["gentle", "strict", "immersion"] = "gentle"
    message: str
    scenario: str = ""
    history: List[LanguageConversationMessage] = Field(default_factory=list)


class LanguageConversationResponse(BaseModel):
    reply: str = ""
    reply_romanization: str = ""
    translation: str = ""
    correction: str = ""
    suggested_user_reply: str = ""
    suggested_user_reply_romanization: str = ""
    vocab: List[LanguageVocabItem] = Field(default_factory=list)


class LanguageWordExplainRequest(BaseModel):
    language: LanguageCode
    level: LanguageLevel = "beginner"
    word: str
    translation: str = ""
    notes: str = ""


class LanguageWordExample(BaseModel):
    target: str = ""
    romanization: str = ""
    translation: str = ""
    note: str = ""


class LanguageWordExplainResponse(BaseModel):
    word: str = ""
    translation: str = ""
    romanization: str = ""
    part_of_speech: str = ""
    explanation: str = ""
    usage_notes: List[str] = Field(default_factory=list)
    examples: List[LanguageWordExample] = Field(default_factory=list)
    common_mistakes: List[str] = Field(default_factory=list)
    quick_drill: str = ""


class UserRuleCondition(BaseModel):
    field: str
    operator: str
    value: str


class UserRule(BaseModel):
    id: str
    name: str
    natural_language: str
    conditions: List[UserRuleCondition]
    target_label: str
    archive: bool
    enabled: bool
    created_at: str


class UserRuleCreateRequest(BaseModel):
    natural_language: str
    name: Optional[str] = None
    conditions: Optional[List[UserRuleCondition]] = None
    target_label: Optional[str] = None
    archive: Optional[bool] = None


class UserRuleUpdateRequest(BaseModel):
    enabled: Optional[bool] = None


class UserRuleListResponse(BaseModel):
    rules: List[UserRule]


class RuleSuggestion(BaseModel):
    natural_language: str
    name: str
    conditions: List[UserRuleCondition]
    target_label: str
    archive: bool


class RuleSuggestionResponse(BaseModel):
    suggestions: List[RuleSuggestion]


class EmailCommandRequest(BaseModel):
    command: str
    dry_run: bool = True
    gmail_query: Optional[str] = None
    action: Optional[str] = None
    target_label: Optional[str] = None
    archive: Optional[bool] = None


class EmailCommandResponse(BaseModel):
    action: str
    gmail_query: str
    description: str
    target_label: Optional[str] = None
    archive: bool = False
    affected_count: int
    has_more: bool = False
    dry_run: bool


JournalDayEntry.model_rebuild()


class JobListing(BaseModel):
    id: str
    title: str
    company: str
    location: str
    salary_range: Optional[str] = None
    apply_url: Optional[str] = None
    source_email_id: str
    source_email_subject: str
    relevance_score: int = 5
    relevance_reason: str = ""
    qualifies: bool = True
    qualification_note: str = ""
    closes_at: Optional[str] = None
    is_new: bool = False


class JobAlertsResponse(BaseModel):
    items: List[JobListing] = Field(default_factory=list)
    total: int = 0
    from_emails: int = 0


class JobAlertsJobStartResponse(BaseModel):
    job_id: str
    status: Literal["queued", "running"]


class JobAlertsJobStatus(BaseModel):
    job_id: str
    status: Literal["queued", "running", "completed", "failed"]
    processed: int = 0
    total: int = 0
    current_subject: Optional[str] = None
    result: Optional[JobAlertsResponse] = None
    error: Optional[str] = None


# ── Nutrition / Food Log ───────────────────────────────────────────────────────

class FoodLogEntry(BaseModel):
    id: str
    date: str
    name: str
    calories: float = 0
    protein_g: float = 0
    carbs_g: float = 0
    fat_g: float = 0
    meal: str = "Other"
    logged_at: str


class ManualWorkoutLog(BaseModel):
    id: str
    date: str
    type: str
    duration_minutes: int = 0
    notes: str = ""
    logged_at: str


class MealPrepItem(BaseModel):
    id: str
    name: str
    calories: float = 0
    protein_g: float = 0
    carbs_g: float = 0
    fat_g: float = 0
    notes: str = ""
    created_at: str


class MacroTargets(BaseModel):
    calories: float = 2600
    protein_g: float = 155
    carbs_g: float = 320
    fat_g: float = 75


class DailyFoodLog(BaseModel):
    date: str
    entries: List[FoodLogEntry] = Field(default_factory=list)
    manual_workout: Optional[ManualWorkoutLog] = None
    targets: MacroTargets = Field(default_factory=MacroTargets)


class FoodLogAddRequest(BaseModel):
    name: str
    calories: float = 0
    protein_g: float = 0
    carbs_g: float = 0
    fat_g: float = 0
    meal: str = "Other"


class ManualWorkoutLogRequest(BaseModel):
    type: str
    duration_minutes: int = 0
    notes: str = ""


class MealPrepCreateRequest(BaseModel):
    name: str
    calories: float = 0
    protein_g: float = 0
    carbs_g: float = 0
    fat_g: float = 0
    notes: str = ""


class MacroTargetsUpdateRequest(BaseModel):
    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float


class FoodLogHistoryResponse(BaseModel):
    days: List[DailyFoodLog] = Field(default_factory=list)


class FoodParseRequest(BaseModel):
    text: str


class FoodParseResponse(BaseModel):
    name: str
    calories: float = 0
    protein_g: float = 0
    carbs_g: float = 0
    fat_g: float = 0
    meal: str = "Other"


class FoodLogUpdateRequest(BaseModel):
    name: str
    calories: float = 0
    protein_g: float = 0
    carbs_g: float = 0
    fat_g: float = 0
    meal: str = "Other"


# ---------------------------------------------------------------------------
# People / person-page timeline
# ---------------------------------------------------------------------------

class PersonPhotoprismRef(BaseModel):
    instance_key: str
    subject_uid: str
    subject_name: str = ""


class Person(BaseModel):
    id: str
    canonical_name: str
    aliases: List[str] = Field(default_factory=list)
    photoprism: List[PersonPhotoprismRef] = Field(default_factory=list)
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class PeopleListResponse(BaseModel):
    people: List[Person] = Field(default_factory=list)


class PersonCreateRequest(BaseModel):
    canonical_name: str
    aliases: List[str] = Field(default_factory=list)


class PersonUpdateRequest(BaseModel):
    canonical_name: Optional[str] = None
    aliases: Optional[List[str]] = None


class PersonPhotoprismRefRequest(BaseModel):
    instance_key: str
    subject_uid: str
    subject_name: str = ""


class CandidatePerson(BaseModel):
    id: str
    canonical_name: str


class PersonTimelineItem(BaseModel):
    kind: Literal["journal", "photo"]
    date: str
    sort_key: str
    # journal
    entry_id: Optional[str] = None
    matched_alias: Optional[str] = None
    snippet: Optional[str] = None
    # journal attributed via a shared alias (offer reassign in the UI)
    via_alias: Optional[str] = None
    shared: Optional[bool] = None
    candidates: Optional[List[CandidatePerson]] = None
    # photo
    uid: Optional[str] = None
    thumb_url: Optional[str] = None
    instance_key: Optional[str] = None


class PersonTimelineResponse(BaseModel):
    id: str
    canonical_name: str
    aliases: List[str] = Field(default_factory=list)
    photoprism: List[PersonPhotoprismRef] = Field(default_factory=list)
    timeline: List[PersonTimelineItem] = Field(default_factory=list)


class PhotoprismSubject(BaseModel):
    uid: str
    name: str
    photo_count: int = 0


class PhotoprismSubjectsResponse(BaseModel):
    instance_key: str
    subjects: List[PhotoprismSubject] = Field(default_factory=list)


class ReviewQueueItem(BaseModel):
    entry_date: str
    alias: str
    snippet: str
    candidates: List[CandidatePerson] = Field(default_factory=list)


class ReviewQueueResponse(BaseModel):
    items: List[ReviewQueueItem] = Field(default_factory=list)


class ReviewCountResponse(BaseModel):
    count: int = 0


class MentionUpsertRequest(BaseModel):
    entry_date: str
    alias: str
    person_id: str


class MentionClearRequest(BaseModel):
    entry_date: str
    alias: str


class AliasDefaultRequest(BaseModel):
    alias: str
    person_id: str


class AliasDefaultClearRequest(BaseModel):
    alias: str
