from __future__ import annotations

from ..alignment_index_operation_agent import (
    prepare_agent_alignment_index_submission,
)
from ..alignment_index_operation_audit import (
    alignment_index_agent_audit_parameters,
    alignment_index_submission_audit_parameters,
)
from ..alignment_index_operation_contract import (
    AlignmentIndexAgentStart,
    AlignmentIndexInput,
    AlignmentIndexResult,
    AlignmentIndexSubmission,
    prepare_alignment_index_submission,
)
from ..operations import ActiveJoinMode, CancellationMode
from ..operations.registration import (
    AgentStartContract,
    ExecutableOperationKind,
    OperationKindKey,
    OperationLimits,
    ResultCodec,
    StartContract,
)

ALIGNMENT_INDEX_PREPARATION_OPERATION_KIND = ExecutableOperationKind(
    key=OperationKindKey(kind="alignment-index-preparation", version=1),
    title="Prepare alignment index",
    input_model=AlignmentIndexInput,
    result=ResultCodec(
        current_version=1,
        model=AlignmentIndexResult,
        decoders={1: AlignmentIndexResult.model_validate},
    ),
    start=StartContract(
        request_model=AlignmentIndexSubmission,
        prepare=prepare_alignment_index_submission,
        required_capabilities=frozenset({"operations.start"}),
        audit_parameters=alignment_index_submission_audit_parameters,
    ),
    agent_start=AgentStartContract(
        request_model=AlignmentIndexAgentStart,
        prepare=prepare_agent_alignment_index_submission,
        required_capabilities=frozenset({"operations.start", "read-workspace"}),
        audit_parameters=alignment_index_agent_audit_parameters,
    ),
    cancellation=CancellationMode.QUEUED_ONLY,
    active_join=ActiveJoinMode.SUBJECT_REVISION,
    limits=OperationLimits(max_input_bytes=64 * 1024, max_result_bytes=64 * 1024),
)


__all__ = ["ALIGNMENT_INDEX_PREPARATION_OPERATION_KIND"]
