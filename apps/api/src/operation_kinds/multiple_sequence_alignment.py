from __future__ import annotations

from ..msa_operation_audit import multiple_sequence_alignment_audit_parameters
from ..msa_operation_contract import (
    MultipleSequenceAlignmentInput,
    MultipleSequenceAlignmentResult,
    MultipleSequenceAlignmentSubmission,
    prepare_multiple_sequence_alignment_submission,
)
from ..operations import CancellationMode
from ..operations.registration import (
    ExecutableOperationKind,
    OperationKindKey,
    OperationLimits,
    ResultCodec,
    StartContract,
)

MULTIPLE_SEQUENCE_ALIGNMENT_OPERATION_KIND = ExecutableOperationKind(
    key=OperationKindKey(kind="multiple-sequence-alignment", version=1),
    title="Multiple sequence alignment",
    input_model=MultipleSequenceAlignmentInput,
    result=ResultCodec(
        current_version=1,
        model=MultipleSequenceAlignmentResult,
        decoders={1: MultipleSequenceAlignmentResult.model_validate},
    ),
    start=StartContract(
        request_model=MultipleSequenceAlignmentSubmission,
        prepare=prepare_multiple_sequence_alignment_submission,
        required_capabilities=frozenset({"operations.start"}),
        audit_parameters=multiple_sequence_alignment_audit_parameters,
    ),
    cancellation=CancellationMode.COOPERATIVE,
    limits=OperationLimits(
        max_input_bytes=2 * 1024 * 1024,
        max_result_bytes=12 * 1024 * 1024,
    ),
)
