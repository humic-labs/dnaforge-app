from __future__ import annotations

import hashlib

from ..ngs_read_analysis_contract import (
    NgsReadAnalysisInput,
    NgsReadAnalysisResult,
    NgsReadAnalysisSubmission,
    prepare_ngs_read_submission,
)
from ..operations import ActiveJoinMode, CancellationMode
from ..operations.registration import (
    ExecutableOperationKind,
    OperationKindKey,
    OperationLimits,
    ResultCodec,
    StartContract,
)


def ngs_audit_parameters(args):
    data = args.get("input")
    data = data if isinstance(data, dict) else {}
    sequence = data.get("referenceSequence", data.get("reference_sequence"))
    path = data.get("readPath", data.get("read_path"))
    return {
        "submission_key": args.get("submission_key"),
        "reference_length": len(sequence) if isinstance(sequence, str) else None,
        "reference_sha256": (
            hashlib.sha256(sequence.encode()).hexdigest()
            if isinstance(sequence, str)
            else None
        ),
        "read_path_sha256": (
            hashlib.sha256(path.encode()).hexdigest() if isinstance(path, str) else None
        ),
        "preset": data.get("preset"),
    }


NGS_READ_ANALYSIS_OPERATION_KIND = ExecutableOperationKind(
    key=OperationKindKey(kind="ngs-read-analysis", version=1),
    title="Analyze raw sequencing reads",
    input_model=NgsReadAnalysisInput,
    result=ResultCodec(
        current_version=1,
        model=NgsReadAnalysisResult,
        decoders={1: NgsReadAnalysisResult.model_validate},
    ),
    start=StartContract(
        request_model=NgsReadAnalysisSubmission,
        prepare=prepare_ngs_read_submission,
        required_capabilities=frozenset({"operations.start"}),
        audit_parameters=ngs_audit_parameters,
    ),
    cancellation=CancellationMode.COOPERATIVE,
    active_join=ActiveJoinMode.SUBJECT_REVISION,
    limits=OperationLimits(
        max_input_bytes=1024 * 1024, max_result_bytes=16 * 1024 * 1024
    ),
)
