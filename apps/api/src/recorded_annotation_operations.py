"""Validated, source-free ledger projection for standalone annotation receipts."""

from __future__ import annotations

import hashlib

from dnaforge_annotation.contract import AnnotationResult
from dnaforge_annotation.core import clean_sequence
from dnaforge_annotation.receipt import AnnotationRunReceiptV1
from pydantic import BaseModel, ConfigDict

from .annotation_operation_contract import AnnotationSubjectInput, InputRevisionMismatch
from .operations import (
    OperationRecordedArtifact,
    OperationRecordedProvenance,
    OperationRecordedRuntime,
    OperationSubject,
    PreparedRecordedOperation,
)


class RecordedAnnotationImport(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    subject: AnnotationSubjectInput
    receipt: AnnotationRunReceiptV1


def prepare_recorded_annotation_import(
    value: BaseModel,
) -> PreparedRecordedOperation[AnnotationResult]:
    imported = RecordedAnnotationImport.model_validate(value)
    receipt = imported.receipt
    expected_revision = imported.subject.input_revision
    if expected_revision is not None and expected_revision != receipt.input.revision:
        raise InputRevisionMismatch(
            "The supplied input revision does not match the recorded annotation input."
        )
    sequence = clean_sequence(receipt.request.sequence)
    provenance = OperationRecordedProvenance(
        schema_version=receipt.schema_version,
        reported_run_id=str(receipt.run_id),
        reported_started_at=receipt.started_at,
        reported_finished_at=receipt.finished_at,
        tool_name=receipt.tool.name,
        tool_version=receipt.tool.version,
        parameters={
            "linear": receipt.request.linear,
            "start": receipt.request.start,
            "end": receipt.request.end,
        },
        inputs=[
            OperationRecordedArtifact(
                role="primary",
                identity=receipt.input.sequence_id,
                revision=receipt.input.revision,
                path=receipt.input.path,
                size=receipt.input.sequence_length,
                size_unit="bases",
                sha256=(
                    "sha256:" + hashlib.sha256(sequence.encode("utf-8")).hexdigest()
                ),
            )
        ],
        outputs=[
            OperationRecordedArtifact(
                role="primary",
                path=receipt.output.path,
                format=receipt.output.format,
            )
        ],
        runtime=OperationRecordedRuntime(
            threads=receipt.runtime.threads,
            data_path=receipt.runtime.data_dir,
            executables=receipt.runtime.executables.model_dump(mode="json"),
            temp_path=receipt.runtime.temp_dir,
            configuration_path=receipt.runtime.database_config,
        ),
        resource_manifest=receipt.reference_data.manifest,
        resources=receipt.reference_data.versions,
    )
    return PreparedRecordedOperation[AnnotationResult](
        subject=OperationSubject(
            scope_id=imported.subject.scope_id,
            subject_id=imported.subject.subject_id,
            input_revision=receipt.input.revision,
        ),
        reported_run_id=str(receipt.run_id),
        provenance=provenance,
        result=receipt.result,
    )
