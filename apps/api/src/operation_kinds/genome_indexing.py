from __future__ import annotations

from ..genome_index_operation_agent import prepare_agent_genome_index_submission
from ..genome_index_operation_audit import (
    genome_index_agent_audit_parameters,
    genome_index_submission_audit_parameters,
)
from ..genome_index_operation_contract import (
    GenomeIndexAgentStart,
    GenomeIndexSubmission,
    IndexGenomeRequest,
    IndexGenomeResponse,
    prepare_genome_index_submission,
)
from ..operations import CancellationMode
from ..operations.registration import (
    AgentStartContract,
    ExecutableOperationKind,
    OperationKindKey,
    OperationLimits,
    ResultCodec,
    StartContract,
)

GENOME_INDEXING_OPERATION_KIND = ExecutableOperationKind(
    key=OperationKindKey(kind="genome-indexing", version=1),
    title="Index genome",
    input_model=IndexGenomeRequest,
    result=ResultCodec(
        current_version=1,
        model=IndexGenomeResponse,
        decoders={1: IndexGenomeResponse.model_validate},
    ),
    start=StartContract(
        request_model=GenomeIndexSubmission,
        prepare=prepare_genome_index_submission,
        required_capabilities=frozenset({"operations.start"}),
        audit_parameters=genome_index_submission_audit_parameters,
    ),
    agent_start=AgentStartContract(
        request_model=GenomeIndexAgentStart,
        prepare=prepare_agent_genome_index_submission,
        required_capabilities=frozenset(
            {"operations.start", "read-workspace", "write-workspace"}
        ),
        audit_parameters=genome_index_agent_audit_parameters,
    ),
    cancellation=CancellationMode.COOPERATIVE,
    limits=OperationLimits(max_input_bytes=64 * 1024, max_result_bytes=64 * 1024),
)


__all__ = ["GENOME_INDEXING_OPERATION_KIND"]
