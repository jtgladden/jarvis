"""List PhotoPrism subjects (people) per instance, so their UIDs can be copied
into the ``people_photoprism`` table.

Reads instance credentials from the environment only (never from code):
    PHOTOPRISM_<KEY>_URL / PHOTOPRISM_<KEY>_TOKEN   (see .env.example)

Run from the repo root:
    python scripts/list_photoprism_subjects.py            # all configured instances
    python scripts/list_photoprism_subjects.py personal   # just one instance
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.config import get_photoprism_instances  # noqa: E402
from app.photoprism_client import PhotoPrismError, list_instance_subjects  # noqa: E402


def _print_instance(instance_key: str) -> None:
    print(f"\n=== instance: {instance_key} ===")
    print(f"{'uid':<24} | {'count':>6} | name")
    print("-" * 60)
    try:
        subjects = list_instance_subjects(instance_key)
    except PhotoPrismError as exc:
        print(f"  ! {exc}")
        return
    for subject in sorted(subjects, key=lambda s: str(s.get("name", "")).lower()):
        print(f"{subject['uid']:<24} | {subject['photo_count']:>6} | {subject['name']}")


def main() -> int:
    configured = get_photoprism_instances()
    if not configured:
        print(
            "No PhotoPrism instances configured. Set PHOTOPRISM_<KEY>_URL and "
            "PHOTOPRISM_<KEY>_TOKEN (e.g. PHOTOPRISM_PERSONAL_URL) — see .env.example."
        )
        return 1

    requested = sys.argv[1:]
    if requested:
        unknown = [key for key in requested if key.lower() not in configured]
        if unknown:
            print(f"Unknown instance(s): {', '.join(unknown)}")
            print(f"Configured: {', '.join(sorted(configured))}")
            return 1
        keys = [key.lower() for key in requested]
    else:
        keys = sorted(configured)

    for instance_key in keys:
        _print_instance(instance_key)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
