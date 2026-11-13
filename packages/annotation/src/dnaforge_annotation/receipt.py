"""Portable receipt creation for foreground annotation runs."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any, Literal
from uuid import UUID, uuid4

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from .contract import AnnotationRequest, AnnotationResult, AnnotationRuntime
from .core import clean_sequence
from .files import validate_annotation_output
from .identity import annotation_input_revision
from .resources import get_reference_versions, get_yaml_path

ReportedPath = Annotated[str, Field(max_length=4096)]
ReportedLabel = Annotated[str, Field(min_length=1, max_length=512)]


class ReceiptFields(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ReceiptTool(ReceiptFields):
    name: Literal["dnaforge-annotation"]
    version: Annotated[str, Field(min_length=1, max_length=128)]


class ReceiptInput(ReceiptFields):
    path: ReportedPath
    sequence_id: ReportedLabel
    sequence_length: int = Field(ge=0)
    revision: str = Field(pattern=r"^annotation-input-v1:sha256:[0-9a-f]{64}$")


class ReceiptOutput(ReceiptFields):
    format: Literal["json", "gff3"]
    path: ReportedPath


class ReceiptExecutables(ReceiptFields):
    blastn: ReportedPath
    diamond: ReportedPath
    cmscan: ReportedPath


class ReceiptRuntime(ReceiptFields):
    data_dir: ReportedPath
    executables: ReceiptExecutables
    temp_dir: ReportedPath | None
    threads: int = Field(ge=1)
    database_config: ReportedPath | None


class ReceiptReferences(ReceiptFields):
    manifest: ReportedPath
    versions: dict[ReportedLabel, ReportedLabel | None] = Field(max_length=64)


class AnnotationRunReceiptV1(ReceiptFields):
    """Self-reported execution facts, never proof of actor or runtime authority.

    Validation reads only the embedded data. Paths and executable names are
    reported strings and must not be resolved or executed during import.
    """

    schema_version: Literal[1]
    run_id: UUID
    tool: ReceiptTool
    outcome: Literal["succeeded"]
    started_at: AwareDatetime
    finished_at: AwareDatetime
    input: ReceiptInput
    output: ReceiptOutput
    request: AnnotationRequest
    runtime: ReceiptRuntime
    reference_data: ReceiptReferences
    result: AnnotationResult

    @model_validator(mode="after")
    def validate_embedded_run(self) -> AnnotationRunReceiptV1:
        if self.finished_at < self.started_at:
            raise ValueError("Reported finish precedes reported start")
        length = len(clean_sequence(self.request.sequence))
        if (
            self.input.sequence_length != length
            or self.result.sequence_length != length
        ):
            raise ValueError("Receipt input, request and result lengths differ")
        if self.input.revision != annotation_input_revision(self.request):
            raise ValueError("Receipt input revision differs from its request")
        if self.result.error is not None:
            raise ValueError("A succeeded receipt cannot contain an engine error")
        validate_annotation_output(self.result)
        return self


def create_receipt(
    *,
    request: AnnotationRequest,
    result: AnnotationResult,
    runtime: AnnotationRuntime,
    input_path: str,
    sequence_id: str,
    output_path: str,
    output_format: str,
    started_at: datetime,
) -> dict[str, Any]:
    """Create a self-contained receipt that can be imported without rerunning."""
    reference_manifest = Path(runtime.database_config or get_yaml_path())
    payload = {
        "schema_version": 1,
        "run_id": str(uuid4()),
        "tool": {"name": "dnaforge-annotation", "version": "0.1.0"},
        "outcome": "succeeded",
        "started_at": started_at.astimezone(timezone.utc).isoformat(),
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "input": {
            "path": input_path,
            "sequence_id": sequence_id,
            "sequence_length": result.sequence_length,
            "revision": annotation_input_revision(request),
        },
        "output": {"format": output_format, "path": output_path},
        "request": request.model_dump(mode="json"),
        "runtime": {
            "data_dir": str(runtime.data_dir.resolve()),
            "executables": {
                name: str(path.resolve())
                for name, path in runtime.executables.model_dump().items()
            },
            "temp_dir": (
                str(runtime.temp_dir.resolve())
                if runtime.temp_dir is not None
                else None
            ),
            "threads": runtime.threads,
            "database_config": (
                str(runtime.database_config.resolve())
                if runtime.database_config is not None
                else None
            ),
        },
        "reference_data": {
            "manifest": str(reference_manifest.resolve()),
            "versions": get_reference_versions(reference_manifest),
        },
        "result": result.model_dump(mode="json"),
    }
    return AnnotationRunReceiptV1.model_validate(payload).model_dump(mode="json")


def display_path(path: str) -> str:
    """Return a portable absolute path, retaining '-' for standard streams."""
    return path if path == "-" else str(Path(path).resolve())
