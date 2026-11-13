"""Managed-operation executor for MAFFT multiple-sequence alignment."""

from __future__ import annotations

import threading

from fastapi import HTTPException
from pydantic import ValidationError

from .msa_operation_contract import (
    MultipleSequenceAlignmentInput,
    MultipleSequenceAlignmentResult,
)
from .operations import OperationCanceled, OperationExecutionError
from .tools.alignment import (
    AlignmentAlgorithm,
    AlignmentCanceled,
    _execute_multiple_alignment,
)


def _alignment_failure_message(exc: HTTPException) -> str:
    if exc.status_code == 504:
        return "Alignment timed out. Try fewer sequences or a faster algorithm."
    if exc.detail == "MAFFT not installed. Please install MAFFT.":
        return exc.detail
    return "Multiple-sequence alignment failed."


async def execute_managed_msa(
    request: MultipleSequenceAlignmentInput,
    cancel_event: threading.Event,
) -> MultipleSequenceAlignmentResult:
    try:
        result = await _execute_multiple_alignment(
            [
                record.model_dump(mode="json", exclude_none=True)
                for record in request.sequences
            ],
            AlignmentAlgorithm(request.algorithm.value),
            request.threads,
            timeout_seconds=request.timeout_seconds,
            cancel_event=cancel_event,
        )
    except AlignmentCanceled as exc:
        raise OperationCanceled("Alignment was canceled") from exc
    except HTTPException as exc:
        code = "ALIGNMENT_TIMEOUT" if exc.status_code == 504 else "ALIGNMENT_FAILED"
        raise OperationExecutionError(code, _alignment_failure_message(exc)) from exc
    try:
        validated = MultipleSequenceAlignmentResult.model_validate(
            result.model_dump(mode="json")
        )
    except ValidationError as exc:
        raise OperationExecutionError(
            "ALIGNMENT_INVALID_RESULT",
            "MAFFT returned an invalid multiple-sequence alignment.",
        ) from exc

    expected_names = {record.id: record.name for record in request.sequences}
    returned_names = {record.id: record.name for record in validated.aligned_sequences}
    if returned_names != expected_names:
        raise OperationExecutionError(
            "ALIGNMENT_INVALID_RESULT",
            "MAFFT returned different sequence identities from the submitted input.",
        )
    return validated
