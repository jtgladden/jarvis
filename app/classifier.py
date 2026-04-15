import json
from typing import Any

from openai import OpenAI

from app.config import OPENAI_API_KEY, OPENAI_EMAIL_BODY_PREVIEW_CHARS
from app.schemas import CleanupDecision, EmailClassification, EmailSummary

client = OpenAI(api_key=OPENAI_API_KEY)
IMPORTANT_LABEL = "Important"
UNIMPORTANT_LABEL = "Unimportant"
LEGACY_IMPORTANT_LABELS = {"AI Important", "Rules Important"}
LEGACY_UNIMPORTANT_LABELS = {"AI Unimportant", "Rules Unimportant", "Rules Security", "Rules Shopping"}

LOW_VALUE_KEYWORDS = {
    "promo",
    "promotion",
    "sale",
    "discount",
    "offer",
    "deal",
    "coupon",
    "save now",
    "limited time",
    "unsubscribe",
    "newsletter",
    "digest",
    "new features",
    "product updates",
    "recommended for you",
    "trending",
    "security alert",
    "login alert",
    "login notification",
    "new sign-in",
    "sign-in attempt",
    "verification code",
    "otp",
    "two-factor",
    "2fa",
    "password reset",
    "new device",
    "device login",
    "receipt available",
    "your order",
    "shipped",
    "delivered",
}

HIGH_VALUE_KEYWORDS = {
    "mission",
    "mom",
    "dad",
    "grandma",
    "grandpa",
    "family",
    "friend",
    "reply needed",
    "please respond",
    "can you",
    "deadline",
    "meeting",
    "invoice due",
    "bill due",
    "travel itinerary",
    "doctor",
    "appointment",
    "legal",
    "interview",
}


def _fallback_classification(raw: str | None = None, reason: str = "AI response fallback used.") -> EmailClassification:
    return EmailClassification(
        category="reference",
        importance_score=3,
        needs_reply=False,
        urgency="low",
        suggested_action="keep",
        reason=reason,
        raw=raw,
    )


def _json_chat_completion(system_prompt: str, user_prompt: str) -> tuple[dict[str, Any], str]:
    response = client.chat.completions.create(
        model="gpt-4.1-mini",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0,
        response_format={"type": "json_object"},
    )

    content = response.choices[0].message.content or "{}"
    return json.loads(content), content


def classify_email(email: EmailSummary) -> EmailClassification:
    body_preview = ""
    if OPENAI_EMAIL_BODY_PREVIEW_CHARS > 0:
        body_preview = (email.body or "")[:OPENAI_EMAIL_BODY_PREVIEW_CHARS]

    system_prompt = """
You classify emails and must return a single valid JSON object with no extra text.
Use exactly these fields:
- category: one of [action_required, meeting, reference, newsletter, promotion, receipt, spam]
- importance_score: integer 1-10
- needs_reply: boolean
- urgency: one of [low, medium, high]
- suggested_action: one of [keep, archive, label]
- reason: short explanation
""".strip()

    user_prompt = f"""
Email:
Subject: {email.subject}
From: {email.sender}
Snippet: {email.snippet}
Body: {body_preview}
""".strip()

    try:
        parsed, raw = _json_chat_completion(system_prompt, user_prompt)
    except Exception as exc:
        return _fallback_classification(reason=f"AI classification failed: {exc}")

    try:
        classification = EmailClassification.model_validate(parsed)
    except Exception:
        return _fallback_classification(raw=raw)

    return classification.model_copy(update={"raw": raw})


def _normalize_cleanup_label(label_name: str | None) -> str | None:
    if not label_name:
        return None

    cleaned = " ".join(label_name.strip().split())
    if not cleaned:
        return None

    return cleaned[:225]


def canonicalize_importance_label(label_name: str | None) -> str | None:
    cleaned = _normalize_cleanup_label(label_name)
    if not cleaned:
        return None

    if cleaned == IMPORTANT_LABEL or cleaned in LEGACY_IMPORTANT_LABELS:
        return IMPORTANT_LABEL

    if cleaned == UNIMPORTANT_LABEL or cleaned in LEGACY_UNIMPORTANT_LABELS:
        return UNIMPORTANT_LABEL

    return cleaned


def _text_for_cleanup(email: EmailSummary) -> str:
    return " ".join(
        part for part in [email.subject, email.sender, email.snippet, email.body or ""] if part
    ).lower()


def _forced_cleanup_label(email: EmailSummary) -> str | None:
    text = _text_for_cleanup(email)

    has_high_value = any(keyword in text for keyword in HIGH_VALUE_KEYWORDS)
    has_low_value = any(keyword in text for keyword in LOW_VALUE_KEYWORDS)

    if has_low_value and not has_high_value:
        return UNIMPORTANT_LABEL

    return None


def classify_cleanup_email(email: EmailSummary, existing_labels=None) -> dict:
    body_preview = (email.body or "")[:2000]
    forced_label = _forced_cleanup_label(email)

    system_prompt = """
You are planning Gmail inbox cleanup and must return a single valid JSON object with no extra text.
The goal is zero inbox for all processed messages.
Use only one of these Gmail labels: Important or Unimportant.
Choose Important for messages a person is likely to truly care about later, such as personal correspondence, mission updates from real people, work items, finance, bills, legal, health, travel, deadlines, or anything that may need follow-up.
Choose Unimportant for noisy login alerts, promotions, newsletters, low-value notifications, routine automated mail, and anything that does not deserve attention later.
Every processed message must leave the inbox after labeling.
Urgent or reply-needed messages should still be labeled Important, but they must also be archived.

Use exactly these fields:
- category: one of [action_required, meeting, reference, newsletter, promotion, receipt, spam]
- importance_score: integer 1-10
- needs_reply: boolean
- urgency: one of [low, medium, high]
- suggested_action: one of [archive, label]
- label_name: short string
- archive: boolean
- reason: short explanation
""".strip()

    user_prompt = f"""
Current labels on this email:
{", ".join(email.labels) if email.labels else "NONE"}

Email:
Subject: {email.subject}
From: {email.sender}
Snippet: {email.snippet}
Body: {body_preview}
""".strip()

    try:
        parsed, raw = _json_chat_completion(system_prompt, user_prompt)
    except Exception as exc:
        classification = _fallback_classification(reason=f"AI cleanup planning failed: {exc}")
        return {
            "classification": classification,
            "decision": CleanupDecision(
                action="archive",
                label_name=UNIMPORTANT_LABEL,
                archive=True,
                reason="Cleanup planner failed, so the message will still be archived.",
            ),
        }

    classification = _fallback_classification(raw=raw)
    try:
        classification = EmailClassification.model_validate(parsed).model_copy(update={"raw": raw})
    except Exception:
        pass

    suggested_action = parsed.get("suggested_action", "archive")
    if suggested_action not in {"archive", "label"}:
        suggested_action = "archive"

    label_name = forced_label or canonicalize_importance_label(parsed.get("label_name"))
    if label_name not in {IMPORTANT_LABEL, UNIMPORTANT_LABEL}:
        label_name = IMPORTANT_LABEL if (
            classification.needs_reply
            or classification.urgency in {"medium", "high"}
            or classification.category in {"action_required", "meeting"}
            or classification.importance_score >= 7
        ) else UNIMPORTANT_LABEL
    reason = str(
        parsed.get("reason")
        or classification.reason
        or "Cleanup plan generated and archived to maintain zero inbox."
    )
    if forced_label == UNIMPORTANT_LABEL:
        reason = "Marked unimportant by conservative automation rules for likely promotional or routine automated mail."

    decision = CleanupDecision(
        action=suggested_action,
        label_name=label_name,
        archive=True,
        reason=reason,
    )

    return {
        "classification": classification,
        "decision": decision,
    }


def classify_new_email_ai_fallback(email: EmailSummary) -> CleanupDecision:
    body_preview = (email.body or "")[:1500]

    system_prompt = """
You are classifying a new email only when hard-coded rules were inconclusive.
Return a single valid JSON object with no extra text.
Choose only one of these labels: Important or Unimportant.
Choose Important for mail that is likely worth revisiting later or that may represent a real personal, work, financial, legal, travel, health, or follow-up matter.
Choose Unimportant for routine notifications, low-value automated mail, promotions, newsletters, login/security alerts, shopping updates, and general inbox noise.

Use exactly these fields:
- label_name: one of [Important, Unimportant]
- reason: short explanation
""".strip()

    user_prompt = f"""
Email:
Subject: {email.subject}
From: {email.sender}
Snippet: {email.snippet}
Body: {body_preview}
""".strip()

    try:
        parsed, _ = _json_chat_completion(system_prompt, user_prompt)
    except Exception:
        fallback_label = IMPORTANT_LABEL if (
            "mission" in _text_for_cleanup(email)
            or "meeting" in _text_for_cleanup(email)
            or "deadline" in _text_for_cleanup(email)
        ) else UNIMPORTANT_LABEL
        return CleanupDecision(
            action="archive",
            label_name=fallback_label,
            archive=True,
            reason="AI fallback failed, so a conservative backup rule was used.",
        )

    label_name = canonicalize_importance_label(parsed.get("label_name"))
    if label_name not in {IMPORTANT_LABEL, UNIMPORTANT_LABEL}:
        label_name = UNIMPORTANT_LABEL

    reason = str(parsed.get("reason") or "Used AI fallback because hard-coded rules were inconclusive.")

    return CleanupDecision(
        action="archive",
        label_name=label_name,
        archive=True,
        reason=reason,
    )
