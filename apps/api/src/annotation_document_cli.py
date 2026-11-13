"""Translate an explicitly reviewed annotation result into a frozen selection."""

import sys
from pathlib import Path

from pydantic import ValidationError

from .annotation_document_contract import AnnotationDocumentSelection
from .annotation_document_responses import (
    AnnotationDocumentApplyResponse,
    AnnotationDocumentInspection,
    DocumentSaved,
)

_MAX_INSPECTION_BYTES = 32 * 1024 * 1024
DOCUMENT_ADMISSION_REFUSALS = frozenset(
    {
        "NATIVE_DOCUMENT_CONNECTION_UNAVAILABLE",
        "OPERATION_RUNTIME_UNAVAILABLE",
        "OPERATION_AUTHORITY_UNAVAILABLE",
        "OPERATION_AUTHORITY_REQUIRED",
        "OPERATION_ACCESS_DENIED",
        "OPERATION_NOT_FOUND",
        "OPERATION_QUEUE_FULL",
        "INVALID_OPERATION_CHANNEL",
        "INVALID_OPERATION_REQUEST",
        "SUBMISSION_CONFLICT",
    }
)


def read_annotation_document_selection(
    path: str, *, candidate_ids: list[str] | None, all_candidates: bool
) -> AnnotationDocumentSelection:
    try:
        if path == "-":
            content = sys.stdin.buffer.read(_MAX_INSPECTION_BYTES + 1)
        else:
            with Path(path).open("rb") as source:
                content = source.read(_MAX_INSPECTION_BYTES + 1)
    except OSError as exc:
        raise ValueError("Cannot read the annotation inspection.") from exc
    if len(content) > _MAX_INSPECTION_BYTES:
        raise ValueError("The annotation inspection is too large.")
    try:
        inspection = AnnotationDocumentInspection.model_validate_json(content)
    except ValidationError as exc:
        raise ValueError(
            "The annotation inspection is invalid or unsupported."
        ) from exc
    if not inspection.applicable or inspection.block_reason is not None:
        raise ValueError(
            inspection.block_reason or "This reviewed result is not applicable."
        )
    available = {candidate.id for candidate in inspection.candidates}
    selected = (
        [candidate.id for candidate in inspection.candidates]
        if all_candidates
        else candidate_ids or []
    )
    if (
        not selected
        or len(set(selected)) != len(selected)
        or not set(selected) <= available
    ):
        raise ValueError("Select one or more unique candidates from this inspection.")
    try:
        return AnnotationDocumentSelection(
            operationId=inspection.operation_id,
            targetDocumentId=inspection.target_document_id,
            expectedOperationVersion=inspection.operation_version,
            expectedResultSha256=inspection.result_sha256,
            expectedTargetDocumentRevision=inspection.target_document_revision,
            selectedCandidateIds=selected,
        )
    except ValidationError as exc:
        raise ValueError("The reviewed annotation selection is invalid.") from exc


def document_apply_exit_code(response: AnnotationDocumentApplyResponse) -> int:
    outcome = response.outcome
    if isinstance(outcome, DocumentSaved):
        if outcome.checkpoint.status != "failed":
            return 0
        message = (
            "The document was saved, but its checkpoint failed: "
            + outcome.checkpoint.reason
        )
    else:
        message = outcome.reason
    print(f"Document action {response.action_id}: {message}", file=sys.stderr)
    if outcome.status == "outcome-unresolved":
        print("Observe this action before repeating Apply.", file=sys.stderr)
        return 3
    return 2
