from __future__ import annotations

import re
import threading
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Annotated, Any, Generic, Literal, Never, TypeAlias, TypeVar, Union

from pydantic import BaseModel, ConfigDict, Field, create_model

from .adapters import (
    DEFAULT_MAX_INPUT_BYTES,
    DEFAULT_MAX_PROVENANCE_BYTES,
    DEFAULT_MAX_RECORDED_IMPORT_BYTES,
    DEFAULT_MAX_RESULT_BYTES,
    ManagedOperationKindAdapter,
    ManagedOperationKindDescriptor,
    ManagedOperationKindSurfaces,
)
from .contracts import (
    ActiveJoinMode,
    CancellationMode,
    ManagedOperationSubmission,
    OperationErrorPayload,
    PreparedRecordedOperation,
)

SubmissionT = TypeVar("SubmissionT", bound=BaseModel)
AgentSubmissionT = TypeVar("AgentSubmissionT", bound=BaseModel)
InputT = TypeVar("InputT", bound=BaseModel)
ResultT = TypeVar("ResultT", bound=BaseModel)
ReceiptT = TypeVar("ReceiptT", bound=BaseModel)

SafeAuditProjection: TypeAlias = Callable[[dict[str, Any]], dict[str, Any]]
SubmissionPreparer: TypeAlias = Callable[
    [SubmissionT], ManagedOperationSubmission[InputT]
]
AgentSubmissionPreparer: TypeAlias = Callable[
    [AgentSubmissionT, Any, Any], Awaitable[ManagedOperationSubmission[InputT]]
]
RecordedImportPreparer: TypeAlias = Callable[
    [ReceiptT], PreparedRecordedOperation[ResultT]
]
ResultDecoder: TypeAlias = Callable[[Any], ResultT]
BoundExecutor: TypeAlias = Callable[[BaseModel, threading.Event], Awaitable[BaseModel]]

_KIND_SLUG = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
_RESERVED_KIND_SLUGS = frozenset({"catalog", "events"})
_COMMON_EXECUTABLE_ACTIONS = (
    "list",
    "get",
    "result",
    "actions",
    "request_cancel",
    "release_result",
)
_COMMON_HISTORY_ACTIONS = (
    "list",
    "get",
    "result",
    "actions",
    "release_result",
)


@dataclass(frozen=True, order=True)
class OperationKindKey:
    kind: str
    version: int


@dataclass(frozen=True)
class OperationLimits:
    max_input_bytes: int = DEFAULT_MAX_INPUT_BYTES
    max_result_bytes: int = DEFAULT_MAX_RESULT_BYTES
    max_recorded_import_bytes: int = DEFAULT_MAX_RECORDED_IMPORT_BYTES
    max_provenance_bytes: int = DEFAULT_MAX_PROVENANCE_BYTES


@dataclass(frozen=True)
class ResultCodec(Generic[ResultT]):
    current_version: int
    model: type[ResultT]
    decoders: Mapping[int, ResultDecoder[ResultT]]

    def __post_init__(self) -> None:
        object.__setattr__(self, "decoders", MappingProxyType(dict(self.decoders)))


@dataclass(frozen=True)
class StartContract(Generic[SubmissionT, InputT]):
    request_model: type[SubmissionT]
    prepare: SubmissionPreparer[SubmissionT, InputT]
    required_capabilities: frozenset[str]
    audit_parameters: SafeAuditProjection

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "required_capabilities", frozenset(self.required_capabilities)
        )


@dataclass(frozen=True)
class AgentStartContract(Generic[AgentSubmissionT, InputT]):
    """Agent-specific admission before work enters the shared operation owner."""

    request_model: type[AgentSubmissionT]
    prepare: AgentSubmissionPreparer[AgentSubmissionT, InputT]
    required_capabilities: frozenset[str]
    audit_parameters: SafeAuditProjection

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "required_capabilities", frozenset(self.required_capabilities)
        )


@dataclass(frozen=True)
class RecordedImportContract(Generic[ReceiptT, ResultT]):
    request_model: type[ReceiptT]
    prepare: RecordedImportPreparer[ReceiptT, ResultT]
    required_capabilities: frozenset[str]
    audit_parameters: SafeAuditProjection

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "required_capabilities", frozenset(self.required_capabilities)
        )


@dataclass(frozen=True)
class ExecutableOperationKind(Generic[SubmissionT, InputT, ResultT, ReceiptT]):
    key: OperationKindKey
    title: str
    input_model: type[InputT]
    result: ResultCodec[ResultT]
    start: StartContract[SubmissionT, InputT]
    cancellation: CancellationMode
    limits: OperationLimits
    active_join: ActiveJoinMode = ActiveJoinMode.NONE
    agent_start: AgentStartContract[Any, InputT] | None = None
    recorded_import: RecordedImportContract[ReceiptT, ResultT] | None = None


@dataclass(frozen=True)
class HistoryOnlyOperationKind(Generic[ResultT]):
    key: OperationKindKey
    title: str
    result: ResultCodec[ResultT]


OperationKindPackage: TypeAlias = (
    ExecutableOperationKind[Any, Any, Any, Any] | HistoryOnlyOperationKind[Any]
)


class _ResultEnvelopeBase(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation_id: str
    status: Literal["pending", "available", "released", "expired", "unavailable"]
    error: OperationErrorPayload | None = None


def _pascal_case(value: str) -> str:
    return "".join(part.capitalize() for part in value.split("-") if part)


def _validate_package(package: OperationKindPackage) -> None:
    if not _KIND_SLUG.fullmatch(package.key.kind):
        raise ValueError(
            "managed operation kind must be a safe lower-case slug using letters, digits, and single hyphens"
        )
    if package.key.kind in _RESERVED_KIND_SLUGS:
        raise ValueError(f"managed operation kind {package.key.kind!r} is reserved")
    if package.key.version < 1:
        raise ValueError("managed operation contract version must be positive")
    if not package.title.strip():
        raise ValueError("managed operation title must not be empty")
    if package.result.current_version < 1:
        raise ValueError("managed operation result schema version must be positive")
    if package.result.current_version not in package.result.decoders:
        raise ValueError("current result schema version requires a decoder")
    if any(
        version < 1 or not callable(decoder)
        for version, decoder in package.result.decoders.items()
    ):
        raise ValueError(
            "managed operation result decoders require positive versions and callable decoders"
        )
    if not issubclass(package.result.model, BaseModel):
        raise ValueError("managed operation result model must be a Pydantic model")

    if isinstance(package, HistoryOnlyOperationKind):
        return

    if not issubclass(package.input_model, BaseModel):
        raise ValueError("managed operation input model must be a Pydantic model")
    if not issubclass(package.start.request_model, BaseModel):
        raise ValueError("managed operation start request must be a Pydantic model")
    if not package.start.required_capabilities or any(
        not capability for capability in package.start.required_capabilities
    ):
        raise ValueError("managed operation start capabilities must be explicit")
    if not callable(package.start.prepare) or not callable(
        package.start.audit_parameters
    ):
        raise ValueError(
            "managed operation start requires preparation and audit policy"
        )
    if package.agent_start is not None:
        if not issubclass(package.agent_start.request_model, BaseModel):
            raise ValueError(
                "managed operation agent start request must be a Pydantic model"
            )
        if not package.agent_start.required_capabilities or any(
            not capability for capability in package.agent_start.required_capabilities
        ):
            raise ValueError(
                "managed operation agent start capabilities must be explicit"
            )
        if not callable(package.agent_start.prepare) or not callable(
            package.agent_start.audit_parameters
        ):
            raise ValueError(
                "managed operation agent start requires preparation and audit policy"
            )
    if package.recorded_import is not None:
        if not issubclass(package.recorded_import.request_model, BaseModel):
            raise ValueError("recorded import request must be a Pydantic model")
        if not package.recorded_import.required_capabilities or any(
            not capability
            for capability in package.recorded_import.required_capabilities
        ):
            raise ValueError("recorded import capabilities must be explicit")
        if not callable(package.recorded_import.prepare) or not callable(
            package.recorded_import.audit_parameters
        ):
            raise ValueError("recorded import requires preparation and audit policy")
    if (
        min(
            package.limits.max_input_bytes,
            package.limits.max_result_bytes,
            package.limits.max_recorded_import_bytes,
            package.limits.max_provenance_bytes,
        )
        < 1
    ):
        raise ValueError("managed operation storage bounds must be positive")


def _descriptor(package: OperationKindPackage) -> ManagedOperationKindDescriptor:
    if isinstance(package, HistoryOnlyOperationKind):
        return ManagedOperationKindDescriptor(
            kind=package.key.kind,
            title=package.title,
            contract_version=package.key.version,
            result_schema_version=package.result.current_version,
            executable=False,
            active_join=ActiveJoinMode.NONE.value,
            input_schema=None,
            agent_input_schema=None,
            result_schema=package.result.model.model_json_schema(),
            recorded_import_schema=None,
            start_capabilities=(),
            agent_start_capabilities=(),
            recorded_import_capabilities=(),
            actions=_COMMON_HISTORY_ACTIONS,
            surfaces=ManagedOperationKindSurfaces(
                http_start=None,
                http_import_recorded=None,
                cli_submit=None,
                cli_import_recorded=None,
                agent_start=None,
                agent_import_recorded=None,
            ),
        )

    import_contract = package.recorded_import
    agent_contract = package.agent_start or package.start
    actions = ("start",)
    if import_contract is not None:
        actions += ("import_recorded",)
    actions += _COMMON_EXECUTABLE_ACTIONS
    base_path = f"/operations/{package.key.kind}"
    return ManagedOperationKindDescriptor(
        kind=package.key.kind,
        title=package.title,
        contract_version=package.key.version,
        result_schema_version=package.result.current_version,
        executable=True,
        active_join=package.active_join.value,
        input_schema=package.start.request_model.model_json_schema(),
        agent_input_schema=agent_contract.request_model.model_json_schema(),
        result_schema=package.result.model.model_json_schema(),
        recorded_import_schema=(
            import_contract.request_model.model_json_schema()
            if import_contract is not None
            else None
        ),
        start_capabilities=tuple(sorted(package.start.required_capabilities)),
        agent_start_capabilities=tuple(sorted(agent_contract.required_capabilities)),
        recorded_import_capabilities=(
            tuple(sorted(import_contract.required_capabilities))
            if import_contract is not None
            else ()
        ),
        actions=actions,
        surfaces=ManagedOperationKindSurfaces(
            http_start=base_path,
            http_import_recorded=(
                f"{base_path}/import-recorded" if import_contract is not None else None
            ),
            cli_submit=(f"dnaforge jobs submit {package.key.kind} --request FILE|-"),
            cli_import_recorded=(
                f"dnaforge jobs import-recorded {package.key.kind} --request FILE|-"
                if import_contract is not None
                else None
            ),
            agent_start=f"operations.{package.key.kind}.start",
            agent_import_recorded=(
                f"operations.{package.key.kind}.import_recorded"
                if import_contract is not None
                else None
            ),
        ),
    )


def _result_envelope_variant(package: OperationKindPackage) -> type[BaseModel]:
    kind_literal = Literal[package.key.kind]  # type: ignore[valid-type]
    version_literal = Literal.__getitem__(tuple(sorted(package.result.decoders)))
    return create_model(
        f"{_pascal_case(package.key.kind)}OperationResultEnvelope",
        __base__=_ResultEnvelopeBase,
        kind=(kind_literal, ...),
        result_schema_version=(version_literal, ...),
        result=(package.result.model | None, None),
    )


class CompiledOperationSystem:
    def __init__(self, packages: tuple[OperationKindPackage, ...]) -> None:
        self.packages = packages
        self.descriptors = tuple(_descriptor(package) for package in packages)
        self._packages_by_kind = {package.key.kind: package for package in packages}
        self._descriptors_by_kind = {
            descriptor.kind: descriptor for descriptor in self.descriptors
        }
        self.kind_literal = Literal.__getitem__(
            tuple(package.key.kind for package in packages)
        )
        executable_kinds = tuple(
            package.key.kind
            for package in packages
            if isinstance(package, ExecutableOperationKind)
        )
        self.executable_kind_literal = (
            Literal.__getitem__(executable_kinds) if executable_kinds else Never
        )
        variants = tuple(_result_envelope_variant(package) for package in packages)
        if len(variants) == 1:
            self.result_envelope = variants[0]
        else:
            result_union = Union[variants]  # type: ignore[arg-type]
            self.result_envelope = Annotated[result_union, Field(discriminator="kind")]

    def package(self, kind: str) -> OperationKindPackage:
        try:
            return self._packages_by_kind[kind]
        except KeyError as exc:
            raise ValueError(f"Unknown managed operation kind {kind!r}") from exc

    def bind_executors(
        self, executors: Mapping[OperationKindKey, BoundExecutor]
    ) -> tuple[ManagedOperationKindAdapter, ...]:
        executable = {
            package.key: package
            for package in self.packages
            if isinstance(package, ExecutableOperationKind)
        }
        missing = sorted(set(executable) - set(executors))
        if missing:
            names = ", ".join(key.kind for key in missing)
            raise ValueError(
                f"Missing executor binding for managed operation kind(s): {names}"
            )
        extra = sorted(set(executors) - set(executable))
        if extra:
            history = [
                key.kind
                for key in extra
                if isinstance(
                    self._packages_by_kind.get(key.kind), HistoryOnlyOperationKind
                )
            ]
            if history:
                raise ValueError(
                    "Cannot bind an executor to history-only managed operation kind(s): "
                    + ", ".join(history)
                )
            raise ValueError(
                "Executor binding does not match a registered executable kind: "
                + ", ".join(key.kind for key in extra)
            )

        adapters = []
        for package in sorted(self.packages, key=lambda value: value.key):
            key = package.key
            if isinstance(package, HistoryOnlyOperationKind):
                adapters.append(
                    ManagedOperationKindAdapter(
                        kind=key.kind,
                        title=package.title,
                        input_model=BaseModel,
                        result_model=package.result.model,
                        executor=None,
                        start_enabled=False,
                        contract_version=key.version,
                        result_schema_version=package.result.current_version,
                        result_decoders=package.result.decoders,
                        catalog_descriptor=self._descriptors_by_kind[key.kind],
                    )
                )
                continue
            import_contract = package.recorded_import
            agent_contract = package.agent_start or package.start
            adapters.append(
                ManagedOperationKindAdapter(
                    kind=key.kind,
                    title=package.title,
                    input_model=package.input_model,
                    result_model=package.result.model,
                    executor=executors[key],
                    submission_model=package.start.request_model,
                    agent_submission_model=agent_contract.request_model,
                    recorded_import_model=(
                        import_contract.request_model
                        if import_contract is not None
                        else None
                    ),
                    recorded_import_preparer=(
                        import_contract.prepare if import_contract is not None else None
                    ),
                    cancellation_mode=package.cancellation,
                    active_join=package.active_join,
                    max_input_bytes=package.limits.max_input_bytes,
                    max_result_bytes=package.limits.max_result_bytes,
                    max_recorded_import_bytes=package.limits.max_recorded_import_bytes,
                    max_provenance_bytes=package.limits.max_provenance_bytes,
                    required_start_capabilities=package.start.required_capabilities,
                    required_agent_start_capabilities=agent_contract.required_capabilities,
                    required_import_capabilities=(
                        import_contract.required_capabilities
                        if import_contract is not None
                        else frozenset()
                    ),
                    contract_version=key.version,
                    result_schema_version=package.result.current_version,
                    result_decoders=package.result.decoders,
                    catalog_descriptor=self._descriptors_by_kind[key.kind],
                )
            )
        return tuple(adapters)

    def decode_result(
        self, *, kind: str, result_schema_version: int, payload: Any
    ) -> BaseModel:
        package = self.package(kind)
        decoder = package.result.decoders.get(result_schema_version)
        if decoder is None:
            raise ValueError(
                f"Unsupported result schema version {result_schema_version} for managed operation kind {kind!r}"
            )
        return package.result.model.model_validate(decoder(payload))


def compile_operation_system(
    *packages: OperationKindPackage,
) -> CompiledOperationSystem:
    if not packages:
        raise ValueError("managed operation system requires at least one kind package")
    for package in packages:
        _validate_package(package)
    keys = [package.key for package in packages]
    if len(keys) != len(set(keys)):
        raise ValueError("managed operation kind and version pairs must be unique")
    kinds = [package.key.kind for package in packages]
    if len(kinds) != len(set(kinds)):
        raise ValueError(
            "managed operation executable/history kind names must be unique"
        )
    return CompiledOperationSystem(tuple(sorted(packages, key=lambda item: item.key)))
