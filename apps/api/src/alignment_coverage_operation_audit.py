"""Path-free audit projections for aligned-read coverage starts."""

from __future__ import annotations

import hashlib
from typing import Any

from pydantic import ValidationError

from .alignment_coverage_operation_contract import AlignmentCoverageInput


def _bounded_string(value: Any, *, max_length: int) -> str | None:
    return value if isinstance(value, str) and len(value) <= max_length else None


def _sha256_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def alignment_coverage_submission_audit_parameters(
    args: dict[str, Any],
) -> dict[str, Any]:
    subject_value = args.get("subject")
    subject = subject_value if isinstance(subject_value, dict) else {}
    input_value = args.get("input")
    payload = input_value if isinstance(input_value, dict) else {}
    parsed: AlignmentCoverageInput | None = None
    try:
        parsed = AlignmentCoverageInput.model_validate(payload)
    except ValidationError:
        pass
    chroms_value = payload.get("chroms")
    chroms = chroms_value if isinstance(chroms_value, list) else []
    return {
        "submission_key": _bounded_string(args.get("submission_key"), max_length=256),
        "subject": {
            "scope_id": _bounded_string(subject.get("scope_id"), max_length=512),
            "claimed_input_revision": _bounded_string(
                subject.get("input_revision"), max_length=512
            ),
        },
        "input": {
            "assembly_id": (
                parsed.assembly_id
                if parsed is not None
                else _bounded_string(payload.get("assemblyId"), max_length=1024)
            ),
            "chrom_count": len(parsed.chroms) if parsed is not None else len(chroms),
            "bam_path_sha256": _sha256_string(payload.get("bamPath")),
            "index_path_sha256": _sha256_string(payload.get("indexPath")),
            "reference_path_sha256": _sha256_string(payload.get("referencePath")),
            "force": payload.get("force"),
        },
    }


def alignment_coverage_agent_audit_parameters(args: dict[str, Any]) -> dict[str, Any]:
    return {
        "assembly_id": _bounded_string(args.get("assemblyId"), max_length=1024),
        "track_id": _bounded_string(args.get("trackId"), max_length=1024),
    }


__all__ = [
    "alignment_coverage_agent_audit_parameters",
    "alignment_coverage_submission_audit_parameters",
]
