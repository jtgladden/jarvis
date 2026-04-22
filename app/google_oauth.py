import os
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Optional
from urllib.parse import urlparse

from fastapi import HTTPException, Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow

from app.config import GMAIL_CREDENTIALS_FILE, GMAIL_TOKEN_FILE, GOOGLE_OAUTH_BASE_URL, GOOGLE_SCOPES

_STATE_TTL = timedelta(minutes=15)
_oauth_states: dict[str, tuple[datetime, str, str | None]] = {}
_oauth_states_lock = Lock()


def get_google_oauth_start_path() -> str:
    return "/api/google/oauth/start"


def get_google_oauth_start_url(request: Request | None = None) -> str:
    if GOOGLE_OAUTH_BASE_URL:
        return f"{GOOGLE_OAUTH_BASE_URL.rstrip('/')}{get_google_oauth_start_path()}"
    if request is not None:
        return str(request.url_for("google_oauth_start"))
    return get_google_oauth_start_path()


def get_google_oauth_instructions(request: Request | None = None) -> str:
    return (
        "Open "
        f"{get_google_oauth_start_url(request)} "
        "in your browser to authorize Google for the running container."
    )


def _build_redirect_uri(request: Request) -> str:
    if GOOGLE_OAUTH_BASE_URL:
        return f"{GOOGLE_OAUTH_BASE_URL.rstrip('/')}/api/google/oauth/callback"
    return str(request.url_for("google_oauth_callback"))


def _build_authorization_response(request: Request, redirect_uri: str) -> str:
    query = request.url.query
    if not query:
      return redirect_uri
    return f"{redirect_uri}?{query}"


def _build_flow(*, redirect_uri: str, state: Optional[str] = None) -> Flow:
    if not os.path.exists(GMAIL_CREDENTIALS_FILE):
        raise RuntimeError(
            "Google credentials are not configured. "
            f"Expected OAuth client file at {GMAIL_CREDENTIALS_FILE}."
        )

    return Flow.from_client_secrets_file(
        GMAIL_CREDENTIALS_FILE,
        scopes=GOOGLE_SCOPES,
        state=state,
        redirect_uri=redirect_uri,
    )


def begin_google_oauth(request: Request) -> str:
    redirect_uri = _build_redirect_uri(request)
    flow = _build_flow(redirect_uri=redirect_uri)
    authorization_url, state = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )

    with _oauth_states_lock:
        _prune_expired_states()
        _oauth_states[state] = (
            datetime.now(timezone.utc),
            redirect_uri,
            getattr(flow, "code_verifier", None),
        )

    return authorization_url


def finish_google_oauth(request: Request, state: str) -> Credentials:
    with _oauth_states_lock:
        _prune_expired_states()
        state_record = _oauth_states.pop(state, None)

    if state_record is None:
        raise HTTPException(status_code=400, detail="Google OAuth state is missing or expired.")

    _, redirect_uri, code_verifier = state_record
    flow = _build_flow(redirect_uri=redirect_uri, state=state)
    if code_verifier:
        flow.code_verifier = code_verifier
    authorization_response = _build_authorization_response(request, redirect_uri)
    original_insecure_transport = os.environ.get("OAUTHLIB_INSECURE_TRANSPORT")
    insecure_transport_enabled = False

    try:
        if _should_allow_insecure_transport(authorization_response):
            os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"
            insecure_transport_enabled = True

        flow.fetch_token(authorization_response=authorization_response)
    finally:
        if insecure_transport_enabled:
            if original_insecure_transport is None:
                os.environ.pop("OAUTHLIB_INSECURE_TRANSPORT", None)
            else:
                os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = original_insecure_transport

    creds = flow.credentials

    token_directory = os.path.dirname(GMAIL_TOKEN_FILE)
    if token_directory:
        os.makedirs(token_directory, exist_ok=True)

    with open(GMAIL_TOKEN_FILE, "w") as token_file:
        token_file.write(creds.to_json())

    return creds


def _prune_expired_states() -> None:
    cutoff = datetime.now(timezone.utc) - _STATE_TTL
    expired_states = [
        state for state, (created_at, _, _) in _oauth_states.items() if created_at < cutoff
    ]
    for state in expired_states:
        _oauth_states.pop(state, None)


def _should_allow_insecure_transport(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"}
