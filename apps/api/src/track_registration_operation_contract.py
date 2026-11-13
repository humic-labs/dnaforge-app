"""Typed contracts for registering a file as a track in the per-machine track store.

One declaration serves the HTTP route, `dnaforge jobs submit track-registration`
and the agent action, so a file produced by any tool can be added to the store
from outside the app.
"""

from __future__ import annotations

import hashlib
import json
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from .local_file_generation import LocalFileGeneration, capture_local_file_generation
from .operations import (
    InputRevisionMismatch,
    ManagedOperationSubmission,
    OperationSubject,
)
from .track_store.layout import ASSEMBLY_ACCESSION, TRACK_SLUG

TrackKind = Literal["promoter", "terminator", "tss", "transcription_unit"]
TrackEvidence = Literal["curated", "measured", "computed"]
TrackResidency = Literal["managed", "linked", "remote"]


class TrackDescription(BaseModel):
    """What the track is: everything that goes into its meta.json besides the file."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    accession: str = Field(
        pattern=ASSEMBLY_ACCESSION.pattern,
        max_length=64,
        description="Versioned accession of the assembly the coordinates are on, e.g. NC_000913.3.",
    )
    length_bp: int = Field(
        alias="lengthBp", ge=1, description="Length of that assembly in bases."
    )
    aliases: list[str] = Field(
        default_factory=list,
        max_length=16,
        description="Other names column 1 may use for this assembly, e.g. U00096.3.",
    )
    name: str = Field(
        pattern=TRACK_SLUG.pattern,
        max_length=48,
        description="Track name: lowercase letters, digits and hyphens. Becomes the directory name.",
    )
    kinds: list[TrackKind] = Field(min_length=1, max_length=4)
    label: str = Field(min_length=1, max_length=200)
    evidence: TrackEvidence
    license_attribution: str = Field(
        alias="licenseAttribution",
        min_length=1,
        max_length=2000,
        description="The exact line DNAForge shows wherever these records appear.",
    )
    license_spdx: Optional[str] = Field(None, alias="licenseSpdx", max_length=64)
    citation: Optional[str] = Field(None, max_length=1000)
    url: Optional[str] = Field(None, max_length=1000)
    doi: Optional[str] = Field(None, max_length=200)
    dataset_version: Optional[str] = Field(
        None, alias="datasetVersion", max_length=1000
    )
    produced_by: Optional[str] = Field(
        None,
        alias="producedBy",
        max_length=500,
        description="The tool or command that made the file.",
    )
    replace_existing: bool = Field(
        False,
        alias="replaceExisting",
        description=(
            "Allow a new version under a name that already holds a differently labelled track."
        ),
    )


class RegisterTrackRequest(TrackDescription):
    path: str = Field(
        min_length=1,
        max_length=4096,
        description="Absolute path to a GFF3 file. Copied into the store unchanged.",
    )
    residency: TrackResidency = Field(
        "managed",
        description="Only managed (copied into the store) is available in this version.",
    )
    source_generation: LocalFileGeneration | None = Field(
        None, alias="sourceGeneration"
    )


class RegisterTrackResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    accession: str = Field(max_length=64)
    track: str = Field(max_length=48)
    version: str = Field(pattern=r"^[0-9a-f]{12}$")
    path: str = Field(max_length=4096, description="The stored file.")
    rows: int = Field(ge=0)
    already_present: bool = Field(
        alias="alreadyPresent",
        description="The same bytes were already in the store under this name.",
    )


class TrackRegistrationSubjectInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    scope_id: str = Field(min_length=1, max_length=512)
    subject_id: str | None = Field(default=None, min_length=1, max_length=1024)
    input_revision: str | None = Field(default=None, min_length=1, max_length=512)


class TrackRegistrationSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    submission_key: str = Field(min_length=1, max_length=256)
    subject: TrackRegistrationSubjectInput
    input: RegisterTrackRequest


class TrackRegistrationAgentStart(TrackDescription):
    """Agent-visible request; the path is grounded by the connected app."""

    path: str = Field(
        min_length=1,
        max_length=4096,
        description=(
            "A GFF3 file inside an open DNAForge project. With multiple projects "
            "open, prefix a relative path with the project name."
        ),
    )


class TrackRegistrationAgentPreparation(BaseModel):
    """Private renderer-to-sidecar preparation result."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    ok: Literal[True]
    input: RegisterTrackRequest


def _hash(prefix: str, value: object) -> str:
    canonical = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return f"{prefix}:sha256:" + hashlib.sha256(canonical).hexdigest()


def track_registration_input_revision(value: RegisterTrackRequest) -> str:
    return _hash(
        "track-registration-v1",
        value.model_dump(mode="json", by_alias=True, exclude_none=False),
    )


def track_registration_subject_id(value: TrackDescription) -> str:
    """The track in the store: one subject per (assembly, name), whatever the file."""
    return _hash("track-v1", {"accession": value.accession, "name": value.name})


def prepare_track_registration_submission(
    submission: TrackRegistrationSubmission,
) -> ManagedOperationSubmission[RegisterTrackRequest]:
    generation = capture_local_file_generation(
        submission.input.path, non_file_message="The track source is not a file."
    )
    operation_input = submission.input.model_copy(
        update={"path": generation.canonical_path, "source_generation": generation}
    )
    revision = track_registration_input_revision(operation_input)
    expected = submission.subject.input_revision
    if expected is not None and expected != revision:
        raise InputRevisionMismatch(
            "The supplied input revision does not match the track registration request."
        )
    return ManagedOperationSubmission[RegisterTrackRequest](
        submission_key=submission.submission_key,
        subject=OperationSubject(
            scope_id=submission.subject.scope_id,
            subject_id=track_registration_subject_id(operation_input),
            input_revision=revision,
        ),
        input=operation_input,
    )


__all__ = [
    "RegisterTrackRequest",
    "RegisterTrackResponse",
    "TrackDescription",
    "TrackRegistrationAgentPreparation",
    "TrackRegistrationAgentStart",
    "TrackRegistrationSubjectInput",
    "TrackRegistrationSubmission",
    "prepare_track_registration_submission",
    "track_registration_input_revision",
    "track_registration_subject_id",
]
