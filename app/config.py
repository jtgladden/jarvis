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
# Triage path: run the bulk on the cheap high-quota model, then re-run only
# low-confidence fragments on the premium model. Makes a 300-page archive
# affordable — most tokens go to the mini tier (~2.5M/day) and only the
# uncertain minority hits the premium tier (~250k/day).
OPENAI_JOURNAL_VISION_TRIAGE_MODEL = os.getenv("OPENAI_JOURNAL_VISION_TRIAGE_MODEL", "gpt-5.4-mini")
# Fragments at or below this confidence are candidates for a premium re-run.
JOURNAL_IMPORT_LOW_CONFIDENCE = os.getenv("JOURNAL_IMPORT_LOW_CONFIDENCE", "medium")  # low | medium | high
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
# Daily token cap for the free/low tier that includes gpt-5.4 (~250k/day). This
# is the *free-tier* guard: 0 disables it. When paying, the USD budget below is
# the primary throttle and you'll usually set this to 0.
JOURNAL_IMPORT_DAILY_TOKEN_CAP = int(os.getenv("JOURNAL_IMPORT_DAILY_TOKEN_CAP", "240000"))
# Hard dollar budget for the whole import. The processor tracks estimated spend
# from per-call token usage and stops before exceeding it (resumable). A ~300pg
# archive runs well under $10 with triage. 0 disables the budget check.
JOURNAL_IMPORT_BUDGET_USD = float(os.getenv("JOURNAL_IMPORT_BUDGET_USD", "10"))

# Per-model token pricing in USD per 1M tokens (input, output), used only to
# estimate spend against the budget above. VERIFY against current OpenAI pricing
# and override via env — defaults lean slightly HIGH so the budget trips early
# rather than overspending. Format: "INPUT,OUTPUT" per million tokens.
def _price_pair(env_name: str, default: str) -> tuple[float, float]:
    raw = os.getenv(env_name, default)
    try:
        parts = [float(p.strip()) for p in raw.split(",")]
        return (parts[0], parts[1])
    except (ValueError, IndexError):
        parts = [float(p.strip()) for p in default.split(",")]
        return (parts[0], parts[1])


# {model_name: (input_$/Mtok, output_$/Mtok)}
OPENAI_JOURNAL_VISION_PRICES: dict[str, tuple[float, float]] = {
    OPENAI_JOURNAL_VISION_MODEL: _price_pair("OPENAI_JOURNAL_VISION_PRICE", "1.50,12.00"),
    OPENAI_JOURNAL_VISION_TRIAGE_MODEL: _price_pair("OPENAI_JOURNAL_VISION_TRIAGE_PRICE", "0.30,2.40"),
}
# Fallback price for an unknown model (leans high).
OPENAI_JOURNAL_VISION_PRICE_FALLBACK: tuple[float, float] = _price_pair(
    "OPENAI_JOURNAL_VISION_PRICE_FALLBACK", "1.50,12.00"
)


def estimate_vision_cost_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    """Estimated USD cost of one vision call from its token usage."""
    input_price, output_price = OPENAI_JOURNAL_VISION_PRICES.get(
        model, OPENAI_JOURNAL_VISION_PRICE_FALLBACK
    )
    return (input_tokens / 1_000_000.0) * input_price + (output_tokens / 1_000_000.0) * output_price


# Retry policy for transient Responses API failures (rate limits, 5xx, timeouts)
# during a long unattended run. Exponential backoff between attempts.
JOURNAL_IMPORT_MAX_RETRIES = int(os.getenv("JOURNAL_IMPORT_MAX_RETRIES", "4"))
JOURNAL_IMPORT_RETRY_BASE_SECONDS = float(os.getenv("JOURNAL_IMPORT_RETRY_BASE_SECONDS", "5"))
# Pre-send image cleanup (grayscale + autocontrast) to lift handwriting accuracy.
JOURNAL_IMPORT_PREPROCESS = os.getenv("JOURNAL_IMPORT_PREPROCESS", "true").lower() in {"1", "true", "yes"}
# Where rasterized source page images are cached (for review thumbnails + reuse).
JOURNAL_IMPORT_PAGES_DIR = os.getenv("JOURNAL_IMPORT_PAGES_DIR", "data/journal_import_pages")
# Permanent per-entry copies of the source page images a committed entry was
# transcribed from. Unlike JOURNAL_IMPORT_PAGES_DIR (regenerable cache, cleared
# with the batch), these survive batch deletion so the journal keeps its scan.
JOURNAL_ENTRY_PHOTOS_DIR = os.getenv("JOURNAL_ENTRY_PHOTOS_DIR", "data/journal_entry_photos")
JOURNAL_IMPORT_DB = os.getenv("JOURNAL_IMPORT_DB", "data/journal_import.db")

# --- journal-api service -----------------------------------------------------
# Standalone service that is the system of record for journal prose (the
# journal_entry / scripture_study fields). All other journal columns stay in
# the local SQLite journal_entries table.
JOURNAL_API_BASE_URL = os.getenv("JOURNAL_API_BASE_URL", "http://192.168.0.67:8008").rstrip("/")
# journal-api keys entries by its own user_id, which need not match the id Jarvis
# uses for local storage (APP_DEFAULT_USER_ID). Only outbound journal-api calls
# are remapped through this; every other store keeps its own id untouched.
JOURNAL_API_USER_ID = os.getenv("JOURNAL_API_USER_ID", "").strip() or APP_DEFAULT_USER_ID

# --- Journal pattern-surfacing feature (3-layer: extract -> analytics -> narrate) ---
# Layer 1 stores per-entry derived signals in a SEPARATE db from the source
# journal so extraction never mutates the entries it reads.
JOURNAL_SIGNALS_DB = os.getenv("JOURNAL_SIGNALS_DB", "data/journal_signals.db")
# Layer 1 extraction model. A cheap structured-extraction model is plenty here;
# gpt-5.4-mini goes through the Responses API (client.responses.create), same as
# the photo pipeline. NOTE: Layer 1 is the ONLY layer that sends raw entry prose
# to OpenAI — Layers 2 (analytics) and 3 (narration over aggregates) do not.
OPENAI_JOURNAL_SIGNALS_MODEL = os.getenv("OPENAI_JOURNAL_SIGNALS_MODEL", "gpt-5.4-mini")
OPENAI_JOURNAL_SIGNALS_TIMEOUT_SECONDS = float(os.getenv("OPENAI_JOURNAL_SIGNALS_TIMEOUT_SECONDS", "60"))
# Layer 3 narration model: turns Layer 2's computed findings into prose. It sees
# only the deterministic aggregates, never raw entries.
OPENAI_JOURNAL_NARRATE_MODEL = os.getenv("OPENAI_JOURNAL_NARRATE_MODEL", "gpt-5.4-mini")
OPENAI_JOURNAL_NARRATE_TIMEOUT_SECONDS = float(os.getenv("OPENAI_JOURNAL_NARRATE_TIMEOUT_SECONDS", "45"))
# Default rolling-window length (days) for Layer 2 trend comparison. The analytics
# compare the most-recent window against the window immediately before it.
JOURNAL_PATTERN_WINDOW_DAYS = int(os.getenv("JOURNAL_PATTERN_WINDOW_DAYS", "30"))
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
