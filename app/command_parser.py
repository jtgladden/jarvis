import json
import logging
from typing import Optional

from openai import OpenAI

from app.config import OPENAI_API_KEY

logger = logging.getLogger(__name__)
_client = OpenAI(api_key=OPENAI_API_KEY)

_SYSTEM = """\
Convert a natural-language email command into structured JSON. Output ONLY valid JSON.

Schema:
{
  "action": "<trash|archive|mark_read|label|mark_handled>",
  "gmail_query": "<Gmail search query string>",
  "target_label": "<label name — only for 'label' action, otherwise null>",
  "archive": <true if emails should also be removed from inbox and Jarvis folders after labeling, false otherwise>,
  "description": "<plain English description of exactly what will happen>"
}

Actions:
  trash        — move emails to trash (delete)
  archive      — remove from inbox (emails stay but leave inbox)
  mark_read    — mark as read
  label        — apply a label to matching emails
  mark_handled — mark as reviewed/handled (removes Jarvis labels)

Gmail search query syntax:
  from:user@example.com         — exact sender address
  from:@domain.com              — any sender from a domain
  subject:keyword               — subject contains keyword
  label:labelname               — has a specific label (spaces → hyphens)
  is:unread                     — unread emails
  before:2024/1/1               — received before date
  after:2024/1/1                — received after date
  Combine filters with spaces (implicit AND), e.g.: from:@amazon.com subject:order
  Use (A OR B) for OR conditions, e.g.: (label:foo OR label:bar)

Jarvis label names (spaces become hyphens in Gmail queries):
  "Jarvis Important"   → label:jarvis-important
  "Jarvis Unimportant" → label:jarvis-unimportant
  "Jarvis folders" or "Jarvis labels" or "sorted by Jarvis" means BOTH:
    (label:jarvis-important OR label:jarvis-unimportant)

Rules:
  - "delete" → action: trash
  - "clear", "clean up", "get rid of" → action: trash
  - "archive" → action: archive
  - "mark read", "mark as read" → action: mark_read
  - "move to [label]" → action: label, archive: TRUE  ← ALWAYS true when "move" is used
  - "label and archive", "label and remove from jarvis", "remove from jarvis folders" → action: label, archive: true
  - "add label", "apply label", "tag as" (without any "move"/"remove" language) → action: label, archive: false
  - If the user says "move" anywhere in a label command, archive MUST be true
  - For domain matching use from:@domain.com not from:domain.com
  - When user says "in jarvis folders/labels", add the Jarvis label OR clause
  - description must be a clear, plain English summary of the action and filter,
    e.g. "Move emails from @amazon.com to Receipts (removes from Jarvis folders)"
"""


_MOVE_WORDS = {"move", "moved", "moving", "relocate", "put", "transfer"}


def parse_command(natural_language: str) -> dict:
    try:
        response = _client.chat.completions.create(
            model="gpt-4.1-mini",
            messages=[
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": natural_language},
            ],
            response_format={"type": "json_object"},
            max_tokens=300,
            temperature=0,
        )
        result = json.loads(response.choices[0].message.content or "{}")
    except Exception:
        logger.exception("Failed to parse email command")
        return {}

    # If the user used any move-intent word and we're labeling, archive must be true.
    if result.get("action") == "label":
        words = set(natural_language.lower().split())
        if words & _MOVE_WORDS:
            result["archive"] = True

    return result
