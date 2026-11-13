from __future__ import annotations

from ..annotation_provisioning_contract import (
    AnnotationProvisioningInput,
    AnnotationProvisioningResult,
    AnnotationProvisioningSubmission,
    annotation_provisioning_audit_parameters,
    prepare_annotation_provisioning_submission,
)
from ..operations import CancellationMode
from ..operations.registration import (
    ExecutableOperationKind,
    OperationKindKey,
    OperationLimits,
    ResultCodec,
    StartContract,
)

ANNOTATION_PROVISIONING_OPERATION_KIND = ExecutableOperationKind(
    key=OperationKindKey(kind="annotation-provisioning", version=1),
    title="Set up annotation",
    input_model=AnnotationProvisioningInput,
    result=ResultCodec(
        current_version=1,
        model=AnnotationProvisioningResult,
        decoders={1: AnnotationProvisioningResult.model_validate},
    ),
    start=StartContract(
        request_model=AnnotationProvisioningSubmission,
        prepare=prepare_annotation_provisioning_submission,
        required_capabilities=frozenset({"operations.start"}),
        audit_parameters=annotation_provisioning_audit_parameters,
    ),
    cancellation=CancellationMode.QUEUED_ONLY,
    limits=OperationLimits(max_input_bytes=16 * 1024, max_result_bytes=16 * 1024),
)

__all__ = ["ANNOTATION_PROVISIONING_OPERATION_KIND"]
