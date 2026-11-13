"""Typed contract for durable primer-library binding searches."""

from __future__ import annotations

import hashlib
import json

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .operations import (
    InputRevisionMismatch,
    ManagedOperationSubmission,
    OperationSubject,
)
from .operations.contracts import OperationAcceptedWorkspaceInput
from .tools.primer_bind import BindingHit

MAX_PRIMER_LIBRARY_SIZE = 10_000
MAX_PRIMER_LENGTH = 10_000
MAX_REFERENCE_SEQUENCE_LENGTH = 12 * 1024 * 1024


def _sha256(prefix: str, value: object) -> str:
    canonical = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"{prefix}:sha256:" + hashlib.sha256(canonical).hexdigest()


class PrimerLibrarySearchPrimer(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(min_length=1, max_length=1024)
    sequence: str = Field(min_length=1, max_length=MAX_PRIMER_LENGTH)
    revision: str = Field(min_length=1, max_length=512)

    @field_validator("id", "revision")
    @classmethod
    def normalize_identity(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("primer identity fields must not be blank")
        return normalized

    @field_validator("sequence")
    @classmethod
    def normalize_sequence(cls, value: str) -> str:
        normalized = value.strip().upper()
        if not normalized:
            raise ValueError("primer sequence must not be blank")
        return normalized


class PrimerLibrarySearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    target_document_id: str = Field(
        alias="targetDocumentId", min_length=1, max_length=1024
    )
    reference_sequence: str = Field(
        alias="referenceSequence",
        min_length=1,
        max_length=MAX_REFERENCE_SEQUENCE_LENGTH,
    )
    circular: bool = False
    primers: list[PrimerLibrarySearchPrimer] = Field(
        min_length=1, max_length=MAX_PRIMER_LIBRARY_SIZE
    )
    region_start: int | None = Field(default=None, alias="regionStart", ge=0)
    region_end: int | None = Field(default=None, alias="regionEnd", ge=1)
    max_edit_distance: int = Field(default=3, alias="maxEditDistance", ge=0, le=10)
    min_match_length: int = Field(default=0, alias="minMatchLength", ge=0)
    min_effective_tm: float = Field(default=0.0, alias="minEffectiveTm", ge=0)
    max_mismatches: int = Field(default=10, alias="maxMismatches", ge=0, le=10)

    @field_validator("target_document_id")
    @classmethod
    def normalize_target_document_id(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("targetDocumentId must not be blank")
        return normalized

    @field_validator("reference_sequence")
    @classmethod
    def normalize_reference_sequence(cls, value: str) -> str:
        normalized = value.strip().upper()
        if not normalized:
            raise ValueError("referenceSequence must not be blank")
        return normalized

    @model_validator(mode="after")
    def validate_snapshot(self) -> PrimerLibrarySearchRequest:
        primer_ids = [primer.id for primer in self.primers]
        if primer_ids != sorted(primer_ids):
            raise ValueError("primer snapshot must be ordered by primer id")
        if len(primer_ids) != len(set(primer_ids)):
            raise ValueError("primer snapshot contains duplicate primer ids")
        if (self.region_start is None) != (self.region_end is None):
            raise ValueError("regionStart and regionEnd must be supplied together")
        if self.region_start is not None and self.region_end is not None:
            if self.region_start >= self.region_end:
                raise ValueError("primer search region must not be empty")
            if self.region_end > len(self.reference_sequence):
                raise ValueError("primer search region exceeds the target sequence")
        return self


class PrimerLibrarySearchInput(PrimerLibrarySearchRequest):
    target_revision: str = Field(
        alias="targetRevision",
        pattern=r"^primer-search-target-v1:sha256:[0-9a-f]{64}$",
    )
    library_revision: str = Field(
        alias="libraryRevision",
        pattern=r"^primer-library-v1:sha256:[0-9a-f]{64}$",
    )
    accepted_workspace_input: OperationAcceptedWorkspaceInput | None = Field(
        default=None,
        alias="acceptedWorkspaceInput",
        exclude_if=lambda value: value is None,
    )


class PrimerLibrarySearchSubjectInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    scope_id: str = Field(min_length=1, max_length=512)
    input_revision: str | None = Field(default=None, min_length=1, max_length=512)
    accepted_workspace_input: OperationAcceptedWorkspaceInput | None = Field(
        default=None, exclude_if=lambda value: value is None
    )

    @model_validator(mode="after")
    def validate_accepted_workspace(self) -> PrimerLibrarySearchSubjectInput:
        accepted = self.accepted_workspace_input
        if accepted is None:
            return self
        if accepted.workspace_id != self.scope_id:
            raise ValueError("accepted input workspace must match the operation scope")
        if [file.key for file in accepted.files] != ["target"]:
            raise ValueError("accepted input must be exactly the target sequence file")
        return self


class PrimerLibrarySearchSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    submission_key: str = Field(min_length=1, max_length=256)
    subject: PrimerLibrarySearchSubjectInput
    input: PrimerLibrarySearchRequest


class PrimerLibrarySearchPrimerResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    primer_id: str = Field(alias="primerId", min_length=1, max_length=1024)
    hits: list[BindingHit]


class PrimerLibrarySearchResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    target_revision: str = Field(
        alias="targetRevision",
        pattern=r"^primer-search-target-v1:sha256:[0-9a-f]{64}$",
    )
    library_revision: str = Field(
        alias="libraryRevision",
        pattern=r"^primer-library-v1:sha256:[0-9a-f]{64}$",
    )
    results: list[PrimerLibrarySearchPrimerResult]


def primer_library_search_target_revision(
    value: PrimerLibrarySearchRequest | PrimerLibrarySearchInput,
) -> str:
    return _sha256(
        "primer-search-target-v1",
        {
            "circular": value.circular,
            "sequence": value.reference_sequence,
        },
    )


def primer_library_search_library_revision(
    value: PrimerLibrarySearchRequest | PrimerLibrarySearchInput,
) -> str:
    return _sha256(
        "primer-library-v1",
        [primer.model_dump(mode="json") for primer in value.primers],
    )


def primer_library_search_input_revision(value: PrimerLibrarySearchInput) -> str:
    return _sha256(
        "primer-library-search-v1",
        value.model_dump(mode="json", by_alias=True),
    )


def primer_library_search_subject_id(target_document_id: str) -> str:
    return _sha256("primer-library-search-target-v1", target_document_id)


def prepare_primer_library_search_submission(
    submission: PrimerLibrarySearchSubmission,
) -> ManagedOperationSubmission[PrimerLibrarySearchInput]:
    request = submission.input
    accepted = submission.subject.accepted_workspace_input
    operation_input = PrimerLibrarySearchInput(
        **request.model_dump(mode="python"),
        targetRevision=primer_library_search_target_revision(request),
        libraryRevision=primer_library_search_library_revision(request),
        acceptedWorkspaceInput=accepted,
    )
    revision = primer_library_search_input_revision(operation_input)
    expected = submission.subject.input_revision
    if expected is not None and expected != revision:
        raise InputRevisionMismatch(
            "The supplied input revision does not match the primer-library search."
        )
    return ManagedOperationSubmission[PrimerLibrarySearchInput](
        submission_key=submission.submission_key,
        subject=OperationSubject(
            scope_id=submission.subject.scope_id,
            subject_id=primer_library_search_subject_id(
                operation_input.target_document_id
            ),
            input_revision=revision,
            accepted_workspace_input=accepted,
        ),
        input=operation_input,
    )


__all__ = [
    "MAX_PRIMER_LIBRARY_SIZE",
    "MAX_PRIMER_LENGTH",
    "MAX_REFERENCE_SEQUENCE_LENGTH",
    "PrimerLibrarySearchInput",
    "PrimerLibrarySearchPrimer",
    "PrimerLibrarySearchPrimerResult",
    "PrimerLibrarySearchRequest",
    "PrimerLibrarySearchResult",
    "PrimerLibrarySearchSubmission",
    "prepare_primer_library_search_submission",
    "primer_library_search_input_revision",
    "primer_library_search_library_revision",
    "primer_library_search_subject_id",
    "primer_library_search_target_revision",
]
