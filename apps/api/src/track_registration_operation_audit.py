"""Privacy-safe audit projections for track registration starts.

Paths are hashed, never logged; the track name, assembly and kinds are the
bounded strings that identify the work.
"""

from __future__ import annotations

import hashlib
from pathlib import PurePath
from typing import Any


def _bounded_string(value: Any, *, max_length: int) -> str | None:
    return value if isinstance(value, str) and len(value) <= max_length else None


def _sha256_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _kinds(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [kind for kind in value if isinstance(kind, str) and len(kind) <= 32][:4]


def _description(value: Any) -> dict[str, Any]:
    description = value if isinstance(value, dict) else {}
    return {
        "name": _bounded_string(description.get("name"), max_length=48),
        "accession": _bounded_string(description.get("accession"), max_length=64),
        "kinds": _kinds(description.get("kinds")),
        "evidence": _bounded_string(description.get("evidence"), max_length=16),
        "path_sha256": _sha256_string(description.get("path")),
    }


def track_registration_submission_audit_parameters(
    args: dict[str, Any],
) -> dict[str, Any]:
    subject_value = args.get("subject")
    subject = subject_value if isinstance(subject_value, dict) else {}
    return {
        "submission_key": _bounded_string(args.get("submission_key"), max_length=256),
        "subject": {
            "scope_id": _bounded_string(subject.get("scope_id"), max_length=512),
            "subject_id": _bounded_string(subject.get("subject_id"), max_length=1024),
            "claimed_input_revision": _bounded_string(
                subject.get("input_revision"), max_length=512
            ),
        },
        "input": _description(args.get("input")),
    }


def track_registration_agent_audit_parameters(args: dict[str, Any]) -> dict[str, Any]:
    path = args.get("path")
    basename = None
    if isinstance(path, str):
        basename = PurePath(path.replace("\\", "/")).name[:256] or None
    projected = _description(args)
    projected["path_basename"] = basename
    return projected


__all__ = [
    "track_registration_agent_audit_parameters",
    "track_registration_submission_audit_parameters",
]
