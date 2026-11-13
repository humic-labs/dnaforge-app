"""Typed contract for application-owned BAM index preparation."""

from __future__ import annotations

import hashlib
import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .aligned_read_file_generation import (
    AlignedReadFileGeneration,
    capture_aligned_read_file_generation,
)
from .operations import (
    InputRevisionMismatch,
    ManagedOperationSubmission,
    OperationSubject,
)


class AlignmentIndexRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    bam_path: str = Field(alias="bamPath", min_length=1, max_length=4096)


class AlignmentIndexInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    bam_path: str = Field(alias="bamPath", min_length=1, max_length=4096)
    source_generation: AlignedReadFileGeneration = Field(alias="sourceGeneration")


class AlignmentIndexSubjectInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    scope_id: str = Field(min_length=1, max_length=512)
    input_revision: str | None = Field(default=None, min_length=1, max_length=512)


class AlignmentIndexSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    submission_key: str = Field(min_length=1, max_length=256)
    subject: AlignmentIndexSubjectInput
    input: AlignmentIndexRequest


class AlignmentIndexAgentStart(BaseModel):
    """Agent-visible path resolved inside an open DNAForge workspace."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    path: str = Field(
        min_length=1,
        max_length=4096,
        description=(
            "A BAM path inside an open DNAForge project. With multiple projects "
            "open, prefix a relative path with the project name."
        ),
    )


class AlignmentIndexAgentPreparation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    ok: Literal[True]
    input: AlignmentIndexRequest


class AlignmentIndexResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    format: Literal["bam", "cram"]
    state: Literal["created", "present"]
    index_path: str = Field(alias="indexPath", min_length=1, max_length=4096)


def _hash(prefix: str, value: object) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"{prefix}:sha256:" + hashlib.sha256(encoded).hexdigest()


def alignment_index_subject_id(value: AlignmentIndexInput) -> str:
    return _hash(
        "aligned-read-file-v1",
        value.source_generation.model_dump(
            mode="json", by_alias=True, exclude_none=False
        ),
    )


def alignment_index_input_revision(value: AlignmentIndexInput) -> str:
    return _hash(
        "alignment-index-v1",
        value.model_dump(mode="json", by_alias=True, exclude_none=False),
    )


def prepare_alignment_index_submission(
    submission: AlignmentIndexSubmission,
) -> ManagedOperationSubmission[AlignmentIndexInput]:
    generation = capture_aligned_read_file_generation(submission.input.bam_path)
    operation_input = AlignmentIndexInput(
        bamPath=generation.canonical_path,
        sourceGeneration=generation,
    )
    revision = alignment_index_input_revision(operation_input)
    expected = submission.subject.input_revision
    if expected is not None and expected != revision:
        raise InputRevisionMismatch(
            "The supplied input revision does not match the alignment index request."
        )
    return ManagedOperationSubmission[AlignmentIndexInput](
        submission_key=submission.submission_key,
        subject=OperationSubject(
            scope_id=submission.subject.scope_id,
            subject_id=alignment_index_subject_id(operation_input),
            input_revision=revision,
        ),
        input=operation_input,
    )


__all__ = [
    "AlignmentIndexAgentPreparation",
    "AlignmentIndexAgentStart",
    "AlignmentIndexInput",
    "AlignmentIndexRequest",
    "AlignmentIndexResult",
    "AlignmentIndexSubmission",
    "alignment_index_input_revision",
    "alignment_index_subject_id",
    "prepare_alignment_index_submission",
]
