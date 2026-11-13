from ..fastq_preprocessing_contract import (
    FastqPreprocessingInput,
    FastqPreprocessingResult,
    FastqPreprocessingSubmission,
    prepare_fastq_preprocessing,
)
from ..operations import ActiveJoinMode, CancellationMode
from ..operations.registration import (
    ExecutableOperationKind,
    OperationKindKey,
    OperationLimits,
    ResultCodec,
    StartContract,
)

FASTQ_PREPROCESSING_OPERATION_KIND = ExecutableOperationKind(
    key=OperationKindKey(kind="fastq-preprocessing", version=1),
    title="Trim adapters and merge paired reads",
    input_model=FastqPreprocessingInput,
    result=ResultCodec(
        current_version=1,
        model=FastqPreprocessingResult,
        decoders={1: FastqPreprocessingResult.model_validate},
    ),
    start=StartContract(
        request_model=FastqPreprocessingSubmission,
        prepare=prepare_fastq_preprocessing,
        required_capabilities=frozenset({"operations.start"}),
        audit_parameters=lambda args: {"submission_key": args.get("submission_key")},
    ),
    cancellation=CancellationMode.COOPERATIVE,
    active_join=ActiveJoinMode.SUBJECT_REVISION,
    limits=OperationLimits(max_input_bytes=64 * 1024, max_result_bytes=2 * 1024 * 1024),
)
