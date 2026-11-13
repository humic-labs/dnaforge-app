"""Privacy-safe audit projections for genome-index operation starts."""

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


def genome_index_submission_audit_parameters(
    args: dict[str, Any],
) -> dict[str, Any]:
    subject_value = args.get("subject")
    subject = subject_value if isinstance(subject_value, dict) else {}
    input_value = args.get("input")
    index_input = input_value if isinstance(input_value, dict) else {}
    output_dir = index_input.get("outputDir", index_input.get("output_dir"))
    workspace_root = index_input.get("workspaceRoot", index_input.get("workspace_root"))
    return {
        "submission_key": _bounded_string(args.get("submission_key"), max_length=256),
        "subject": {
            "scope_id": _bounded_string(subject.get("scope_id"), max_length=512),
            "subject_id": _bounded_string(subject.get("subject_id"), max_length=1024),
            "claimed_input_revision": _bounded_string(
                subject.get("input_revision"), max_length=512
            ),
        },
        "input": {
            "name": _bounded_string(index_input.get("name"), max_length=80),
            "input_sha256": _sha256_string(index_input.get("input")),
            "output_dir_sha256": _sha256_string(output_dir),
            "workspace_root_sha256": _sha256_string(workspace_root),
        },
    }


def genome_index_agent_audit_parameters(args: dict[str, Any]) -> dict[str, Any]:
    path = args.get("path")
    basename = None
    if isinstance(path, str):
        basename = PurePath(path.replace("\\", "/")).name[:256] or None
    return {
        "path_basename": basename,
        "path_sha256": _sha256_string(path),
    }
