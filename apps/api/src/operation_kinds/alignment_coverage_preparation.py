from __future__ import annotations

from ..alignment_coverage_operation_agent import (
    prepare_agent_alignment_coverage_submission,
)
from ..alignment_coverage_operation_audit import (
    alignment_coverage_agent_audit_parameters,
    alignment_coverage_submission_audit_parameters,
)
from ..alignment_coverage_operation_contract import (
    AlignmentCoverageAgentStart,
    AlignmentCoverageInput,
    AlignmentCoverageResult,
    AlignmentCoverageSubmission,
    prepare_alignment_coverage_submission,
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

ALIGNMENT_COVERAGE_PREPARATION_OPERATION_KIND = ExecutableOperationKind(
    key=OperationKindKey(kind="alignment-coverage-preparation", version=1),
    title="Prepare alignment coverage",
    input_model=AlignmentCoverageInput,
    result=ResultCodec(
        current_version=1,
        model=AlignmentCoverageResult,
        decoders={1: AlignmentCoverageResult.model_validate},
    ),
    start=StartContract(
        request_model=AlignmentCoverageSubmission,
        prepare=prepare_alignment_coverage_submission,
        required_capabilities=frozenset({"operations.start"}),
        audit_parameters=alignment_coverage_submission_audit_parameters,
    ),
    agent_start=AgentStartContract(
        request_model=AlignmentCoverageAgentStart,
        prepare=prepare_agent_alignment_coverage_submission,
        required_capabilities=frozenset({"operations.start", "read-workspace"}),
        audit_parameters=alignment_coverage_agent_audit_parameters,
    ),
    cancellation=CancellationMode.QUEUED_ONLY,
    active_join=ActiveJoinMode.SUBJECT_REVISION,
    limits=OperationLimits(
        max_input_bytes=4 * 1024 * 1024, max_result_bytes=8 * 1024 * 1024
    ),
)

__all__ = ["ALIGNMENT_COVERAGE_PREPARATION_OPERATION_KIND"]
