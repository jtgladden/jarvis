"""journal-api client (journal prose only).

The standalone journal-api service is the system of record for the two
author-written prose fields, stored as one row per (user_id, entry_date,
entry_type):

    entry_type='journal'  <-  Jarvis's journal_entry column
    entry_type='study'    <-  Jarvis's scripture_study column

Everything else on a journal day (calendar, news, photos, study links, and the
retired accomplishments/gratitude/spiritual_notes columns) stays in local
SQLite and is NOT touched by this module.

The service is replace-only: a PUT overwrites that entry_type's whole content,
so callers must always send the full body, never a fragment.

Uses only the stdlib ``urllib`` HTTP convention already used elsewhere in the
app (see ``app/photoprism_client.py`` / ``app/dashboard.py``); no new HTTP
dependency.
"""

import json
import logging
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from app.config import APP_DEFAULT_USER_ID, JOURNAL_API_BASE_URL, JOURNAL_API_USER_ID

logger = logging.getLogger(__name__)

_HTTP_TIMEOUT = 15

# entry_type values the service accepts, keyed by the Jarvis column they back.
ENTRY_TYPE_FOR_COLUMN = {
    "journal_entry": "journal",
    "scripture_study": "study",
}


class JournalAPIError(RuntimeError):
    """Raised when journal-api cannot be reached or returns an unusable response."""


def _api_user_id(user_id: str) -> str:
    """Translate Jarvis's local user_id into journal-api's.

    The default local user maps to JOURNAL_API_USER_ID (the two systems were
    populated under different ids). Any other id is passed through unchanged, so
    an explicitly-scoped caller still addresses exactly the user it named.
    """
    return JOURNAL_API_USER_ID if user_id == APP_DEFAULT_USER_ID else user_id


def _request(method: str, path: str, payload: dict | None = None):
    """Issue a request to journal-api; return the decoded body, or None on 404.

    A 404 is a normal "no entry for that day/type" answer, not a failure, so it
    is reported as None for the caller to treat as empty.
    """
    url = f"{JOURNAL_API_BASE_URL}{path}"
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = Request(url, method=method, data=data, headers=headers)
    try:
        with urlopen(request, timeout=_HTTP_TIMEOUT) as response:
            raw = response.read()
    except HTTPError as exc:
        if exc.code == 404:
            return None
        raise JournalAPIError(f"journal-api {method} {path} failed: {exc}") from exc
    except URLError as exc:
        raise JournalAPIError(f"journal-api {method} {path} failed: {exc}") from exc

    return json.loads(raw) if raw else None


def _content_of(entry) -> str:
    """Pull the content string out of a service entry payload."""
    if isinstance(entry, dict):
        return str(entry.get("content") or "")
    return ""


def get_entry_content(user_id: str, entry_date: str, entry_type: str) -> str:
    """Content for one (date, type), or "" when the service has no such entry."""
    path = f"/entries/{quote(_api_user_id(user_id), safe='')}/{quote(entry_date, safe='')}/{quote(entry_type, safe='')}"
    return _content_of(_request("GET", path))


def put_entry_content(user_id: str, entry_date: str, entry_type: str, content: str) -> str:
    """Replace the whole content for one (date, type); return what was stored.

    Replace-only: ``content`` must be the complete body for that entry_type.
    """
    path = f"/entries/{quote(_api_user_id(user_id), safe='')}/{quote(entry_date, safe='')}/{quote(entry_type, safe='')}"
    stored = _request("PUT", path, payload={"content": content})
    # The service echoes the stored row; fall back to what we sent if it doesn't.
    return _content_of(stored) if stored is not None else content


def list_entry_contents(
    user_id: str,
    entry_type: str,
    start: str | None = None,
    end: str | None = None,
) -> dict[str, str]:
    """Map entry_date -> content for one entry_type. start/end are inclusive."""
    params = {k: v for k, v in (("start", start), ("end", end)) if v}
    params["entry_type"] = entry_type
    path = f"/entries/{quote(_api_user_id(user_id), safe='')}?{urlencode(params, quote_via=quote)}"
    rows = _request("GET", path) or []
    if not isinstance(rows, list):
        return {}

    contents: dict[str, str] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        entry_date = str(row.get("entry_date") or "")
        if entry_date:
            contents[entry_date] = _content_of(row)
    return contents


def list_prose_by_date(
    user_id: str,
    start: str | None = None,
    end: str | None = None,
) -> dict[str, dict[str, str]]:
    """Map entry_date -> {"journal_entry": ..., "scripture_study": ...}.

    One list call per entry_type, merged on entry_date. Dates present for only
    one type still get a full pair, with the absent side as "".
    """
    by_date: dict[str, dict[str, str]] = {}
    for column, entry_type in ENTRY_TYPE_FOR_COLUMN.items():
        for entry_date, content in list_entry_contents(
            user_id, entry_type, start=start, end=end
        ).items():
            by_date.setdefault(entry_date, {})[column] = content

    for fields in by_date.values():
        for column in ENTRY_TYPE_FOR_COLUMN:
            fields.setdefault(column, "")
    return by_date
