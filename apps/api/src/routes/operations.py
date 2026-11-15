"""Typed human-client routes over the same owner used by authorized agent tools."""

from __future__ import annotations

import hashlib
import os
from contextlib import contextmanager
from typing import Annotated, Any, Iterator, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse
from starlette.responses import JSONResponse
from typing_extensions import TypeAliasType

from ..annotation_document_contract import (
    AnnotationDocumentSelection,
    AnnotationDocumentTarget,
)
from ..annotation_document_responses import (
    AnnotationDocumentApplyResponse,
    AnnotationDocumentInspection,
)
from ..concurrency.job_manager import ACTIVE_JOB_STATUSES, JobRecord, get_job_manager
from ..control_plane import get_control_plane_store
from ..managed_annotation_document_actions import ManagedAnnotationDocumentActions
from ..managed_annotation_documents import (
    ManagedAnnotationDocuments,
    NativeDocumentConnectionUnavailable,
    NativeDocumentInspectionUnavailable,
)
from ..managed_operations import MANAGED_OPERATION_SYSTEM
from ..operations import (
    ActorKind,
    ClientChannel,
    ManagedOperationError,
    ManagedOperationService,
    OperationAccessDenied,
    OperationActionPage,
    OperationCancelResponse,
    OperationEvent,
    OperationNotFound,
    OperationPrincipal,
    OperationQueueFull,
    OperationReleaseResponse,
    OperationResultEnvelope,
    OperationResultStorageFull,
    OperationResultTooLarge,
    OperationSnapshot,
    SubmissionConflict,
)
from ..operations.registration import ExecutableOperationKind
from ..operations.surfaces import install_registered_operation_kind_routes
from ..security.native_document_authority import NativeDocumentAuthority
from ..security.operation_authority import require_human_operation_authority


class OperationValidationErrorDetail(BaseModel):
    code: Literal["INVALID_OPERATION_REQUEST"]
    message: Literal["The operation request is invalid."]


class OperationValidationErrorResponse(BaseModel):
    detail: OperationValidationErrorDetail


OPERATION_VALIDATION_ERROR_RESPONSE = OperationValidationErrorResponse(
    detail=OperationValidationErrorDetail(
        code="INVALID_OPERATION_REQUEST",
        message="The operation request is invalid.",
    )
).model_dump(mode="json")


class AgentJobIdentity(BaseModel):
    id: str
    label: str | None = None
    kind: str | None = None


class AgentJobSummary(BaseModel):
    id: str
    tool_name: str
    duration: Literal["long-running", "streaming"]
    pool: str
    state: Literal[
        "queued", "running", "succeeded", "failed", "canceled", "interrupted"
    ]
    cancelable: bool
    can_cancel: bool
    requested_at: str
    completed_at: str | None = None
    error_code: str | None = None
    agent_identity: AgentJobIdentity


class AgentJobCollection(BaseModel):
    jobs: list[AgentJobSummary]
    job_count: int = Field(ge=0)
    active_count: int = Field(ge=0)
    terminal_count: int = Field(ge=0)
    history_complete: bool


class SanitizedOperationRoute(APIRoute):
    def get_route_handler(self):
        route_handler = super().get_route_handler()

        async def sanitized_route_handler(request: Request):
            try:
                return await route_handler(request)
            except RequestValidationError:
                return JSONResponse(
                    status_code=422,
                    content=OPERATION_VALIDATION_ERROR_RESPONSE,
                )

        return sanitized_route_handler


router = APIRouter(
    prefix="/operations",
    tags=["Operations"],
    dependencies=[Depends(require_human_operation_authority)],
    route_class=SanitizedOperationRoute,
    responses={422: {"model": OperationValidationErrorResponse}},
)
OperationKindName = MANAGED_OPERATION_SYSTEM.kind_literal
ExecutableOperationKindName = MANAGED_OPERATION_SYSTEM.executable_kind_literal


def operation_scope_id() -> str:
    for variable in ("DNAFORGE_OPERATION_SCOPE", "DNAFORGE_SIDECAR_ENVIRONMENT_ID"):
        configured = os.environ.get(variable, "").strip()
        if configured:
            return configured

    if os.environ.get("DNAFORGE_HUMAN_OPERATION_TOKEN", "").strip():
        return "local-runtime"
    session_token = os.environ.get("DNAFORGE_MCP_SESSION_TOKEN", "").strip()
    if session_token:
        digest = hashlib.sha256(session_token.encode("utf-8")).hexdigest()[:20]
        return f"local-session-{digest}"
    return f"local-process-{os.getpid()}"


def operation_owner_id() -> str:
    return os.environ.get("DNAFORGE_OPERATION_OWNER_ID", "local-human")


def human_principal(request: Request) -> OperationPrincipal:
    channel = request.headers.get("X-DNAForge-Operation-Channel", "desktop_ui")
    if channel not in {ClientChannel.DESKTOP_UI.value, ClientChannel.MANAGED_CLI.value}:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "INVALID_OPERATION_CHANNEL",
                "message": "Use desktop_ui or managed_cli for a human connection.",
            },
        )
    return OperationPrincipal(
        actor_kind=ActorKind.HUMAN,
        actor_id=operation_owner_id(),
        channel=ClientChannel(channel),
        scope_ids={operation_scope_id()},
    )


def operation_owner(
    request: Request,
) -> ManagedOperationService[Any, Any]:
    service = getattr(request.app.state, "managed_operations", None)
    if service is None:
        service = getattr(request.app.state, "managed_annotation_operations", None)
    if not isinstance(service, ManagedOperationService):
        raise HTTPException(
            status_code=503,
            detail={
                "code": "OPERATION_RUNTIME_UNAVAILABLE",
                "message": "The managed operation runtime is unavailable.",
            },
        )
    return service


def _agent_job_state(row: dict[str, Any], live: JobRecord | None) -> tuple[
    Literal["queued", "running", "succeeded", "failed", "canceled", "interrupted"],
    str | None,
]:
    error = row.get("error_json")
    error_code = error.get("code") if isinstance(error, dict) else None
    if live is not None and live.status in ACTIVE_JOB_STATUSES:
        return "running" if live.status == "stopping" else live.status, error_code
    if error_code == "OUTCOME_UNRESOLVED":
        return "interrupted", error_code
    if error_code == "CANCELED":
        return "canceled", error_code
    if error is not None:
        return "failed", error_code
    if row.get("completed_at"):
        return "succeeded", None
    return "interrupted", "OUTCOME_UNRESOLVED"


def _agent_job_summary(row: dict[str, Any]) -> AgentJobSummary:
    live = get_job_manager().get_live_owner(str(row["id"]))
    state, error_code = _agent_job_state(row, live)
    active = state in {"queued", "running"}
    return AgentJobSummary(
        id=str(row["id"]),
        tool_name=str(row["tool_name"]),
        duration=row["job_duration"],
        pool=str(row["job_pool"]),
        state=state,
        cancelable=bool(row.get("job_cancelable")),
        can_cancel=bool(active and live is not None and live.cancelable),
        requested_at=str(row["requested_at"]),
        completed_at=(
            str(row["completed_at"]) if row.get("completed_at") is not None else None
        ),
        error_code=error_code,
        agent_identity=AgentJobIdentity(
            id=str(row["agent_identity_id"]),
            label=(str(row["agent_label"]) if row.get("agent_label") else None),
            kind=(str(row["agent_kind"]) if row.get("agent_kind") else None),
        ),
    )


@router.get("/agent-jobs", response_model=AgentJobCollection)
async def list_agent_jobs(
    limit: int = Query(default=100, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> AgentJobCollection:
    (
        rows,
        total,
        active_count,
        terminal_count,
        next_offset,
    ) = get_control_plane_store().page_visible_agent_jobs(
        parent_human_identity_id=operation_owner_id(),
        environment_id=operation_scope_id(),
        limit=limit,
        offset=offset,
    )
    jobs = [_agent_job_summary(row) for row in rows]
    return AgentJobCollection(
        jobs=jobs,
        job_count=total,
        active_count=active_count,
        terminal_count=terminal_count,
        history_complete=next_offset is None and offset + len(jobs) == total,
    )


@router.delete("/agent-jobs/{job_id}", status_code=204)
async def cancel_agent_job(job_id: str) -> Response:
    row = get_control_plane_store().get_visible_agent_job(
        job_id,
        parent_human_identity_id=operation_owner_id(),
        environment_id=operation_scope_id(),
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Unknown agent job")
    live = get_job_manager().get_live_owner(job_id)
    state, _error_code = _agent_job_state(row, live)
    if state not in {"queued", "running"}:
        return Response(status_code=204)
    if live is None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "AGENT_JOB_OWNER_UNAVAILABLE",
                "message": "The agent job no longer has a live execution owner.",
            },
        )
    if not live.cancelable:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "AGENT_JOB_NOT_CANCELABLE",
                "message": "This agent job does not support cancellation.",
            },
        )
    await get_job_manager().cancel(job_id)
    return Response(status_code=204)


@contextmanager
def operation_errors() -> Iterator[None]:
    try:
        yield
    except (
        NativeDocumentConnectionUnavailable,
        NativeDocumentInspectionUnavailable,
    ) as exc:
        raise HTTPException(
            status_code=(
                503 if isinstance(exc, NativeDocumentConnectionUnavailable) else 502
            ),
            detail={
                "code": exc.code,
                "message": str(exc),
                **(
                    {"reasonCode": exc.reason_code}
                    if isinstance(exc, NativeDocumentInspectionUnavailable)
                    else {}
                ),
            },
        ) from exc
    except ManagedOperationError as exc:
        status_code = (
            404
            if isinstance(exc, OperationNotFound)
            else (
                403
                if isinstance(exc, OperationAccessDenied)
                else (
                    429
                    if isinstance(exc, OperationQueueFull)
                    else (
                        507
                        if isinstance(exc, OperationResultStorageFull)
                        else (
                            413
                            if isinstance(exc, OperationResultTooLarge)
                            else 409 if isinstance(exc, SubmissionConflict) else 409
                        )
                    )
                )
            )
        )
        raise HTTPException(
            status_code=status_code,
            detail={"code": exc.code, "message": str(exc) or exc.code},
        ) from exc


def annotation_documents(request: Request) -> ManagedAnnotationDocuments:
    native = getattr(request.app.state, "native_document_authority", None)
    authority = native if isinstance(native, NativeDocumentAuthority) else None
    return ManagedAnnotationDocuments(
        actions=ManagedAnnotationDocumentActions(
            service=operation_owner(request),
            native_owner_instance_id=authority.owner_instance_id if authority else "",
        ),
        authority=authority,
    )


@router.post(
    "/annotation/documents/inspect",
    response_model=AnnotationDocumentInspection,
    response_model_exclude_none=True,
)
async def inspect_annotation_document(
    request: Request, body: AnnotationDocumentTarget
) -> AnnotationDocumentInspection:
    with operation_errors():
        return await annotation_documents(request).inspect(
            human_principal(request), body
        )


@router.post(
    "/annotation/documents/apply",
    response_model=AnnotationDocumentApplyResponse,
    response_model_exclude_none=True,
)
async def apply_annotation_document(
    request: Request, body: AnnotationDocumentSelection
) -> AnnotationDocumentApplyResponse:
    with operation_errors():
        return await annotation_documents(request).apply(human_principal(request), body)


class OperationKindSurfaceDescription(BaseModel):
    http_start: str | None = None
    http_import_recorded: str | None = None
    cli_submit: str | None = None
    cli_import_recorded: str | None = None
    agent_start: str | None = None
    agent_import_recorded: str | None = None


class OperationKindDescriptionBase(BaseModel):
    title: str
    contract_version: int = Field(ge=1)
    result_schema_version: int = Field(ge=1)
    executable: bool
    active_join: Literal["none", "subject_revision"] = "none"
    result_schema: dict[str, Any]
    agent_input_schema: dict[str, Any] | None = None
    recorded_import_schema: dict[str, Any] | None = None
    start_capabilities: list[str]
    agent_start_capabilities: list[str] = Field(default_factory=list)
    recorded_import_capabilities: list[str]
    actions: list[str]
    surfaces: OperationKindSurfaceDescription


class ExecutableOperationKindDescription(OperationKindDescriptionBase):
    registration: Literal["executable"]
    executable: Literal[True]
    kind: ExecutableOperationKindName  # type: ignore[valid-type]
    input_schema: dict[str, Any]


class HistoryOnlyOperationKindDescription(OperationKindDescriptionBase):
    registration: Literal["history_only"]
    executable: Literal[False]
    kind: str
    input_schema: None = None
    recorded_import_schema: None = None


OperationKindDescription = TypeAliasType(
    "OperationKindDescription",
    Annotated[
        ExecutableOperationKindDescription | HistoryOnlyOperationKindDescription,
        Field(discriminator="registration"),
    ],
)


class OperationCatalog(BaseModel):
    scope_id: str
    owner_id: str
    owner_instance_id: str
    kinds: list[OperationKindDescription]


class OperationList(BaseModel):
    operations: list[OperationSnapshot]
    total: int = Field(ge=0)
    next_offset: int | None = None


class OperationInitial(BaseModel):
    operations: list[OperationSnapshot]
    operation_count: int = Field(ge=0)
    active_count: int = Field(ge=0)
    terminal_count: int = Field(ge=0)
    history_complete: bool


class OperationEventStream(EventSourceResponse):
    media_type = "text/event-stream"


@router.get("/catalog", response_model=OperationCatalog)
def discover_operations(request: Request) -> OperationCatalog:
    service = operation_owner(request)
    return OperationCatalog(
        scope_id=operation_scope_id(),
        owner_id=operation_owner_id(),
        owner_instance_id=service.owner_instance_id,
        kinds=[
            (
                ExecutableOperationKindDescription
                if descriptor.executable
                else HistoryOnlyOperationKindDescription
            )(
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
                actions=list(descriptor.actions),
                surfaces=OperationKindSurfaceDescription(
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
    )


@router.get("", response_model=OperationList)
def list_operations(
    request: Request,
    scope_id: str | None = None,
    subject_id: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> OperationList:
    with operation_errors():
        page = operation_owner(request).list_page(
            human_principal(request),
            scope_id=scope_id or operation_scope_id(),
            subject_id=subject_id,
            limit=limit,
            offset=offset,
        )
    return OperationList(
        operations=page.operations,
        total=page.total,
        next_offset=page.next_offset,
    )


@router.get(
    "/events",
    response_class=OperationEventStream,
    response_model=OperationInitial | OperationEvent,
    description=(
        "Server-sent events. The initial event's JSON data uses OperationInitial; "
        "subsequent snapshot and control event data uses OperationEvent. "
        "The HTTP response is an event stream, not a single JSON document."
    ),
)
async def observe_operations(request: Request, scope_id: str | None = None):
    with operation_errors():
        subscription = await operation_owner(request).subscribe(
            human_principal(request), scope_id=scope_id or operation_scope_id()
        )

    async def events():
        try:
            initial = OperationInitial(
                operations=list(subscription.initial),
                operation_count=subscription.operation_count,
                active_count=subscription.active_count,
                terminal_count=subscription.terminal_count,
                history_complete=subscription.history_complete,
            )
            yield {"event": "initial", "data": initial.model_dump_json()}
            async for event in subscription:
                yield {"event": event.kind, "data": event.model_dump_json()}
                if event.kind != "snapshot":
                    return
        finally:
            subscription.close()

    return OperationEventStream(events())


async def start_registered_operation(
    request: Request,
    package: ExecutableOperationKind,
    body: BaseModel,
) -> OperationSnapshot:
    with operation_errors():
        return await operation_owner(request).start(
            human_principal(request),
            package.start.prepare(body),
            kind=package.key.kind,
        )


async def import_registered_operation(
    request: Request,
    package: ExecutableOperationKind,
    body: BaseModel,
) -> OperationSnapshot:
    if package.recorded_import is None:
        raise RuntimeError("registered import route has no import contract")
    with operation_errors():
        return await operation_owner(request).import_recorded(
            human_principal(request),
            body,
            kind=package.key.kind,
        )


install_registered_operation_kind_routes(
    router,
    MANAGED_OPERATION_SYSTEM,
    start=start_registered_operation,
    import_recorded=import_registered_operation,
)


@router.get("/{operation_id}", response_model=OperationSnapshot)
def get_operation(request: Request, operation_id: str) -> OperationSnapshot:
    with operation_errors():
        return operation_owner(request).get(human_principal(request), operation_id)


@router.get(
    "/{operation_id}/result", response_model=MANAGED_OPERATION_SYSTEM.result_envelope
)
def get_operation_result(
    request: Request, operation_id: str
) -> OperationResultEnvelope:
    with operation_errors():
        return operation_owner(request).get_result(
            human_principal(request), operation_id
        )


@router.get("/{operation_id}/actions", response_model=OperationActionPage)
def list_operation_actions(
    request: Request,
    operation_id: str,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> OperationActionPage:
    with operation_errors():
        return operation_owner(request).list_actions_page(
            human_principal(request),
            operation_id,
            limit=limit,
            offset=offset,
        )


@router.post("/{operation_id}/cancel", response_model=OperationCancelResponse)
async def request_operation_cancel(
    request: Request,
    operation_id: str,
) -> OperationCancelResponse:
    with operation_errors():
        return await operation_owner(request).request_cancel(
            human_principal(request), operation_id
        )


@router.post(
    "/{operation_id}/release-result",
    response_model=OperationReleaseResponse,
)
async def release_operation_result(
    request: Request,
    operation_id: str,
) -> OperationReleaseResponse:
    with operation_errors():
        return await operation_owner(request).release_result(
            human_principal(request), operation_id
        )
