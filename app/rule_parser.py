import json
from typing import List, Tuple

from openai import OpenAI

from app.config import OPENAI_API_KEY
from app.user_rules import RuleCondition

_client = OpenAI(api_key=OPENAI_API_KEY)

_SYSTEM = """\
Convert a natural-language email routing rule into structured JSON. Output ONLY valid JSON.

Schema:
{
  "name": "<short descriptive rule name, ≤60 chars>",
  "conditions": [
    {"field": "<sender|subject|body|any>", "operator": "<contains|starts_with|ends_with|equals>", "value": "<lowercase string>"}
  ],
  "target_label": "<exact Gmail label name the user wants>",
  "archive": <true|false>
}

## Fields
- sender  — the full From header, e.g. "USAJOBS <no-reply@usajobs.gov>"
- subject — the email subject line
- body    — the email body or snippet
- any     — match any field (only when intent is genuinely ambiguous)

## Operators
- contains    — substring match; most common
- ends_with   — use for domain matching, e.g. "@usajobs.gov"
- starts_with — text begins with value
- equals      — exact full-string match; rarely useful

## Sender matching heuristics (most important)
1. Prefer domain-based matching — it is unambiguous and unaffected by display name changes.
   - Infer the likely domain when possible:
     "from Amazon"       → ends_with "@amazon.com"
     "from BYU"          → ends_with "@byu.edu"
     "from GitHub"       → ends_with "@github.com"
     "from LinkedIn"     → ends_with "@linkedin.com"
     "from USAJobs"      → ends_with "@usajobs.gov"
   - If you cannot confidently infer the domain, fall back to contains on the normalized name.
2. When the user writes a brand name with spaces, strip the spaces for the match value —
   email senders never have spaces inside the address or domain:
     "usa jobs"    → "usajobs"
     "linked in"   → "linkedin"
     "you tube"    → "youtube"
3. For explicit @domain patterns ("@missionary.org"), always use ends_with.
4. "from company.com" (user wrote the domain) → ends_with "@company.com".

## Subject matching
- "emails about X" / "emails with subject X" / "subject contains X" → field="subject", operator="contains"

## Compound conditions
- "from X about Y" → two conditions: sender condition AND subject condition
- "newsletters from X" — the newsletter qualifier doesn't add a separate condition; one sender condition suffices

## archive
- Default to true ("move to X" implies archive).
- Set false only if the user says "keep in inbox", "don't archive", "label as X", or "tag as X".

## General
- All values must be lowercase.
- Multiple conditions are AND-ed; keep them specific and non-redundant.
- target_label must preserve the user's exact casing (e.g. "Job Alerts", not "job alerts").
"""


def parse_rule(natural_language: str) -> dict:
    response = _client.chat.completions.create(
        model="gpt-4.1-mini",
        messages=[
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": natural_language},
        ],
        response_format={"type": "json_object"},
        max_tokens=400,
        temperature=0,
    )
    return json.loads(response.choices[0].message.content or "{}")


def parse_rule_to_fields(
    natural_language: str,
) -> Tuple[str, List[RuleCondition], str, bool]:
    data = parse_rule(natural_language)
    name = str(data.get("name") or natural_language)[:60]
    conditions = [
        RuleCondition(
            field=str(c.get("field", "any")),
            operator=str(c.get("operator", "contains")),
            value=str(c.get("value", "")).lower(),
        )
        for c in data.get("conditions", [])
        if c.get("value")
    ]
    target_label = str(data.get("target_label") or "").strip()
    archive = bool(data.get("archive", True))
    return name, conditions, target_label, archive
