"""Agent tool projection over the shared managed operation owner."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from .concurrency.schema import (
    DNAForgeTool,
    ExpectedLatency,
    PoolName,
    ToolCategory,
    ToolDuration,
    ToolEffect,
    ToolHome,
    ToolRuntime,
    ToolShape,
)
from .concurrency.tool_errors import ToolExecutionFailure
from .concurrency.tool_registry import (
    AgentToolRegistry,
    RegisteredTool,
    ToolContext,
    ToolHandler,
    ToolReplayPolicy,
    agent_tool_registry,
)
from .managed_operations import MANAGED_OPERATION_SYSTEM
from .operations import (
    InputRevisionMismatch,
    ManagedOperationError,
    ManagedOperationService,
    OperationAccessDenied,
    OperationActionPage,
    OperationCancelResponse,
    OperationNotFound,
    OperationPrincipal,
    OperationQueueFull,
    OperationReleaseResponse,
    OperationResultStorageFull,
    OperationResultTooLarge,
    OperationSnapshot,
    SubmissionConflict,
)
from .operations.contracts import ActorKind, ClientChannel
from .operations.registration import (
    CompiledOperationSystem,
    ExecutableOperationKind,
)


def managed_operation_audit_result(result: dict[str, Any]) -> dict[str, Any]:
    canonical = json.dumps(
        result, sort_keys=True, separators=(",", ":"), default=str
    ).encode("utf-8")
    projection: dict[str, Any] = {
        "schema_version": 1,
        "payload_bytes": len(canonical),
        "payload_sha256": "sha256:" + hashlib.sha256(canonical).hexdigest(),
    }

    snapshot = result.get("snapshot")
    operation = snapshot if isinstance(snapshot, dict) else result
    operation_id = operation.get("id")
    if not isinstance(operation_id, str):
        operation_id = result.get("operation_id")
    if not isinstance(operation_id, str):
        operation_id = result.get("operationId")
    if isinstance(operation_id, str):
        projection["operation_id"] = operation_id

    document_action_id = result.get("actionId")
    if isinstance(document_action_id, str):
        projection["document_action_id"] = document_action_id

    operation_kind = operation.get("kind")
    if isinstance(operation_kind, str):
        projection["operation_kind"] = operation_kind
    operation_state = operation.get("state")
    if isinstance(operation_state, str):
        projection["operation_state"] = operation_state

    for key in (
        "disposition",
        "status",
        "total",
        "next_offset",
        "omitted_count",
        "history_complete",
        "operation_count",
        "active_count",
        "terminal_count",
    ):
        value = result.get(key)
        if key in result and (
            isinstance(value, (str, int, bool))
            or (value is None and key == "next_offset")
        ):
            projection["result_status" if key == "status" else key] = value

    for key in ("operations", "actions", "kinds"):
        value = result.get(key)
        if isinstance(value, list):
            projection[f"returned_{key}"] = len(value)
    return projection


class _EmptyInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _OperationIdInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation_id: str = Field(min_length=1, max_length=256)


class _OperationListInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scope_id: str | None = Field(default=None, min_length=1, max_length=512)
    subject_id: str | None = Field(default=None, min_length=1, max_length=1024)
    limit: int = Field(default=50, ge=1, le=100)
    offset: int = Field(default=0, ge=0)


class _OperationActionsInput(_OperationIdInput):
    limit: int = Field(default=50, ge=1, le=100)
    offset: int = Field(default=0, ge=0)


class ManagedOperationList(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operations: list[OperationSnapshot]
    total: int = Field(ge=0)
    next_offset: int | None = None


class ManagedOperationKindSurfaces(BaseModel):
    model_config = ConfigDict(extra="forbid")

    http_start: str | None = None
    http_import_recorded: str | None = None
    cli_submit: str | None = None
    cli_import_recorded: str | None = None
    agent_start: str | None = None
    agent_import_recorded: str | None = None


class ManagedOperationKind(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: str
    registration: Literal["executable", "history_only"]
    title: str
    contract_version: int = Field(ge=1)
    result_schema_version: int = Field(ge=1)
    executable: bool
    active_join: Literal["none", "subject_revision"] = "none"
    input_schema: dict[str, Any] | None
    agent_input_schema: dict[str, Any] | None
    result_schema: dict[str, Any]
    recorded_import_schema: dict[str, Any] | None = None
    start_capabilities: list[str]
    agent_start_capabilities: list[str] = Field(default_factory=list)
    recorded_import_capabilities: list[str]
    actions: list[str]
    surfaces: ManagedOperationKindSurfaces


class ManagedOperationCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scope_id: str
    owner_instance_id: str
    kinds: list[ManagedOperationKind]


def _service(
    context: ToolContext,
) -> ManagedOperationService:
    service = context.managed_operations
    if not isinstance(service, ManagedOperationService):
        raise ToolExecutionFailure(
            code="OPERATION_RUNTIME_UNAVAILABLE",
            message="The managed operation runtime is unavailable.",
            retriable=True,
        )
    return service


def _principal(
    context: ToolContext,
    service: ManagedOperationService,
) -> OperationPrincipal:
    return OperationPrincipal(
        actor_kind=ActorKind.AGENT,
        actor_id=context.agent_identity_id,
        channel=ClientChannel.AGENT,
        scope_ids={service.runtime_scope},
        capabilities=frozenset(context.agent_capabilities),
    )


def _validate_input(model: type[BaseModel], args: dict[str, Any]) -> BaseModel:
    try:
        return model.model_validate(args)
    except ValidationError as exc:
        raise ToolExecutionFailure(
            code="BAD_INPUT",
            message="Managed operation tool input is invalid.",
            retriable=False,
        ) from exc


def _raise_managed_failure(exc: ManagedOperationError) -> None:
    messages: list[tuple[type[ManagedOperationError], str, bool]] = [
        (
            OperationAccessDenied,
            "This agent is not authorized for the managed operation.",
            False,
        ),
        (OperationNotFound, "The managed operation was not found.", False),
        (
            SubmissionConflict,
            "The submission key was reused with different input.",
            False,
        ),
        (
            InputRevisionMismatch,
            "The supplied input revision does not match the prepared input.",
            False,
        ),
        (
            OperationQueueFull,
            "The managed operation queue is full or shutting down.",
            True,
        ),
        (
            OperationResultTooLarge,
            "The managed operation input or result exceeds its size limit.",
            False,
        ),
        (
            OperationResultStorageFull,
            "Managed result storage is full. Release a retained result before starting more work.",
            False,
        ),
    ]
    for error_type, message, retriable in messages:
        if isinstance(exc, error_type):
            raise ToolExecutionFailure(
                code=exc.code,
                message=message,
                retriable=retriable,
            ) from exc
    raise ToolExecutionFailure(
        code=exc.code,
        message="The managed operation was refused.",
        retriable=False,
    ) from exc


def _link_operation(
    service: ManagedOperationService,
    context: ToolContext,
    operation_id: str,
) -> None:
    if service.store.link_agent_action_operation(context.job_id, operation_id):
        return
    raise ToolExecutionFailure(
        code="OPERATION_ACTION_LINK_FAILED",
        message="The operation completed but its agent action could not be linked.",
        retriable=False,
    )


async def discover_managed_operations_handler(
    args: dict[str, Any], context: ToolContext
) -> dict[str, Any]:
    _validate_input(_EmptyInput, args)
    service = _service(context)
    principal = _principal(context, service)
    try:
        service.list(principal, scope_id=service.runtime_scope, limit=1)
    except ManagedOperationError as exc:
        _raise_managed_failure(exc)
    return ManagedOperationCatalog(
        scope_id=service.runtime_scope,
        owner_instance_id=service.owner_instance_id,
        kinds=[
            ManagedOperationKind(
                kind=descriptor.kind,
                registration=(
                    "executable" if descriptor.executable else "history_only"
                ),
                title=descriptor.title,
                contract_version=descriptor.contract_version,
                result_schema_version=descriptor.result_schema_version,
                executable=descriptor.executable,
                active_join=descriptor.active_join,
                input_schema=descriptor.input_schema,
                agent_input_schema=descriptor.agent_input_schema,
                result_schema=descriptor.result_schema,
                recorded_import_schema=descriptor.recorded_import_schema,
                start_capabilities=list(descriptor.start_capabilities),
                agent_start_capabilities=list(descriptor.agent_start_capabilities),
                recorded_import_capabilities=list(
                    descriptor.recorded_import_capabilities
                ),
                actions=[
                    (
                        f"operations.{descriptor.kind}.start"
                        if action == "start"
                        else (
                            f"operations.{descriptor.kind}.import_recorded"
                            if action == "import_recorded"
                            else f"operations.{action}"
                        )
                    )
                    for action in descriptor.actions
                ],
                surfaces=ManagedOperationKindSurfaces(
                    http_start=descriptor.surfaces.http_start,
                    http_import_recorded=descriptor.surfaces.http_import_recorded,
                    cli_submit=descriptor.surfaces.cli_submit,
                    cli_import_recorded=descriptor.surfaces.cli_import_recorded,
                    agent_start=descriptor.surfaces.agent_start,
                    agent_import_recorded=descriptor.surfaces.agent_import_recorded,
                ),
            )
            for descriptor in service.kind_descriptors()
        ],
    ).model_dump(mode="json")


async def list_managed_operations_handler(
    args: dict[str, Any], context: ToolContext
) -> dict[str, Any]:
    parsed = _validate_input(_OperationListInput, args)
    assert isinstance(parsed, _OperationListInput)
    service = _service(context)
    try:
        page = service.list_page(
            _principal(context, service),
            scope_id=parsed.scope_id or service.runtime_scope,
            subject_id=parsed.subject_id,
            limit=parsed.limit,
            offset=parsed.offset,
        )
    except ManagedOperationError as exc:
        _raise_managed_failure(exc)
    return ManagedOperationList(
        operations=page.operations,
        total=page.total,
        next_offset=page.next_offset,
    ).model_dump(mode="json")


async def get_managed_operation_handler(
    args: dict[str, Any], context: ToolContext
) -> dict[str, Any]:
    parsed = _validate_input(_OperationIdInput, args)
    assert isinstance(parsed, _OperationIdInput)
    service = _service(context)
    try:
        snapshot = service.get(_principal(context, service), parsed.operation_id)
    except ManagedOperationError as exc:
        _raise_managed_failure(exc)
    _link_operation(service, context, snapshot.id)
    return snapshot.model_dump(mode="json")


async def get_managed_operation_result_handler(
    args: dict[str, Any], context: ToolContext
) -> dict[str, Any]:
    parsed = _validate_input(_OperationIdInput, args)
    assert isinstance(parsed, _OperationIdInput)
    service = _service(context)
    try:
        result = service.get_result(_principal(context, service), parsed.operation_id)
    except ManagedOperationError as exc:
        _raise_managed_failure(exc)
    _link_operation(service, context, result.operation_id)
    return result.model_dump(mode="json")


async def list_managed_operation_actions_handler(
    args: dict[str, Any], context: ToolContext
) -> dict[str, Any]:
    parsed = _validate_input(_OperationActionsInput, args)
    assert isinstance(parsed, _OperationActionsInput)
    service = _service(context)
    try:
        page = service.list_actions_page(
            _principal(context, service),
            parsed.operation_id,
            limit=parsed.limit,
            offset=parsed.offset,
        )
    except ManagedOperationError as exc:
        _raise_managed_failure(exc)
    _link_operation(service, context, parsed.operation_id)
    return page.model_dump(mode="json")


def _registered_start_handler(package: ExecutableOperationKind) -> ToolHandler:
    async def handler(args: dict[str, Any], context: ToolContext) -> dict[str, Any]:
        contract = package.agent_start or package.start
        parsed = _validate_input(contract.request_model, args)
        service = _service(context)
        try:
            submission = (
                await package.agent_start.prepare(parsed, context, service)
                if package.agent_start is not None
                else package.start.prepare(parsed)
            )
            snapshot = await service.start(
                _principal(context, service),
                submission,
                kind=package.key.kind,
            )
        except ManagedOperationError as exc:
            _raise_managed_failure(exc)
        _link_operation(service, context, snapshot.id)
        return snapshot.model_dump(mode="json")

    handler.__name__ = f"start_managed_{package.key.kind.replace('-', '_')}_handler"
    return handler


def _registered_import_handler(package: ExecutableOperationKind) -> ToolHandler:
    async def handler(args: dict[str, Any], context: ToolContext) -> dict[str, Any]:
        contract = package.recorded_import
        if contract is None:
            raise RuntimeError("registered import tool has no import contract")
        parsed = _validate_input(contract.request_model, args)
        service = _service(context)
        try:
            snapshot = await service.import_recorded(
                _principal(context, service), parsed, kind=package.key.kind
            )
        except ManagedOperationError as exc:
            _raise_managed_failure(exc)
        _link_operation(service, context, snapshot.id)
        return snapshot.model_dump(mode="json")

    handler.__name__ = (
        f"import_recorded_managed_{package.key.kind.replace('-', '_')}_handler"
    )
    return handler


async def request_managed_operation_cancel_handler(
    args: dict[str, Any], context: ToolContext
) -> dict[str, Any]:
    parsed = _validate_input(_OperationIdInput, args)
    assert isinstance(parsed, _OperationIdInput)
    service = _service(context)
    try:
        response = await service.request_cancel(
            _principal(context, service), parsed.operation_id
        )
    except ManagedOperationError as exc:
        _raise_managed_failure(exc)
    _link_operation(service, context, response.snapshot.id)
    return response.model_dump(mode="json")


async def release_managed_operation_result_handler(
    args: dict[str, Any], context: ToolContext
) -> dict[str, Any]:
    parsed = _validate_input(_OperationIdInput, args)
    assert isinstance(parsed, _OperationIdInput)
    service = _service(context)
    try:
        response = await service.release_result(
            _principal(context, service), parsed.operation_id
        )
    except ManagedOperationError as exc:
        _raise_managed_failure(exc)
    _link_operation(service, context, response.snapshot.id)
    return response.model_dump(mode="json")


def _spec(
    *,
    name: str,
    description: str,
    inputs: dict[str, Any],
    outputs: dict[str, Any],
    capabilities: list[str],
    effect: ToolEffect,
    shape: ToolShape,
    handler_ref: str,
    idempotency_keyable: bool = False,
) -> DNAForgeTool:
    return DNAForgeTool(
        name=name,
        description=description,
        inputs=inputs,
        outputs=outputs,
        home=ToolHome.IN_HOST_TRANSITIONAL,
        runtime=ToolRuntime.IN_HOST,
        handler_ref=handler_ref,
        pool=PoolName.CPU_FAST,
        expected_latency=ExpectedLatency.SUB_SECOND,
        idempotency_keyable=idempotency_keyable,
        streams_progress=False,
        category=ToolCategory(
            shape=shape,
            duration=ToolDuration.IMMEDIATE,
            effects=[effect],
            cancelable=False,
            approval_gated=False,
        ),
        required_capabilities=capabilities,
        audit_required=True,
    )


def _registered_tool(
    spec: DNAForgeTool,
    handler: ToolHandler,
    *,
    audit_parameter_projector=None,
) -> RegisteredTool:
    return RegisteredTool(
        spec=spec,
        handler=handler,
        replay_policy=ToolReplayPolicy.EXECUTE,
        audit_parameter_projector=audit_parameter_projector,
        audit_result_projector=managed_operation_audit_result,
    )


def managed_operation_tool_definitions(
    system: CompiledOperationSystem,
) -> tuple[RegisteredTool, ...]:
    operation_id_schema = _OperationIdInput.model_json_schema()
    snapshot_schema = OperationSnapshot.model_json_schema()
    definitions = [
        _registered_tool(
            _spec(
                name="operations.discover",
                description="Discover installed managed operation commands and schemas.",
                inputs=_EmptyInput.model_json_schema(),
                outputs=ManagedOperationCatalog.model_json_schema(),
                capabilities=["operations.read"],
                effect=ToolEffect.READ_ONLY,
                shape=ToolShape.DATA_SERVICE,
                handler_ref="src.managed_operation_agent_tools.discover_managed_operations_handler",
            ),
            discover_managed_operations_handler,
        ),
        _registered_tool(
            _spec(
                name="operations.list",
                description="List retained managed operations in this runtime.",
                inputs=_OperationListInput.model_json_schema(),
                outputs=ManagedOperationList.model_json_schema(),
                capabilities=["operations.read"],
                effect=ToolEffect.READ_ONLY,
                shape=ToolShape.DATA_SERVICE,
                handler_ref="src.managed_operation_agent_tools.list_managed_operations_handler",
            ),
            list_managed_operations_handler,
        ),
        _registered_tool(
            _spec(
                name="operations.get",
                description="Read one managed operation snapshot.",
                inputs=operation_id_schema,
                outputs=snapshot_schema,
                capabilities=["operations.read"],
                effect=ToolEffect.READ_ONLY,
                shape=ToolShape.DATA_SERVICE,
                handler_ref="src.managed_operation_agent_tools.get_managed_operation_handler",
            ),
            get_managed_operation_handler,
        ),
        _registered_tool(
            _spec(
                name="operations.result",
                description="Read the retained result of one managed operation.",
                inputs=operation_id_schema,
                outputs=TypeAdapter(system.result_envelope).json_schema(),
                capabilities=["operations.read"],
                effect=ToolEffect.READ_ONLY,
                shape=ToolShape.DATA_SERVICE,
                handler_ref="src.managed_operation_agent_tools.get_managed_operation_result_handler",
            ),
            get_managed_operation_result_handler,
        ),
        _registered_tool(
            _spec(
                name="operations.actions",
                description="Read authenticated actor and outcome history for one operation.",
                inputs=_OperationActionsInput.model_json_schema(),
                outputs=OperationActionPage.model_json_schema(),
                capabilities=["operations.read"],
                effect=ToolEffect.READ_ONLY,
                shape=ToolShape.DATA_SERVICE,
                handler_ref="src.managed_operation_agent_tools.list_managed_operation_actions_handler",
            ),
            list_managed_operation_actions_handler,
        ),
        _registered_tool(
            _spec(
                name="operations.request_cancel",
                description="Request cancellation without misreporting physical execution.",
                inputs=operation_id_schema,
                outputs=OperationCancelResponse.model_json_schema(),
                capabilities=["operations.cancel"],
                effect=ToolEffect.MUTATING,
                shape=ToolShape.ADAPTER,
                handler_ref="src.managed_operation_agent_tools.request_managed_operation_cancel_handler",
                idempotency_keyable=True,
            ),
            request_managed_operation_cancel_handler,
        ),
        _registered_tool(
            _spec(
                name="operations.release_result",
                description="Release a retained result and free its managed storage.",
                inputs=operation_id_schema,
                outputs=OperationReleaseResponse.model_json_schema(),
                capabilities=["operations.release"],
                effect=ToolEffect.MUTATING,
                shape=ToolShape.ADAPTER,
                handler_ref="src.managed_operation_agent_tools.release_managed_operation_result_handler",
                idempotency_keyable=True,
            ),
            release_managed_operation_result_handler,
        ),
    ]
    for package in system.packages:
        if not isinstance(package, ExecutableOperationKind):
            continue
        start_contract = package.agent_start or package.start
        start_name = f"operations.{package.key.kind}.start"
        start_handler = _registered_start_handler(package)
        definitions.append(
            _registered_tool(
                _spec(
                    name=start_name,
                    description=f"Start or reattach to one durable {package.title.lower()} operation.",
                    inputs=start_contract.request_model.model_json_schema(),
                    outputs=snapshot_schema,
                    capabilities=sorted(start_contract.required_capabilities),
                    effect=ToolEffect.MUTATING,
                    shape=ToolShape.ADAPTER,
                    handler_ref=(
                        f"src.managed_operation_agent_tools.{start_handler.__name__}"
                    ),
                    idempotency_keyable=True,
                ),
                start_handler,
                audit_parameter_projector=start_contract.audit_parameters,
            )
        )
        if package.recorded_import is None:
            continue
        import_handler = _registered_import_handler(package)
        definitions.append(
            _registered_tool(
                _spec(
                    name=f"operations.{package.key.kind}.import_recorded",
                    description=f"Retain a validated successful standalone {package.title.lower()} receipt without rerunning it.",
                    inputs=package.recorded_import.request_model.model_json_schema(),
                    outputs=snapshot_schema,
                    capabilities=sorted(package.recorded_import.required_capabilities),
                    effect=ToolEffect.MUTATING,
                    shape=ToolShape.ADAPTER,
                    handler_ref=(
                        f"src.managed_operation_agent_tools.{import_handler.__name__}"
                    ),
                    idempotency_keyable=True,
                ),
                import_handler,
                audit_parameter_projector=package.recorded_import.audit_parameters,
            )
        )
    return tuple(definitions)


def register_managed_operation_agent_tools(
    system: CompiledOperationSystem,
    *,
    registry: AgentToolRegistry = agent_tool_registry,
    replace_existing: bool = False,
) -> None:
    definitions = managed_operation_tool_definitions(system)
    generated_handlers: dict[str, ToolHandler] = {}
    module_prefix = f"{__name__}."
    for definition in definitions:
        handler = definition.handler
        handler_ref = definition.spec.handler_ref
        if handler is None or not handler_ref.startswith(module_prefix):
            continue
        attribute = handler_ref.removeprefix(module_prefix)
        if attribute != handler.__name__:
            raise ValueError(
                f"Managed operation handler reference {handler_ref!r} does not match "
                f"callable {handler.__name__!r}"
            )
        if attribute.startswith(("start_managed_", "import_recorded_managed_")):
            generated_handlers[attribute] = handler

    registry.register_many(definitions, replace_existing=replace_existing)
    globals().update(generated_handlers)


def managed_annotation_tool_definitions() -> (
    tuple[tuple[DNAForgeTool, ToolHandler], ...]
):
    definitions = managed_operation_tool_definitions(MANAGED_OPERATION_SYSTEM)
    return tuple(
        (definition.spec, definition.handler)
        for definition in definitions
        if definition.handler is not None
    )


def register_managed_annotation_agent_tools() -> None:
    register_managed_operation_agent_tools(
        MANAGED_OPERATION_SYSTEM,
        replace_existing=True,
    )
