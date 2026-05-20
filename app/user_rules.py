import re
from dataclasses import dataclass
from typing import List

from app.schemas import EmailSummary

_ANGLE_BRACKET_RE = re.compile(r"<([^>]+)>")


@dataclass
class RuleCondition:
    field: str    # "sender" | "subject" | "body" | "any"
    operator: str # "contains" | "starts_with" | "ends_with" | "equals"
    value: str


@dataclass
class UserRule:
    id: str
    name: str
    natural_language: str
    conditions: List[RuleCondition]
    target_label: str
    archive: bool
    enabled: bool
    created_at: str


def evaluate_rule(email: EmailSummary, rule: UserRule) -> bool:
    if not rule.enabled or not rule.conditions:
        return False
    return all(_eval_condition(email, cond) for cond in rule.conditions)


def _match(op: str, text: str, value: str) -> bool:
    if op == "contains":
        return value in text
    if op == "ends_with":
        return text.endswith(value)
    if op == "starts_with":
        return text.startswith(value)
    if op == "equals":
        return text == value
    return False


def _eval_condition(email: EmailSummary, condition: RuleCondition) -> bool:
    field = condition.field.lower()
    op = condition.operator.lower()
    value = condition.value.lower()

    if field == "sender":
        raw = (email.sender or "").lower()
        # Also test against just the email address extracted from angle brackets,
        # so ends_with "@domain.com" works on "Display Name <user@domain.com>"
        m = _ANGLE_BRACKET_RE.search(raw)
        candidates = [raw, m.group(1)] if m else [raw]
        return any(_match(op, c, value) for c in candidates)
    elif field == "subject":
        text = (email.subject or "").lower()
    elif field == "body":
        text = " ".join(filter(None, [email.snippet, email.body or ""])).lower()
    else:  # "any"
        text = " ".join(filter(None, [email.sender, email.subject, email.snippet, email.body or ""])).lower()

    return _match(op, text, value)
