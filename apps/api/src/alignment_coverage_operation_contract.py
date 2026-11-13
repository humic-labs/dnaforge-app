"""Typed contract for application-owned aligned-read coverage preparation."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .aligned_read_file_generation import (
    AlignedReadFileGeneration,
    capture_aligned_read_file_generation,
)
from .operations import (
    InputRevisionMismatch,
    ManagedOperationSubmission,
    OperationSubject,
)


class AlignedReadSourceGeneration(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    contract: Literal["aligned-read-source-generation.v1"]
    alignment: AlignedReadFileGeneration
    index: AlignedReadFileGeneration
    reference: AlignedReadFileGeneration | None = None
    reference_index: AlignedReadFileGeneration | None = Field(
        default=None, alias="referenceIndex"
    )

    @model_validator(mode="after")
    def validate_reference_pair(self) -> AlignedReadSourceGeneration:
        if (self.reference is None) != (self.reference_index is None):
            raise ValueError(
                "reference and referenceIndex generations must be supplied together"
            )
        return self


def discover_local_alignment_index_path(bam_path: str) -> str:
    source = Path(bam_path).resolve(strict=True)
    lower = str(source).lower()
    if lower.endswith(".bam"):
        stem = str(source)[:-4]
        candidates = (
            Path(f"{source}.bai"),
            Path(f"{source}.csi"),
            Path(f"{stem}.bai"),
            Path(f"{stem}.csi"),
        )
    elif lower.endswith(".cram"):
        stem = str(source)[:-5]
        candidates = (
            Path(f"{source}.crai"),
            Path(f"{source}.csi"),
            Path(f"{stem}.crai"),
        )
    else:
        candidates = (
            Path(f"{source}.bai"),
            Path(f"{source}.crai"),
            Path(f"{source}.csi"),
        )
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate.resolve(strict=True))
    raise ValueError("The aligned-read source bundle has no local index file.")


def capture_aligned_read_source_generation(
    *,
    bam_path: str,
    index_path: str,
    reference_path: str | None,
) -> AlignedReadSourceGeneration:
    reference = (
        capture_aligned_read_file_generation(reference_path)
        if reference_path is not None
        else None
    )
    reference_index = (
        capture_aligned_read_file_generation(f"{reference_path}.fai")
        if reference_path is not None
        else None
    )
    return AlignedReadSourceGeneration(
        contract="aligned-read-source-generation.v1",
        alignment=capture_aligned_read_file_generation(bam_path),
        index=capture_aligned_read_file_generation(index_path),
        reference=reference,
        referenceIndex=reference_index,
    )


class AlignmentCoverageInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    assembly_id: str = Field(alias="assemblyId", min_length=1, max_length=1024)
    bam_path: str = Field(alias="bamPath", min_length=1, max_length=4096)
    index_path: str = Field(alias="indexPath", min_length=1, max_length=4096)
    reference_path: str | None = Field(
        default=None, alias="referencePath", min_length=1, max_length=4096
    )
    source_generation: AlignedReadSourceGeneration = Field(alias="sourceGeneration")
    chroms: list[str] = Field(min_length=1)
    force: bool = False

    @field_validator("assembly_id")
    @classmethod
    def normalize_assembly_id(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("assemblyId must not be blank")
        return normalized

    @field_validator("chroms", mode="before")
    @classmethod
    def normalize_chromosomes(cls, value: object) -> object:
        if not isinstance(value, (list, tuple)):
            return value
        normalized: set[str] = set()
        for item in value:
            if not isinstance(item, str):
                return value
            chrom = item.strip()
            if (
                not chrom
                or len(chrom) > 512
                or any(character.isspace() for character in chrom)
                or "\x00" in chrom
            ):
                raise ValueError(
                    "chromosome names must be nonempty SAM reference names"
                )
            normalized.add(chrom)
        return sorted(normalized)


class AlignmentCoverageSubjectInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    scope_id: str = Field(min_length=1, max_length=512)
    input_revision: str | None = Field(default=None, min_length=1, max_length=512)


class AlignmentCoverageSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    submission_key: str = Field(min_length=1, max_length=256)
    subject: AlignmentCoverageSubjectInput
    input: AlignmentCoverageInput


class AlignmentCoverageAgentStart(BaseModel):
    """Agent request grounded to a mounted track by the connected app."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    assembly_id: str = Field(alias="assemblyId", min_length=1, max_length=1024)
    track_id: str = Field(alias="trackId", min_length=1, max_length=1024)


class AlignmentCoverageAgentPreparation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    ok: Literal[True]
    input: AlignmentCoverageInput


class AlignmentCoverageChromResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    chrom: str = Field(min_length=1, max_length=512)
    present: bool
    built: bool
    reason: str | None = Field(default=None, max_length=1024)
    chrom_length: int | None = Field(default=None, alias="chromLength", ge=0)
    base_bin_bp: int | None = Field(default=None, alias="baseBinBp", ge=1)
    size_bytes: int | None = Field(default=None, alias="sizeBytes", ge=0)
    max_depth: float | None = Field(default=None, alias="maxDepth", ge=0)
    duration_ms: float | None = Field(default=None, alias="durationMs", ge=0)


class AlignmentCoverageResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    chroms: list[AlignmentCoverageChromResult] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_unique_chromosomes(self) -> AlignmentCoverageResult:
        names = [row.chrom for row in self.chroms]
        if len(names) != len(set(names)):
            raise ValueError("coverage result contains duplicate chromosome rows")
        return self


def _sha256(prefix: str, value: object) -> str:
    canonical = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"{prefix}:sha256:" + hashlib.sha256(canonical).hexdigest()


def alignment_coverage_subject_id(value: AlignmentCoverageInput) -> str:
    return _sha256(
        "aligned-read-source-v1",
        {
            "assemblyId": value.assembly_id,
            "bamPath": value.bam_path,
            "indexPath": value.index_path,
            "referencePath": value.reference_path,
            "sourceGeneration": value.source_generation.model_dump(
                mode="json", by_alias=True, exclude_none=True
            ),
        },
    )


def alignment_coverage_input_revision(value: AlignmentCoverageInput) -> str:
    return _sha256(
        "alignment-coverage-v1",
        value.model_dump(mode="json", by_alias=True, exclude_none=True),
    )


def prepare_alignment_coverage_submission(
    submission: AlignmentCoverageSubmission,
) -> ManagedOperationSubmission[AlignmentCoverageInput]:
    revision = alignment_coverage_input_revision(submission.input)
    expected = submission.subject.input_revision
    if expected is not None and expected != revision:
        raise InputRevisionMismatch(
            "The supplied input revision does not match the coverage request."
        )
    return ManagedOperationSubmission[AlignmentCoverageInput](
        submission_key=submission.submission_key,
        subject=OperationSubject(
            scope_id=submission.subject.scope_id,
            subject_id=alignment_coverage_subject_id(submission.input),
            input_revision=revision,
        ),
        input=submission.input,
    )


__all__ = [
    "AlignedReadFileGeneration",
    "AlignedReadSourceGeneration",
    "AlignmentCoverageAgentPreparation",
    "AlignmentCoverageAgentStart",
    "AlignmentCoverageChromResult",
    "AlignmentCoverageInput",
    "AlignmentCoverageResult",
    "AlignmentCoverageSubmission",
    "alignment_coverage_input_revision",
    "alignment_coverage_subject_id",
    "capture_aligned_read_source_generation",
    "discover_local_alignment_index_path",
    "prepare_alignment_coverage_submission",
]
