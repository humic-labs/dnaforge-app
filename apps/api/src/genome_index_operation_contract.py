"""Typed contracts for application-owned genome indexing."""

from __future__ import annotations

import hashlib
import json
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from .operations import (
    InputRevisionMismatch,
    ManagedOperationSubmission,
    OperationSubject,
)


class IndexGenomeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    input: str = Field(
        min_length=1,
        max_length=4096,
        description=(
            "Absolute path to a supported GenBank, FASTA, or GFF3 source; "
            "gzip-compressed inputs are accepted."
        ),
    )
    output_dir: str = Field(
        alias="outputDir",
        min_length=1,
        max_length=4096,
        description="Absolute output directory.",
    )
    name: str = Field(
        min_length=1,
        max_length=80,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$",
        description="Filesystem-safe output basename.",
    )
    workspace_root: str = Field(
        alias="workspaceRoot",
        min_length=1,
        max_length=4096,
        description="Workspace root containing the input and output directory.",
    )


class GenomeMetadataResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    length: int = Field(ge=0)
    circular: bool
    feature_count: int = Field(ge=0, alias="featureCount")
    annotation_types: list[str] = Field(default_factory=list, alias="annotationTypes")
    annotation_raster_ready: bool = Field(True, alias="annotationRasterReady")


class IndexGenomeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    fasta_path: str = Field(min_length=1, max_length=4096, alias="fastaPath")
    fai_path: str = Field(min_length=1, max_length=4096, alias="faiPath")
    gff_path: Optional[str] = Field(None, max_length=4096, alias="gffPath")
    tbi_path: Optional[str] = Field(None, max_length=4096, alias="tbiPath")
    metadata: GenomeMetadataResponse


class GenomeIndexSubjectInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    scope_id: str = Field(min_length=1, max_length=512)
    subject_id: str = Field(min_length=1, max_length=1024)
    input_revision: str | None = Field(default=None, min_length=1, max_length=512)


class GenomeIndexSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    submission_key: str = Field(min_length=1, max_length=256)
    subject: GenomeIndexSubjectInput
    input: IndexGenomeRequest


class GenomeIndexAgentStart(BaseModel):
    """Agent-visible request; paths are grounded by the connected app."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    path: str = Field(
        min_length=1,
        max_length=4096,
        description=(
            "A path inside an open DNAForge project. With multiple projects open, "
            "prefix a relative path with the project name."
        ),
    )


class GenomeIndexAgentPreparation(BaseModel):
    """Private renderer-to-sidecar preparation result."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    ok: Literal[True]
    input: IndexGenomeRequest


def genome_index_input_revision(value: IndexGenomeRequest) -> str:
    canonical = json.dumps(
        value.model_dump(mode="json", by_alias=True),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "genome-index-v1:sha256:" + hashlib.sha256(canonical).hexdigest()


def genome_index_subject_id(value: IndexGenomeRequest) -> str:
    identity = json.dumps(
        {
            "input": value.input,
            "outputDir": value.output_dir,
            "workspaceRoot": value.workspace_root,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "genome-source-v1:sha256:" + hashlib.sha256(identity).hexdigest()


def prepare_genome_index_submission(
    submission: GenomeIndexSubmission,
) -> ManagedOperationSubmission[IndexGenomeRequest]:
    revision = genome_index_input_revision(submission.input)
    expected = submission.subject.input_revision
    if expected is not None and expected != revision:
        raise InputRevisionMismatch(
            "The supplied input revision does not match the genome index request."
        )
    return ManagedOperationSubmission[IndexGenomeRequest](
        submission_key=submission.submission_key,
        subject=OperationSubject(
            scope_id=submission.subject.scope_id,
            subject_id=submission.subject.subject_id,
            input_revision=revision,
        ),
        input=submission.input,
    )
