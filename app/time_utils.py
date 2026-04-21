from datetime import datetime, timezone


def normalize_utc_timestamp(value: str | None) -> str | None:
    if not value:
        return value

    text = value.strip()
    if not text:
        return None

    if text.endswith("Z"):
        return text

    # SQLite CURRENT_TIMESTAMP uses "YYYY-MM-DD HH:MM:SS" in UTC.
    if " " in text and "T" not in text:
        try:
            parsed = datetime.strptime(text, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            return parsed.isoformat().replace("+00:00", "Z")
        except ValueError:
            return text

    return text
