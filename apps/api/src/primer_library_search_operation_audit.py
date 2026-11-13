"""Sequence-free audit projection for primer-library search admission."""

from __future__ import annotations

import hashlib
from typing import Any

from pydantic import ValidationError

from .primer_library_search_operation_contract import (
    PrimerLibrarySearchRequest,
    primer_library_search_library_revision,
    primer_library_search_target_revision,
)


def _bounded_string(value: Any, *, max_length: int) -> str | None:
    return value if isinstance(value, str) and len(value) <= max_length else None


def _sha256_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def primer_library_search_audit_parameters(args: dict[str, Any]) -> dict[str, Any]:
    subject_value = args.get("subject")
    subject = subject_value if isinstance(subject_value, dict) else {}
    input_value = args.get("input")
    operation_input = input_value if isinstance(input_value, dict) else {}
    primers = operation_input.get("primers")
    sequence = operation_input.get(
        "referenceSequence", operation_input.get("reference_sequence")
    )
    target_document_id = operation_input.get(
        "targetDocumentId", operation_input.get("target_document_id")
    )
    parsed: PrimerLibrarySearchRequest | None = None
    try:
        parsed = PrimerLibrarySearchRequest.model_validate(operation_input)
    except ValidationError:
        pass
    return {
        "submission_key": _bounded_string(args.get("submission_key"), max_length=256),
        "subject": {
            "scope_id": _bounded_string(subject.get("scope_id"), max_length=512),
            "claimed_input_revision": _bounded_string(
                subject.get("input_revision"), max_length=512
            ),
        },
        "input": {
            "target_document_id_sha256": _sha256_string(target_document_id),
            "target_revision": (
                primer_library_search_target_revision(parsed)
                if parsed is not None
                else None
            ),
            "library_revision": (
                primer_library_search_library_revision(parsed)
                if parsed is not None
                else None
            ),
            "target_length": (
                len(parsed.reference_sequence)
                if parsed is not None
                else (len(sequence) if isinstance(sequence, str) else None)
            ),
            "primer_count": (
                len(parsed.primers)
                if parsed is not None
                else (len(primers) if isinstance(primers, list) else None)
            ),
            "circular": (
                parsed.circular
                if parsed is not None
                else operation_input.get("circular")
            ),
            "region_start": (
                parsed.region_start
                if parsed is not None
                else operation_input.get(
                    "regionStart", operation_input.get("region_start")
                )
            ),
            "region_end": (
                parsed.region_end
                if parsed is not None
                else operation_input.get("regionEnd", operation_input.get("region_end"))
            ),
            "max_edit_distance": (
                parsed.max_edit_distance
                if parsed is not None
                else operation_input.get(
                    "maxEditDistance", operation_input.get("max_edit_distance")
                )
            ),
            "min_match_length": (
                parsed.min_match_length
                if parsed is not None
                else operation_input.get(
                    "minMatchLength", operation_input.get("min_match_length")
                )
            ),
            "min_effective_tm": (
                parsed.min_effective_tm
                if parsed is not None
                else operation_input.get(
                    "minEffectiveTm", operation_input.get("min_effective_tm")
                )
            ),
            "max_mismatches": (
                parsed.max_mismatches
                if parsed is not None
                else operation_input.get(
                    "maxMismatches", operation_input.get("max_mismatches")
                )
            ),
        },
    }


__all__ = ["primer_library_search_audit_parameters"]
