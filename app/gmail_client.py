import base64
import os.path
from email.utils import parsedate_to_datetime
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

from app.classifier import IMPORTANT_LABEL, UNIMPORTANT_LABEL
from app.config import GMAIL_SCOPES, GMAIL_TOKEN_FILE, GMAIL_CREDENTIALS_FILE
from app.schemas import CleanupDecision, CleanupItem, CleanupResponse, CleanupSummary, EmailClassification, EmailSummary, HandleEmailResponse, RuleDecision, RuleItem, RuleProcessResponse, RuleSummary

REVIEWED_LABEL = "Reviewed"


def get_gmail_service():
    creds: Optional[Credentials] = None

    if os.path.exists(GMAIL_TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(GMAIL_TOKEN_FILE, GMAIL_SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(
                GMAIL_CREDENTIALS_FILE,
                GMAIL_SCOPES,
            )
            creds = flow.run_local_server(port=0)

        with open(GMAIL_TOKEN_FILE, "w") as token:
            token.write(creds.to_json())

    return build("gmail", "v1", credentials=creds)


def _get_header(headers: list[dict], name: str) -> str:
    for header in headers:
        if header.get("name", "").lower() == name.lower():
            return header.get("value", "")
    return ""


def _decode_base64url(data: str) -> str:
    if not data:
        return ""
    padding = "=" * (-len(data) % 4)
    decoded = base64.urlsafe_b64decode(data + padding)
    return decoded.decode("utf-8", errors="ignore")


def _extract_text_from_payload(payload: dict) -> str:
    mime_type = payload.get("mimeType", "")
    body = payload.get("body", {})
    data = body.get("data")

    if mime_type == "text/plain" and data:
        return _decode_base64url(data)

    if mime_type == "text/html" and data:
        return _decode_base64url(data)

    for part in payload.get("parts", []):
        text = _extract_text_from_payload(part)
        if text:
            return text

    return ""


def get_label_maps(service) -> tuple[Dict[str, str], Dict[str, str]]:
    response = service.users().labels().list(userId="me").execute()
    id_to_name: Dict[str, str] = {}
    name_to_id: Dict[str, str] = {}

    for label in response.get("labels", []):
        label_id = label["id"]
        label_name = label["name"]
        id_to_name[label_id] = label_name
        name_to_id[label_name] = label_id

    return id_to_name, name_to_id


def _to_email_summary(full_msg: dict, label_id_to_name: Dict[str, str]) -> EmailSummary:
    payload = full_msg.get("payload", {})
    headers = payload.get("headers", [])

    subject = _get_header(headers, "Subject")
    sender = _get_header(headers, "From")
    date = _get_header(headers, "Date")
    snippet = full_msg.get("snippet", "")
    label_ids = full_msg.get("labelIds", [])
    labels = [label_id_to_name.get(label_id, label_id) for label_id in label_ids]
    body = _extract_text_from_payload(payload)

    return EmailSummary(
        id=full_msg["id"],
        thread_id=full_msg["threadId"],
        subject=subject,
        sender=sender,
        snippet=snippet,
        date=date,
        labels=labels,
        body=body[:5000] if body else None,
    )


def _fetch_message(service, msg_id: str, label_id_to_name: Dict[str, str]) -> EmailSummary:
    full_msg = (
        service.users()
        .messages()
        .get(userId="me", id=msg_id, format="full")
        .execute()
    )
    return _to_email_summary(full_msg, label_id_to_name)


def _list_inbox_message_ids(service, limit: Optional[int] = None, unread_only: bool = False) -> List[str]:
    message_ids: List[str] = []
    page_token: Optional[str] = None

    while True:
        remaining = None if limit is None else max(limit - len(message_ids), 0)
        if remaining == 0:
            break

        request_size = 100 if remaining is None else min(100, remaining)
        label_ids = ["INBOX"]
        if unread_only:
            label_ids.append("UNREAD")

        response = (
            service.users()
            .messages()
            .list(
                userId="me",
                labelIds=label_ids,
                maxResults=request_size,
                pageToken=page_token,
            )
            .execute()
        )

        messages = response.get("messages", [])
        if not messages:
            break

        message_ids.extend(msg["id"] for msg in messages)

        page_token = response.get("nextPageToken")
        if not page_token:
            break

    return message_ids


def get_recent_inbox_emails(max_results: int = 10) -> List[EmailSummary]:
    service = get_gmail_service()
    label_id_to_name, _ = get_label_maps(service)
    message_ids = _list_inbox_message_ids(service, limit=max_results, unread_only=False)
    return [_fetch_message(service, msg_id, label_id_to_name) for msg_id in message_ids]


def get_emails_by_label(label_name: str, limit: Optional[int] = None) -> List[EmailSummary]:
    service = get_gmail_service()
    label_id_to_name, name_to_id = get_label_maps(service)
    label_id = name_to_id.get(label_name)
    if not label_id:
        return []

    message_ids: List[str] = []
    page_token: Optional[str] = None

    while True:
        remaining = None if limit is None else max(limit - len(message_ids), 0)
        if remaining == 0:
            break

        request_size = 100 if remaining is None else min(100, remaining)
        response = (
            service.users()
            .messages()
            .list(
                userId="me",
                labelIds=[label_id],
                maxResults=request_size,
                pageToken=page_token,
            )
            .execute()
        )

        messages = response.get("messages", [])
        if not messages:
            break

        message_ids.extend(msg["id"] for msg in messages)

        page_token = response.get("nextPageToken")
        if not page_token:
            break

    return [_fetch_message(service, msg_id, label_id_to_name) for msg_id in message_ids]


def get_all_inbox_emails(limit: Optional[int] = None, page_size: int = 100) -> List[EmailSummary]:
    service = get_gmail_service()
    label_id_to_name, _ = get_label_maps(service)
    message_ids = _list_inbox_message_ids(service, limit=limit, unread_only=False)
    return [_fetch_message(service, msg_id, label_id_to_name) for msg_id in message_ids]


def get_new_inbox_emails(limit: Optional[int] = None, unread_only: bool = True) -> List[EmailSummary]:
    service = get_gmail_service()
    label_id_to_name, _ = get_label_maps(service)
    message_ids = _list_inbox_message_ids(service, limit=limit, unread_only=unread_only)
    return [_fetch_message(service, msg_id, label_id_to_name) for msg_id in message_ids]


def _fallback_cleanup_decision(
    email: EmailSummary,
    classification: EmailClassification,
    existing_labels: List[str] | None = None,
) -> CleanupDecision:
    fallback_label = IMPORTANT_LABEL if (
        classification.needs_reply
        or classification.urgency in {"medium", "high"}
        or classification.category in {"action_required", "meeting"}
        or classification.importance_score >= 7
    ) else UNIMPORTANT_LABEL

    return CleanupDecision(
        action="archive",
        label_name=fallback_label,
        archive=True,
        reason="Archived with a simplified fallback label.",
    )


def _get_or_create_label_id(service, label_name: str, label_name_to_id: Dict[str, str]) -> str:
    sanitized = " ".join(label_name.replace("/", " ").split()).strip()[:225]
    if not sanitized:
        sanitized = UNIMPORTANT_LABEL

    existing = label_name_to_id.get(sanitized)
    if existing:
        return existing

    created = (
        service.users()
        .labels()
        .create(
            userId="me",
            body={
                "name": sanitized,
                "labelListVisibility": "labelShow",
                "messageListVisibility": "show",
            },
        )
        .execute()
    )
    label_id = created["id"]
    label_name_to_id[sanitized] = label_id
    return label_id


def _apply_decision(service, item: CleanupItem, label_name_to_id: Dict[str, str]) -> None:
    add_label_ids: List[str] = []
    remove_label_ids: List[str] = []

    if item.decision.label_name:
        label_id = _get_or_create_label_id(service, item.decision.label_name, label_name_to_id)
        if item.decision.label_name not in item.email.labels:
            add_label_ids.append(label_id)

    if item.decision.archive and "INBOX" in item.email.labels:
        remove_label_ids.append("INBOX")

    if not add_label_ids and not remove_label_ids:
        return

    (
        service.users()
        .messages()
        .modify(
            userId="me",
            id=item.email.id,
            body={
                "addLabelIds": add_label_ids,
                "removeLabelIds": remove_label_ids,
            },
        )
        .execute()
    )


def _apply_rule_decision(service, email: EmailSummary, decision: RuleDecision, label_name_to_id: Dict[str, str]) -> None:
    add_label_ids: List[str] = []
    remove_label_ids: List[str] = []

    label_id = _get_or_create_label_id(service, decision.label_name, label_name_to_id)
    if decision.label_name not in email.labels:
        add_label_ids.append(label_id)

    if decision.archive and "INBOX" in email.labels:
        remove_label_ids.append("INBOX")

    if not add_label_ids and not remove_label_ids:
        return

    (
        service.users()
        .messages()
        .modify(
            userId="me",
            id=email.id,
            body={
                "addLabelIds": add_label_ids,
                "removeLabelIds": remove_label_ids,
            },
        )
        .execute()
    )


def mark_email_handled(message_id: str) -> HandleEmailResponse:
    service = get_gmail_service()
    label_id_to_name, label_name_to_id = get_label_maps(service)
    reviewed_label_id = _get_or_create_label_id(service, REVIEWED_LABEL, label_name_to_id)

    full_msg = (
        service.users()
        .messages()
        .get(userId="me", id=message_id, format="full")
        .execute()
    )
    email = _to_email_summary(full_msg, label_id_to_name)

    add_label_ids: List[str] = []
    remove_label_ids: List[str] = []

    if REVIEWED_LABEL not in email.labels:
        add_label_ids.append(reviewed_label_id)

    important_label_id = label_name_to_id.get(IMPORTANT_LABEL)
    if important_label_id and IMPORTANT_LABEL in email.labels:
        remove_label_ids.append(important_label_id)

    if add_label_ids or remove_label_ids:
        (
            service.users()
            .messages()
            .modify(
                userId="me",
                id=message_id,
                body={
                    "addLabelIds": add_label_ids,
                    "removeLabelIds": remove_label_ids,
                },
            )
            .execute()
        )

    return HandleEmailResponse(
        message_id=message_id,
        removed_label=IMPORTANT_LABEL,
        added_label=REVIEWED_LABEL,
        status="handled",
    )


def expire_stale_important_emails(days_old: int = 7, limit: int = 200) -> int:
    service = get_gmail_service()
    label_id_to_name, label_name_to_id = get_label_maps(service)
    reviewed_label_id = _get_or_create_label_id(service, REVIEWED_LABEL, label_name_to_id)
    important_label_id = label_name_to_id.get(IMPORTANT_LABEL)
    if not important_label_id:
        return 0

    emails = get_emails_by_label(IMPORTANT_LABEL, limit=limit)
    cutoff = datetime.now(timezone.utc) - timedelta(days=days_old)
    updated = 0

    for email in emails:
        if "UNREAD" in email.labels:
            continue
        if REVIEWED_LABEL in email.labels:
            continue
        if not email.date:
            continue

        try:
            parsed_date = parsedate_to_datetime(email.date)
            if parsed_date.tzinfo is None:
                parsed_date = parsed_date.replace(tzinfo=timezone.utc)
            parsed_date = parsed_date.astimezone(timezone.utc)
        except Exception:
            continue

        if parsed_date > cutoff:
            continue

        (
            service.users()
            .messages()
            .modify(
                userId="me",
                id=email.id,
                body={
                    "addLabelIds": [reviewed_label_id],
                    "removeLabelIds": [important_label_id],
                },
            )
            .execute()
        )
        updated += 1

    return updated


def cleanup_inbox(
    emails: List[EmailSummary],
    classify_cleanup_email_fn,
    dry_run: bool = True,
    progress_callback=None,
) -> CleanupResponse:
    service = get_gmail_service()
    _, label_name_to_id = get_label_maps(service)
    items: List[CleanupItem] = []

    for email in emails:
        result = classify_cleanup_email_fn(email)
        classification = result.get("classification")
        decision = result.get("decision")

        if classification is None or decision is None:
            fallback_classification = EmailClassification(
                category="reference",
                importance_score=3,
                needs_reply=False,
                urgency="low",
                suggested_action="archive",
                reason="Cleanup planner returned an incomplete result.",
            )
            classification = fallback_classification
            decision = _fallback_cleanup_decision(email, fallback_classification)

        decision = decision.model_copy(update={"archive": True})
        if decision.action == "keep":
            decision = decision.model_copy(
                update={
                    "action": "archive",
                    "reason": f"{decision.reason} Archived to maintain zero inbox.",
                }
            )

        item = CleanupItem(
            email=email,
            classification=classification,
            decision=decision,
        )

        if not dry_run:
            _apply_decision(service, item, label_name_to_id)

        items.append(item)
        if progress_callback is not None:
            progress_callback(len(items), len(emails), email)

    summary = CleanupSummary(
        total_processed=len(items),
        archived=sum(1 for item in items if item.decision.archive),
        labeled_only=sum(
            1 for item in items if item.decision.action == "label" and not item.decision.archive
        ),
        kept=sum(1 for item in items if item.decision.action == "keep"),
    )

    return CleanupResponse(
        dry_run=dry_run,
        summary=summary,
        items=items,
    )


def process_new_inbox_emails(
    emails: List[EmailSummary],
    classify_rule_fn,
    ai_fallback_fn=None,
    dry_run: bool = True,
) -> RuleProcessResponse:
    service = get_gmail_service()
    _, label_name_to_id = get_label_maps(service)
    items: List[RuleItem] = []

    for email in emails:
        decision = classify_rule_fn(email)
        if decision.matched_rule == "needs_ai_review" and ai_fallback_fn is not None:
            ai_decision = ai_fallback_fn(email)
            decision = RuleDecision(
                label_name=ai_decision.label_name or UNIMPORTANT_LABEL,
                archive=ai_decision.archive,
                matched_rule="needs_ai_review",
                source="ai_fallback",
                reason=ai_decision.reason,
            )
        item = RuleItem(email=email, decision=decision)

        if not dry_run:
            _apply_rule_decision(service, email, decision, label_name_to_id)

        items.append(item)

    by_label: dict[str, int] = {}
    for item in items:
        by_label[item.decision.label_name] = by_label.get(item.decision.label_name, 0) + 1

    summary = RuleSummary(
        total_processed=len(items),
        archived=sum(1 for item in items if item.decision.archive),
        by_label=by_label,
    )

    return RuleProcessResponse(
        dry_run=dry_run,
        unread_only=True,
        summary=summary,
        items=items,
    )
