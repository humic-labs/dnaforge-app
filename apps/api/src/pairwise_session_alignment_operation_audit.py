"""Sequence-free audit projection for pairwise session-alignment admission."""

from __future__ import annotations

import hashlib
from typing import Any

from pydantic import ValidationError

from .pairwise_session_alignment_operation_contract import (
    PairwiseSessionAlignmentRequest,
    PairwiseSessionAlignmentSubmission,
    pairwise_session_alignment_input_revision,
    prepare_pairwise_session_alignment_submission,
)

MAX_AUDIT_QUERIES = 65


def _bounded_string(value: Any, *, max_length: int) -> str | None:
    return value if isinstance(value, str) and len(value) <= max_length else None


def _sha256_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def pairwise_session_alignment_audit_parameters(
    args: dict[str, Any],
) -> dict[str, Any]:
    subject_value = args.get("subject")
    subject = subject_value if isinstance(subject_value, dict) else {}
    input_value = args.get("input")
    input_payload = input_value if isinstance(input_value, dict) else {}
    query_values = input_payload.get("queries")
    query_payloads = query_values if isinstance(query_values, list) else []
    reference_value = input_payload.get(
        "referenceSequence", input_payload.get("reference_sequence")
    )
    reference = reference_value if isinstance(reference_value, str) else None

    parsed: PairwiseSessionAlignmentRequest | None = None
    revision: str | None = None
    try:
        parsed = PairwiseSessionAlignmentRequest.model_validate(input_payload)
        prepared = prepare_pairwise_session_alignment_submission(
            PairwiseSessionAlignmentSubmission.model_validate(
                {
                    "submission_key": args.get("submission_key", "audit"),
                    "subject": {
                        "scope_id": subject.get("scope_id", "audit"),
                        "document_id": subject.get("document_id", "audit-document"),
                        "session_id": subject.get("session_id", "audit-session"),
                    },
                    "input": parsed.model_dump(mode="json", by_alias=True),
                }
            )
        )
        revision = pairwise_session_alignment_input_revision(prepared.input)
    except (ValidationError, TypeError, ValueError):
        pass

    query_sequences: list[str | None] = []
    for value in query_payloads[:MAX_AUDIT_QUERIES]:
        record = value if isinstance(value, dict) else {}
        sequence_value = record.get("sequence")
        query_sequences.append(
            sequence_value if isinstance(sequence_value, str) else None
        )

    return {
        "submission_key": _bounded_string(args.get("submission_key"), max_length=256),
        "subject": {
            "scope_id": _bounded_string(subject.get("scope_id"), max_length=512),
            "document_id_sha256": _sha256_string(subject.get("document_id")),
            "session_id_sha256": _sha256_string(subject.get("session_id")),
            "claimed_input_revision": _bounded_string(
                subject.get("input_revision"), max_length=512
            ),
        },
        "input": {
            "input_revision": revision,
            "reference_length": len(reference) if reference is not None else None,
            "reference_sha256": _sha256_string(reference),
            "query_count": len(query_payloads),
            "query_lengths": [
                len(sequence) if sequence is not None else None
                for sequence in query_sequences
            ],
            "query_sha256": [_sha256_string(sequence) for sequence in query_sequences],
            "algorithm": _bounded_string(input_payload.get("algorithm"), max_length=32),
            "threads": input_payload.get("threads"),
            "timeout_seconds": input_payload.get(
                "timeoutSeconds", input_payload.get("timeout_seconds")
            ),
            "is_circular": input_payload.get(
                "isCircular", input_payload.get("is_circular")
            ),
        },
    }


__all__ = ["pairwise_session_alignment_audit_parameters"]
