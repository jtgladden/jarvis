import json
import logging
import os
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Optional
from urllib.parse import urlparse

from fastapi import HTTPException, Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow

from app.config import GMAIL_CREDENTIALS_FILE, GMAIL_TOKEN_FILE, GOOGLE_OAUTH_BASE_URL, GOOGLE_SCOPES

logger = logging.getLogger(__name__)

_STATE_TTL = timedelta(minutes=15)
_oauth_states_lock = Lock()

# Pending OAuth states are persisted next to the token file (the mounted /data
# volume in Docker) so they survive container restarts / redeploys. An
# in-memory-only dict loses every in-flight state on restart, which surfaces as
# "Google OAuth state is missing or expired." on the callback.
_OAUTH_STATE_FILE = os.path.join(os.path.dirname(GMAIL_TOKEN_FILE) or ".", "oauth_states.json")


def _load_states() -> dict[str, list]:
    try:
        with open(_OAUTH_STATE_FILE, "r") as state_file:
            data = json.load(state_file)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    except OSError as exc:
        logger.warning("Failed to read OAuth state file %s: %s", _OAUTH_STATE_FILE, exc)
        return {}


def _save_states(states: dict[str, list]) -> None:
    directory = os.path.dirname(_OAUTH_STATE_FILE)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(_OAUTH_STATE_FILE, "w") as state_file:
        json.dump(states, state_file)


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
        states = _load_states()
        _prune_expired_states(states)
        states[state] = [
            datetime.now(timezone.utc).isoformat(),
            redirect_uri,
            getattr(flow, "code_verifier", None),
        ]
        _save_states(states)

    return authorization_url


def finish_google_oauth(request: Request, state: str) -> Credentials:
    with _oauth_states_lock:
        states = _load_states()
        _prune_expired_states(states)
        state_record = states.pop(state, None)
        if state_record is not None:
            _save_states(states)

    if state_record is None:
        raise HTTPException(status_code=400, detail="Google OAuth state is missing or expired.")

    _, redirect_uri, code_verifier = state_record
    flow = _build_flow(redirect_uri=redirect_uri, state=state)
    if code_verifier:
        flow.code_verifier = code_verifier
    authorization_response = _build_authorization_response(request, redirect_uri)
    original_insecure_transport = os.environ.get("OAUTHLIB_INSECURE_TRANSPORT")
    original_relax_scope = os.environ.get("OAUTHLIB_RELAX_TOKEN_SCOPE")
    insecure_transport_enabled = False

    try:
        if _should_allow_insecure_transport(authorization_response):
            os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"
            insecure_transport_enabled = True

        # include_granted_scopes="true" makes Google return a scope set that
        # differs from what we requested (incremental auth folds in previously
        # granted scopes / openid). Without this, oauthlib raises
        # "Scope has changed" and the token is never written.
        os.environ["OAUTHLIB_RELAX_TOKEN_SCOPE"] = "1"

        flow.fetch_token(authorization_response=authorization_response)
    except Exception:
        logger.exception("Google OAuth token exchange failed")
        raise
    finally:
        _restore_env("OAUTHLIB_RELAX_TOKEN_SCOPE", original_relax_scope)
        if insecure_transport_enabled:
            _restore_env("OAUTHLIB_INSECURE_TRANSPORT", original_insecure_transport)

    creds = flow.credentials

    token_directory = os.path.dirname(GMAIL_TOKEN_FILE)
    if token_directory:
        os.makedirs(token_directory, exist_ok=True)

    with open(GMAIL_TOKEN_FILE, "w") as token_file:
        token_file.write(creds.to_json())

    return creds


def _prune_expired_states(states: dict[str, list]) -> None:
    cutoff = datetime.now(timezone.utc) - _STATE_TTL
    expired_states = []
    for state, record in states.items():
        try:
            created_at = datetime.fromisoformat(record[0])
        except (ValueError, IndexError, TypeError):
            expired_states.append(state)
            continue
        if created_at < cutoff:
            expired_states.append(state)
    for state in expired_states:
        states.pop(state, None)


def _restore_env(name: str, original: str | None) -> None:
    if original is None:
        os.environ.pop(name, None)
    else:
        os.environ[name] = original


def _should_allow_insecure_transport(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"}
