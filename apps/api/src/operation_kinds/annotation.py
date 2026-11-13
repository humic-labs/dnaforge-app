from __future__ import annotations

from dnaforge_annotation.contract import AnnotationRequest, AnnotationResult

from ..annotation_operation_audit import (
    annotation_submission_audit_parameters,
    recorded_annotation_import_audit_parameters,
)
from ..annotation_operation_contract import (
    AnnotationSubmission,
    prepare_annotation_submission,
)
from ..operations import CancellationMode
from ..operations.registration import (
    ExecutableOperationKind,
    OperationKindKey,
    OperationLimits,
    RecordedImportContract,
    ResultCodec,
    StartContract,
)
from ..recorded_annotation_operations import (
    RecordedAnnotationImport,
    prepare_recorded_annotation_import,
)

ANNOTATION_OPERATION_KIND = ExecutableOperationKind(
    key=OperationKindKey(kind="annotation", version=1),
    title="Annotate sequence",
    input_model=AnnotationRequest,
    result=ResultCodec(
        current_version=1,
        model=AnnotationResult,
        decoders={1: AnnotationResult.model_validate},
    ),
    start=StartContract(
        request_model=AnnotationSubmission,
        prepare=prepare_annotation_submission,
        required_capabilities=frozenset({"operations.start"}),
        audit_parameters=annotation_submission_audit_parameters,
    ),
    recorded_import=RecordedImportContract(
        request_model=RecordedAnnotationImport,
        prepare=prepare_recorded_annotation_import,
        required_capabilities=frozenset({"operations.import"}),
        audit_parameters=recorded_annotation_import_audit_parameters,
    ),
    cancellation=CancellationMode.QUEUED_ONLY,
    limits=OperationLimits(),
)
