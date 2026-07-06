from datetime import date, datetime
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
import os

load_dotenv()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
GMAIL_TOKEN_FILE = os.getenv("GMAIL_TOKEN_FILE", "token.json")
GMAIL_CREDENTIALS_FILE = os.getenv("GMAIL_CREDENTIALS_FILE", "credentials.json")
GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]
CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.events"]
GOOGLE_SCOPES = [*GMAIL_SCOPES, *CALENDAR_SCOPES]
GOOGLE_OAUTH_BASE_URL = os.getenv("GOOGLE_OAUTH_BASE_URL", "").strip()
DEFAULT_TIMEZONE = os.getenv("DEFAULT_TIMEZONE", "America/Denver")
LOCAL_TIMEZONE = ZoneInfo(DEFAULT_TIMEZONE)


def today_local() -> date:
    return datetime.now(LOCAL_TIMEZONE).date()
APP_DEFAULT_USER_ID = os.getenv("APP_DEFAULT_USER_ID", "local-default-user")
ASSISTANT_CHAT_DB = os.getenv("ASSISTANT_CHAT_DB", "data/assistant_chat.db")
LANGUAGE_DB = os.getenv("LANGUAGE_DB", "data/language_learning.db")
OPENAI_MAX_EMAILS_PER_RUN = int(os.getenv("OPENAI_MAX_EMAILS_PER_RUN", "15"))
OPENAI_EMAIL_BODY_PREVIEW_CHARS = int(os.getenv("OPENAI_EMAIL_BODY_PREVIEW_CHARS", "0"))
OPENAI_PLANNING_TIMEOUT_SECONDS = float(os.getenv("OPENAI_PLANNING_TIMEOUT_SECONDS", "25"))
OPENAI_PLANNING_MODEL = os.getenv("OPENAI_PLANNING_MODEL", "gpt-4.1-mini")
OPENAI_PLANNING_MAX_TOKENS = int(os.getenv("OPENAI_PLANNING_MAX_TOKENS", "1200"))
OPENAI_LANGUAGE_MODEL = os.getenv("OPENAI_LANGUAGE_MODEL", "gpt-4.1-mini")
OPENAI_LANGUAGE_MAX_TOKENS = int(os.getenv("OPENAI_LANGUAGE_MAX_TOKENS", "1400"))
# --- Journal handwriting/scripture vision extraction (Responses API) ---------
# gpt-5.4 uses the Responses API (client.responses.create), not Chat Completions.
# These are the throughput / accuracy / cost knobs — keep them env-overridable.
OPENAI_JOURNAL_VISION_MODEL = os.getenv("OPENAI_JOURNAL_VISION_MODEL", "gpt-5.4")
# Future triage path: bulk on the cheap high-quota model, re-run low-confidence
# fragments on the premium model. Not wired yet, but the constant reserves it.
OPENAI_JOURNAL_VISION_TRIAGE_MODEL = os.getenv("OPENAI_JOURNAL_VISION_TRIAGE_MODEL", "gpt-5.4-mini")
# "original" keeps handwriting/low-quality scans un-downscaled (do not use "high"
# / "low" for this workload). Per-page image detail.
OPENAI_JOURNAL_VISION_IMAGE_DETAIL = os.getenv("OPENAI_JOURNAL_VISION_IMAGE_DETAIL", "original")
OPENAI_JOURNAL_VISION_TIMEOUT_SECONDS = float(os.getenv("OPENAI_JOURNAL_VISION_TIMEOUT_SECONDS", "180"))
# Contiguous pages fed to the model in one call, with an overlap carried forward
# so an entry split across a group boundary is still seen whole in one group.
JOURNAL_IMPORT_BATCH_PAGES = int(os.getenv("JOURNAL_IMPORT_BATCH_PAGES", "4"))
JOURNAL_IMPORT_OVERLAP_PAGES = int(os.getenv("JOURNAL_IMPORT_OVERLAP_PAGES", "1"))
# Rasterization DPI for PDF pages -> images (high enough for handwriting).
JOURNAL_IMPORT_RASTER_DPI = int(os.getenv("JOURNAL_IMPORT_RASTER_DPI", "200"))
# Daily token cap for the free/low tier that includes gpt-5.4 (~250k/day). The
# processor tracks per-call usage and stops-and-resumes so a long run drips
# across days instead of spilling into billed rates. 0 disables the cap.
JOURNAL_IMPORT_DAILY_TOKEN_CAP = int(os.getenv("JOURNAL_IMPORT_DAILY_TOKEN_CAP", "240000"))
JOURNAL_IMPORT_DB = os.getenv("JOURNAL_IMPORT_DB", "data/journal_import.db")
OPENAI_TRANSCRIPTION_MODEL = os.getenv("OPENAI_TRANSCRIPTION_MODEL", "gpt-4o-mini-transcribe")
OPENAI_TTS_MODEL = os.getenv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts")
OPENAI_TTS_VOICE = os.getenv("OPENAI_TTS_VOICE", "cedar")
OPENAI_ASSISTANT_TIMEOUT_SECONDS = float(os.getenv("OPENAI_ASSISTANT_TIMEOUT_SECONDS", "30"))
OPENAI_ASSISTANT_MODEL = os.getenv("OPENAI_ASSISTANT_MODEL", "gpt-4.1-mini")
OPENAI_ASSISTANT_ROUTER_MODEL = os.getenv("OPENAI_ASSISTANT_ROUTER_MODEL", "gpt-5.4-mini")
OPENAI_ASSISTANT_SYNTHESIS_MODEL = os.getenv("OPENAI_ASSISTANT_SYNTHESIS_MODEL", "gpt-5.4")
OPENAI_ASSISTANT_WEB_MODEL = os.getenv("OPENAI_ASSISTANT_WEB_MODEL", OPENAI_ASSISTANT_ROUTER_MODEL)
OPENAI_ASSISTANT_MAX_TOKENS = int(os.getenv("OPENAI_ASSISTANT_MAX_TOKENS", "1400"))
DASHBOARD_CACHE_TTL_SECONDS = int(os.getenv("DASHBOARD_CACHE_TTL_SECONDS", "600"))
USAJOBS_API_KEY = os.getenv("USAJOBS_API_KEY", "")
USAJOBS_USER_AGENT = os.getenv("USAJOBS_USER_AGENT", "")
JOB_ALERTS_EMAIL_CACHE_FILE = os.getenv("JOB_ALERTS_EMAIL_CACHE_FILE", "data/job_alerts_email_cache.json")
FOOD_LOG_DB = os.getenv("FOOD_LOG_DB", "data/food_log.db")
PEOPLE_DB = os.getenv("PEOPLE_DB", "data/people.db")


def get_photoprism_instances() -> dict[str, dict[str, str]]:
    """Discover configured PhotoPrism instances from the environment.

    An instance is declared by a matched pair of env vars, keyed by an
    arbitrary instance_key (lower-cased):

        PHOTOPRISM_<KEY>_URL     e.g. PHOTOPRISM_PERSONAL_URL
        PHOTOPRISM_<KEY>_TOKEN   e.g. PHOTOPRISM_PERSONAL_TOKEN  (app password)

    Any number of instances can be configured; nothing is hardcoded. An
    instance is only returned when both its URL and TOKEN are present, so
    secrets never live in code and half-configured instances are skipped.

    Returns a mapping of instance_key -> {"base_url", "token"}.
    """
    urls: dict[str, str] = {}
    tokens: dict[str, str] = {}
    for name, value in os.environ.items():
        if not name.startswith("PHOTOPRISM_") or not value.strip():
            continue
        if name.endswith("_URL"):
            key = name[len("PHOTOPRISM_"): -len("_URL")].lower()
            if key:
                urls[key] = value.strip().rstrip("/")
        elif name.endswith("_TOKEN"):
            key = name[len("PHOTOPRISM_"): -len("_TOKEN")].lower()
            if key:
                tokens[key] = value.strip()

    return {
        key: {"base_url": urls[key], "token": tokens[key]}
        for key in sorted(urls)
        if key in tokens
    }

CORS_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ALLOWED_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000",
    ).split(",")
    if origin.strip()
]
