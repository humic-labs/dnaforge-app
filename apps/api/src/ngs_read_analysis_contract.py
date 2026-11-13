"""Bounded raw-read evidence against an exact small reference; never a clone consensus."""

from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .local_file_generation import LocalFileGeneration, capture_local_file_generation
from .operations import (
    InputRevisionMismatch,
    ManagedOperationSubmission,
    OperationSubject,
)
from .operations.contracts import OperationAcceptedWorkspaceInput
from .sequence_variant_contract import SequenceVariantCall


class NgsReadAnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)
    document_id: str = Field(alias="documentId", min_length=1, max_length=1024)
    read_path: str = Field(alias="readPath", min_length=1, max_length=4096)
    reference_sequence: str = Field(
        alias="referenceSequence", min_length=100, max_length=250_000
    )
    is_circular: bool = Field(default=False, alias="isCircular")
    preset: Literal["sr", "map-ont", "lr:hq", "map-hifi"]
    min_base_quality: int = Field(default=20, alias="minBaseQuality", ge=0, le=60)
    min_mapping_quality: int = Field(default=20, alias="minMappingQuality", ge=0, le=60)
    min_depth: int = Field(default=10, alias="minDepth", ge=1, le=1_000_000)
    min_alternate_count: int = Field(
        default=3, alias="minAlternateCount", ge=1, le=1_000_000
    )
    min_allele_fraction: float = Field(
        default=0.01, alias="minAlleleFraction", ge=0, le=1
    )
    threads: int = Field(default=2, ge=1, le=4)

    @field_validator("reference_sequence")
    @classmethod
    def reference(cls, value: str) -> str:
        value = value.upper()
        if set(value) - set("ACGTN"):
            raise ValueError("Raw read mapping needs an A/C/G/T/N reference.")
        return value


class NgsReadAnalysisInput(NgsReadAnalysisRequest):
    source_generation: LocalFileGeneration = Field(alias="sourceGeneration")
    reference_sha256: str = Field(alias="referenceSha256", pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def identities(self):
        if (
            self.read_path != self.source_generation.canonical_path
            or self.reference_sha256
            != hashlib.sha256(self.reference_sequence.encode()).hexdigest()
        ):
            raise ValueError("Read/reference identity does not match its input.")
        return self


class InvalidRawReadInput(ValueError):
    """An input-format failure before a managed job is admitted."""


def _admit_fastq_header(path: str) -> None:
    source = Path(path)
    try:
        with source.open("rb") as stream:
            compressed = stream.read(2) == b"\x1f\x8b"
        opener = gzip.open if compressed else open
        with opener(source, "rb") as stream:
            header = stream.readline(8193)
    except (OSError, EOFError) as error:
        raise InvalidRawReadInput(
            "The FASTQ header could not be read or decompressed."
        ) from error
    if header.startswith((b"##fileformat=VCF", b"#CHROM\t", b"BCF\x02")):
        raise InvalidRawReadInput(
            "This file contains called variants, not raw FASTQ reads. "
            "Use start_variant_calls followed by import_variant_calls for VCF/BCF."
        )
    if not header.startswith(b"@") or len(header) > 8192:
        raise InvalidRawReadInput(
            "Raw-read analysis requires a FASTQ read header of at most 8192 bytes. "
            "Use analyze_clone for an assembled sequence, or start_variant_calls "
            "followed by import_variant_calls for VCF/BCF."
        )


def prepare_ngs_read_input(request: NgsReadAnalysisRequest) -> NgsReadAnalysisInput:
    generation = capture_local_file_generation(request.read_path)
    if generation.size > 2_000_000_000:
        raise ValueError(
            "This small-reference workflow accepts FASTQ files up to 2 GB."
        )
    _admit_fastq_header(generation.canonical_path)
    if capture_local_file_generation(generation.canonical_path) != generation:
        raise InvalidRawReadInput("The raw-read input changed during format admission.")
    return NgsReadAnalysisInput(
        **{**request.model_dump(), "read_path": generation.canonical_path},
        sourceGeneration=generation,
        referenceSha256=hashlib.sha256(request.reference_sequence.encode()).hexdigest(),
    )


def ngs_input_revision(request: NgsReadAnalysisInput) -> str:
    return (
        "ngs-read-analysis-v1:sha256:"
        + hashlib.sha256(
            json.dumps(
                request.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
            ).encode()
        ).hexdigest()
    )


class NgsReadAnalysisSubject(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    scope_id: str = Field(min_length=1, max_length=512)
    input_revision: str | None = None
    accepted_workspace_input: OperationAcceptedWorkspaceInput | None = Field(
        default=None, exclude_if=lambda value: value is None
    )

    @model_validator(mode="after")
    def accepted_workspace(self):
        if (
            self.accepted_workspace_input is not None
            and self.accepted_workspace_input.workspace_id != self.scope_id
        ):
            raise ValueError("accepted input workspace must match the operation scope")
        return self


class NgsReadAnalysisSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    submission_key: str = Field(min_length=1, max_length=256)
    subject: NgsReadAnalysisSubject
    input: NgsReadAnalysisRequest


def prepare_ngs_read_submission(submission: NgsReadAnalysisSubmission):
    request = prepare_ngs_read_input(submission.input)
    revision = ngs_input_revision(request)
    if (
        submission.subject.input_revision
        and submission.subject.input_revision != revision
    ):
        raise InputRevisionMismatch("The raw-read input changed.")
    subject_id = (
        "ngs-read-analysis:sha256:"
        + hashlib.sha256(
            json.dumps([request.document_id, request.read_path]).encode()
        ).hexdigest()
    )
    return ManagedOperationSubmission(
        submission_key=submission.submission_key,
        subject=OperationSubject(
            scope_id=submission.subject.scope_id,
            subject_id=subject_id,
            input_revision=revision,
        ),
        input=request,
    )


class NgsAlignmentArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)
    origin_offset: int = Field(alias="originOffset", ge=0)
    alignment_path: str = Field(alias="alignmentPath")
    reference_path: str = Field(alias="referencePath")
    pileup_path: str = Field(alias="pileupPath")
    alignment_sha256: str = Field(alias="alignmentSha256", pattern=r"^[0-9a-f]{64}$")
    pileup_sha256: str = Field(alias="pileupSha256", pattern=r"^[0-9a-f]{64}$")


class NgsReadAnalysisResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)
    document_id: str = Field(alias="documentId")
    input_revision: str = Field(alias="inputRevision")
    source_label: str = Field(alias="sourceLabel")
    source_sha256: str = Field(alias="sourceSha256", pattern=r"^[0-9a-f]{64}$")
    reference_sha256: str = Field(alias="referenceSha256", pattern=r"^[0-9a-f]{64}$")
    total_reads: int = Field(alias="totalReads", ge=0)
    total_bases: int = Field(alias="totalBases", ge=0)
    mapped_reads: int = Field(alias="mappedReads", ge=0)
    unmapped_reads: int = Field(alias="unmappedReads", ge=0)
    mapping_quality_reads: int = Field(alias="mappingQualityReads", ge=0)
    coverage: list[int] = Field(max_length=250_000)
    circular_method: Literal["linear", "two-origins-central-half"] = Field(
        alias="circularMethod"
    )
    settings: NgsReadAnalysisRequest
    versions: dict[str, str]
    commands: list[list[str]]
    artifacts: list[NgsAlignmentArtifact]
    calls: list[SequenceVariantCall] = Field(max_length=5000)
    excluded_alleles: int = Field(alias="excludedAlleles", ge=0)
    count_basis: str = Field(
        default="bcftools mpileup FORMAT/AD after base/mapping-quality and BAQ filtering; denominator=sum of all original allele depths",
        alias="countBasis",
    )

    @model_validator(mode="after")
    def complete(self):
        if (
            self.mapped_reads + self.unmapped_reads != self.total_reads
            or self.mapping_quality_reads > self.mapped_reads
        ):
            raise ValueError("Every input read must be accounted for.")
        if len(self.coverage) != len(self.settings.reference_sequence) or any(
            depth < 0 for depth in self.coverage
        ):
            raise ValueError("Coverage does not match the reference.")
        return self
