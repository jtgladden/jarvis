import json
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable, List, Optional

from openai import OpenAI

from app.config import OPENAI_API_KEY, USAJOBS_API_KEY, USAJOBS_USER_AGENT
from app.gmail_client import get_emails_by_label
from app.schemas import EmailSummary, JobAlertsJobStartResponse, JobAlertsJobStatus, JobAlertsResponse, JobListing

client = OpenAI(api_key=OPENAI_API_KEY)

JOB_ALERT_LABEL = "Job Alerts"
MIN_RELEVANCE_SCORE = 5
MAX_EMAILS = 30

_cache: Optional[JobAlertsResponse] = None
_cache_ts: float = 0.0
_CACHE_TTL = 1800.0  # 30 minutes

# ── Per-email parse cache (persisted to disk) ──────────────────────────────────

_EMAIL_CACHE_FILE = "data/job_alerts_email_cache.json"
_email_cache: dict[str, list] = {}
_email_cache_lock = threading.Lock()


def _load_email_cache() -> None:
    global _email_cache
    try:
        with open(_EMAIL_CACHE_FILE) as f:
            _email_cache = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        _email_cache = {}


def _save_email_cache() -> None:
    os.makedirs(os.path.dirname(_EMAIL_CACHE_FILE), exist_ok=True)
    with open(_EMAIL_CACHE_FILE, "w") as f:
        json.dump(_email_cache, f)


_load_email_cache()

_SYSTEM_PROMPT = """You are a job alert parser for a graduating college student majoring in Political Science \
seeking entry-level positions in the US intelligence community, foreign affairs, national security, or \
foreign policy fields (CIA, DIA, NSA, DoD, State Department, congressional staff, think tanks, contractors, etc.).

Extract all individual job listings from the email. For each listing return:
- title: job title
- company: employer name
- location: city/state or "Remote" or "DC Metro" etc.
- salary_range: salary if visible, else null
- apply_url: direct application link if present in the provided links list, else null
- relevance_score: integer 1-10 based on the combined criteria below
- relevance_reason: one sentence explaining the score
- qualifies: boolean — see criteria below
- qualification_note: one sentence on why they do or don't qualify

## Scoring rules (apply strictly in this order)

STEP 1 — Check "Who May Apply" (this is the most important field):
  - "Internal to an agency", "Status Candidates", "Current Federal Employees", "ICTAP/CTAP", \
"Career Transition", or any phrase meaning current/former federal employees only:
    → set relevance_score = 1, qualifies = false.
    → qualification_note must say the position is internal-only and the user cannot apply.
    → DO NOT give a high relevance score even if the job title sounds perfect. \
The user is a new graduate with ZERO federal service history and is categorically ineligible.
  - "Open to the public", "US Citizens", "All US Citizens": proceed to Step 2.
  - If "Who May Apply" is absent or ambiguous: proceed to Step 2 but note uncertainty.

STEP 2 — Check other disqualifiers:
  - Requires 3+ years of experience → qualifies = false
  - Requires a Master's/PhD/Doctorate → qualifies = false
  - GS-13 or higher as the MINIMUM grade → qualifies = false (senior level)
  - Restricted to National Guard / Reserves members → qualifies = false
  - qualifies = true only if none of the above apply

STEP 3 — Score relevance (only matters if the job is open to public):
  - 9-10: Perfect fit — intelligence analyst, foreign affairs officer, policy analyst, DoD/IC contractor analyst \
(open to public, entry-level appropriate)
  - 7-8: Good fit — relevant field but slightly outside core target (immigration, security, diplomacy support)
  - 5-6: Marginal fit — government role, tangentially related to security/policy
  - 1-4: Poor fit OR internal-only (user cannot apply)

Return JSON: {"listings": [...]}. If no job listings found, return {"listings": []}.
"""


def _parse_jobs_from_email(email: EmailSummary) -> List[JobListing]:
    # Return cached parse result if this email was already processed
    with _email_cache_lock:
        if email.id in _email_cache:
            return [JobListing(**item) for item in _email_cache[email.id]]

    body_text = (email.body or email.snippet or "").strip()
    if not body_text:
        return []

    links_text = ""
    if email.links:
        lines = [f"- [{lnk.label}]({lnk.url})" for lnk in email.links[:40]]
        links_text = "\n\nLinks in email:\n" + "\n".join(lines)

    user_prompt = (
        f"Subject: {email.subject}\nFrom: {email.sender}\n\n"
        f"Body:\n{body_text[:4000]}{links_text}"
    )

    try:
        response = client.chat.completions.create(
            model="gpt-4.1-mini",
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0,
            response_format={"type": "json_object"},
            timeout=30,
        )
        content = response.choices[0].message.content or "{}"
        parsed = json.loads(content)
    except Exception:
        return []

    listings: List[JobListing] = []
    for i, item in enumerate(parsed.get("listings", [])):
        try:
            score = max(1, min(10, int(item.get("relevance_score", 5))))
            if score < MIN_RELEVANCE_SCORE:
                continue
            listings.append(
                JobListing(
                    id=f"{email.id}_{i}",
                    title=str(item.get("title", "Unknown Role")),
                    company=str(item.get("company", "Unknown")),
                    location=str(item.get("location", "")),
                    salary_range=item.get("salary_range") or None,
                    apply_url=item.get("apply_url") or None,
                    source_email_id=email.id,
                    source_email_subject=email.subject,
                    relevance_score=score,
                    relevance_reason=str(item.get("relevance_reason", "")),
                    qualifies=bool(item.get("qualifies", True)),
                    qualification_note=str(item.get("qualification_note", "")),
                )
            )
        except Exception:
            continue

    with _email_cache_lock:
        _email_cache[email.id] = [j.model_dump() for j in listings]
        _save_email_cache()

    return listings


# ── USAJobs API enrichment ─────────────────────────────────────────────────────

_USAJOBS_API = "https://data.usajobs.gov/api/search"

# WhoMayApply codes/phrases that mean internal federal employees only
_INTERNAL_PHRASES = (
    "internal to an agency",
    "status candidates",
    "current federal employees",
    "federal employees",
    "ictap",
    "ctap",
    "career transition",
    "merit promotion",
    "reinstatement",
    "transfer",
)
_PUBLIC_PHRASES = ("open to the public", "us citizens", "all us citizens", "public")


def _usajobs_control_number(url: str) -> Optional[str]:
    m = re.search(r"/GetJob/ViewDetails/(\d+)", url)
    return m.group(1) if m else None


def _fetch_usajobs_descriptor(control_number: str) -> Optional[dict]:
    if not USAJOBS_API_KEY or not USAJOBS_USER_AGENT:
        return None
    try:
        qs = urllib.parse.urlencode({"ControlNumber": control_number})
        req = urllib.request.Request(
            f"{_USAJOBS_API}?{qs}",
            headers={
                "Host": "data.usajobs.gov",
                "User-Agent": USAJOBS_USER_AGENT,
                "Authorization-Key": USAJOBS_API_KEY,
            },
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        items = data.get("SearchResult", {}).get("SearchResultItems", [])
        return items[0].get("MatchedObjectDescriptor", {}) if items else None
    except Exception:
        return None


def _enrich_from_usajobs(listing: JobListing) -> JobListing:
    if not listing.apply_url or "usajobs.gov" not in listing.apply_url:
        return listing

    ctrl = _usajobs_control_number(listing.apply_url)
    if not ctrl:
        return listing

    desc = _fetch_usajobs_descriptor(ctrl)
    if not desc:
        return listing

    details = desc.get("UserArea", {}).get("Details", {})
    who_may = details.get("WhoMayApply", {})
    apply_name: str = (who_may.get("Name") or "").lower().strip()
    low_grade: str = str(details.get("LowGrade") or "")

    # Determine if internal-only
    is_internal = any(p in apply_name for p in _INTERNAL_PHRASES) and not any(p in apply_name for p in _PUBLIC_PHRASES)

    if is_internal:
        return listing.model_copy(update={
            "qualifies": False,
            "qualification_note": f"Confirmed internal-only: '{who_may.get('Name', apply_name)}'. New graduates cannot apply.",
            "relevance_score": 1,
            "relevance_reason": "Internal-only position — not open to new graduates regardless of fit.",
        })

    # Grade check
    try:
        if int(low_grade) >= 13:
            return listing.model_copy(update={
                "qualifies": False,
                "qualification_note": f"Minimum grade GS-{low_grade} — requires significant prior experience.",
            })
    except (ValueError, TypeError):
        pass

    # Closing date
    closes_at: Optional[str] = desc.get("ApplicationCloseDate") or None

    # Confirmed open to public — preserve the AI's qualifies judgment, just update the note
    public_name = who_may.get("Name", "")
    note = f"Confirmed open to: {public_name}." if public_name else "Confirmed open to public."
    if low_grade:
        note += f" GS-{low_grade} minimum grade."
    return listing.model_copy(update={"qualification_note": note, "closes_at": closes_at})


def _deduplicate_listings(listings: List[JobListing]) -> List[JobListing]:
    best: dict[str, JobListing] = {}
    for listing in listings:
        key = (
            listing.apply_url.lower().strip()
            if listing.apply_url
            else f"{listing.title.lower().strip()}|{listing.company.lower().strip()}"
        )
        if key not in best or listing.relevance_score > best[key].relevance_score:
            best[key] = listing
    return list(best.values())


# ── Background job runner ──────────────────────────────────────────────────────

def run_job_alerts_job(
    job_id: str,
    progress_callback: Callable[[int, int, str], None],
    done_callback: Callable[[JobAlertsResponse], None],
    error_callback: Callable[[str], None],
) -> None:
    global _cache, _cache_ts
    try:
        emails = get_emails_by_label(JOB_ALERT_LABEL, limit=MAX_EMAILS)
        total = len(emails)

        # Pass 1: parse all emails with AI (concurrent)
        all_listings: List[JobListing] = []
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = {pool.submit(_parse_jobs_from_email, email): email for email in emails}
            for idx, fut in enumerate(as_completed(futures)):
                email = futures[fut]
                progress_callback(idx, total, email.subject or "(no subject)")
                all_listings.extend(fut.result())

        # Pass 2: enrich USAJobs listings with real API data (concurrent)
        usajobs_listings = [j for j in all_listings if j.apply_url and "usajobs.gov" in j.apply_url]
        enriched_map: dict[str, JobListing] = {}

        def _enrich_with_progress(i_listing):
            i, listing = i_listing
            progress_callback(total, total, f"Verifying {i + 1}/{len(usajobs_listings)}: {listing.title}")
            return listing.id, _enrich_from_usajobs(listing)

        with ThreadPoolExecutor(max_workers=8) as pool:
            for listing_id, enriched in pool.map(_enrich_with_progress, enumerate(usajobs_listings)):
                enriched_map[listing_id] = enriched

        all_listings = [enriched_map.get(j.id, j) for j in all_listings]

        # Deduplicate, drop below threshold, re-sort
        all_listings = _deduplicate_listings(all_listings)
        all_listings = [j for j in all_listings if j.relevance_score >= MIN_RELEVANCE_SCORE]
        all_listings.sort(key=lambda j: j.relevance_score, reverse=True)

        # Mark listings that weren't in the previous cache as new
        prev_keys: set[str] = set()
        if _cache is not None:
            for j in _cache.items:
                key = j.apply_url.lower().strip() if j.apply_url else f"{j.title.lower().strip()}|{j.company.lower().strip()}"
                prev_keys.add(key)
        if prev_keys:
            marked = []
            for j in all_listings:
                key = j.apply_url.lower().strip() if j.apply_url else f"{j.title.lower().strip()}|{j.company.lower().strip()}"
                marked.append(j.model_copy(update={"is_new": key not in prev_keys}))
            all_listings = marked

        result = JobAlertsResponse(
            items=all_listings,
            total=len(all_listings),
            from_emails=total,
        )
        _cache = result
        _cache_ts = time.monotonic()
        done_callback(result)
    except Exception as exc:
        error_callback(str(exc))


def get_job_alerts_cached() -> Optional[JobAlertsResponse]:
    if _cache is not None and time.monotonic() - _cache_ts < _CACHE_TTL:
        return _cache
    return None


def invalidate_job_alerts_cache() -> None:
    global _cache, _cache_ts
    _cache = None
    _cache_ts = 0.0


def clear_email_parse_cache() -> None:
    with _email_cache_lock:
        _email_cache.clear()
        _save_email_cache()
