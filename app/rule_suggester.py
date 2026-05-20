import json
import logging
import re
from collections import Counter
from typing import List

from openai import OpenAI

from app.config import OPENAI_API_KEY
from app.schemas import EmailSummary
from app.user_rules import UserRule

logger = logging.getLogger(__name__)
_client = OpenAI(api_key=OPENAI_API_KEY)

_ANGLE_BRACKET_RE = re.compile(r"<[^@>]+@([^>]+)>")
_PLAIN_ADDR_RE = re.compile(r"[^@\s]+@([^\s>]+)")

_SYSTEM = """\
You are analyzing a user's email patterns to suggest Gmail routing rules.

Given a list of frequent senders/subjects and the user's available Gmail labels, suggest
3–5 useful routing rules. Focus on:
- High-volume senders (newsletters, job alerts, notifications, automated emails)
- Senders from specific organizations/domains that belong in a dedicated folder
- Subject patterns that indicate a clear category

For each suggestion output an object with these fields:
  natural_language  — plain English description (e.g. "Emails from USAJobs go to Job Alerts")
  name              — short rule name ≤60 chars
  conditions        — array of condition objects (see below)
  target_label      — exact label name from the provided list, or a sensible new one
  archive           — true if the email should leave the inbox, false to label only

Condition object:
  field     — "sender" | "subject" | "body" | "any"
  operator  — "contains" | "ends_with" | "starts_with" | "equals"
  value     — lowercase string to match

Condition rules (same as the routing rule parser):
- Prefer domain matching for sender: ends_with "@domain.com"
- Strip spaces from brand names: "usa jobs" → "usajobs"
- All values must be lowercase
- Multiple conditions are AND-ed

Output only valid JSON: {"suggestions": [...]}
Do not suggest rules that duplicate existing ones.
Only suggest rules where the pattern is clear and the correct folder is obvious.
"""


def _extract_domain(sender: str) -> str | None:
    raw = sender.lower()
    m = _ANGLE_BRACKET_RE.search(raw)
    if m:
        return m.group(1).strip()
    m2 = _PLAIN_ADDR_RE.search(raw)
    if m2:
        return m2.group(1).strip()
    return None


def suggest_rules(
    emails: List[EmailSummary],
    existing_rules: List[UserRule],
    available_labels: List[str],
) -> list[dict]:
    domain_counter: Counter = Counter()
    for email in emails:
        domain = _extract_domain(email.sender or "")
        if domain:
            domain_counter[domain] += 1

    top_domains = domain_counter.most_common(25)
    existing_descriptions = [r.natural_language for r in existing_rules]

    user_content = (
        f"Available Gmail labels: {', '.join(available_labels[:60])}\n\n"
        f"Existing rules (do not re-suggest):\n"
        + ("\n".join(f"- {d}" for d in existing_descriptions) or "None")
        + "\n\nTop sender domains found in this mailbox (domain: email count):\n"
        + "\n".join(f"- @{domain}: {count}" for domain, count in top_domains)
        + "\n\nSuggest routing rules for the most clearly categorical patterns above."
    )

    try:
        response = _client.chat.completions.create(
            model="gpt-4.1-mini",
            messages=[
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": user_content},
            ],
            response_format={"type": "json_object"},
            max_tokens=1200,
            temperature=0.2,
        )
        data = json.loads(response.choices[0].message.content or "{}")
        return data.get("suggestions", [])
    except Exception:
        logger.exception("Failed to generate rule suggestions")
        return []
