"""PhotoPrism API client (read-only, API-only — never touches its MariaDB).

One instance == one base URL + one app password. There is no session: every
request authenticates directly with ``Authorization: Bearer {token}`` (the
instance's PHOTOPRISM_<KEY>_TOKEN). The thumbnail preview token is read from the
``X-Preview-Token`` response header of the photo search. Uses only the stdlib
``urllib`` HTTP convention already used elsewhere in the app (see
``app/dashboard.py`` / ``app/job_alerts.py``); no new HTTP dependency.
"""

import json
import logging
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from app.config import get_photoprism_instances

logger = logging.getLogger(__name__)

_HTTP_TIMEOUT = 15


class PhotoPrismError(RuntimeError):
    """Raised when a PhotoPrism instance cannot be reached or authenticated."""


def _http_get(base_url: str, token: str, path_query: str):
    """GET a Bearer-authenticated endpoint, returning (payload, response_headers)."""
    url = f"{base_url}{path_query}"
    request = Request(url, method="GET", headers={"Authorization": f"Bearer {token}"})
    try:
        with urlopen(request, timeout=_HTTP_TIMEOUT) as response:
            raw = response.read()
            headers = response.headers
    except (HTTPError, URLError) as exc:
        raise PhotoPrismError(f"PhotoPrism request failed for {base_url}: {exc}") from exc
    payload = json.loads(raw) if raw else {}
    return payload, headers


def _escape_query_name(name: str) -> str:
    """Escape filter-grammar operators inside a person name.

    ``&`` and ``|`` are boolean operators in PhotoPrism's search grammar, so a
    literal one in a name must be backslash-escaped before it goes into q=.
    """
    return name.replace("\\", "\\\\").replace("&", "\\&").replace("|", "\\|")


# ---------------------------------------------------------------------------
# Low-level API (explicit base_url + token — no session)
# ---------------------------------------------------------------------------

def search_photos_by_person(
    base_url: str,
    token: str,
    name: str,
    count: int = 100,
    offset: int = 0,
) -> tuple[list[dict[str, str]], str]:
    """GET photos tagged with person:"{name}".

    Uses primary=true so Hash stays top-level on each result. Returns
    ``(photos, preview_token)`` where photos are {"uid","hash","taken_at"} and
    preview_token comes from the X-Preview-Token response header.
    """
    q = f'person:"{_escape_query_name(name)}"'
    query = urlencode(
        {"count": count, "offset": offset, "primary": "true", "q": q},
        quote_via=quote,
    )
    payload, headers = _http_get(base_url, token, f"/api/v1/photos?{query}")
    preview_token = headers.get("X-Preview-Token", "") if headers else ""
    results = payload if isinstance(payload, list) else payload.get("photos", [])
    photos = [
        {
            "uid": item.get("UID", ""),
            "hash": item.get("Hash", ""),
            "taken_at": item.get("TakenAt", ""),
        }
        for item in results
        if item.get("Hash")
    ]
    return photos, preview_token


def thumb_url(base_url: str, hash: str, preview_token: str, size: str = "tile_500") -> str:
    """Build a directly-embeddable PhotoPrism thumbnail URL (token is in the path).

    Valid sizes include tile_50, tile_100, tile_224, tile_500, fit_720,
    fit_1280. These render in <img src> with no auth header — but only from a
    client that can reach the instance's base URL (a LAN/TrueNAS address). Use
    ``proxy_thumb_url`` for a URL the browser can always reach.
    """
    return f"{base_url}/api/v1/t/{hash}/{preview_token}/{size}"


def proxy_thumb_url(instance_key: str, hash: str, preview_token: str, size: str = "tile_500") -> str:
    """Build a thumbnail URL served by the Jarvis backend, not PhotoPrism directly.

    The instance's base URL is often only reachable on the LAN (e.g. a TrueNAS
    box), so embedding it in the browser fails for remote clients. This routes
    the image through the API, which fetches it server-side (see
    ``fetch_thumbnail`` and the ``/photoprism/{instance}/thumb/...`` route).
    """
    return f"/api/photoprism/{instance_key}/thumb/{hash}/{preview_token}/{size}"


def fetch_thumbnail(
    instance_key: str, hash: str, preview_token: str, size: str = "tile_500"
) -> tuple[bytes, str]:
    """Fetch a thumbnail's bytes from a configured instance, returning (bytes, content_type).

    Runs server-side so the browser never needs to reach the instance's base URL.
    The preview token authenticates the request (it lives in the path), so no
    Authorization header is sent.
    """
    instance = _instance(instance_key)
    url = f"{instance['base_url']}/api/v1/t/{hash}/{preview_token}/{size}"
    request = Request(url, method="GET")
    try:
        with urlopen(request, timeout=_HTTP_TIMEOUT) as response:
            return response.read(), response.headers.get("Content-Type", "image/jpeg")
    except (HTTPError, URLError) as exc:
        raise PhotoPrismError(f"PhotoPrism thumbnail fetch failed for {instance_key}: {exc}") from exc


def list_subjects(base_url: str, token: str, count: int = 1000) -> list[dict]:
    """GET the instance's subjects (people) with uid, name, and photo count."""
    payload, _ = _http_get(base_url, token, f"/api/v1/subjects?{urlencode({'count': count})}")
    results = payload if isinstance(payload, list) else payload.get("subjects", [])
    return [
        {
            "uid": item.get("UID", ""),
            "name": item.get("Name", ""),
            "photo_count": item.get("PhotoCount", item.get("FileCount", 0)),
        }
        for item in results
    ]


# ---------------------------------------------------------------------------
# Instance-keyed helpers (resolve base_url + token from config)
# ---------------------------------------------------------------------------

def _instance(instance_key: str) -> dict[str, str]:
    instances = get_photoprism_instances()
    instance = instances.get(instance_key)
    if instance is None:
        raise PhotoPrismError(f"PhotoPrism instance '{instance_key}' is not configured.")
    return instance


def search_person_photos(instance_key: str, name: str, count: int = 100, offset: int = 0) -> list[dict[str, str]]:
    """Search one configured instance for a person's photos, with thumb URLs."""
    instance = _instance(instance_key)
    base_url, token = instance["base_url"], instance["token"]
    photos, preview_token = search_photos_by_person(base_url, token, name, count, offset)
    for photo in photos:
        # Serve through the backend proxy: the instance base URL is often only
        # reachable on the LAN, so a direct thumb URL fails for remote browsers.
        photo["thumb_url"] = proxy_thumb_url(instance_key, photo["hash"], preview_token)
        photo["instance_key"] = instance_key
    return photos


def list_instance_subjects(instance_key: str) -> list[dict]:
    """List subjects for one configured instance (used by the seeding CLI)."""
    instance = _instance(instance_key)
    return list_subjects(instance["base_url"], instance["token"])
