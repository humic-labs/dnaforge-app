from __future__ import annotations

from ..operations import ActiveJoinMode, CancellationMode
from ..operations.registration import (
    AgentStartContract,
    ExecutableOperationKind,
    OperationKindKey,
    OperationLimits,
    ResultCodec,
    StartContract,
)
from ..variant_source_operation_agent import prepare_agent_variant_source_submission
from ..variant_source_operation_audit import (
    variant_source_agent_audit_parameters,
    variant_source_submission_audit_parameters,
)
from ..variant_source_operation_contract import (
    VariantSourceAgentStart,
    VariantSourceInput,
    VariantSourceResult,
    VariantSourceSubmission,
    prepare_variant_source_submission,
)

VARIANT_SOURCE_PREPARATION_OPERATION_KIND = ExecutableOperationKind(
    key=OperationKindKey(kind="variant-source-preparation", version=1),
    title="Prepare variant source",
    input_model=VariantSourceInput,
    result=ResultCodec(
        current_version=1,
        model=VariantSourceResult,
        decoders={1: VariantSourceResult.model_validate},
    ),
    start=StartContract(
        request_model=VariantSourceSubmission,
        prepare=prepare_variant_source_submission,
        required_capabilities=frozenset({"operations.start"}),
        audit_parameters=variant_source_submission_audit_parameters,
    ),
    agent_start=AgentStartContract(
        request_model=VariantSourceAgentStart,
        prepare=prepare_agent_variant_source_submission,
        required_capabilities=frozenset({"operations.start", "read-workspace"}),
        audit_parameters=variant_source_agent_audit_parameters,
    ),
    cancellation=CancellationMode.QUEUED_ONLY,
    active_join=ActiveJoinMode.SUBJECT_REVISION,
    limits=OperationLimits(
        max_input_bytes=2 * 1024 * 1024,
        max_result_bytes=2 * 1024 * 1024,
    ),
)


__all__ = ["VARIANT_SOURCE_PREPARATION_OPERATION_KIND"]
