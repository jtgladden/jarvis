from app.schemas import EmailSummary, RuleDecision

RULE_LABEL_PREFIX = "Rules"
REVIEW_LABEL = f"{RULE_LABEL_PREFIX} Review"


def _email_text(email: EmailSummary) -> str:
    return " ".join(
        part for part in [email.subject, email.sender, email.snippet, email.body or ""] if part
    ).lower()


def classify_new_email_rule(email: EmailSummary) -> RuleDecision:
    text = _email_text(email)

    if any(
        keyword in text
        for keyword in {
            "password reset",
            "verification code",
            "security alert",
            "login alert",
            "login notification",
            "new sign-in",
            "sign-in attempt",
            "new device",
            "two-factor",
            "2fa",
            "otp",
        }
    ):
        return RuleDecision(
            label_name=f"{RULE_LABEL_PREFIX} Security",
            archive=True,
            matched_rule="security_alerts",
            reason="Matched a security or login-notification rule.",
        )

    if any(
        keyword in text
        for keyword in {
            "sale",
            "discount",
            "offer",
            "deal",
            "coupon",
            "promo",
            "promotion",
            "unsubscribe",
            "newsletter",
            "digest",
            "recommended for you",
            "trending",
            "limited time",
        }
    ):
        return RuleDecision(
            label_name=f"{RULE_LABEL_PREFIX} Unimportant",
            archive=True,
            matched_rule="promotions_and_newsletters",
            reason="Matched a promotional or newsletter-style rule.",
        )

    if any(
        keyword in text
        for keyword in {
            "receipt",
            "your order",
            "order confirmation",
            "shipped",
            "delivered",
            "tracking",
            "package",
            "return",
        }
    ):
        return RuleDecision(
            label_name=f"{RULE_LABEL_PREFIX} Shopping",
            archive=True,
            matched_rule="shopping_and_receipts",
            reason="Matched an order, shipping, or receipt rule.",
        )

    if any(
        keyword in text
        for keyword in {
            "invoice",
            "bill due",
            "payment due",
            "statement",
            "bank",
            "tax",
            "insurance",
            "finance",
        }
    ):
        return RuleDecision(
            label_name=f"{RULE_LABEL_PREFIX} Important",
            archive=True,
            matched_rule="finance_and_bills",
            reason="Matched a finance, bill, or payment-related rule.",
        )

    if any(
        keyword in text
        for keyword in {
            "meeting",
            "calendar",
            "deadline",
            "interview",
            "follow up",
            "please respond",
            "can you",
            "doctor",
            "appointment",
            "travel",
            "itinerary",
            "mission",
        }
    ):
        return RuleDecision(
            label_name=f"{RULE_LABEL_PREFIX} Important",
            archive=True,
            matched_rule="personal_or_actionable",
            reason="Matched a human-important or follow-up-oriented rule.",
        )

    return RuleDecision(
        label_name=REVIEW_LABEL,
        archive=True,
        matched_rule="needs_ai_review",
        reason="No hard-coded rule matched, so this email should use the AI fallback.",
    )
