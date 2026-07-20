import logging
import os
from threading import Lock, Thread
from time import sleep
from uuid import uuid4

from fastapi import APIRouter, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response

from app.assistant import ask_jarvis_assistant
from app.assistant_chat_store import archive_chat, delete_chat, get_chat_thread, init_assistant_chat_store, list_chats
from app.calendar_client import build_calendar_preview, create_calendar_event_from_plan_item, create_calendar_events_from_plan_items, create_calendar_event_from_preview, list_upcoming_events
from app.calendar_quick_add import create_calendar_event_from_description
from app.classification_cache import get_cached_classification, init_classification_cache, save_classification, summarize_cached_classifications
from app.classification_guidance import get_classification_guidance, init_classification_guidance, update_classification_guidance
from app.classifier import IMPORTANT_LABEL, LEGACY_IMPORTANT_LABELS, LEGACY_UNIMPORTANT_LABELS, UNIMPORTANT_LABEL, classify_cleanup_email, classify_email, classify_emails_batch, classify_new_email_ai_fallback
from app.config import APP_DEFAULT_USER_ID, CORS_ALLOWED_ORIGINS, OPENAI_MAX_EMAILS_PER_RUN
from app.dashboard import generate_dashboard, invalidate_dashboard_cache
from app.gmail_client import apply_custom_rules_to_jarvis_emails, cleanup_inbox, expire_stale_important_emails, get_all_inbox_emails, get_email_by_id, get_emails_by_any_label, get_mailbox_emails, get_mailbox_emails_page, get_new_inbox_emails, get_recent_inbox_emails, list_gmail_labels, mark_email_handled, process_new_inbox_emails, trash_email, update_email
from app.google_oauth import begin_google_oauth, finish_google_oauth, get_google_oauth_instructions
from app.health import list_health_entries, sync_health_daily_entry
from app.health_store import init_health_store
from app.food_log import add_food_log_entry, add_meal_prep_item, get_daily_food_log, get_food_log_history, get_meal_prep_library, get_user_macro_targets, log_manual_workout, parse_food_description, remove_food_log_entry, remove_meal_prep_item, remove_manual_workout, update_food_log_entry, update_user_macro_targets
from app.food_log_store import init_food_log_store
from app.job_alerts import clear_email_parse_cache, get_job_alerts_cached, invalidate_job_alerts_cache, run_job_alerts_job
from app.journal import extract_journal_day_citations, get_journal, get_journal_day, get_journal_entry_dates, save_journal_day
from app.journal_store import init_journal_store
from app.journal_signal_extract import EXTRACTION_VERSION, run_extraction
from app.journal_signals_store import get_signals_status, init_journal_signals_store
from app.journal_patterns import compute_patterns
from app.journal_pattern_narrate import narrate_patterns_cached
from app.config import JOURNAL_PATTERN_WINDOW_DAYS, OPENAI_JOURNAL_SIGNALS_MODEL
from app.schemas import JournalPatternsResponse, SignalExtractionResponse, SignalsStatusResponse
from app.journal_scan import extract_journal_entries
from app.journal_import import (
    analyze_batch,
    commit_batch,
    delete_import_batch,
    existing_dates_for_batch,
    make_dedupe_key,
    record_usage,
    reextract_low_confidence_fragments,
)
from app.journal_ingest import entry_photo_path, page_image_path, preprocess_jpeg, rasterize_to_jpegs, save_page_image
from app.journal_import_store import (
    create_batch,
    get_batch,
    get_spend_summary,
    get_tokens_used_today,
    init_journal_import_store,
    insert_fragment,
    list_batches,
    list_fragments,
    set_batch_default_year,
    set_batch_status,
    update_fragment,
)
from app.config import JOURNAL_IMPORT_BUDGET_USD, JOURNAL_IMPORT_DAILY_TOKEN_CAP, OPENAI_JOURNAL_VISION_MODEL
from app.language_learning import create_language_conversation_reply, create_language_session, create_language_vocab, delete_language_session, delete_language_vocab, explain_language_word, export_language_vocab_anki, generate_language_practice, get_language_dashboard, get_language_pronunciation_feedback, get_language_writing_feedback, normalize_existing_language_vocab, review_language_vocab, synthesize_language_speech, update_language_profile, update_language_session, update_language_vocab
from app.language_store import backfill_pronunciation_from_notes, init_language_store, purge_kana_in_romanization_records, purge_kana_in_vocab_pronunciation
from app.people import (
    get_person_timeline,
    get_unresolved_count,
    get_unresolved_review_queue,
    list_people_summaries,
)
from app.people_store import (
    create_person,
    delete_alias_default,
    delete_journal_mention,
    delete_person,
    delete_photoprism_ref,
    init_people_store,
    set_alias_default,
    set_photoprism_ref,
    update_person,
    upsert_journal_mention,
)
from app.photoprism_client import PhotoPrismError, fetch_thumbnail, list_instance_subjects
from app.config import get_photoprism_instances
from app.movement import list_movement_entries, sync_movement_daily_entry
from app.movement_store import init_movement_store
from app.planner import generate_schedule_plan
from app.rules import classify_new_email_rule
from app.schemas import AssistantAskRequest, JournalImageExtractRequest, JournalImagesExtractRequest, JournalImageExtractResponse, JournalScanStageRequest, JournalScanBatch, JournalScanBatchListResponse, JournalScanBatchDetail, JournalScanFragment, JournalFragmentUpdateRequest, JournalBatchUpdateRequest, JournalBatchCommitRequest, JournalBatchCommitResponse, JournalDateConflict, JournalImportSpendResponse, JournalTriageRequest, JournalTriageResponse, DailyFoodLog, FoodLogAddRequest, FoodLogEntry, FoodLogHistoryResponse, FoodLogUpdateRequest, FoodParseRequest, FoodParseResponse, JobAlertsJobStartResponse, JobAlertsJobStatus, JobAlertsResponse, JobListing, MacroTargets, MacroTargetsUpdateRequest, ManualWorkoutLog, ManualWorkoutLogRequest, MealPrepCreateRequest, MealPrepItem, AssistantAskResponse, AssistantChatListResponse, AssistantChatThread, CalendarAgendaResponse, CalendarEventCreateResponse, CalendarEventPreview, CalendarQuickAddRequest, CalendarQuickAddResponse, ClassifiedEmailResponse, ClassificationGuidanceRequest, ClassificationGuidanceResponse, ClassificationOverviewResponse, CleanupJobStartResponse, CleanupJobStatus, CleanupResponse, DashboardResponse, DashboardTaskItem, DeleteEmailResponse, EmailCommandRequest, EmailCommandResponse, EmailPageResponse, EmailSummary, EmailUpdateRequest, EmailUpdateResponse, GmailLabel, HandleEmailRequest, HandleEmailResponse, HealthDailySyncRequest, HealthDailySyncResponse, HealthListResponse, JournalDayEntry, JournalDayNoteUpdateRequest, JournalEntryDatesResponse, JournalResponse, LanguageCode, LanguageConversationRequest, LanguageConversationResponse, LanguageDashboardResponse, LanguageFeedbackResponse, LanguagePracticeGenerateRequest, LanguagePracticeGenerateResponse, LanguagePracticeSession, LanguagePracticeSessionCreateRequest, LanguagePracticeSessionUpdateRequest, LanguageProfile, LanguageProfileUpdateRequest, LanguageSpeechRequest, LanguageVocabCreateRequest, LanguageVocabItem, LanguageVocabNormalizeResponse, LanguageVocabReviewRequest, LanguageVocabUpdateRequest, LanguageWordExplainRequest, LanguageWordExplainResponse, LanguageWritingFeedbackRequest, MovementDailySyncRequest, MovementDailySyncResponse, MovementListResponse, PlanningCalendarBulkCreateRequest, PlanningCalendarBulkCreateResponse, PlanningCalendarCreateRequest, PlanningCalendarCreateResponse, PlanningJobStartResponse, PlanningJobStatus, PlanningRequest, PlanningResponse, RuleSuggestion, RuleSuggestionResponse, RuleProcessResponse, TaskCreateRequest, TaskListResponse, TaskUpdateRequest, UserRule, UserRuleCondition, UserRuleCreateRequest, UserRuleListResponse, UserRuleUpdateRequest, WorkoutBatchSyncRequest, WorkoutBatchSyncResponse, WorkoutListResponse, WorkoutSetEntry, PeopleListResponse, Person, PersonCreateRequest, PersonUpdateRequest, PersonPhotoprismRefRequest, PersonTimelineResponse, PhotoprismSubjectsResponse, ReviewQueueResponse, ReviewCountResponse, MentionUpsertRequest, MentionClearRequest, AliasDefaultRequest, AliasDefaultClearRequest
from app.rule_parser import parse_rule_to_fields
from app.task_service import create_task, delete_task, list_tasks, update_task
from app.task_store import init_task_store
from app.user_rules_store import create_user_rule, delete_user_rule, init_user_rules_store, list_user_rules, set_user_rule_enabled
from app.user_context import get_default_user_context
from app.workout import list_workout_entries, sync_workout_batch
from app.workout_store import init_workout_store, save_workout_exercise_log, set_workout_override_label

app = FastAPI(title="Mail AI", version="0.1.0")
api = APIRouter(prefix="/api")
logger = logging.getLogger(__name__)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_cleanup_jobs: dict[str, CleanupJobStatus] = {}
_cleanup_jobs_lock = Lock()
_planning_jobs: dict[str, PlanningJobStatus] = {}
_planning_jobs_lock = Lock()
_job_alerts_jobs: dict[str, JobAlertsJobStatus] = {}
_job_alerts_jobs_lock = Lock()
_new_mail_sort_lock = Lock()


@app.exception_handler(RuntimeError)
async def runtime_error_handler(_: Request, exc: RuntimeError):
    return JSONResponse(status_code=500, content={"detail": str(exc)})


@app.exception_handler(ValueError)
async def value_error_handler(_: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


def _set_cleanup_job(job_id: str, **updates) -> CleanupJobStatus:
    with _cleanup_jobs_lock:
        job = _cleanup_jobs[job_id]
        _cleanup_jobs[job_id] = job.model_copy(update=updates)
        return _cleanup_jobs[job_id]


def _run_cleanup_job(job_id: str, limit: int | None, dry_run: bool) -> None:
    try:
        emails = get_all_inbox_emails(limit=limit)
        _set_cleanup_job(job_id, status="running", total=len(emails))

        def on_progress(processed: int, total: int, email: EmailSummary) -> None:
            _set_cleanup_job(
                job_id,
                status="running",
                processed=processed,
                total=total,
                current_subject=email.subject or "(No subject)",
            )

        result = cleanup_inbox(
            emails=emails,
            classify_cleanup_email_fn=classify_cleanup_email,
            dry_run=dry_run,
            progress_callback=on_progress,
        )
        _set_cleanup_job(
            job_id,
            status="completed",
            processed=result.summary.total_processed,
            total=result.summary.total_processed,
            current_subject=None,
            result=result,
        )
    except Exception as exc:
        _set_cleanup_job(
            job_id,
            status="failed",
            current_subject=None,
            error=str(exc),
        )


def _start_cleanup_job(limit: int | None, dry_run: bool) -> CleanupJobStartResponse:
    job_id = uuid4().hex
    with _cleanup_jobs_lock:
        _cleanup_jobs[job_id] = CleanupJobStatus(
            job_id=job_id,
            status="queued",
            dry_run=dry_run,
        )

    thread = Thread(target=_run_cleanup_job, args=(job_id, limit, dry_run), daemon=True)
    thread.start()
    return CleanupJobStartResponse(job_id=job_id, status="queued")


def _set_planning_job(job_id: str, **updates) -> PlanningJobStatus:
    with _planning_jobs_lock:
        job = _planning_jobs[job_id]
        _planning_jobs[job_id] = job.model_copy(update=updates)
        return _planning_jobs[job_id]


def _run_planning_job(job_id: str, goals: str, days: int) -> None:
    try:
        _set_planning_job(job_id, status="running")
        result = generate_schedule_plan(goals=goals, days=days)
        _set_planning_job(job_id, status="completed", result=result, error=None)
    except Exception as exc:
        logger.exception("Planning job failed")
        _set_planning_job(job_id, status="failed", error=str(exc))


def _start_planning_job(goals: str, days: int) -> PlanningJobStartResponse:
    job_id = uuid4().hex
    with _planning_jobs_lock:
        _planning_jobs[job_id] = PlanningJobStatus(
            job_id=job_id,
            status="queued",
            goals=goals,
            days=days,
        )

    thread = Thread(target=_run_planning_job, args=(job_id, goals, days), daemon=True)
    thread.start()
    return PlanningJobStartResponse(job_id=job_id, status="queued")


def _run_new_mail_sort_once(limit: int = 50) -> None:
    if not _new_mail_sort_lock.acquire(blocking=False):
        return

    try:
        custom_rules = [r for r in list_user_rules() if r.enabled]
        emails = get_new_inbox_emails(limit=limit, unread_only=True)
        if emails:
            process_new_inbox_emails(
                emails=emails,
                classify_rule_fn=classify_new_email_rule,
                ai_fallback_fn=classify_new_email_ai_fallback,
                dry_run=False,
                custom_rules=custom_rules,
            )
        apply_custom_rules_to_jarvis_emails(custom_rules)
        expire_stale_important_emails()
    finally:
        _new_mail_sort_lock.release()


def _new_mail_sort_loop() -> None:
    while True:
        try:
            _run_new_mail_sort_once()
        except Exception:
            pass
        sleep(60)


@app.on_event("startup")
def start_background_new_mail_sorter() -> None:
    init_classification_cache()
    init_classification_guidance()
    init_journal_store()
    init_journal_import_store()
    init_journal_signals_store()
    init_task_store()
    init_user_rules_store()
    init_health_store()
    init_movement_store()
    init_workout_store()
    init_assistant_chat_store()
    init_language_store()
    init_food_log_store()
    init_people_store()
    thread = Thread(target=_new_mail_sort_loop, daemon=True)
    thread.start()
    Thread(target=purge_kana_in_romanization_records, daemon=True).start()
    Thread(target=purge_kana_in_vocab_pronunciation, daemon=True).start()
    Thread(target=backfill_pronunciation_from_notes, daemon=True).start()


@app.get("/")
def root():
    return {"message": "Mail AI backend is running"}


@api.get("", response_model=dict[str, str], include_in_schema=False)
@api.get("/", response_model=dict[str, str])
def api_root():
    return {"message": "Mail AI backend is running"}


@api.get("/google/oauth/status")
def google_oauth_status():
    token_file = os.getenv("GMAIL_TOKEN_FILE", "token.json")
    authorized = False
    if os.path.exists(token_file):
        try:
            from google.oauth2.credentials import Credentials
            from google.auth.transport.requests import Request as GRequest
            from app.config import GOOGLE_SCOPES
            creds = Credentials.from_authorized_user_file(token_file, GOOGLE_SCOPES)
            if creds and creds.valid:
                authorized = True
            elif creds and creds.expired and creds.refresh_token:
                creds.refresh(GRequest())
                authorized = True
        except Exception:
            authorized = False
    return {
        "authorized": authorized,
        "start_path": "/api/google/oauth/start",
        "instructions": get_google_oauth_instructions(),
    }


@api.get("/google/oauth/start", name="google_oauth_start")
def google_oauth_start(request: Request):
    authorization_url = begin_google_oauth(request)
    return RedirectResponse(url=authorization_url, status_code=307)


@api.get("/google/oauth/callback", name="google_oauth_callback")
def google_oauth_callback(request: Request, state: str, code: str | None = None, error: str | None = None):
    if error:
        raise HTTPException(status_code=400, detail=f"Google OAuth was cancelled or failed: {error}")
    if not code:
        raise HTTPException(status_code=400, detail="Google OAuth callback did not include an authorization code.")

    finish_google_oauth(request, state)
    # The dashboard response carries a `google_error` flag and is cached for
    # DASHBOARD_CACHE_TTL_SECONDS. If it was cached while Google was
    # disconnected, that stale flag keeps the "Google disconnected" banner up
    # for up to the full TTL even though we just saved a fresh token. Clear the
    # cache so the next dashboard fetch reflects the reconnected state.
    invalidate_dashboard_cache()
    return HTMLResponse(
        """
        <html>
          <head>
            <title>Jarvis Google Auth Complete</title>
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                background: #0f172a;
                color: #e2e8f0;
                margin: 0;
                min-height: 100vh;
                display: grid;
                place-items: center;
                padding: 24px;
              }
              .card {
                max-width: 560px;
                background: rgba(15, 23, 42, 0.92);
                border: 1px solid rgba(148, 163, 184, 0.25);
                border-radius: 20px;
                padding: 28px;
                box-shadow: 0 20px 70px rgba(0, 0, 0, 0.35);
              }
              h1 {
                margin: 0 0 12px;
                font-size: 1.4rem;
              }
              p {
                margin: 0;
                line-height: 1.55;
                color: #cbd5e1;
              }
            </style>
          </head>
          <body>
            <div class="card">
              <h1>Google authorization complete</h1>
              <p>Jarvis saved the Google token for this container. You can close this tab and refresh the app.</p>
            </div>
          </body>
        </html>
        """
    )


@api.get("/emails", response_model=EmailPageResponse)
def list_emails(
    limit: int = Query(default=50, ge=1, le=100),
    mailbox: str = Query(default="INBOX"),
    page_token: str | None = Query(default=None),
):
    normalized_mailbox = mailbox.strip() or "INBOX"
    return get_mailbox_emails_page(
        mailbox=normalized_mailbox,
        limit=limit,
        page_token=page_token,
    )


@api.get("/emails/{message_id}/classified", response_model=ClassifiedEmailResponse)
def get_classified_email(message_id: str):
    email = get_email_by_id(message_id)
    classification = _get_or_create_classification(email)
    return ClassifiedEmailResponse(email=email, classification=classification)


@api.get("/labels", response_model=list[GmailLabel])
def list_labels():
    return list_gmail_labels()


@api.get("/classify")
def classify_emails(
    limit: int | None = Query(default=None, ge=1),
    bucket: str = Query(default="all"),
    mailbox: str = Query(default="INBOX"),
):
    user_id = get_default_user_context().user_id
    requested_limit = (
        OPENAI_MAX_EMAILS_PER_RUN if limit is None else min(limit, OPENAI_MAX_EMAILS_PER_RUN)
    )
    normalized_bucket = bucket.strip().lower()
    normalized_mailbox = mailbox.strip() or "INBOX"

    emails = get_mailbox_emails(mailbox=normalized_mailbox, limit=requested_limit)

    if normalized_bucket == "important":
        emails = [
            email
            for email in emails
            if any(label in {IMPORTANT_LABEL, *LEGACY_IMPORTANT_LABELS} for label in email.labels)
        ]
    elif normalized_bucket == "unimportant":
        emails = [
            email
            for email in emails
            if any(label in {UNIMPORTANT_LABEL, *LEGACY_UNIMPORTANT_LABELS} for label in email.labels)
        ]

    cached_results = []
    uncached_emails = []
    for email in emails:
        cached = get_cached_classification(email, user_id=user_id)
        if cached is None:
            uncached_emails.append(email)
            continue
        cached_results.append((email.id, cached.classification))

    classified_uncached = classify_emails_batch(uncached_emails)
    for email, classification in zip(uncached_emails, classified_uncached):
        save_classification(email, classification, user_id=user_id)
        cached_results.append((email.id, classification))

    classifications_by_id = {email_id: classification for email_id, classification in cached_results}
    results = [
        {
            "email": email,
            "classification": classifications_by_id[email.id],
        }
        for email in emails
        if email.id in classifications_by_id
    ]

    return results


@api.get("/overview", response_model=ClassificationOverviewResponse)
def classification_overview(
    mailbox: str = Query(default=IMPORTANT_LABEL),
    limit: int = Query(default=200, ge=1, le=1000),
):
    user_id = get_default_user_context().user_id
    return ClassificationOverviewResponse.model_validate(
        summarize_cached_classifications(mailbox=mailbox, limit=limit, user_id=user_id)
    )


@api.get("/dashboard", response_model=DashboardResponse)
def dashboard():
    return generate_dashboard()


@api.post("/assistant/ask", response_model=AssistantAskResponse)
def assistant_ask(payload: AssistantAskRequest):
    return ask_jarvis_assistant(payload)


@api.get("/assistant/chats", response_model=AssistantChatListResponse)
def assistant_chats(limit: int = Query(default=40, ge=1, le=100)):
    return list_chats(limit=limit, archived=False, user_id=get_default_user_context().user_id)


@api.get("/assistant/chats/archived", response_model=AssistantChatListResponse)
def assistant_archived_chats(limit: int = Query(default=40, ge=1, le=100)):
    return list_chats(limit=limit, archived=True, user_id=get_default_user_context().user_id)


@api.get("/assistant/chats/{chat_id}", response_model=AssistantChatThread)
def assistant_chat_thread(chat_id: str):
    return get_chat_thread(chat_id, user_id=get_default_user_context().user_id)


@api.patch("/assistant/chats/{chat_id}/archive")
def assistant_archive_chat(chat_id: str, archived: bool = Query(default=True)):
    archive_chat(chat_id, archived=archived, user_id=get_default_user_context().user_id)
    return {"ok": True, "archived": archived}


@api.delete("/assistant/chats/{chat_id}")
def assistant_delete_chat(chat_id: str):
    delete_chat(chat_id, user_id=get_default_user_context().user_id)
    return {"ok": True}


@api.get("/health", response_model=HealthListResponse)
def health(days: int = Query(default=7, ge=1, le=3650)):
    return list_health_entries(days=days)


@api.post("/health/daily", response_model=HealthDailySyncResponse)
def sync_health_daily(payload: HealthDailySyncRequest):
    response = sync_health_daily_entry(payload)
    invalidate_dashboard_cache(get_default_user_context().user_id)
    return response


@api.get("/movement", response_model=MovementListResponse)
def movement(days: int = Query(default=14, ge=1, le=60)):
    return list_movement_entries(days=days)


@api.post("/movement/daily", response_model=MovementDailySyncResponse)
def sync_movement_daily(payload: MovementDailySyncRequest):
    response = sync_movement_daily_entry(payload)
    invalidate_dashboard_cache(get_default_user_context().user_id)
    return response


@api.get("/workouts", response_model=WorkoutListResponse)
def workouts(days: int = Query(default=30, ge=1, le=365), limit: int = Query(default=100, ge=1, le=500)):
    return list_workout_entries(days=days, limit=limit)


@api.post("/workouts/sync", response_model=WorkoutBatchSyncResponse)
def sync_workouts(payload: WorkoutBatchSyncRequest):
    return sync_workout_batch(payload)


class WorkoutLabelRequest(BaseModel):
    label: str | None = None


@api.patch("/workouts/{workout_id}/label", status_code=204)
def patch_workout_label(workout_id: str, payload: WorkoutLabelRequest):
    if not set_workout_override_label(workout_id, payload.label):
        raise HTTPException(status_code=404, detail="Workout not found")


class WorkoutExerciseLogRequest(BaseModel):
    exercises: list[WorkoutSetEntry]


@api.put("/workouts/{workout_id}/exercises", status_code=204)
def put_workout_exercises(workout_id: str, payload: WorkoutExerciseLogRequest):
    if not save_workout_exercise_log(workout_id, payload.exercises):
        raise HTTPException(status_code=404, detail="Workout not found")


@api.get("/tasks", response_model=TaskListResponse)
def tasks(include_completed: bool = Query(default=True)):
    return list_tasks(include_completed=include_completed)


@api.get("/languages", response_model=LanguageDashboardResponse)
def language_dashboard():
    return get_language_dashboard()


@api.put("/languages/profile", response_model=LanguageProfile)
def put_language_profile(payload: LanguageProfileUpdateRequest):
    return update_language_profile(payload)


@api.post("/languages/vocab", response_model=LanguageVocabItem)
def post_language_vocab(payload: LanguageVocabCreateRequest):
    return create_language_vocab(payload)


@api.post("/languages/vocab/normalize-existing", response_model=LanguageVocabNormalizeResponse)
def post_language_vocab_normalize_existing():
    return normalize_existing_language_vocab()


@api.patch("/languages/vocab/{vocab_id}/review", response_model=LanguageVocabItem)
def patch_language_vocab_review(vocab_id: str, payload: LanguageVocabReviewRequest):
    return review_language_vocab(vocab_id, remembered=payload.remembered)


@api.patch("/languages/vocab/{vocab_id}", response_model=LanguageVocabItem)
def patch_language_vocab(vocab_id: str, payload: LanguageVocabUpdateRequest):
    return update_language_vocab(vocab_id, payload)


@api.delete("/languages/vocab/{vocab_id}", status_code=204)
def delete_language_vocab_route(vocab_id: str):
    delete_language_vocab(vocab_id)


@api.post("/languages/sessions", response_model=LanguagePracticeSession)
def post_language_session(payload: LanguagePracticeSessionCreateRequest):
    return create_language_session(payload)


@api.patch("/languages/sessions/{session_id}", response_model=LanguagePracticeSession)
def patch_language_session(session_id: str, payload: LanguagePracticeSessionUpdateRequest):
    try:
        return update_language_session(session_id, payload)
    except RuntimeError:
        raise HTTPException(status_code=404, detail="Practice session not found.")


@api.delete("/languages/sessions/{session_id}", status_code=204)
def delete_language_session_route(session_id: str):
    if not delete_language_session(session_id):
        raise HTTPException(status_code=404, detail="Practice session not found.")


@api.post("/languages/practice/generate", response_model=LanguagePracticeGenerateResponse)
def post_language_practice_generate(payload: LanguagePracticeGenerateRequest):
    return generate_language_practice(payload)


@api.post("/languages/feedback/writing", response_model=LanguageFeedbackResponse)
def post_language_writing_feedback(payload: LanguageWritingFeedbackRequest):
    return get_language_writing_feedback(payload)


@api.post("/languages/feedback/pronunciation", response_model=LanguageFeedbackResponse)
async def post_language_pronunciation_feedback(
    language: LanguageCode = Form(...),
    level: str = Form(default="beginner"),
    target_text: str = Form(default=""),
    audio: UploadFile = File(...),
):
    return await get_language_pronunciation_feedback(
        language=language,
        level=level,
        target_text=target_text,
        audio=audio,
    )


@api.post("/languages/speech")
def post_language_speech(payload: LanguageSpeechRequest):
    audio = synthesize_language_speech(payload)
    return Response(
        content=audio,
        media_type="audio/mpeg",
        headers={"Content-Disposition": 'inline; filename="language-practice.mp3"'},
    )


@api.get("/languages/export/anki")
def get_language_export_anki(
    language: LanguageCode | None = Query(default=None),
    scope: str = Query(default="mine"),
    tag: str | None = Query(default=None),
):
    content, filename = export_language_vocab_anki(language=language, scope=scope, tag=tag)
    return Response(
        content=content.encode("utf-8"),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@api.post("/languages/conversation", response_model=LanguageConversationResponse)
def post_language_conversation(payload: LanguageConversationRequest):
    return create_language_conversation_reply(payload)


@api.post("/languages/words/explain", response_model=LanguageWordExplainResponse)
def post_language_word_explain(payload: LanguageWordExplainRequest):
    return explain_language_word(payload)


@api.post("/tasks", response_model=DashboardTaskItem)
def create_task_route(payload: TaskCreateRequest):
    return create_task(payload)


@api.patch("/tasks/{task_id}", response_model=DashboardTaskItem)
def update_task_route(task_id: str, payload: TaskUpdateRequest):
    return update_task(task_id, payload)


@api.delete("/tasks/{task_id}")
def delete_task_route(task_id: str):
    delete_task(task_id)
    return {"deleted": True, "task_id": task_id}


@api.get("/journal", response_model=JournalResponse)
def journal(
    days: int = Query(default=14, ge=1, le=60),
    before: str | None = Query(default=None),
    saved_only: bool = Query(default=False),
    query: str = Query(default=""),
):
    return get_journal(days=days, before=before, saved_only=saved_only, query=query)


# Declared before /journal/{entry_date} so the literal path is not captured as a date param.
@api.get("/journal/entry-dates", response_model=JournalEntryDatesResponse)
def journal_entry_dates():
    return get_journal_entry_dates()


# --- Pattern-surfacing feature (Layers 1-3). Literal paths, declared before
# /journal/{entry_date} so they are not captured as a date param. ------------
@api.post("/journal/signals/extract", response_model=SignalExtractionResponse)
def journal_signals_extract(
    force: bool = Query(default=False),
    limit: int | None = Query(default=None, ge=1),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    dry_run: bool = Query(default=False),
):
    """Layer 1: (re)extract per-entry signals. Idempotent — only unextracted or
    stale entries are processed. `limit` caps API calls for a first backfill;
    `dry_run` reports what would run without calling the model."""
    return run_extraction(
        force=force, limit=limit, start_date=start_date, end_date=end_date, dry_run=dry_run
    )


@api.get("/journal/signals/status", response_model=SignalsStatusResponse)
def journal_signals_status():
    status = get_signals_status(user_id=get_default_user_context().user_id)
    return SignalsStatusResponse(
        extracted_entries=status["extracted_entries"],
        distinct_habits=status["distinct_habits"],
        distinct_themes=status["distinct_themes"],
        extraction_version=EXTRACTION_VERSION,
        model=OPENAI_JOURNAL_SIGNALS_MODEL,
    )


@api.get("/journal/patterns", response_model=JournalPatternsResponse)
def journal_patterns(
    window_days: int = Query(default=JOURNAL_PATTERN_WINDOW_DAYS, ge=1, le=365),
    as_of: str | None = Query(default=None),
    narrate: bool = Query(default=False),
    refresh: bool = Query(default=False),
):
    """Layer 2 (always) + Layer 3 (when narrate=true). Layer 2 is deterministic
    and recomputed each call; the LLM narration is cached and only regenerated
    when the findings change or refresh=true."""
    report = compute_patterns(window_days=window_days, as_of=as_of)
    if narrate:
        narration, was_cached = narrate_patterns_cached(
            report,
            window_days=window_days,
            user_id=get_default_user_context().user_id,
            refresh=refresh,
        )
        report.narration = narration
        report.narration_cached = was_cached
    return report


@api.get("/journal/{entry_date}/photo/{index}")
def get_journal_entry_photo(entry_date: str, index: int):
    """Serve a committed entry's scanned source page image by index."""
    user_id = get_default_user_context().user_id
    path = entry_photo_path(user_id, entry_date, index)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Source photo not found.")
    return FileResponse(path, media_type="image/jpeg")


@api.get("/journal/{entry_date}", response_model=JournalDayEntry)
def journal_day(entry_date: str):
    return get_journal_day(entry_date)


def _journal_owned_fields(payload: JournalDayNoteUpdateRequest) -> dict:
    """Pass through only the optional fields the client actually sent.

    A field the request omitted stays UNSET, so the stored value survives. This
    keeps a prose-only client (the iOS app sends no photo or agenda) from
    blanking the day's photo and calendar items on every save.
    """
    provided = payload.model_fields_set
    owned = {}
    if "photo_data_url" in provided:
        owned["photo_data_url"] = payload.photo_data_url
    if "calendar_items" in provided:
        owned["calendar_items"] = payload.calendar_items
    return owned


@api.put("/journal/{entry_date}", response_model=JournalDayEntry)
def journal_save(entry_date: str, payload: JournalDayNoteUpdateRequest):
    return save_journal_day(
        entry_date=entry_date,
        journal_entry=payload.journal_entry,
        scripture_study=payload.scripture_study,
        **_journal_owned_fields(payload),
    )


@api.post("/journal/{entry_date}/extract-citations", response_model=JournalDayEntry)
def journal_extract_citations(entry_date: str, payload: JournalDayNoteUpdateRequest):
    return extract_journal_day_citations(
        entry_date=entry_date,
        journal_entry=payload.journal_entry,
        scripture_study=payload.scripture_study,
        **_journal_owned_fields(payload),
    )


def _validate_base64(value: str) -> str:
    """Strip any data-URL prefix and confirm the payload is real base64."""
    import base64, re as _re

    cleaned = _re.sub(r"^data:[^;]+;base64,", "", value or "")
    try:
        base64.b64decode(cleaned, validate=True)
    except Exception:
        raise ValueError("image is not valid base64")
    return cleaned


@api.post("/journal/extract-from-image", response_model=JournalImageExtractResponse)
def journal_extract_from_image(payload: JournalImageExtractRequest):
    # The live single-page phone flow is just the 1-page case of the batch path.
    b64 = _validate_base64(payload.image_base64)
    result = extract_journal_entries(
        [b64], payload.media_type, payload.scan_target
    )
    return result.response


@api.post("/journal/extract-from-images", response_model=JournalImageExtractResponse)
def journal_extract_from_images(payload: JournalImagesExtractRequest):
    if not payload.pages:
        raise ValueError("pages must contain at least one image")
    pages = [_validate_base64(page) for page in payload.pages]
    print(f"[scan] batch request pages={len(pages)} target={payload.scan_target}")
    result = extract_journal_entries(pages, payload.media_type, payload.scan_target)
    return result.response


# --- Batch journal-import review + commit ------------------------------------


@api.post("/journal/import/scan", response_model=JournalScanBatchDetail)
def journal_scan_to_staging(payload: JournalScanStageRequest):
    """Extract one uploaded image/PDF and stage it as a batch for review.

    The date-aware alternative to /journal/extract-from-image: rather than
    merging everything into one day, each detected entry becomes a dated fragment
    the user reviews (and can re-date) at /journal/review before committing. Page
    images are rasterized, preprocessed, and cached so the reviewer can show the
    original page next to each fragment.
    """
    import base64 as _base64

    data = _base64.b64decode(_validate_base64(payload.image_base64))
    raw_pages = rasterize_to_jpegs(data, payload.media_type)
    if not raw_pages:
        raise HTTPException(status_code=422, detail="No pages found in the upload.")

    source = (payload.source_name or "").strip() or "Web scan"
    # Seed year resolution: explicit default_year, else the launching day's year.
    default_year = payload.default_year
    if default_year is None and payload.fallback_date and len(payload.fallback_date) >= 4:
        try:
            default_year = int(payload.fallback_date[:4])
        except ValueError:
            default_year = None
    batch_id = create_batch(
        source, len(raw_pages), payload.scan_target, OPENAI_JOURNAL_VISION_MODEL, default_year=default_year
    )

    pages_b64: list[str] = []
    for index, page_bytes in enumerate(raw_pages):
        processed = preprocess_jpeg(page_bytes)
        save_page_image(batch_id, index, processed)
        pages_b64.append(_base64.b64encode(processed).decode("ascii"))

    result = extract_journal_entries(pages_b64, "image/jpeg", payload.scan_target)
    record_usage(result.usage)
    if not result.entries:
        set_batch_status(batch_id, "extracted")
        raise HTTPException(status_code=422, detail="No journal entries were found in the scan.")

    for entry in result.entries:
        detected = entry.detected_date or None
        # Undated fragments fall back to the launching day (flagged, still editable).
        date_value = detected or (payload.fallback_date or None)
        insert_fragment(
            batch_id=batch_id,
            page_index=entry.start_page,
            detected_date=date_value,
            date_detected=bool(detected),
            text_markdown=entry.text,
            confidence=result.response.confidence,
            # Dedupe on the *real* detected date (None -> text-prefix key), not the
            # fallback-filled date_value: otherwise two undated entries on one page
            # both key to the fallback date and one is silently dropped.
            dedupe_key=make_dedupe_key(entry.start_page, detected, entry.text),
            source_model=result.usage.model,
            date_text=entry.date_text,
        )
    set_batch_status(batch_id, "extracted")
    return _build_batch_detail(batch_id)


def _batch_to_schema(batch: dict) -> JournalScanBatch:
    return JournalScanBatch(
        id=int(batch["id"]),
        source_file=str(batch.get("source_file") or ""),
        page_count=int(batch.get("page_count") or 0),
        scan_target=batch.get("scan_target") or "journal",
        model=str(batch.get("model") or ""),
        status=batch.get("status") or "pending",
        error=batch.get("error"),
        created_at=batch.get("created_at"),
        fragment_count=int(batch.get("fragment_count") or 0),
        pending_count=int(batch.get("pending_count") or 0),
        committed_count=int(batch.get("committed_count") or 0),
        low_confidence_count=int(batch.get("low_confidence_count") or 0),
        failed_group_count=int(batch.get("failed_group_count") or 0),
        default_year=batch.get("default_year"),
    )


def _fragment_to_schema(
    fragment: dict, anomalies: list[str] | None = None, resolved: dict | None = None
) -> JournalScanFragment:
    resolved = resolved or {}
    return JournalScanFragment(
        id=int(fragment["id"]),
        batch_id=int(fragment["batch_id"]),
        page_index=int(fragment.get("page_index") or 0),
        detected_date=fragment.get("detected_date"),
        date_text=fragment.get("date_text"),
        date_detected=bool(fragment.get("date_detected")),
        text_markdown=str(fragment.get("text_markdown") or ""),
        confidence=fragment.get("confidence") or "medium",
        status=fragment.get("status") or "pending",
        source_model=str(fragment.get("source_model") or ""),
        anomalies=anomalies or [],
        resolved_date=resolved.get("resolved_date"),
        year_inferred=bool(resolved.get("year_inferred")),
        year_rollover=bool(resolved.get("rollover")),
        created_at=fragment.get("created_at"),
    )


def _build_batch_detail(batch_id: int) -> JournalScanBatchDetail:
    batch = get_batch(batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Batch not found.")
    existing = existing_dates_for_batch(batch_id)
    analysis = analyze_batch(batch_id)
    per_fragment = analysis["per_fragment"]
    resolved = analysis["resolved"]
    return JournalScanBatchDetail(
        batch=_batch_to_schema(batch),
        fragments=[
            _fragment_to_schema(f, per_fragment.get(int(f["id"])), resolved.get(int(f["id"])))
            for f in list_fragments(batch_id)
        ],
        existing_dates=existing,
        anomaly_summary=analysis["summary"],
    )


@api.get("/journal/import/spend", response_model=JournalImportSpendResponse)
def get_journal_import_spend():
    from datetime import date as _date

    summary = get_spend_summary()
    return JournalImportSpendResponse(
        total_cost_usd=summary["total_cost_usd"],
        total_tokens=summary["total_tokens"],
        total_calls=summary["total_calls"],
        budget_usd=JOURNAL_IMPORT_BUDGET_USD,
        tokens_today=get_tokens_used_today(_date.today().isoformat()),
        daily_token_cap=JOURNAL_IMPORT_DAILY_TOKEN_CAP,
        by_model=summary["by_model"],
    )


@api.get("/journal/import/batches", response_model=JournalScanBatchListResponse)
def get_journal_import_batches():
    return JournalScanBatchListResponse(
        batches=[_batch_to_schema(batch) for batch in list_batches()]
    )


@api.get("/journal/import/batches/{batch_id}", response_model=JournalScanBatchDetail)
def get_journal_import_batch(batch_id: int):
    return _build_batch_detail(batch_id)


@api.patch("/journal/import/batches/{batch_id}", response_model=JournalScanBatchDetail)
def patch_journal_import_batch(batch_id: int, payload: JournalBatchUpdateRequest):
    """Set the batch's default_year, then re-resolve years across its fragments."""
    if get_batch(batch_id) is None:
        raise HTTPException(status_code=404, detail="Batch not found.")
    set_batch_default_year(batch_id, payload.default_year)
    return _build_batch_detail(batch_id)


@api.delete("/journal/import/batches/{batch_id}", status_code=204)
def delete_journal_import_batch(batch_id: int):
    if not delete_import_batch(batch_id):
        raise HTTPException(status_code=404, detail="Batch not found.")


@api.get("/journal/import/batches/{batch_id}/pages/{page_index}")
def get_journal_import_page_image(batch_id: int, page_index: int):
    path = page_image_path(batch_id, page_index)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Page image not found.")
    return FileResponse(path, media_type="image/jpeg")


@api.patch("/journal/import/fragments/{fragment_id}", response_model=JournalScanFragment)
def patch_journal_import_fragment(fragment_id: int, payload: JournalFragmentUpdateRequest):
    fields = payload.model_dump(exclude_unset=True)
    sets_date = "detected_date" in fields
    updated = update_fragment(
        fragment_id,
        detected_date=payload.detected_date,
        text_markdown=payload.text_markdown,
        status=payload.status,
        # A user-supplied date is authoritative — it's no longer an inferred year.
        year_inferred=False if sets_date else None,
        set_date=sets_date,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Fragment not found.")
    return _fragment_to_schema(updated)


@api.post("/journal/import/batches/{batch_id}/triage", response_model=JournalTriageResponse)
def triage_journal_import_batch(batch_id: int, payload: JournalTriageRequest):
    """Re-run low-confidence fragments on the premium model (cached pages)."""
    if get_batch(batch_id) is None:
        raise HTTPException(status_code=404, detail="Batch not found.")
    result = reextract_low_confidence_fragments(
        batch_id,
        model=payload.model or OPENAI_JOURNAL_VISION_MODEL,
        threshold=payload.threshold,
    )
    return JournalTriageResponse(**result)


@api.post("/journal/import/batches/{batch_id}/commit", response_model=JournalBatchCommitResponse)
def commit_journal_import_batch(batch_id: int, payload: JournalBatchCommitRequest):
    if get_batch(batch_id) is None:
        raise HTTPException(status_code=404, detail="Batch not found.")
    result = commit_batch(batch_id, overwrite_existing=payload.overwrite_existing)
    return JournalBatchCommitResponse(
        batch_id=result["batch_id"],
        committed_dates=result["committed_dates"],
        committed_fragment_ids=result["committed_fragment_ids"],
        conflicts=[JournalDateConflict(**c) for c in result["conflicts"]],
        skipped_undated=result["skipped_undated"],
        unresolved_years=result.get("unresolved_years", []),
    )


@api.get("/classification-guidance", response_model=ClassificationGuidanceResponse)
def get_saved_classification_guidance():
    return get_classification_guidance()


@api.put("/classification-guidance", response_model=ClassificationGuidanceResponse)
def put_saved_classification_guidance(payload: ClassificationGuidanceRequest):
    return update_classification_guidance(payload.text)


def _get_or_create_classification(email: EmailSummary):
    user_id = get_default_user_context().user_id
    cached = get_cached_classification(email, user_id=user_id)
    if cached is not None:
        return cached.classification

    classification = classify_email(email)
    save_classification(email, classification, user_id=user_id)
    return classification


@api.get("/calendar/preview/{message_id}", response_model=CalendarEventPreview)
def calendar_preview(message_id: str):
    email = get_email_by_id(message_id)
    classification = _get_or_create_classification(email)
    return build_calendar_preview(email, classification)


@api.post("/calendar/create/{message_id}", response_model=CalendarEventCreateResponse)
def calendar_create(message_id: str):
    email = get_email_by_id(message_id)
    classification = _get_or_create_classification(email)
    preview = build_calendar_preview(email, classification)
    return create_calendar_event_from_preview(preview)


@api.get("/calendar/schedule", response_model=CalendarAgendaResponse)
def calendar_schedule(
    days: int = Query(default=7, ge=1, le=60),
    max_results: int = Query(default=25, ge=1, le=200),
):
    return list_upcoming_events(days=days, max_results=max_results)


@api.post("/calendar/quick-add", response_model=CalendarQuickAddResponse)
def calendar_quick_add(payload: CalendarQuickAddRequest):
    return create_calendar_event_from_description(payload.description)


@api.post("/planning/plan", response_model=PlanningJobStartResponse)
def planning_plan(payload: PlanningRequest):
    logger.warning("Planning route entered: days=%s goals_len=%s", payload.days, len(payload.goals or ""))
    return _start_planning_job(goals=payload.goals, days=payload.days)


@api.get("/planning/jobs/{job_id}", response_model=PlanningJobStatus)
def planning_job_status(job_id: str):
    with _planning_jobs_lock:
        job = _planning_jobs.get(job_id)

    if job is None:
        raise HTTPException(status_code=404, detail="Planning job not found.")

    return job


@api.post("/planning/calendar", response_model=PlanningCalendarCreateResponse)
def planning_calendar_create(payload: PlanningCalendarCreateRequest):
    return create_calendar_event_from_plan_item(payload.item)


@api.post("/planning/calendar/bulk", response_model=PlanningCalendarBulkCreateResponse)
def planning_calendar_bulk_create(payload: PlanningCalendarBulkCreateRequest):
    return create_calendar_events_from_plan_items(payload.items)




@api.post("/cleanup/preview", response_model=CleanupJobStartResponse)
def preview_inbox_cleanup(limit: int | None = Query(default=None, ge=1)):
    return _start_cleanup_job(limit=limit, dry_run=True)


@api.post("/cleanup/apply", response_model=CleanupJobStartResponse)
def apply_inbox_cleanup(limit: int | None = Query(default=None, ge=1)):
    return _start_cleanup_job(limit=limit, dry_run=False)


@api.get("/cleanup/jobs/{job_id}", response_model=CleanupJobStatus)
def get_cleanup_job(job_id: str):
    with _cleanup_jobs_lock:
        job = _cleanup_jobs.get(job_id)

    if job is None:
        raise HTTPException(status_code=404, detail="Cleanup job not found.")

    return job


@api.post("/rules/preview-new", response_model=RuleProcessResponse)
def preview_new_email_rules(
    limit: int | None = Query(default=50, ge=1),
    unread_only: bool = Query(default=True),
):
    emails = get_new_inbox_emails(limit=limit, unread_only=unread_only)
    response = process_new_inbox_emails(
        emails=emails,
        classify_rule_fn=classify_new_email_rule,
        ai_fallback_fn=classify_new_email_ai_fallback,
        dry_run=True,
    )
    return response.model_copy(update={"unread_only": unread_only})


@api.post("/rules/apply-new", response_model=RuleProcessResponse)
def apply_new_email_rules(
    limit: int | None = Query(default=50, ge=1),
    unread_only: bool = Query(default=True),
):
    emails = get_new_inbox_emails(limit=limit, unread_only=unread_only)
    response = process_new_inbox_emails(
        emails=emails,
        classify_rule_fn=classify_new_email_rule,
        ai_fallback_fn=classify_new_email_ai_fallback,
        dry_run=False,
    )
    return response.model_copy(update={"unread_only": unread_only})


@api.post("/emails/{message_id}/handle", response_model=HandleEmailResponse)
def handle_email(message_id: str, payload: HandleEmailRequest = None):
    thread_id = payload.thread_id if payload else None
    response = mark_email_handled(message_id, thread_id=thread_id)
    invalidate_dashboard_cache(get_default_user_context().user_id)
    return response


@api.delete("/emails/{message_id}", response_model=DeleteEmailResponse)
def delete_email(message_id: str):
    trash_email(message_id)
    invalidate_dashboard_cache(get_default_user_context().user_id)
    return DeleteEmailResponse(message_id=message_id, status="trashed")


@api.patch("/emails/{message_id}", response_model=EmailUpdateResponse)
def patch_email(message_id: str, payload: EmailUpdateRequest):
    response = update_email(
        message_id=message_id,
        add_label_names=payload.add_label_names,
        remove_label_names=payload.remove_label_names,
        archive=payload.archive,
        unread=payload.unread,
    )
    invalidate_dashboard_cache(get_default_user_context().user_id)
    return response


def _rule_to_schema(rule) -> UserRule:
    return UserRule(
        id=rule.id,
        name=rule.name,
        natural_language=rule.natural_language,
        conditions=[{"field": c.field, "operator": c.operator, "value": c.value} for c in rule.conditions],
        target_label=rule.target_label,
        archive=rule.archive,
        enabled=rule.enabled,
        created_at=rule.created_at,
    )


@api.get("/email-rules", response_model=UserRuleListResponse)
def get_email_rules():
    return UserRuleListResponse(rules=[_rule_to_schema(r) for r in list_user_rules()])


@api.post("/email-rules", response_model=UserRule)
def create_email_rule(payload: UserRuleCreateRequest):
    if payload.conditions is not None and payload.target_label:
        from app.user_rules import RuleCondition as _RC
        name = (payload.name or payload.natural_language)[:60]
        conditions = [_RC(field=c.field, operator=c.operator, value=c.value.lower()) for c in payload.conditions]
        target_label = payload.target_label
        archive = payload.archive if payload.archive is not None else True
    else:
        name, conditions, target_label, archive = parse_rule_to_fields(payload.natural_language)
    if not target_label:
        raise HTTPException(status_code=400, detail="Could not determine a target label from that description.")
    if not conditions:
        raise HTTPException(status_code=400, detail="Could not determine any matching conditions from that description.")
    rule = create_user_rule(name, payload.natural_language, conditions, target_label, archive)
    return _rule_to_schema(rule)


@api.get("/email-rules/suggestions", response_model=RuleSuggestionResponse)
def get_email_rule_suggestions():
    from app.rule_suggester import suggest_rules
    emails = get_emails_by_any_label(
        [IMPORTANT_LABEL, UNIMPORTANT_LABEL, *LEGACY_IMPORTANT_LABELS, *LEGACY_UNIMPORTANT_LABELS],
        limit=150,
    )
    existing = list_user_rules()
    available_labels = [l.name for l in list_gmail_labels() if l.type == "user"]
    raw = suggest_rules(emails, existing, available_labels)
    suggestions: list[RuleSuggestion] = []
    for s in raw:
        try:
            conditions = [
                UserRuleCondition(field=str(c.get("field", "any")), operator=str(c.get("operator", "contains")), value=str(c.get("value", "")).lower())
                for c in s.get("conditions", []) if c.get("value")
            ]
            if not conditions or not s.get("target_label"):
                continue
            suggestions.append(RuleSuggestion(
                natural_language=str(s.get("natural_language", "")),
                name=str(s.get("name", ""))[:60],
                conditions=conditions,
                target_label=str(s.get("target_label", "")),
                archive=bool(s.get("archive", True)),
            ))
        except Exception:
            pass
    return RuleSuggestionResponse(suggestions=suggestions)


@api.patch("/email-rules/{rule_id}", response_model=UserRule)
def update_email_rule(rule_id: str, payload: UserRuleUpdateRequest):
    if payload.enabled is None:
        raise HTTPException(status_code=400, detail="Nothing to update.")
    rule = set_user_rule_enabled(rule_id, payload.enabled)
    if rule is None:
        raise HTTPException(status_code=404, detail="Rule not found.")
    return _rule_to_schema(rule)


@api.delete("/email-rules/{rule_id}", response_model=DeleteEmailResponse)
def delete_email_rule(rule_id: str):
    delete_user_rule(rule_id)
    return DeleteEmailResponse(message_id=rule_id, status="deleted")


@api.post("/email-commands", response_model=EmailCommandResponse)
def run_email_command(payload: EmailCommandRequest):
    from app.command_parser import parse_command
    from app.command_executor import execute_command

    if payload.gmail_query and payload.action:
        parsed = {
            "action": payload.action,
            "gmail_query": payload.gmail_query,
            "target_label": payload.target_label,
            "archive": payload.archive,
            "description": f"{payload.action} — {payload.gmail_query}",
        }
    else:
        parsed = parse_command(payload.command)

    action = str(parsed.get("action", "")).strip()
    gmail_query = str(parsed.get("gmail_query", "")).strip()
    description = str(parsed.get("description", payload.command)).strip()
    target_label = parsed.get("target_label") or payload.target_label
    archive = bool(payload.archive if payload.archive is not None else parsed.get("archive", False))

    if not action or not gmail_query:
        raise HTTPException(status_code=400, detail="Could not parse a valid action and query from that command.")

    result = execute_command(
        action=action,
        gmail_query=gmail_query,
        target_label=target_label,
        archive=archive,
        dry_run=payload.dry_run,
    )

    return EmailCommandResponse(
        action=action,
        gmail_query=gmail_query,
        description=description,
        target_label=target_label,
        archive=archive,
        affected_count=result["affected_count"],
        has_more=result.get("has_more", False),
        dry_run=payload.dry_run,
    )


def _set_job_alerts_job(job_id: str, **updates) -> JobAlertsJobStatus:
    with _job_alerts_jobs_lock:
        job = _job_alerts_jobs[job_id]
        _job_alerts_jobs[job_id] = job.model_copy(update=updates)
        return _job_alerts_jobs[job_id]


def _start_job_alerts_job() -> JobAlertsJobStartResponse:
    job_id = uuid4().hex
    with _job_alerts_jobs_lock:
        _job_alerts_jobs[job_id] = JobAlertsJobStatus(job_id=job_id, status="queued")

    def on_progress(processed: int, total: int, subject: str) -> None:
        _set_job_alerts_job(job_id, status="running", processed=processed, total=total, current_subject=subject)

    def on_done(result: JobAlertsResponse) -> None:
        _set_job_alerts_job(job_id, status="completed", processed=result.from_emails, total=result.from_emails, result=result, current_subject=None)

    def on_error(msg: str) -> None:
        _set_job_alerts_job(job_id, status="failed", error=msg, current_subject=None)

    thread = Thread(
        target=run_job_alerts_job,
        args=(job_id, on_progress, on_done, on_error),
        daemon=True,
    )
    thread.start()
    return JobAlertsJobStartResponse(job_id=job_id, status="queued")


@api.get("/job-alerts", response_model=JobAlertsResponse)
def job_alerts_cached():
    cached = get_job_alerts_cached()
    if cached is None:
        return JobAlertsResponse()
    return cached


@api.post("/job-alerts/start", response_model=JobAlertsJobStartResponse)
def job_alerts_start(force: bool = Query(default=False)):
    if force:
        invalidate_job_alerts_cache()
        clear_email_parse_cache()
    cached = get_job_alerts_cached()
    if cached is not None:
        return JobAlertsJobStartResponse(job_id="cached", status="queued")
    return _start_job_alerts_job()


@api.get("/job-alerts/jobs/{job_id}", response_model=JobAlertsJobStatus)
def job_alerts_status(job_id: str):
    if job_id == "cached":
        cached = get_job_alerts_cached()
        result = cached or JobAlertsResponse()
        return JobAlertsJobStatus(job_id="cached", status="completed", result=result)
    with _job_alerts_jobs_lock:
        job = _job_alerts_jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@api.get("/nutrition/log/{entry_date}", response_model=DailyFoodLog)
def get_nutrition_log(entry_date: str):
    return get_daily_food_log(entry_date)


@api.post("/nutrition/log/{entry_date}/entries", response_model=FoodLogEntry)
def add_nutrition_entry(entry_date: str, payload: FoodLogAddRequest):
    return add_food_log_entry(entry_date, payload)


@api.delete("/nutrition/log/{entry_date}/entries/{entry_id}", status_code=204)
def delete_nutrition_entry(entry_date: str, entry_id: str):
    remove_food_log_entry(entry_date, entry_id)


@api.post("/nutrition/log/{entry_date}/workout", response_model=ManualWorkoutLog)
def log_nutrition_workout(entry_date: str, payload: ManualWorkoutLogRequest):
    return log_manual_workout(entry_date, payload)


@api.delete("/nutrition/log/{entry_date}/workout", status_code=204)
def delete_nutrition_workout(entry_date: str):
    remove_manual_workout(entry_date)


@api.get("/nutrition/history", response_model=FoodLogHistoryResponse)
def nutrition_history(days: int = Query(default=14, ge=1, le=60)):
    return get_food_log_history(days)


@api.get("/nutrition/meal-prep", response_model=list[MealPrepItem])
def get_nutrition_meal_prep():
    return get_meal_prep_library()


@api.post("/nutrition/meal-prep", response_model=MealPrepItem)
def post_nutrition_meal_prep(payload: MealPrepCreateRequest):
    return add_meal_prep_item(payload)


@api.delete("/nutrition/meal-prep/{item_id}", status_code=204)
def delete_nutrition_meal_prep(item_id: str):
    remove_meal_prep_item(item_id)


@api.get("/nutrition/targets", response_model=MacroTargets)
def get_nutrition_targets():
    return get_user_macro_targets()


@api.put("/nutrition/targets", response_model=MacroTargets)
def put_nutrition_targets(payload: MacroTargetsUpdateRequest):
    return update_user_macro_targets(payload)


@api.post("/nutrition/parse-food", response_model=FoodParseResponse)
def post_parse_food(payload: FoodParseRequest):
    return parse_food_description(payload)


@api.put("/nutrition/log/{entry_date}/entries/{entry_id}", response_model=FoodLogEntry)
def put_nutrition_entry(entry_date: str, entry_id: str, payload: FoodLogUpdateRequest):
    entry = update_food_log_entry(entry_date, entry_id, payload)
    if not entry:
        raise HTTPException(status_code=404, detail="Entry not found")
    return entry


# ---------------------------------------------------------------------------
# People / person-page timeline (read-only merge of journal + PhotoPrism)
# ---------------------------------------------------------------------------

@api.get("/people", response_model=PeopleListResponse)
def get_people():
    return PeopleListResponse(people=[Person(**person) for person in list_people_summaries()])


@api.post("/people", response_model=Person, status_code=201)
def post_person(payload: PersonCreateRequest):
    return Person(**create_person(payload.canonical_name, payload.aliases))


# Alias disambiguation — literal paths registered BEFORE /people/{person_id}
# so e.g. DELETE /people/mentions is not captured by the {person_id} route.

@api.get("/people/review/unresolved", response_model=ReviewQueueResponse)
def get_review_unresolved():
    return ReviewQueueResponse(items=get_unresolved_review_queue())


@api.get("/people/review/count", response_model=ReviewCountResponse)
def get_review_count():
    return ReviewCountResponse(count=get_unresolved_count())


@api.post("/people/mentions", status_code=204)
def post_mention(payload: MentionUpsertRequest):
    try:
        upsert_journal_mention(
            APP_DEFAULT_USER_ID, payload.entry_date, payload.alias, payload.person_id
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@api.delete("/people/mentions", status_code=204)
def delete_mention(payload: MentionClearRequest):
    delete_journal_mention(APP_DEFAULT_USER_ID, payload.entry_date, payload.alias)


@api.put("/people/aliases/default", status_code=204)
def put_alias_default(payload: AliasDefaultRequest):
    try:
        set_alias_default(APP_DEFAULT_USER_ID, payload.alias, payload.person_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@api.delete("/people/aliases/default", status_code=204)
def delete_alias_default_route(payload: AliasDefaultClearRequest):
    delete_alias_default(APP_DEFAULT_USER_ID, payload.alias)


@api.get("/people/{person_id}", response_model=PersonTimelineResponse)
def get_person_page(person_id: str):
    timeline = get_person_timeline(person_id)
    if timeline is None:
        raise HTTPException(status_code=404, detail="Person not found.")
    return timeline


@api.patch("/people/{person_id}", response_model=Person)
def patch_person(person_id: str, payload: PersonUpdateRequest):
    try:
        return Person(**update_person(person_id, payload.canonical_name, payload.aliases))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@api.delete("/people/{person_id}", status_code=204)
def delete_person_route(person_id: str):
    if not delete_person(person_id):
        raise HTTPException(status_code=404, detail="Person not found.")


@api.put("/people/{person_id}/photoprism", response_model=Person)
def put_person_photoprism(person_id: str, payload: PersonPhotoprismRefRequest):
    try:
        return Person(**set_photoprism_ref(
            person_id, payload.instance_key, payload.subject_uid, payload.subject_name
        ))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@api.delete("/people/{person_id}/photoprism/{instance_key}/{subject_uid}", status_code=204)
def delete_person_photoprism(person_id: str, instance_key: str, subject_uid: str):
    if not delete_photoprism_ref(person_id, instance_key, subject_uid):
        raise HTTPException(status_code=404, detail="PhotoPrism reference not found.")


@api.get("/photoprism/instances", response_model=list[str])
def get_photoprism_instance_keys():
    return sorted(get_photoprism_instances().keys())


@api.get("/photoprism/{instance_key}/subjects", response_model=PhotoprismSubjectsResponse)
def get_photoprism_subjects(instance_key: str):
    try:
        subjects = list_instance_subjects(instance_key)
    except PhotoPrismError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return PhotoprismSubjectsResponse(instance_key=instance_key, subjects=subjects)


@api.get("/photoprism/{instance_key}/thumb/{hash}/{token}/{size}")
def get_photoprism_thumbnail(instance_key: str, hash: str, token: str, size: str):
    """Proxy a PhotoPrism thumbnail through the API.

    The instance's base URL is usually only reachable on the LAN (TrueNAS), so
    the browser can't embed it directly. The backend fetches it server-side and
    streams the bytes back. The preview token in the path authorizes the fetch.
    """
    try:
        content, content_type = fetch_thumbnail(instance_key, hash, token, size)
    except PhotoPrismError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    # Thumbnails are content-addressed (hash + token), so they're safe to cache hard.
    return Response(
        content=content,
        media_type=content_type,
        headers={"Cache-Control": "private, max-age=86400"},
    )


app.include_router(api)
