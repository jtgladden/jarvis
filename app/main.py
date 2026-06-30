import logging
import os
from threading import Lock, Thread
from time import sleep
from uuid import uuid4

from fastapi import APIRouter, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

from app.assistant import ask_jarvis_assistant
from app.assistant_chat_store import archive_chat, delete_chat, get_chat_thread, init_assistant_chat_store, list_chats
from app.calendar_client import build_calendar_preview, create_calendar_event_from_plan_item, create_calendar_events_from_plan_items, create_calendar_event_from_preview, list_upcoming_events
from app.calendar_quick_add import create_calendar_event_from_description
from app.classification_cache import get_cached_classification, init_classification_cache, save_classification, summarize_cached_classifications
from app.classification_guidance import get_classification_guidance, init_classification_guidance, update_classification_guidance
from app.classifier import IMPORTANT_LABEL, LEGACY_IMPORTANT_LABELS, LEGACY_UNIMPORTANT_LABELS, UNIMPORTANT_LABEL, classify_cleanup_email, classify_email, classify_emails_batch, classify_new_email_ai_fallback
from app.config import CORS_ALLOWED_ORIGINS, OPENAI_MAX_EMAILS_PER_RUN
from app.dashboard import generate_dashboard, invalidate_dashboard_cache
from app.gmail_client import apply_custom_rules_to_jarvis_emails, cleanup_inbox, expire_stale_important_emails, get_all_inbox_emails, get_email_by_id, get_emails_by_any_label, get_mailbox_emails, get_mailbox_emails_page, get_new_inbox_emails, get_recent_inbox_emails, list_gmail_labels, mark_email_handled, process_new_inbox_emails, trash_email, update_email
from app.google_oauth import begin_google_oauth, finish_google_oauth, get_google_oauth_instructions
from app.health import list_health_entries, sync_health_daily_entry
from app.health_store import init_health_store
from app.food_log import add_food_log_entry, add_meal_prep_item, get_daily_food_log, get_food_log_history, get_meal_prep_library, get_user_macro_targets, log_manual_workout, parse_food_description, remove_food_log_entry, remove_meal_prep_item, remove_manual_workout, update_food_log_entry, update_user_macro_targets
from app.food_log_store import init_food_log_store
from app.job_alerts import clear_email_parse_cache, get_job_alerts_cached, invalidate_job_alerts_cache, run_job_alerts_job
from app.journal import extract_journal_day_citations, get_journal, get_journal_day, save_journal_day
from app.journal_store import init_journal_store
from app.language_learning import create_language_conversation_reply, create_language_session, create_language_vocab, delete_language_session, delete_language_vocab, explain_language_word, export_language_vocab_anki, generate_language_practice, get_language_dashboard, get_language_pronunciation_feedback, get_language_writing_feedback, normalize_existing_language_vocab, review_language_vocab, synthesize_language_speech, update_language_profile, update_language_session, update_language_vocab
from app.language_store import backfill_pronunciation_from_notes, init_language_store, purge_kana_in_romanization_records, purge_kana_in_vocab_pronunciation
from app.movement import list_movement_entries, sync_movement_daily_entry
from app.movement_store import init_movement_store
from app.planner import generate_schedule_plan
from app.rules import classify_new_email_rule
from app.schemas import AssistantAskRequest, JournalDayExtract, JournalImageExtractRequest, JournalImageExtractResponse, DailyFoodLog, FoodLogAddRequest, FoodLogEntry, FoodLogHistoryResponse, FoodLogUpdateRequest, FoodParseRequest, FoodParseResponse, JobAlertsJobStartResponse, JobAlertsJobStatus, JobAlertsResponse, JobListing, MacroTargets, MacroTargetsUpdateRequest, ManualWorkoutLog, ManualWorkoutLogRequest, MealPrepCreateRequest, MealPrepItem, AssistantAskResponse, AssistantChatListResponse, AssistantChatThread, CalendarAgendaResponse, CalendarEventCreateResponse, CalendarEventPreview, CalendarQuickAddRequest, CalendarQuickAddResponse, ClassifiedEmailResponse, ClassificationGuidanceRequest, ClassificationGuidanceResponse, ClassificationOverviewResponse, CleanupJobStartResponse, CleanupJobStatus, CleanupResponse, DashboardResponse, DashboardTaskItem, DeleteEmailResponse, EmailCommandRequest, EmailCommandResponse, EmailPageResponse, EmailSummary, EmailUpdateRequest, EmailUpdateResponse, GmailLabel, HandleEmailRequest, HandleEmailResponse, HealthDailySyncRequest, HealthDailySyncResponse, HealthListResponse, JournalDayEntry, JournalDayNoteUpdateRequest, JournalResponse, LanguageCode, LanguageConversationRequest, LanguageConversationResponse, LanguageDashboardResponse, LanguageFeedbackResponse, LanguagePracticeGenerateRequest, LanguagePracticeGenerateResponse, LanguagePracticeSession, LanguagePracticeSessionCreateRequest, LanguagePracticeSessionUpdateRequest, LanguageProfile, LanguageProfileUpdateRequest, LanguageSpeechRequest, LanguageVocabCreateRequest, LanguageVocabItem, LanguageVocabNormalizeResponse, LanguageVocabReviewRequest, LanguageVocabUpdateRequest, LanguageWordExplainRequest, LanguageWordExplainResponse, LanguageWritingFeedbackRequest, MovementDailySyncRequest, MovementDailySyncResponse, MovementListResponse, PlanningCalendarBulkCreateRequest, PlanningCalendarBulkCreateResponse, PlanningCalendarCreateRequest, PlanningCalendarCreateResponse, PlanningJobStartResponse, PlanningJobStatus, PlanningRequest, PlanningResponse, RuleSuggestion, RuleSuggestionResponse, RuleProcessResponse, TaskCreateRequest, TaskListResponse, TaskUpdateRequest, UserRule, UserRuleCondition, UserRuleCreateRequest, UserRuleListResponse, UserRuleUpdateRequest, WorkoutBatchSyncRequest, WorkoutBatchSyncResponse, WorkoutListResponse, WorkoutSetEntry
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
    init_task_store()
    init_user_rules_store()
    init_health_store()
    init_movement_store()
    init_workout_store()
    init_assistant_chat_store()
    init_language_store()
    init_food_log_store()
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


@api.get("/journal/{entry_date}", response_model=JournalDayEntry)
def journal_day(entry_date: str):
    return get_journal_day(entry_date)


@api.put("/journal/{entry_date}", response_model=JournalDayEntry)
def journal_save(entry_date: str, payload: JournalDayNoteUpdateRequest):
    return save_journal_day(
        entry_date=entry_date,
        journal_entry=payload.journal_entry,
        accomplishments=payload.accomplishments,
        gratitude_entry=payload.gratitude_entry,
        scripture_study=payload.scripture_study,
        spiritual_notes=payload.spiritual_notes,
        photo_data_url=payload.photo_data_url,
        calendar_items=payload.calendar_items,
    )


@api.post("/journal/{entry_date}/extract-citations", response_model=JournalDayEntry)
def journal_extract_citations(entry_date: str, payload: JournalDayNoteUpdateRequest):
    return extract_journal_day_citations(
        entry_date=entry_date,
        journal_entry=payload.journal_entry,
        accomplishments=payload.accomplishments,
        gratitude_entry=payload.gratitude_entry,
        scripture_study=payload.scripture_study,
        spiritual_notes=payload.spiritual_notes,
        photo_data_url=payload.photo_data_url,
        calendar_items=payload.calendar_items,
    )


@api.post("/journal/extract-from-image", response_model=JournalImageExtractResponse)
def journal_extract_from_image(payload: JournalImageExtractRequest):
    import base64, re as _re
    from app.config import OPENAI_API_KEY
    from openai import OpenAI as _OpenAI

    _client = _OpenAI(api_key=OPENAI_API_KEY)

    # Strip data-URL prefix if the client sent one
    b64 = _re.sub(r"^data:[^;]+;base64,", "", payload.image_base64)
    # Validate it's real base64 before sending
    try:
        base64.b64decode(b64, validate=True)
    except Exception:
        raise ValueError("image_base64 is not valid base64")

    prompt = (
        "Transcribe this handwritten page verbatim. The page may contain entries for one or multiple dates.\n\n"
        "STEP 1 — Identify date headings. Look for any dates written as section headers or at the start of "
        "a paragraph (e.g. 'May 31', '5/31/26', 'Tuesday, May 31', 'May 31st'). Each date heading marks "
        "the start of a new entry. If there are no date headings, treat the entire page as one entry.\n\n"
        "STEP 2 — For EACH entry, transcribe every word verbatim from top to bottom within that section. "
        "Do NOT summarize, skip, or stop early. For illegible words write [illegible]. "
        "Preserve paragraph breaks with \\n\\n. The last word in the section must appear in the text.\n\n"
        "Return ONLY valid JSON:\n"
        "{\n"
        "  \"entries\": [\n"
        "    { \"detected_date\": \"yyyy-mm-dd or null\", \"text\": \"complete verbatim text for this entry\" }\n"
        "  ],\n"
        "  \"confidence\": \"high / medium / low\",\n"
        "  \"notes\": \"any issues such as blurry image or cut-off edges\"\n"
        "}"
    )

    response = _client.chat.completions.create(
        model="gpt-4o",
        max_tokens=8192,
        response_format={"type": "json_object"},
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{payload.media_type};base64,{b64}",
                            "detail": "high",
                        },
                    },
                    {"type": "text", "text": prompt},
                ],
            }
        ],
    )

    import json as _json
    choice = response.choices[0]
    raw = choice.message.content or "{}"
    print(f"[scan] finish_reason={choice.finish_reason} "
          f"tokens(prompt={response.usage.prompt_tokens} "
          f"completion={response.usage.completion_tokens} "
          f"total={response.usage.total_tokens})")
    print(f"[scan] raw response ({len(raw)} chars):\n{raw[:2000]}")
    if len(raw) > 2000:
        print(f"[scan] ... (truncated for log, full length {len(raw)})")
    data = _json.loads(raw)
    raw_entries = data.get("entries") or []
    if not isinstance(raw_entries, list):
        raw_entries = []
    entries = [
        JournalDayExtract(
            detected_date=e.get("detected_date") or None,
            text=str(e.get("text") or "").strip(),
        )
        for e in raw_entries
        if isinstance(e, dict) and str(e.get("text") or "").strip()
    ]
    result = JournalImageExtractResponse(
        entries=entries,
        confidence=data.get("confidence", "medium"),
        notes=str(data.get("notes") or "").strip(),
    )
    print(f"[scan] {len(entries)} entries — " +
          ", ".join(f"{e.detected_date or 'no-date'}:{len(e.text)}c" for e in entries))
    return result


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


app.include_router(api)
