"""Typed contract for application-owned VCF/BCF source preparation."""

from __future__ import annotations

import hashlib
import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .local_file_generation import LocalFileGeneration, capture_local_file_generation
from .operations import (
    InputRevisionMismatch,
    ManagedOperationSubmission,
    OperationSubject,
)


class VariantFileGeneration(LocalFileGeneration):
    """Named wire contract for one VCF, BCF, or index generation."""


class VariantReferenceIdentity(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str = Field(min_length=1, max_length=512)
    length: int = Field(gt=0)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        normalized = value.strip()
        if (
            not normalized
            or "\x00" in normalized
            or any(character.isspace() for character in normalized)
        ):
            raise ValueError(
                "reference names must be nonempty names without whitespace"
            )
        return normalized


def _validate_unique_references(
    references: list[VariantReferenceIdentity],
) -> list[VariantReferenceIdentity]:
    names = [reference.name for reference in references]
    if len(names) != len(set(names)):
        raise ValueError("expected references must have unique names")
    return references


class VariantSourceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    variant_path: str = Field(alias="variantPath", min_length=1, max_length=4096)
    references: list[VariantReferenceIdentity] = Field(min_length=1)

    @field_validator("references")
    @classmethod
    def validate_references(
        cls, value: list[VariantReferenceIdentity]
    ) -> list[VariantReferenceIdentity]:
        return _validate_unique_references(value)


class VariantSourceInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    variant_path: str = Field(alias="variantPath", min_length=1, max_length=4096)
    references: list[VariantReferenceIdentity] = Field(min_length=1)
    source_generation: VariantFileGeneration = Field(alias="sourceGeneration")
    assembly_revision: str = Field(
        alias="assemblyRevision",
        pattern=r"^variant-assembly-v1:sha256:[0-9a-f]{64}$",
    )

    @model_validator(mode="after")
    def validate_bound_identity(self) -> VariantSourceInput:
        _validate_unique_references(self.references)
        if self.variant_path != self.source_generation.canonical_path:
            raise ValueError(
                "variantPath must equal the captured canonical source path"
            )
        if self.assembly_revision != variant_assembly_revision(self.references):
            raise ValueError("assemblyRevision does not match the expected references")
        return self


class VariantSourceSubjectInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    scope_id: str = Field(min_length=1, max_length=512)
    input_revision: str | None = Field(default=None, min_length=1, max_length=512)


class VariantSourceSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    submission_key: str = Field(min_length=1, max_length=256)
    subject: VariantSourceSubjectInput
    input: VariantSourceRequest


class VariantSourceAgentStart(BaseModel):
    """Agent request resolved against an indexed assembly and workspace path."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    assembly_id: str = Field(alias="assemblyId", min_length=1, max_length=1024)
    path: str = Field(
        min_length=1,
        max_length=4096,
        description=(
            "A VCF or BCF path inside an open DNAForge project. With multiple "
            "projects open, prefix a relative path with the project name."
        ),
    )


class VariantSourceAgentPreparation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    ok: Literal[True]
    assembly_id: str = Field(alias="assemblyId", min_length=1, max_length=1024)
    input: VariantSourceRequest


class VariantSourceResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    source_path: str = Field(alias="sourcePath", min_length=1, max_length=4096)
    query_path: str = Field(alias="queryPath", min_length=1, max_length=4096)
    index_path: str = Field(alias="indexPath", min_length=1, max_length=4096)
    format: Literal["vcf", "bcf"]
    label: str = Field(min_length=1, max_length=1024)
    source_size_bytes: int = Field(alias="sourceSizeBytes", ge=0)
    source_mtime_ns: str = Field(alias="sourceMtimeNs", pattern=r"^\d+$")
    source_identity: str = Field(alias="sourceIdentity", pattern=r"^[0-9a-f]{64}$")
    source_generation: VariantFileGeneration = Field(alias="sourceGeneration")
    query_generation: VariantFileGeneration = Field(alias="queryGeneration")
    index_generation: VariantFileGeneration = Field(alias="indexGeneration")
    assembly_revision: str = Field(
        alias="assemblyRevision",
        pattern=r"^variant-assembly-v1:sha256:[0-9a-f]{64}$",
    )
    matched_references: list[str] = Field(alias="matchedReferences", min_length=1)
    samples: list[str]


class VariantPageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    query_path: str = Field(alias="queryPath", min_length=1, max_length=4096)
    index_path: str = Field(alias="indexPath", min_length=1, max_length=4096)
    references: list[str] = Field(min_length=1)
    source_generation: VariantFileGeneration = Field(alias="sourceGeneration")
    query_generation: VariantFileGeneration = Field(alias="queryGeneration")
    index_generation: VariantFileGeneration = Field(alias="indexGeneration")
    assembly_revision: str = Field(
        alias="assemblyRevision",
        pattern=r"^variant-assembly-v1:sha256:[0-9a-f]{64}$",
    )
    cursor: str | None = None
    limit: int = Field(default=100, ge=1, le=200)


class VariantRegionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    query_path: str = Field(alias="queryPath", min_length=1, max_length=4096)
    index_path: str = Field(alias="indexPath", min_length=1, max_length=4096)
    source_generation: VariantFileGeneration = Field(alias="sourceGeneration")
    query_generation: VariantFileGeneration = Field(alias="queryGeneration")
    index_generation: VariantFileGeneration = Field(alias="indexGeneration")
    assembly_revision: str = Field(
        alias="assemblyRevision",
        pattern=r"^variant-assembly-v1:sha256:[0-9a-f]{64}$",
    )
    chrom: str = Field(min_length=1, max_length=512, pattern=r"^\S+$")
    start: int = Field(ge=0)
    end: int = Field(gt=0)
    limit: int = Field(default=10_000, ge=1, le=10_000)

    @model_validator(mode="after")
    def validate_region(self) -> VariantRegionRequest:
        if self.end <= self.start:
            raise ValueError("variant region end must be greater than start")
        if self.end - self.start > 5_000_000:
            raise ValueError("variant region exceeds the 5,000,000-base viewport limit")
        return self


def _sha256(prefix: str, value: object) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"{prefix}:sha256:" + hashlib.sha256(encoded).hexdigest()


def variant_assembly_revision(
    references: list[VariantReferenceIdentity],
) -> str:
    return _sha256(
        "variant-assembly-v1",
        [reference.model_dump(mode="json") for reference in references],
    )


def variant_source_subject_id(value: VariantSourceInput) -> str:
    return _sha256(
        "variant-source-v1",
        {
            "sourceGeneration": value.source_generation.model_dump(
                mode="json", by_alias=True, exclude_none=False
            ),
            "assemblyRevision": value.assembly_revision,
        },
    )


def variant_source_input_revision(value: VariantSourceInput) -> str:
    return _sha256(
        "variant-source-preparation-v1",
        value.model_dump(mode="json", by_alias=True, exclude_none=False),
    )


def capture_variant_file_generation(path: str) -> VariantFileGeneration:
    generation = capture_local_file_generation(
        path,
        non_file_message="The selected variant source is not a file.",
    )
    return VariantFileGeneration.model_validate(
        generation.model_dump(mode="json", by_alias=True, exclude_none=False)
    )


def prepare_variant_source_submission(
    submission: VariantSourceSubmission,
) -> ManagedOperationSubmission[VariantSourceInput]:
    generation = capture_variant_file_generation(submission.input.variant_path)
    assembly_revision = variant_assembly_revision(submission.input.references)
    operation_input = VariantSourceInput(
        variantPath=generation.canonical_path,
        references=submission.input.references,
        sourceGeneration=generation,
        assemblyRevision=assembly_revision,
    )
    revision = variant_source_input_revision(operation_input)
    expected = submission.subject.input_revision
    if expected is not None and expected != revision:
        raise InputRevisionMismatch(
            "The supplied input revision does not match the variant source request."
        )
    return ManagedOperationSubmission[VariantSourceInput](
        submission_key=submission.submission_key,
        subject=OperationSubject(
            scope_id=submission.subject.scope_id,
            subject_id=variant_source_subject_id(operation_input),
            input_revision=revision,
        ),
        input=operation_input,
    )


__all__ = [
    "VariantFileGeneration",
    "VariantPageRequest",
    "VariantReferenceIdentity",
    "VariantSourceAgentPreparation",
    "VariantSourceAgentStart",
    "VariantSourceInput",
    "VariantSourceRequest",
    "VariantSourceResult",
    "VariantSourceSubmission",
    "capture_variant_file_generation",
    "prepare_variant_source_submission",
    "variant_assembly_revision",
    "variant_source_input_revision",
    "variant_source_subject_id",
]
