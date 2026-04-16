from dataclasses import dataclass

from app.config import APP_DEFAULT_USER_ID


@dataclass(frozen=True)
class AppUserContext:
    user_id: str


def get_default_user_context() -> AppUserContext:
    return AppUserContext(user_id=APP_DEFAULT_USER_ID)
