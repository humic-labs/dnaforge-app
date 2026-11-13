from __future__ import annotations

import threading
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Generic, TypeVar

from pydantic import BaseModel

from .contracts import (
    ActiveJoinMode,
    CancellationMode,
    ManagedOperationSubmission,
    OperationKind,
    PreparedRecordedOperation,
)

InputT = TypeVar("InputT", bound=BaseModel)
ResultT = TypeVar("ResultT", bound=BaseModel)
OperationExecutor = Callable[[InputT, threading.Event], Awaitable[ResultT]]
RecordedOperationPreparer = Callable[[BaseModel], PreparedRecordedOperation[ResultT]]
ResultDecoder = Callable[[Any], BaseModel]

DEFAULT_MAX_INPUT_BYTES = 16 * 1024 * 1024
DEFAULT_MAX_RESULT_BYTES = 16 * 1024 * 1024
DEFAULT_MAX_RECORDED_IMPORT_BYTES = DEFAULT_MAX_INPUT_BYTES + DEFAULT_MAX_RESULT_BYTES
DEFAULT_MAX_PROVENANCE_BYTES = 64 * 1024
DEFAULT_OPERATION_ACTIONS = (
    "start",
    "list",
    "get",
    "result",
    "actions",
    "request_cancel",
    "release_result",
)
DEFAULT_HISTORY_ACTIONS = (
    "list",
    "get",
    "result",
    "actions",
    "release_result",
)


def operation_kind_value(kind: str | OperationKind) -> str:
    value = kind.value if isinstance(kind, OperationKind) else kind
    if not isinstance(value, str) or not value or len(value) > 128:
        raise ValueError(
            "operation kind must be a non-empty string of at most 128 characters"
        )
    return value


@dataclass(frozen=True)
class ManagedOperationKindSurfaces:
    http_start: str | None
    http_import_recorded: str | None
    cli_submit: str | None
    cli_import_recorded: str | None
    agent_start: str | None
    agent_import_recorded: str | None


@dataclass(frozen=True)
class ManagedOperationKindDescriptor:
    kind: str
    title: str
    contract_version: int
    result_schema_version: int
    executable: bool
    active_join: str
    input_schema: dict | None
    agent_input_schema: dict | None
    result_schema: dict
    recorded_import_schema: dict | None
    start_capabilities: tuple[str, ...]
    agent_start_capabilities: tuple[str, ...]
    recorded_import_capabilities: tuple[str, ...]
    actions: tuple[str, ...]
    surfaces: ManagedOperationKindSurfaces


@dataclass(frozen=True)
class ManagedOperationKindAdapter(Generic[InputT, ResultT]):
    """Typed scientific boundary registered with one shared runtime owner."""

    kind: str | OperationKind
    title: str
    input_model: type[InputT]
    result_model: type[ResultT]
    executor: OperationExecutor[InputT, ResultT] | None
    submission_model: type[BaseModel] | None = None
    agent_submission_model: type[BaseModel] | None = None
    recorded_import_model: type[BaseModel] | None = None
    recorded_import_preparer: RecordedOperationPreparer[ResultT] | None = None
    cancellation_mode: CancellationMode = CancellationMode.QUEUED_ONLY
    active_join: ActiveJoinMode = ActiveJoinMode.NONE
    max_input_bytes: int = DEFAULT_MAX_INPUT_BYTES
    max_result_bytes: int = DEFAULT_MAX_RESULT_BYTES
    max_recorded_import_bytes: int = DEFAULT_MAX_RECORDED_IMPORT_BYTES
    max_provenance_bytes: int = DEFAULT_MAX_PROVENANCE_BYTES
    required_start_capabilities: frozenset[str] = frozenset()
    required_agent_start_capabilities: frozenset[str] | None = None
    required_import_capabilities: frozenset[str] = frozenset()
    start_enabled: bool = True
    contract_version: int = 1
    result_schema_version: int = 1
    result_decoders: Mapping[int, ResultDecoder] | None = None
    catalog_descriptor: ManagedOperationKindDescriptor | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "kind", operation_kind_value(self.kind))
        if not self.title:
            raise ValueError("operation kind title must not be empty")
        if (
            min(
                self.max_input_bytes,
                self.max_result_bytes,
                self.max_recorded_import_bytes,
                self.max_provenance_bytes,
            )
            < 1
        ):
            raise ValueError("operation kind storage bounds must be positive")
        if self.start_enabled and self.executor is None:
            raise ValueError("a start-enabled operation kind requires an executor")
        if any(not capability for capability in self.required_start_capabilities):
            raise ValueError("operation kind capabilities must not be empty")
        if self.required_agent_start_capabilities is not None and any(
            not capability for capability in self.required_agent_start_capabilities
        ):
            raise ValueError("operation kind agent capabilities must not be empty")
        if (self.recorded_import_model is None) != (
            self.recorded_import_preparer is None
        ):
            raise ValueError(
                "recorded import model and preparer must be configured together"
            )
        if any(not capability for capability in self.required_import_capabilities):
            raise ValueError("operation kind import capabilities must not be empty")
        if self.contract_version < 1 or self.result_schema_version < 1:
            raise ValueError("operation kind contract versions must be positive")
        decoders = (
            {self.result_schema_version: self.result_model.model_validate}
            if self.result_decoders is None
            else dict(self.result_decoders)
        )
        if self.result_schema_version not in decoders:
            raise ValueError("current result schema version requires a decoder")
        if any(
            version < 1 or not callable(decoder)
            for version, decoder in decoders.items()
        ):
            raise ValueError(
                "result decoders require positive versions and callable decoders"
            )
        object.__setattr__(self, "result_decoders", MappingProxyType(decoders))
        if (
            self.catalog_descriptor is not None
            and self.catalog_descriptor != self._derived_descriptor()
        ):
            raise ValueError(
                "compiled operation descriptor does not match its runtime adapter"
            )

    def descriptor(self) -> ManagedOperationKindDescriptor:
        if self.catalog_descriptor is not None:
            return self.catalog_descriptor
        return self._derived_descriptor()

    def _derived_descriptor(self) -> ManagedOperationKindDescriptor:
        submission_model = (
            self.submission_model or ManagedOperationSubmission[self.input_model]
        )
        agent_submission_model = self.agent_submission_model or submission_model
        agent_start_capabilities = (
            self.required_agent_start_capabilities
            if self.required_agent_start_capabilities is not None
            else self.required_start_capabilities
        )
        actions = list(
            DEFAULT_OPERATION_ACTIONS if self.start_enabled else DEFAULT_HISTORY_ACTIONS
        )
        if self.recorded_import_model is not None:
            actions.insert(1 if self.start_enabled else 0, "import_recorded")
        base_path = f"/operations/{self.kind}"
        return ManagedOperationKindDescriptor(
            kind=self.kind,
            title=self.title,
            contract_version=self.contract_version,
            result_schema_version=self.result_schema_version,
            executable=self.start_enabled,
            active_join=self.active_join.value,
            input_schema=(
                submission_model.model_json_schema() if self.start_enabled else None
            ),
            agent_input_schema=(
                agent_submission_model.model_json_schema()
                if self.start_enabled
                else None
            ),
            result_schema=self.result_model.model_json_schema(),
            recorded_import_schema=(
                self.recorded_import_model.model_json_schema()
                if self.recorded_import_model is not None
                else None
            ),
            start_capabilities=tuple(sorted(self.required_start_capabilities)),
            agent_start_capabilities=tuple(sorted(agent_start_capabilities)),
            recorded_import_capabilities=tuple(
                sorted(self.required_import_capabilities)
            ),
            actions=tuple(actions),
            surfaces=ManagedOperationKindSurfaces(
                http_start=base_path if self.start_enabled else None,
                http_import_recorded=(
                    f"{base_path}/import-recorded"
                    if self.recorded_import_model is not None
                    else None
                ),
                cli_submit=(
                    f"dnaforge jobs submit {self.kind} --request FILE|-"
                    if self.start_enabled
                    else None
                ),
                cli_import_recorded=(
                    f"dnaforge jobs import-recorded {self.kind} --request FILE|-"
                    if self.recorded_import_model is not None
                    else None
                ),
                agent_start=(
                    f"operations.{self.kind}.start" if self.start_enabled else None
                ),
                agent_import_recorded=(
                    f"operations.{self.kind}.import_recorded"
                    if self.recorded_import_model is not None
                    else None
                ),
            ),
        )
