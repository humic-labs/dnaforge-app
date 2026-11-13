from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any, Generic, Literal, TypeVar
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ActorKind(str, Enum):
    HUMAN = "human"
    AGENT = "agent"


class ClientChannel(str, Enum):
    DESKTOP_UI = "desktop_ui"
    HOSTED_BROWSER = "hosted_browser"
    MANAGED_CLI = "managed_cli"
    AGENT = "agent"


class OperationKind(str, Enum):
    ANNOTATION = "annotation"
    ANNOTATION_PROVISIONING = "annotation-provisioning"
    GENOME_INDEXING = "genome-indexing"
    MULTIPLE_SEQUENCE_ALIGNMENT = "multiple-sequence-alignment"
    ALIGNMENT_COVERAGE_PREPARATION = "alignment-coverage-preparation"


class OperationOrigin(str, Enum):
    MANAGED = "managed"
    RECORDED = "recorded"


class OperationState(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    STOPPING = "stopping"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELED = "canceled"
    INTERRUPTED = "interrupted"


class CancellationMode(str, Enum):
    QUEUED_ONLY = "queued_only"
    COOPERATIVE = "cooperative"


class ActiveJoinMode(str, Enum):
    NONE = "none"
    SUBJECT_REVISION = "subject_revision"


class CancellationAvailability(str, Enum):
    AVAILABLE = "available"
    UNAVAILABLE = "unavailable"
    ALREADY_REQUESTED = "already_requested"
    ALREADY_SETTLED = "already_settled"


ACTIVE_STATES = frozenset(
    {OperationState.QUEUED, OperationState.RUNNING, OperationState.STOPPING}
)
TERMINAL_STATES = frozenset(
    {
        OperationState.SUCCEEDED,
        OperationState.FAILED,
        OperationState.CANCELED,
        OperationState.INTERRUPTED,
    }
)


class OperationPrincipal(BaseModel):
    """Trusted caller identity produced by an authenticated transport adapter."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    actor_kind: ActorKind
    actor_id: str = Field(min_length=1, max_length=256)
    channel: ClientChannel
    scope_ids: frozenset[str] = Field(min_length=1)
    capabilities: frozenset[str] = Field(default_factory=frozenset)


class OperationAcceptedWorkspaceFile(BaseModel):
    """Immutable input identity verified by the hosted workspace authority."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    key: str = Field(min_length=1, max_length=262)
    resource_id: str
    path: str = Field(min_length=1, max_length=1024)
    content_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    size_bytes: int = Field(ge=0, strict=True)

    @field_validator("resource_id")
    @classmethod
    def validate_resource_id(cls, value: str) -> str:
        return str(UUID(value))

    @field_validator("path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        if (
            "\\" in value
            or any(ord(character) < 32 or ord(character) == 127 for character in value)
            or any(part in ("", ".", "..") for part in value.split("/"))
        ):
            raise ValueError("input path must be a safe workspace-relative file path")
        return value


class OperationAcceptedWorkspaceInput(BaseModel):
    """Accepted version and stable files behind a hosted computation."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    workspace_id: str
    version_id: str
    manifest_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    files: tuple[OperationAcceptedWorkspaceFile, ...] = Field(
        min_length=1, max_length=65
    )

    @field_validator("workspace_id", "version_id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        return str(UUID(value))

    @field_validator("files")
    @classmethod
    def validate_unique_keys(
        cls, value: tuple[OperationAcceptedWorkspaceFile, ...]
    ) -> tuple[OperationAcceptedWorkspaceFile, ...]:
        if len({file.key for file in value}) != len(value):
            raise ValueError("accepted input file keys must be unique")
        return value


class OperationSubject(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    scope_id: str = Field(min_length=1, max_length=512)
    subject_id: str = Field(min_length=1, max_length=1024)
    input_revision: str = Field(min_length=1, max_length=512)
    accepted_workspace_input: OperationAcceptedWorkspaceInput | None = Field(
        default=None, exclude_if=lambda value: value is None
    )

    @model_validator(mode="after")
    def validate_accepted_workspace(self) -> OperationSubject:
        if (
            self.accepted_workspace_input is not None
            and self.accepted_workspace_input.workspace_id != self.scope_id
        ):
            raise ValueError("accepted input workspace must match the operation scope")
        return self


InputT = TypeVar("InputT", bound=BaseModel)
ResultT = TypeVar("ResultT", bound=BaseModel)


class ManagedOperationSubmission(BaseModel, Generic[InputT]):
    model_config = ConfigDict(extra="forbid", frozen=True)

    submission_key: str = Field(min_length=1, max_length=256)
    subject: OperationSubject
    input: InputT


class OperationErrorPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    code: str = Field(min_length=1, max_length=128)
    message: str = Field(min_length=1, max_length=1024)
    details: dict[str, str | int | float | bool | None] | None = None


class OperationRecordedArtifact(BaseModel):
    """Bounded identity for one reported input or output artifact."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    role: str = Field(min_length=1, max_length=64)
    identity: str | None = Field(default=None, max_length=512)
    revision: str | None = Field(default=None, max_length=512)
    path: str | None = Field(default=None, max_length=4096)
    format: str | None = Field(default=None, max_length=128)
    size: int | None = Field(default=None, ge=0)
    size_unit: str | None = Field(default=None, min_length=1, max_length=64)
    sha256: str | None = Field(default=None, pattern=r"^sha256:[0-9a-f]{64}$")


class OperationRecordedRuntime(BaseModel):
    """Optional, tool-neutral runtime facts copied from a validated receipt."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    threads: int | None = Field(default=None, ge=1)
    data_path: str | None = Field(default=None, max_length=4096)
    temp_path: str | None = Field(default=None, max_length=4096)
    configuration_path: str | None = Field(default=None, max_length=4096)
    executables: dict[str, str] = Field(default_factory=dict, max_length=64)


class OperationRecordedProvenance(BaseModel):
    """Bounded, tool-neutral self-reported facts from an offline run receipt."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    source: Literal["self_reported_receipt"] = "self_reported_receipt"
    schema_version: int = Field(ge=1)
    reported_run_id: str = Field(min_length=1, max_length=128)
    reported_started_at: datetime
    reported_finished_at: datetime
    tool_name: str = Field(min_length=1, max_length=128)
    tool_version: str = Field(min_length=1, max_length=128)
    parameters: dict[str, str | int | float | bool | None] = Field(
        default_factory=dict, max_length=64
    )
    inputs: list[OperationRecordedArtifact] = Field(default_factory=list, max_length=64)
    outputs: list[OperationRecordedArtifact] = Field(
        default_factory=list, max_length=64
    )
    runtime: OperationRecordedRuntime = Field(default_factory=OperationRecordedRuntime)
    resource_manifest: str | None = Field(default=None, max_length=4096)
    resources: dict[str, str | None] = Field(default_factory=dict, max_length=64)

    @model_validator(mode="before")
    @classmethod
    def migrate_annotation_era_shape(cls, value: Any) -> Any:
        if not isinstance(value, dict) or "input_sequence_id" not in value:
            return value
        return {
            "source": value.get("source", "self_reported_receipt"),
            "schema_version": value["schema_version"],
            "reported_run_id": value["reported_run_id"],
            "reported_started_at": value["reported_started_at"],
            "reported_finished_at": value["reported_finished_at"],
            "tool_name": value["tool_name"],
            "tool_version": value["tool_version"],
            "parameters": value.get("request_parameters", {}),
            "inputs": [
                {
                    "role": "primary",
                    "identity": value.get("input_sequence_id"),
                    "revision": value.get("input_revision"),
                    "path": value.get("reported_input_path"),
                    "size": value.get("input_sequence_length"),
                    "size_unit": "bases",
                    "sha256": value.get("input_sequence_sha256"),
                }
            ],
            "outputs": [
                {
                    "role": "primary",
                    "path": value.get("reported_output_path"),
                    "format": value.get("reported_output_format"),
                }
            ],
            "runtime": {
                "threads": value.get("reported_runtime_threads"),
                "data_path": value.get("reported_runtime_data_dir"),
                "temp_path": value.get("reported_runtime_temp_dir"),
                "configuration_path": value.get("reported_runtime_database_config"),
                "executables": value.get("reported_runtime_executables", {}),
            },
            "resource_manifest": value.get("reported_reference_manifest"),
            "resources": value.get("reference_versions", {}),
        }


class PreparedRecordedOperation(BaseModel, Generic[ResultT]):
    """Trusted kind adapter output; source input is deliberately absent."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    subject: OperationSubject
    reported_run_id: str = Field(min_length=1, max_length=128)
    provenance: OperationRecordedProvenance
    result: ResultT


class OperationSnapshot(BaseModel, Generic[ResultT]):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    kind: str = Field(min_length=1, max_length=128)
    kind_contract_version: int = Field(ge=1)
    origin: OperationOrigin = OperationOrigin.MANAGED
    subject: OperationSubject
    state: OperationState
    actor_kind: ActorKind
    actor_id: str
    channel: ClientChannel
    owner_instance_id: str
    version: int = Field(ge=1)
    created_at: float
    updated_at: float
    started_at: float | None = None
    settled_at: float | None = None
    cancel_requested_at: float | None = None
    cancellation_mode: CancellationMode
    cancellation_availability: CancellationAvailability
    result_status: Literal["none", "available", "released", "expired"] = "none"
    provenance: OperationRecordedProvenance | None = None
    error: OperationErrorPayload | None = None

    @model_validator(mode="after")
    def validate_origin_provenance(self) -> OperationSnapshot[ResultT]:
        if self.origin == OperationOrigin.RECORDED and self.provenance is None:
            raise ValueError("recorded operations require reported provenance")
        if self.origin == OperationOrigin.MANAGED and self.provenance is not None:
            raise ValueError("managed operations cannot claim reported provenance")
        return self


class OperationPage(BaseModel, Generic[ResultT]):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operations: list[OperationSnapshot[ResultT]]
    total: int = Field(ge=0)
    next_offset: int | None = Field(default=None, ge=0)


class OperationInitialCollection(BaseModel, Generic[ResultT]):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operations: list[OperationSnapshot[ResultT]]
    operation_count: int = Field(ge=0)
    active_count: int = Field(ge=0)
    terminal_count: int = Field(ge=0)
    history_complete: bool

    @model_validator(mode="after")
    def validate_counts(self) -> OperationInitialCollection[ResultT]:
        if self.operation_count != self.active_count + self.terminal_count:
            raise ValueError(
                "operation_count must equal active_count plus terminal_count"
            )
        if self.history_complete and len(self.operations) != self.operation_count:
            raise ValueError(
                "a complete initial collection must contain every operation"
            )
        if len(self.operations) < self.active_count:
            raise ValueError(
                "an initial collection must contain every active operation"
            )
        return self


class OperationResultEnvelope(BaseModel, Generic[ResultT]):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation_id: str
    kind: str = Field(min_length=1, max_length=128)
    result_schema_version: int = Field(ge=1)
    status: Literal["pending", "available", "released", "expired", "unavailable"]
    result: ResultT | None = None
    error: OperationErrorPayload | None = None


class OperationEvent(BaseModel, Generic[ResultT]):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["snapshot", "resync_required", "authorization_revoked"]
    snapshot: OperationSnapshot[ResultT] | None = None
    operation_count: int | None = Field(default=None, ge=0)
    active_count: int | None = Field(default=None, ge=0)
    terminal_count: int | None = Field(default=None, ge=0)
    history_complete: bool | None = None

    @model_validator(mode="after")
    def validate_snapshot_collection(self) -> OperationEvent[ResultT]:
        counts = (self.operation_count, self.active_count, self.terminal_count)
        if self.kind == "snapshot":
            if self.snapshot is None or any(value is None for value in counts):
                raise ValueError(
                    "snapshot events require a snapshot and collection counts"
                )
            if self.history_complete is None:
                raise ValueError("snapshot events require history coverage")
            if self.operation_count != self.active_count + self.terminal_count:
                raise ValueError(
                    "operation_count must equal active_count plus terminal_count"
                )
        elif self.snapshot is not None or any(value is not None for value in counts):
            raise ValueError(
                "control events cannot include a snapshot or collection counts"
            )
        return self


class OperationCancelResponse(BaseModel, Generic[ResultT]):
    model_config = ConfigDict(extra="forbid", frozen=True)

    snapshot: OperationSnapshot[ResultT]
    disposition: Literal[
        "accepted", "already_requested", "already_settled", "unavailable"
    ]
    reason: str = Field(min_length=1, max_length=1024)


class OperationReleaseResponse(BaseModel, Generic[ResultT]):
    model_config = ConfigDict(extra="forbid", frozen=True)

    snapshot: OperationSnapshot[ResultT]
    disposition: Literal["released", "already_released", "unavailable"]
    reason: str = Field(min_length=1, max_length=1024)


class OperationActionRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(min_length=1, max_length=128)
    action: str = Field(min_length=1, max_length=128)
    actor_kind: Literal["human", "agent", "system"]
    actor_id: str = Field(min_length=1, max_length=256)
    channel: Literal["desktop_ui", "hosted_browser", "managed_cli", "agent", "runtime"]
    outcome: str = Field(min_length=1, max_length=256)
    details: dict[str, str | int | float | bool | None] = Field(
        default_factory=dict, max_length=64
    )
    recorded_at: float


class OperationActionPage(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    actions: list[OperationActionRecord]
    total: int = Field(
        ge=0,
        description="Number of action rows currently retained for paging.",
    )
    next_offset: int | None = Field(default=None, ge=0)
    omitted_count: int = Field(
        ge=0,
        description="Lifetime action rows omitted by the 256-row retention bound.",
    )
    history_complete: bool = Field(
        description="True only when no lifetime action rows were omitted.",
    )

    @model_validator(mode="after")
    def validate_history_coverage(self) -> OperationActionPage:
        if self.history_complete != (self.omitted_count == 0):
            raise ValueError("action history completeness must match omitted_count")
        return self


class ManagedOperationError(Exception):
    code = "MANAGED_OPERATION_ERROR"


class InputRevisionMismatch(ManagedOperationError):
    code = "INPUT_REVISION_MISMATCH"


class RuntimeOwnerConflict(ManagedOperationError):
    code = "RUNTIME_OWNER_CONFLICT"


class SubmissionConflict(ManagedOperationError):
    code = "SUBMISSION_CONFLICT"


class OperationAccessDenied(ManagedOperationError):
    code = "OPERATION_ACCESS_DENIED"


class OperationNotFound(ManagedOperationError):
    code = "OPERATION_NOT_FOUND"


class OperationKindUnavailable(ManagedOperationError):
    code = "OPERATION_KIND_UNAVAILABLE"


class OperationQueueFull(ManagedOperationError):
    code = "OPERATION_QUEUE_FULL"


class OperationAccountLimitReached(OperationQueueFull):
    code = "OPERATION_ACCOUNT_LIMIT"


@dataclass(frozen=True)
class OperationAdmissionRequest:
    principal: OperationPrincipal
    kind: str
    active_count: int


class OperationResultTooLarge(ManagedOperationError):
    code = "OPERATION_RESULT_TOO_LARGE"


class OperationResultStorageFull(ManagedOperationError):
    code = "OPERATION_RESULT_STORAGE_FULL"

    def __init__(
        self,
        *,
        retained_bytes: int,
        reserved_bytes: int,
        requested_bytes: int,
        limit_bytes: int,
        retained_count: int,
        reserved_count: int,
        limit_count: int,
    ) -> None:
        super().__init__(
            "Managed result storage is full. Release a retained result before starting more work."
        )
        self.retained_bytes = retained_bytes
        self.reserved_bytes = reserved_bytes
        self.requested_bytes = requested_bytes
        self.limit_bytes = limit_bytes
        self.retained_count = retained_count
        self.reserved_count = reserved_count
        self.limit_count = limit_count


class OperationExecutionError(ManagedOperationError):
    """An executor-provided error whose fields are safe to retain and display."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: dict[str, str | int | float | bool | None] | None = None,
    ) -> None:
        super().__init__(message)
        self.payload = OperationErrorPayload(
            code=code, message=message, details=details
        )


class OperationCanceled(ManagedOperationError):
    """Executor proof that cooperative cancellation physically settled."""

    code = "OPERATION_CANCELED"
