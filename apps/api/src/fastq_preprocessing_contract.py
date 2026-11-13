from __future__ import annotations

import hashlib
import json

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .local_file_generation import LocalFileGeneration, capture_local_file_generation
from .ngs_read_analysis_contract import NgsReadAnalysisSubject, _admit_fastq_header
from .operations import (
    InputRevisionMismatch,
    ManagedOperationSubmission,
    OperationSubject,
)


class FastqPreprocessingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)
    read1_path: str = Field(alias="read1Path", min_length=1, max_length=4096)
    read2_path: str = Field(alias="read2Path", min_length=1, max_length=4096)
    adapter1: str = Field(default="", max_length=200)
    adapter2: str = Field(default="", max_length=200)
    overlap_length: int = Field(default=30, alias="overlapLength", ge=10, le=1000)
    overlap_mismatches: int = Field(default=5, alias="overlapMismatches", ge=0, le=50)
    overlap_mismatch_percent: int = Field(
        default=20, alias="overlapMismatchPercent", ge=0, le=100
    )
    qualified_quality: int = Field(default=15, alias="qualifiedQuality", ge=0, le=60)
    unqualified_percent: int = Field(
        default=40, alias="unqualifiedPercent", ge=0, le=100
    )
    minimum_length: int = Field(default=15, alias="minimumLength", ge=1, le=1000)
    maximum_n_bases: int = Field(default=5, alias="maximumNBases", ge=0, le=1000)
    threads: int = Field(default=2, ge=1, le=4)

    @field_validator("adapter1", "adapter2")
    @classmethod
    def adapter(cls, value: str) -> str:
        value = value.strip().upper()
        if value and (len(value) < 6 or set(value) - set("ACGT")):
            raise ValueError(
                "Adapter sequences must contain at least six A/C/G/T bases."
            )
        return value

    @model_validator(mode="after")
    def complete_adapters(self):
        if bool(self.adapter1) != bool(self.adapter2):
            raise ValueError(
                "Supply both adapters or leave both empty for paired overlap detection."
            )
        return self


class FastqPreprocessingInput(FastqPreprocessingRequest):
    read1_generation: LocalFileGeneration = Field(alias="read1Generation")
    read2_generation: LocalFileGeneration = Field(alias="read2Generation")

    @model_validator(mode="after")
    def generations(self):
        if (
            self.read1_path != self.read1_generation.canonical_path
            or self.read2_path != self.read2_generation.canonical_path
        ):
            raise ValueError("FASTQ input identities do not match.")
        if self.read1_path == self.read2_path:
            raise ValueError("Select separate R1 and R2 files.")
        return self


class FastqPreprocessingSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    submission_key: str = Field(min_length=1, max_length=256)
    subject: NgsReadAnalysisSubject
    input: FastqPreprocessingRequest


def fastq_preprocessing_revision(request: FastqPreprocessingInput) -> str:
    return (
        "fastq-preprocessing-v1:sha256:"
        + hashlib.sha256(
            json.dumps(
                request.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
            ).encode()
        ).hexdigest()
    )


def prepare_fastq_preprocessing(submission: FastqPreprocessingSubmission):
    generations = [
        capture_local_file_generation(path)
        for path in (submission.input.read1_path, submission.input.read2_path)
    ]
    for generation in generations:
        _admit_fastq_header(generation.canonical_path)
        if capture_local_file_generation(generation.canonical_path) != generation:
            raise ValueError("The FASTQ input changed during admission.")
    request = FastqPreprocessingInput(
        **{
            **submission.input.model_dump(),
            "read1_path": generations[0].canonical_path,
            "read2_path": generations[1].canonical_path,
        },
        read1Generation=generations[0],
        read2Generation=generations[1],
    )
    revision = fastq_preprocessing_revision(request)
    if (
        submission.subject.input_revision
        and submission.subject.input_revision != revision
    ):
        raise InputRevisionMismatch("The paired FASTQ inputs changed.")
    subject_id = (
        "fastq-preprocessing:sha256:"
        + hashlib.sha256(
            json.dumps([request.read1_path, request.read2_path]).encode()
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


class PreparedFastqArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)
    path: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    reads: int = Field(ge=0)
    bases: int = Field(ge=0)


class PreparedFastqReport(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    path: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class FastqPreprocessingResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)
    input_revision: str = Field(alias="inputRevision")
    settings: FastqPreprocessingRequest
    input_pairs: int = Field(alias="inputPairs", ge=1)
    rejected_reads: int = Field(alias="rejectedReads", ge=0)
    input_sha256: list[str] = Field(alias="inputSha256", min_length=2, max_length=2)
    executable_path: str = Field(alias="executablePath")
    executable_sha256: str = Field(alias="executableSha256", pattern=r"^[0-9a-f]{64}$")
    version: str
    commands: list[list[str]]
    outputs: dict[str, PreparedFastqArtifact]
    report_path: str = Field(alias="reportPath")
    report_sha256: str = Field(alias="reportSha256", pattern=r"^[0-9a-f]{64}$")
    report: dict
    native_reports: dict[str, PreparedFastqReport] = Field(alias="nativeReports")
