"""Sequence-free audit projection for managed MSA submissions."""

from __future__ import annotations

import hashlib
from typing import Any

from pydantic import ValidationError

from .msa_operation_contract import (
    MultipleSequenceAlignmentInput,
    multiple_sequence_alignment_input_revision,
)


def _bounded_string(value: Any, *, max_length: int) -> str | None:
    return value if isinstance(value, str) and len(value) <= max_length else None


def multiple_sequence_alignment_audit_parameters(
    args: dict[str, Any],
) -> dict[str, Any]:
    subject_value = args.get("subject")
    subject = subject_value if isinstance(subject_value, dict) else {}
    input_value = args.get("input")
    input_payload = input_value if isinstance(input_value, dict) else {}
    sequence_values = input_payload.get("sequences")
    sequences = sequence_values if isinstance(sequence_values, list) else []

    revision: str | None = None
    try:
        parsed = MultipleSequenceAlignmentInput.model_validate(input_payload)
        revision = multiple_sequence_alignment_input_revision(parsed)
    except ValidationError:
        pass

    summaries: list[dict[str, Any]] = []
    for item in sequences[:129]:
        record = item if isinstance(item, dict) else {}
        sequence_value = record.get("sequence")
        sequence = sequence_value if isinstance(sequence_value, str) else None
        summaries.append(
            {
                "id": _bounded_string(record.get("id"), max_length=256),
                "length": len(sequence) if sequence is not None else None,
                "sha256": (
                    "sha256:" + hashlib.sha256(sequence.encode("utf-8")).hexdigest()
                    if sequence is not None
                    else None
                ),
            }
        )

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
            "input_revision": revision,
            "sequence_count": len(sequences),
            "sequences": summaries,
            "algorithm": _bounded_string(input_payload.get("algorithm"), max_length=32),
            "threads": input_payload.get("threads"),
            "timeout_seconds": input_payload.get("timeout_seconds"),
        },
    }
