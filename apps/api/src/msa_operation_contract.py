"""Typed, bounded contract for managed multiple-sequence alignment."""

from __future__ import annotations

import hashlib
import json
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .operations import (
    InputRevisionMismatch,
    ManagedOperationSubmission,
    OperationSubject,
)
from .operations.contracts import OperationAcceptedWorkspaceInput

MAX_MSA_SEQUENCE_COUNT = 128
MAX_MSA_SEQUENCE_RESIDUES = 100_000
MAX_MSA_TOTAL_RESIDUES = 1_000_000
MAX_MSA_OUTPUT_CELLS = 8_000_000
MAX_MSA_TIMEOUT_SECONDS = 600
MAX_MSA_THREADS = 16

PROTEIN_ALPHABET = frozenset("ACDEFGHIKLMNPQRSTVWYX*-")


def _validated_sequence_id(value: str) -> str:
    if any(character.isspace() for character in value) or value.startswith(">"):
        raise ValueError("sequence ID must not contain whitespace or start with '>'")
    return value


def _validated_protein_sequence(value: str) -> str:
    cleaned = "".join(value.split()).upper()
    invalid = set(cleaned) - PROTEIN_ALPHABET
    if invalid:
        raise ValueError("sequence contains invalid amino-acid characters")
    return cleaned


class MsaAlgorithm(str, Enum):
    AUTO = "auto"
    FAST = "fast"
    ACCURATE = "accurate"
    GINSI = "ginsi"
    LINSI = "linsi"
    EINSI = "einsi"


class MsaSequenceInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(min_length=1, max_length=256)
    name: str | None = Field(default=None, max_length=512)
    sequence: str = Field(min_length=1, max_length=MAX_MSA_SEQUENCE_RESIDUES)

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        return _validated_sequence_id(value)

    @field_validator("sequence")
    @classmethod
    def validate_sequence(cls, value: str) -> str:
        return _validated_protein_sequence(value)


class MsaAlignedSequence(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(min_length=1, max_length=256)
    name: str | None = Field(default=None, max_length=512)
    sequence: str = Field(min_length=1, max_length=MAX_MSA_TOTAL_RESIDUES)

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        return _validated_sequence_id(value)

    @field_validator("sequence")
    @classmethod
    def validate_sequence(cls, value: str) -> str:
        return _validated_protein_sequence(value)


class MultipleSequenceAlignmentInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    sequences: list[MsaSequenceInput] = Field(
        min_length=2, max_length=MAX_MSA_SEQUENCE_COUNT
    )
    algorithm: MsaAlgorithm = MsaAlgorithm.AUTO
    threads: int = Field(default=4, ge=1, le=MAX_MSA_THREADS)
    timeout_seconds: int = Field(
        default=MAX_MSA_TIMEOUT_SECONDS, ge=1, le=MAX_MSA_TIMEOUT_SECONDS
    )
    accepted_workspace_input: OperationAcceptedWorkspaceInput | None = Field(
        default=None, exclude_if=lambda value: value is None
    )

    @model_validator(mode="after")
    def validate_work_size(self) -> MultipleSequenceAlignmentInput:
        identifiers = [record.id for record in self.sequences]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("sequence IDs must be unique")
        total_residues = sum(len(record.sequence) for record in self.sequences)
        if total_residues > MAX_MSA_TOTAL_RESIDUES:
            raise ValueError(
                "total sequence residues exceed the managed alignment limit"
            )
        if len(self.sequences) * total_residues > MAX_MSA_OUTPUT_CELLS:
            raise ValueError(
                "estimated aligned output exceeds the managed result limit"
            )
        return self


class MultipleSequenceAlignmentResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    aligned_sequences: list[MsaAlignedSequence] = Field(
        min_length=2, max_length=MAX_MSA_SEQUENCE_COUNT
    )
    alignment_length: int = Field(ge=1)
    num_sequences: int = Field(ge=2, le=MAX_MSA_SEQUENCE_COUNT)

    @model_validator(mode="after")
    def validate_shape(self) -> MultipleSequenceAlignmentResult:
        if self.num_sequences != len(self.aligned_sequences):
            raise ValueError("num_sequences must match aligned_sequences")
        identifiers = [record.id for record in self.aligned_sequences]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("aligned sequence IDs must be unique")
        if any(
            len(record.sequence) != self.alignment_length
            for record in self.aligned_sequences
        ):
            raise ValueError(
                "all aligned sequences must have alignment_length residues"
            )
        if self.num_sequences * self.alignment_length > MAX_MSA_OUTPUT_CELLS:
            raise ValueError("aligned output exceeds the managed result limit")
        return self


class MultipleSequenceAlignmentSubjectInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    scope_id: str = Field(min_length=1, max_length=512)
    subject_id: str = Field(min_length=1, max_length=1024)
    input_revision: str | None = Field(default=None, min_length=1, max_length=512)
    accepted_workspace_input: OperationAcceptedWorkspaceInput | None = Field(
        default=None, exclude_if=lambda value: value is None
    )

    @model_validator(mode="after")
    def validate_accepted_workspace(self) -> MultipleSequenceAlignmentSubjectInput:
        if (
            self.accepted_workspace_input is not None
            and self.accepted_workspace_input.workspace_id != self.scope_id
        ):
            raise ValueError("accepted input workspace must match the operation scope")
        return self


class MultipleSequenceAlignmentSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    submission_key: str = Field(min_length=1, max_length=256)
    subject: MultipleSequenceAlignmentSubjectInput
    input: MultipleSequenceAlignmentInput


def multiple_sequence_alignment_input_revision(
    value: MultipleSequenceAlignmentInput,
) -> str:
    canonical = json.dumps(
        value.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return "msa-v1:sha256:" + hashlib.sha256(canonical).hexdigest()


def prepare_multiple_sequence_alignment_submission(
    submission: MultipleSequenceAlignmentSubmission,
) -> ManagedOperationSubmission[MultipleSequenceAlignmentInput]:
    accepted = submission.subject.accepted_workspace_input
    operation_input = submission.input.model_copy(
        update={"accepted_workspace_input": accepted}
    )
    revision = multiple_sequence_alignment_input_revision(operation_input)
    expected = submission.subject.input_revision
    if expected is not None and expected != revision:
        raise InputRevisionMismatch(
            "The supplied input revision does not match the alignment input."
        )
    return ManagedOperationSubmission[MultipleSequenceAlignmentInput](
        submission_key=submission.submission_key,
        subject=OperationSubject(
            scope_id=submission.subject.scope_id,
            subject_id=submission.subject.subject_id,
            input_revision=revision,
            accepted_workspace_input=accepted,
        ),
        input=operation_input,
    )
