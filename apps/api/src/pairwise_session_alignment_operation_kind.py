from __future__ import annotations

from typing import Any

from .operations import ActiveJoinMode, CancellationMode
from .operations.registration import (
    ExecutableOperationKind,
    OperationKindKey,
    OperationLimits,
    ResultCodec,
    StartContract,
)
from .pairwise_session_alignment_operation_audit import (
    pairwise_session_alignment_audit_parameters,
)
from .pairwise_session_alignment_operation_contract import (
    PairwiseSessionAlignmentInput,
    PairwiseSessionAlignmentResult,
    PairwiseSessionAlignmentSubmission,
    prepare_pairwise_session_alignment_submission,
)


def _decode_legacy_result(payload: Any) -> PairwiseSessionAlignmentResult:
    result = PairwiseSessionAlignmentResult.model_validate(payload)
    if result.tool is not None:
        raise ValueError("Legacy pairwise results cannot claim tool identity")
    return result


def _decode_result(payload: Any) -> PairwiseSessionAlignmentResult:
    result = PairwiseSessionAlignmentResult.model_validate(payload)
    if result.tool is None:
        raise ValueError("Pairwise result schema 2 requires tool identity")
    return result


PAIRWISE_SESSION_ALIGNMENT_OPERATION_KIND = ExecutableOperationKind(
    key=OperationKindKey(kind="pairwise-session-alignment", version=1),
    title="Align verification session",
    input_model=PairwiseSessionAlignmentInput,
    result=ResultCodec(
        current_version=2,
        model=PairwiseSessionAlignmentResult,
        decoders={1: _decode_legacy_result, 2: _decode_result},
    ),
    start=StartContract(
        request_model=PairwiseSessionAlignmentSubmission,
        prepare=prepare_pairwise_session_alignment_submission,
        required_capabilities=frozenset({"operations.start"}),
        audit_parameters=pairwise_session_alignment_audit_parameters,
    ),
    cancellation=CancellationMode.COOPERATIVE,
    active_join=ActiveJoinMode.SUBJECT_REVISION,
    limits=OperationLimits(
        max_input_bytes=4 * 1024 * 1024,
        max_result_bytes=16 * 1024 * 1024,
    ),
)

__all__ = ["PAIRWISE_SESSION_ALIGNMENT_OPERATION_KIND"]
