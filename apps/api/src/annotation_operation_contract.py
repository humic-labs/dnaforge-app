"""Verified annotation submission identity shared by managed client adapters."""

from __future__ import annotations

from dnaforge_annotation.contract import AnnotationRequest
from dnaforge_annotation.identity import annotation_input_revision
from pydantic import BaseModel, ConfigDict, Field

from .operations import (
    InputRevisionMismatch,
    ManagedOperationSubmission,
    OperationSubject,
)


class AnnotationSubjectInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    scope_id: str = Field(min_length=1, max_length=512)
    subject_id: str = Field(min_length=1, max_length=1024)
    input_revision: str | None = Field(default=None, min_length=1, max_length=512)


class AnnotationSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    submission_key: str = Field(min_length=1, max_length=256)
    subject: AnnotationSubjectInput
    input: AnnotationRequest


def prepare_annotation_submission(
    submission: AnnotationSubmission,
) -> ManagedOperationSubmission[AnnotationRequest]:
    revision = annotation_input_revision(submission.input)
    expected = submission.subject.input_revision
    if expected is not None and expected != revision:
        raise InputRevisionMismatch(
            "The supplied input revision does not match the analyzed sequence."
        )
    return ManagedOperationSubmission[AnnotationRequest](
        submission_key=submission.submission_key,
        subject=OperationSubject(
            scope_id=submission.subject.scope_id,
            subject_id=submission.subject.subject_id,
            input_revision=revision,
        ),
        input=submission.input,
    )
