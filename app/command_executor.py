import logging
from typing import Optional

from app.classification_cache import invalidate_cached_email
from app.gmail_client import _get_or_create_label_id, get_gmail_service, get_label_maps

logger = logging.getLogger(__name__)

_BATCH_SIZE = 500
_MAX_MESSAGES = 1000


def _list_query_message_ids(service, query: str, limit: int) -> list[str]:
    message_ids: list[str] = []
    page_token: Optional[str] = None

    while len(message_ids) < limit:
        response = (
            service.users()
            .messages()
            .list(
                userId="me",
                q=query,
                maxResults=min(500, limit - len(message_ids)),
                pageToken=page_token,
            )
            .execute()
        )
        for msg in response.get("messages", []):
            message_ids.append(msg["id"])
        page_token = response.get("nextPageToken")
        if not page_token:
            break

    return message_ids


def _chunked(lst: list, size: int):
    for i in range(0, len(lst), size):
        yield lst[i : i + size]


def execute_command(
    action: str,
    gmail_query: str,
    target_label: Optional[str] = None,
    archive: bool = False,
    dry_run: bool = True,
    limit: int = _MAX_MESSAGES,
) -> dict:
    service = get_gmail_service()
    _, label_name_to_id = get_label_maps(service)

    message_ids = _list_query_message_ids(service, gmail_query, limit)
    has_more = len(message_ids) >= limit

    if dry_run:
        return {
            "affected_count": len(message_ids),
            "has_more": has_more,
            "dry_run": True,
        }

    applied = 0

    if action == "trash":
        user_label_ids = [lid for lid in label_name_to_id.values() if lid.startswith("Label_")]
        remove_ids = list({"INBOX", "UNREAD"} | set(user_label_ids))
        for chunk in _chunked(message_ids, _BATCH_SIZE):
            service.users().messages().batchModify(
                userId="me",
                body={"ids": chunk, "addLabelIds": ["TRASH"], "removeLabelIds": remove_ids},
            ).execute()
            applied += len(chunk)

    elif action == "archive":
        for chunk in _chunked(message_ids, _BATCH_SIZE):
            service.users().messages().batchModify(
                userId="me",
                body={"ids": chunk, "removeLabelIds": ["INBOX"]},
            ).execute()
            applied += len(chunk)

    elif action == "mark_read":
        for chunk in _chunked(message_ids, _BATCH_SIZE):
            service.users().messages().batchModify(
                userId="me",
                body={"ids": chunk, "removeLabelIds": ["UNREAD"]},
            ).execute()
            applied += len(chunk)

    elif action == "label" and target_label:
        from app.classifier import IMPORTANT_LABEL, LEGACY_IMPORTANT_LABELS, LEGACY_UNIMPORTANT_LABELS, UNIMPORTANT_LABEL
        label_id = _get_or_create_label_id(service, target_label, label_name_to_id)
        remove_ids: list[str] = []
        if archive:
            remove_ids.append("INBOX")
            remove_ids.extend(
                label_name_to_id[n]
                for n in {IMPORTANT_LABEL, UNIMPORTANT_LABEL, *LEGACY_IMPORTANT_LABELS, *LEGACY_UNIMPORTANT_LABELS}
                if n in label_name_to_id
            )
        for chunk in _chunked(message_ids, _BATCH_SIZE):
            body: dict = {"ids": chunk, "addLabelIds": [label_id]}
            if remove_ids:
                body["removeLabelIds"] = remove_ids
            service.users().messages().batchModify(userId="me", body=body).execute()
            applied += len(chunk)

    elif action == "mark_handled":
        from app.classifier import IMPORTANT_LABEL, LEGACY_IMPORTANT_LABELS, LEGACY_UNIMPORTANT_LABELS, UNIMPORTANT_LABEL
        reviewed_id = _get_or_create_label_id(service, "Reviewed", label_name_to_id)
        jarvis_ids = [
            label_name_to_id[n]
            for n in {IMPORTANT_LABEL, UNIMPORTANT_LABEL, *LEGACY_IMPORTANT_LABELS, *LEGACY_UNIMPORTANT_LABELS}
            if n in label_name_to_id
        ]
        for chunk in _chunked(message_ids, _BATCH_SIZE):
            service.users().messages().batchModify(
                userId="me",
                body={"ids": chunk, "addLabelIds": [reviewed_id], "removeLabelIds": jarvis_ids + ["UNREAD"]},
            ).execute()
            applied += len(chunk)

    for msg_id in message_ids:
        try:
            invalidate_cached_email(msg_id)
        except Exception:
            pass

    logger.info("execute_command: action=%s query=%r applied=%d", action, gmail_query, applied)
    return {
        "affected_count": applied,
        "has_more": has_more,
        "dry_run": False,
    }
