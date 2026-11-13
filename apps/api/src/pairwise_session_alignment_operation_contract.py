"""Typed, bounded contract for managed pairwise Alignment Manager sessions."""

from __future__ import annotations

import hashlib
import json
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .operations import (
    InputRevisionMismatch,
    ManagedOperationSubmission,
    OperationSubject,
)
from .operations.contracts import OperationAcceptedWorkspaceInput
from .tools.alignment import AlignmentResult

MAX_PAIRWISE_QUERY_COUNT = 64
MAX_PAIRWISE_SEQUENCE_RESIDUES = 250_000
MAX_PAIRWISE_TOTAL_RESIDUES = 2_000_000
MAX_PAIRWISE_OUTPUT_CELLS = 8_000_000
MAX_PAIRWISE_TIMEOUT_SECONDS = 300
MAX_PAIRWISE_THREADS = 16

_NUCLEIC_ALPHABET = frozenset("ATCGUNRYKMSWBDHV-")


def _sha256(prefix: str, value: object) -> str:
    canonical = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"{prefix}:sha256:" + hashlib.sha256(canonical).hexdigest()


def _normalize_identity(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError("identity must not be blank")
    if any(character.isspace() for character in normalized):
        raise ValueError("identity must not contain whitespace")
    return normalized


def _normalize_sequence(value: str) -> str:
    normalized = "".join(value.split()).upper()
    invalid = set(normalized) - _NUCLEIC_ALPHABET
    if invalid:
        raise ValueError("sequence contains invalid nucleic-acid characters")
    return normalized


class PairwiseSessionAlgorithm(str, Enum):
    AUTO = "auto"
    FAST = "fast"
    ACCURATE = "accurate"
    GINSI = "ginsi"
    LINSI = "linsi"
    EINSI = "einsi"


class PairwiseSessionQueryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(min_length=1, max_length=256)
    sequence: str = Field(min_length=10, max_length=MAX_PAIRWISE_SEQUENCE_RESIDUES)

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        return _normalize_identity(value)

    @field_validator("sequence")
    @classmethod
    def validate_sequence(cls, value: str) -> str:
        return _normalize_sequence(value)


class PairwiseSessionQueryInput(PairwiseSessionQueryRequest):
    revision: str = Field(
        pattern=r"^pairwise-query-v1:sha256:[0-9a-f]{64}$",
    )


class PairwiseSessionAlignmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    reference_sequence: str = Field(
        alias="referenceSequence",
        min_length=10,
        max_length=MAX_PAIRWISE_SEQUENCE_RESIDUES,
    )
    queries: list[PairwiseSessionQueryRequest] = Field(
        min_length=1,
        max_length=MAX_PAIRWISE_QUERY_COUNT,
    )
    algorithm: PairwiseSessionAlgorithm = PairwiseSessionAlgorithm.AUTO
    threads: int = Field(default=4, ge=1, le=MAX_PAIRWISE_THREADS)
    timeout_seconds: int = Field(
        default=MAX_PAIRWISE_TIMEOUT_SECONDS,
        alias="timeoutSeconds",
        ge=1,
        le=MAX_PAIRWISE_TIMEOUT_SECONDS,
    )
    is_circular: bool = Field(default=False, alias="isCircular")

    @field_validator("reference_sequence")
    @classmethod
    def validate_reference(cls, value: str) -> str:
        return _normalize_sequence(value)

    @model_validator(mode="after")
    def validate_work_size(self) -> PairwiseSessionAlignmentRequest:
        identifiers = [query.id for query in self.queries]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("query IDs must be unique")
        total_residues = len(self.reference_sequence) + sum(
            len(query.sequence) for query in self.queries
        )
        if total_residues > MAX_PAIRWISE_TOTAL_RESIDUES:
            raise ValueError(
                "total sequence residues exceed the managed pairwise limit"
            )
        output_cells = sum(
            2 * (len(self.reference_sequence) + len(query.sequence))
            for query in self.queries
        )
        if output_cells > MAX_PAIRWISE_OUTPUT_CELLS:
            raise ValueError(
                "estimated aligned output exceeds the managed result limit"
            )
        return self


class PairwiseSessionAlignmentInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    reference_sequence: str = Field(
        alias="referenceSequence",
        min_length=10,
        max_length=MAX_PAIRWISE_SEQUENCE_RESIDUES,
    )
    reference_revision: str = Field(
        alias="referenceRevision",
        pattern=r"^pairwise-reference-v1:sha256:[0-9a-f]{64}$",
    )
    queries: list[PairwiseSessionQueryInput] = Field(
        min_length=1,
        max_length=MAX_PAIRWISE_QUERY_COUNT,
    )
    algorithm: PairwiseSessionAlgorithm = PairwiseSessionAlgorithm.AUTO
    threads: int = Field(default=4, ge=1, le=MAX_PAIRWISE_THREADS)
    timeout_seconds: int = Field(
        default=MAX_PAIRWISE_TIMEOUT_SECONDS,
        alias="timeoutSeconds",
        ge=1,
        le=MAX_PAIRWISE_TIMEOUT_SECONDS,
    )
    is_circular: bool = Field(default=False, alias="isCircular")
    accepted_workspace_input: OperationAcceptedWorkspaceInput | None = Field(
        default=None,
        alias="acceptedWorkspaceInput",
        exclude_if=lambda value: value is None,
    )

    @field_validator("reference_sequence")
    @classmethod
    def validate_reference(cls, value: str) -> str:
        return _normalize_sequence(value)

    @model_validator(mode="after")
    def validate_work_size(self) -> PairwiseSessionAlignmentInput:
        request = PairwiseSessionAlignmentRequest(
            referenceSequence=self.reference_sequence,
            queries=[
                PairwiseSessionQueryRequest(id=query.id, sequence=query.sequence)
                for query in self.queries
            ],
            algorithm=self.algorithm,
            threads=self.threads,
            timeoutSeconds=self.timeout_seconds,
            isCircular=self.is_circular,
        )
        if self.reference_revision != pairwise_reference_revision(
            request.reference_sequence
        ):
            raise ValueError("reference revision does not match reference sequence")
        for query in self.queries:
            if query.revision != pairwise_query_revision(query.sequence):
                raise ValueError("query revision does not match query sequence")
        if self.accepted_workspace_input is not None:
            expected = {"reference", *(f"query:{query.id}" for query in self.queries)}
            if {file.key for file in self.accepted_workspace_input.files} != expected:
                raise ValueError(
                    "accepted input files must match the reference and queries"
                )
        return self


class PairwiseSessionAlignmentSubjectInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    scope_id: str = Field(min_length=1, max_length=512)
    document_id: str = Field(min_length=1, max_length=1024)
    session_id: str = Field(min_length=1, max_length=1024)
    input_revision: str | None = Field(default=None, min_length=1, max_length=512)
    accepted_workspace_input: OperationAcceptedWorkspaceInput | None = Field(
        default=None, exclude_if=lambda value: value is None
    )

    @model_validator(mode="after")
    def validate_accepted_workspace(self) -> PairwiseSessionAlignmentSubjectInput:
        if (
            self.accepted_workspace_input is not None
            and self.accepted_workspace_input.workspace_id != self.scope_id
        ):
            raise ValueError("accepted input workspace must match the operation scope")
        return self

    @field_validator("document_id", "session_id")
    @classmethod
    def validate_identity(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("session subject identity must not be blank")
        return normalized


class PairwiseSessionAlignmentSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    submission_key: str = Field(min_length=1, max_length=256)
    subject: PairwiseSessionAlignmentSubjectInput
    input: PairwiseSessionAlignmentRequest


class PairwiseSessionQueryResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    query_id: str = Field(alias="queryId", min_length=1, max_length=256)
    query_revision: str = Field(
        alias="queryRevision",
        pattern=r"^pairwise-query-v1:sha256:[0-9a-f]{64}$",
    )
    alignment: AlignmentResult


class PairwiseSessionAlignmentToolIdentity(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    name: Literal["MAFFT"]
    version: str = Field(
        min_length=1,
        max_length=128,
        pattern=r"^v?[0-9]+\.[0-9]+(?:\.[0-9]+)?(?: \([ -~]+\))?$",
    )

    @field_validator("version")
    @classmethod
    def validate_version_line(cls, value: str) -> str:
        if value != value.strip() or any(
            ord(char) < 32 or ord(char) > 126 for char in value
        ):
            raise ValueError("MAFFT version must be one printable version line")
        return value


class PairwiseSessionAlignmentResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    input_revision: str = Field(
        alias="inputRevision",
        pattern=r"^pairwise-session-alignment-v1:sha256:[0-9a-f]{64}$",
    )
    reference_revision: str = Field(
        alias="referenceRevision",
        pattern=r"^pairwise-reference-v1:sha256:[0-9a-f]{64}$",
    )
    results: list[PairwiseSessionQueryResult] = Field(
        min_length=1,
        max_length=MAX_PAIRWISE_QUERY_COUNT,
    )
    tool: PairwiseSessionAlignmentToolIdentity | None = Field(
        default=None, exclude_if=lambda value: value is None
    )

    @model_validator(mode="after")
    def validate_unique_results(self) -> PairwiseSessionAlignmentResult:
        identifiers = [row.query_id for row in self.results]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("pairwise result query IDs must be unique")
        return self


def pairwise_reference_revision(sequence: str) -> str:
    return _sha256("pairwise-reference-v1", _normalize_sequence(sequence))


def pairwise_query_revision(sequence: str) -> str:
    return _sha256("pairwise-query-v1", _normalize_sequence(sequence))


def pairwise_session_alignment_input_revision(
    value: PairwiseSessionAlignmentInput,
) -> str:
    return _sha256(
        "pairwise-session-alignment-v1",
        value.model_dump(mode="json", by_alias=True),
    )


def pairwise_session_alignment_subject_id(
    document_id: str,
    session_id: str,
) -> str:
    return _sha256(
        "pairwise-session-alignment-subject-v1",
        {"document_id": document_id, "session_id": session_id},
    )


def prepare_pairwise_session_alignment_submission(
    submission: PairwiseSessionAlignmentSubmission,
) -> ManagedOperationSubmission[PairwiseSessionAlignmentInput]:
    request = submission.input
    operation_input = PairwiseSessionAlignmentInput(
        referenceSequence=request.reference_sequence,
        referenceRevision=pairwise_reference_revision(request.reference_sequence),
        queries=[
            PairwiseSessionQueryInput(
                id=query.id,
                sequence=query.sequence,
                revision=pairwise_query_revision(query.sequence),
            )
            for query in request.queries
        ],
        algorithm=request.algorithm,
        threads=request.threads,
        timeoutSeconds=request.timeout_seconds,
        isCircular=request.is_circular,
        acceptedWorkspaceInput=submission.subject.accepted_workspace_input,
    )
    revision = pairwise_session_alignment_input_revision(operation_input)
    expected = submission.subject.input_revision
    if expected is not None and expected != revision:
        raise InputRevisionMismatch(
            "The supplied input revision does not match the pairwise session alignment."
        )
    return ManagedOperationSubmission[PairwiseSessionAlignmentInput](
        submission_key=submission.submission_key,
        subject=OperationSubject(
            scope_id=submission.subject.scope_id,
            subject_id=pairwise_session_alignment_subject_id(
                submission.subject.document_id,
                submission.subject.session_id,
            ),
            input_revision=revision,
            accepted_workspace_input=submission.subject.accepted_workspace_input,
        ),
        input=operation_input,
    )


__all__ = [
    "MAX_PAIRWISE_OUTPUT_CELLS",
    "MAX_PAIRWISE_QUERY_COUNT",
    "MAX_PAIRWISE_SEQUENCE_RESIDUES",
    "MAX_PAIRWISE_THREADS",
    "MAX_PAIRWISE_TIMEOUT_SECONDS",
    "MAX_PAIRWISE_TOTAL_RESIDUES",
    "PairwiseSessionAlignmentInput",
    "PairwiseSessionAlignmentRequest",
    "PairwiseSessionAlignmentResult",
    "PairwiseSessionAlignmentToolIdentity",
    "PairwiseSessionAlignmentSubmission",
    "PairwiseSessionQueryInput",
    "PairwiseSessionQueryRequest",
    "PairwiseSessionQueryResult",
    "pairwise_query_revision",
    "pairwise_reference_revision",
    "pairwise_session_alignment_input_revision",
    "pairwise_session_alignment_subject_id",
    "prepare_pairwise_session_alignment_submission",
]
