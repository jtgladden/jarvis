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
CORS_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ALLOWED_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000",
    ).split(",")
    if origin.strip()
]
