"""Path-safe audit projections for BAM index preparation."""

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


def alignment_index_submission_audit_parameters(
    args: dict[str, Any],
) -> dict[str, Any]:
    subject_value = args.get("subject")
    subject = subject_value if isinstance(subject_value, dict) else {}
    input_value = args.get("input")
    operation_input = input_value if isinstance(input_value, dict) else {}
    bam_path = operation_input.get("bamPath", operation_input.get("bam_path"))
    return {
        "submission_key": _bounded_string(args.get("submission_key"), max_length=256),
        "subject": {
            "scope_id": _bounded_string(subject.get("scope_id"), max_length=512),
            "claimed_input_revision": _bounded_string(
                subject.get("input_revision"), max_length=512
            ),
        },
        "input": {"bam_path_sha256": _sha256_string(bam_path)},
    }


def alignment_index_agent_audit_parameters(args: dict[str, Any]) -> dict[str, Any]:
    path = args.get("path")
    basename = None
    if isinstance(path, str):
        basename = PurePath(path.replace("\\", "/")).name[:256] or None
    return {
        "path_basename": basename,
        "path_sha256": _sha256_string(path),
    }


__all__ = [
    "alignment_index_agent_audit_parameters",
    "alignment_index_submission_audit_parameters",
]
