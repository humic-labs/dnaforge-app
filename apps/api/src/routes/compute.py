"""`/compute/*` routes — hosted bioinformatics compute endpoints .


Trust model, same as `/external/*`:

- `X-DNAForge-Session` is the loopback trust boundary (`mcp_auth.check_session`).
- Requested capabilities in the body are clamped to the server-side session
  grant; the route then checks the operation's required scope
  (`external-compute:discover` for everything read-only,
  `external-compute:submit` for submit).
- The USER's provider key arrives in `X-DNAForge-Compute-Credential`, injected
  by the desktop main process from the OS keychain. It is wrapped in a redacting
  `ProviderCredential` immediately, never logged, never stored, never echoed.

Every route is POST with a JSON body so the audit shape matches the other
sidecar-routed tools (action id + granted capabilities in the body).
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, JsonValue

from ..capability_policy import has_required_capabilities
from ..compute.contract import (
    BadCredentialError,
    BudgetExhaustedError,
    ComputeOperation,
    ComputeProviderError,
    ComputeRateLimitError,
    InvalidJobSettingsError,
    MappedToolMissingError,
    ProviderJobRef,
    ProviderUnavailableError,
    SubmitRequest,
    UnknownJobError,
    capability_for,
)
from ..compute.manifests import ManifestError, parse_manifest
from ..compute.service import (
    REST_DRIVER_BINDINGS,
    ComputeCircuitOpen,
    ComputeService,
    UnknownComputeProvider,
)
from .mcp_auth import (
    check_session,
    effective_capabilities_for_session_request,
    session_grant_capabilities,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/compute", tags=["Compute Endpoints"])

CREDENTIAL_HEADER = "X-DNAForge-Compute-Credential"

_service: ComputeService | None = None


def set_service(service: ComputeService | None) -> None:
    global _service
    _service = service


def _service_or_raise() -> ComputeService:
    if _service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "compute_service_unavailable"},
        )
    return _service


def _enforce_session(session_token: str | None) -> None:
    err = check_session(session_token)
    if err is None:
        return
    error = err["error"]
    code = error.get("code", "BAD_SESSION")
    status_code = (
        status.HTTP_500_INTERNAL_SERVER_ERROR
        if code == "MCP_SESSION_NOT_CONFIGURED"
        else status.HTTP_401_UNAUTHORIZED
    )
    raise HTTPException(status_code=status_code, detail=error)


def _require_capability(requested: list[str], operation: ComputeOperation) -> None:
    required = [capability_for(operation)]
    effective = effective_capabilities_for_session_request(requested)
    if not has_required_capabilities(effective, required):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "capability_denied",
                "required": required,
                "granted": effective,
            },
        )
    grant = session_grant_capabilities()
    if grant is not None and not has_required_capabilities(grant, required):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "capability_denied",
                "required": required,
                "granted": grant,
            },
        )


def _credential(service: ComputeService, provider_id: str, header_value: str | None):
    if not header_value or not header_value.strip():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": "missing_credential",
                "provider": provider_id,
                "header": CREDENTIAL_HEADER,
            },
        )
    try:
        return service.credential_for(provider_id, header_value.strip())
    except UnknownComputeProvider as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "unknown_provider", "provider": provider_id},
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "bad_credential_format", "message": str(exc)},
        ) from exc


def _http_from_compute_error(
    exc: ComputeProviderError, provider_id: str
) -> HTTPException:
    """Typed error → HTTP. The detail `error` field is the stable failure kind the
    renderer renders in plain language; the message is provider wording."""
    detail: dict[str, Any] = {
        "error": exc.failure_kind,
        "provider": provider_id,
        "message": str(exc),
    }
    if isinstance(exc, BadCredentialError):
        return HTTPException(status.HTTP_401_UNAUTHORIZED, detail)
    if isinstance(exc, BudgetExhaustedError):
        return HTTPException(status.HTTP_402_PAYMENT_REQUIRED, detail)
    if isinstance(exc, ComputeRateLimitError):
        detail["retry_after_s"] = exc.retry_after_s
        return HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail)
    if isinstance(exc, ComputeCircuitOpen):
        detail["retry_after_s"] = exc.opens_at_s
        return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail)
    if isinstance(exc, ProviderUnavailableError):
        return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail)
    if isinstance(exc, MappedToolMissingError):
        detail["operation"] = exc.operation.value
        detail["remote_tool"] = exc.remote_tool
        return HTTPException(status.HTTP_502_BAD_GATEWAY, detail)
    if isinstance(exc, InvalidJobSettingsError):
        detail["problems"] = list(exc.problems)
        return HTTPException(status.HTTP_400_BAD_REQUEST, detail)
    if isinstance(exc, UnknownJobError):
        return HTTPException(status.HTTP_404_NOT_FOUND, detail)
    return HTTPException(status.HTTP_502_BAD_GATEWAY, detail)


class ComputeRequestBase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    granted_capabilities: list[str] = Field(default_factory=list)
    action_id: str | None = Field(
        default=None, description="Renderer action id for audit correlation"
    )


class ProviderPublicModel(BaseModel):
    id: str
    display_name: str
    summary: str
    transport: Literal["mcp", "rest"]
    driver: str
    custom: bool
    auth_scheme: Literal["header", "bearer", "oauth"]
    credential_header: str | None
    endpoint_url: str
    verify_target: str
    catalog: str
    job_model: str
    cost: str
    disclosure: str
    retention_note: str
    cancellation_mode: Literal["provider", "unavailable"]
    cancellation_note: str
    docs_url: str
    key_page_url: str | None
    terms_url: str
    privacy_url: str
    has_binding: bool


class ProvidersResponse(BaseModel):
    providers: list[ProviderPublicModel]


class ValidateManifestRequest(ComputeRequestBase):
    manifest: dict[str, JsonValue]


class ListToolsRequest(ComputeRequestBase):
    search: str | None = Field(default=None, max_length=200)
    tags: list[str] = Field(default_factory=list, max_length=20)


class ToolDescriptorModel(BaseModel):
    id: str
    display_name: str
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    output_kind: str | None = None


class ListToolsResponse(BaseModel):
    provider: str
    tools: list[ToolDescriptorModel]


class ToolRequest(ComputeRequestBase):
    tool_id: str = Field(min_length=1, max_length=128)


class SchemaResponse(BaseModel):
    provider: str
    tool_id: str
    schema_: dict[str, JsonValue] = Field(alias="schema")
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class SettingsRequest(ToolRequest):
    settings: dict[str, JsonValue] = Field(default_factory=dict)


class ValidateResponse(BaseModel):
    provider: str
    tool_id: str
    ok: bool
    problems: list[str]


class EstimateResponse(BaseModel):
    provider: str
    tool_id: str
    amount: float | None
    unit: str
    estimated_seconds: float | None
    note: str
    known: bool


class SubmitRequestModel(SettingsRequest):
    label: str | None = Field(default=None, max_length=120)
    idempotency_key: str | None = Field(default=None, max_length=128)

    files: dict[str, str] = Field(default_factory=dict)


class JobRefModel(BaseModel):
    provider: str
    remote_id: str
    tool_id: str
    artifact_refs: list[str] = Field(default_factory=list)


class JobRefRequest(ComputeRequestBase):
    remote_id: str = Field(min_length=1, max_length=256)
    tool_id: str = Field(min_length=1, max_length=128)


class JobStatusResponse(BaseModel):
    ref: JobRefModel
    state: Literal["queued", "running", "completed", "failed", "canceled"]
    provider_state: str
    progress_note: str
    cost_amount: float | None
    cost_unit: str | None
    terminal: bool


class ResultFileModel(BaseModel):
    name: str
    media_type: str
    size_bytes: int | None

    content: str | None
    url: str | None


class ResultResponse(BaseModel):
    ref: JobRefModel
    output_kind: str
    files: list[ResultFileModel]
    metrics: dict[str, JsonValue]
    provenance: dict[str, str]
    provider_request: dict[str, JsonValue] | None = None


class VerifyResponse(BaseModel):
    provider: str
    ok: bool
    tool_count: int


def _ref_model(ref: ProviderJobRef) -> JobRefModel:
    return JobRefModel(
        provider=ref.provider_id,
        remote_id=ref.remote_id,
        tool_id=ref.tool_id,
        artifact_refs=list(ref.artifact_refs),
    )


@router.get(
    "/providers",
    response_model=ProvidersResponse,
    summary=": list compute providers (manifests, no secrets)",
)
async def list_providers(
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> ProvidersResponse:
    _enforce_session(x_dnaforge_session)
    service = _service_or_raise()
    return ProvidersResponse(
        providers=[
            ProviderPublicModel(
                **m.public_view(), has_binding=service.has_binding(m.id)
            )
            for m in service.manifests()
        ]
    )


@router.post(
    "/providers/validate-manifest",
    response_model=ProviderPublicModel,
    summary="Validate an untrusted custom compute manifest without installing it",
)
async def validate_manifest(
    body: ValidateManifestRequest,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> ProviderPublicModel:
    _enforce_session(x_dnaforge_session)
    _require_capability(body.granted_capabilities, ComputeOperation.LIST_TOOLS)
    service = _service_or_raise()
    try:
        manifest = parse_manifest(body.manifest, source="user")
    except (ManifestError, KeyError, TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "invalid_compute_manifest", "message": str(exc)},
        ) from exc
    if manifest.schema_version != 2:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "invalid_compute_manifest",
                "message": "custom manifests must use schemaVersion 2",
            },
        )
    try:
        service.manifest(manifest.id)
    except UnknownComputeProvider:
        pass
    else:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "provider_id_conflict", "provider": manifest.id},
        )
    has_binding = (
        manifest.driver_kind == "mcp-tool-map"
        or manifest.driver_kind in REST_DRIVER_BINDINGS
    )
    if not has_binding:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "unsupported_compute_driver",
                "driver": manifest.driver_kind,
            },
        )
    return ProviderPublicModel(**manifest.public_view(), has_binding=True)


@router.post(
    "/{provider_id}/verify",
    response_model=VerifyResponse,
    summary=": prove a pasted key works (read-only, never saved here)",
)
async def verify_credential(
    provider_id: str,
    body: ComputeRequestBase,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
    x_dnaforge_compute_credential: str | None = Header(
        default=None, alias=CREDENTIAL_HEADER
    ),
) -> VerifyResponse:
    _enforce_session(x_dnaforge_session)
    _require_capability(body.granted_capabilities, ComputeOperation.LIST_TOOLS)
    service = _service_or_raise()
    credential = _credential(service, provider_id, x_dnaforge_compute_credential)
    try:
        tools = await service.verify_credential(provider_id, credential)
    except ComputeProviderError as exc:
        raise _http_from_compute_error(exc, provider_id) from exc
    return VerifyResponse(provider=provider_id, ok=True, tool_count=len(tools))


@router.post(
    "/{provider_id}/tools",
    response_model=ListToolsResponse,
    summary=": list a provider's tools",
)
async def list_tools(
    provider_id: str,
    body: ListToolsRequest,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
    x_dnaforge_compute_credential: str | None = Header(
        default=None, alias=CREDENTIAL_HEADER
    ),
) -> ListToolsResponse:
    _enforce_session(x_dnaforge_session)
    _require_capability(body.granted_capabilities, ComputeOperation.LIST_TOOLS)
    service = _service_or_raise()
    credential = _credential(service, provider_id, x_dnaforge_compute_credential)
    try:
        tools = await service.list_tools(
            provider_id, credential, search=body.search, tags=tuple(body.tags)
        )
    except ComputeProviderError as exc:
        raise _http_from_compute_error(exc, provider_id) from exc
    return ListToolsResponse(
        provider=provider_id,
        tools=[
            ToolDescriptorModel(
                id=t.id,
                display_name=t.display_name,
                description=t.description,
                tags=list(t.tags),
                output_kind=t.output_kind.value if t.output_kind else None,
            )
            for t in tools
        ],
    )


@router.post(
    "/{provider_id}/schema",
    response_model=SchemaResponse,
    response_model_by_alias=True,
    summary=": a tool's settings schema",
)
async def get_schema(
    provider_id: str,
    body: ToolRequest,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
    x_dnaforge_compute_credential: str | None = Header(
        default=None, alias=CREDENTIAL_HEADER
    ),
) -> SchemaResponse:
    _enforce_session(x_dnaforge_session)
    _require_capability(body.granted_capabilities, ComputeOperation.GET_SCHEMA)
    service = _service_or_raise()
    credential = _credential(service, provider_id, x_dnaforge_compute_credential)
    try:
        schema = await service.get_schema(provider_id, credential, body.tool_id)
    except ComputeProviderError as exc:
        raise _http_from_compute_error(exc, provider_id) from exc
    return SchemaResponse(
        provider=provider_id, tool_id=body.tool_id, schema=dict(schema)
    )


@router.post(
    "/{provider_id}/validate",
    response_model=ValidateResponse,
    summary=": validate settings before spending",
)
async def validate_settings(
    provider_id: str,
    body: SettingsRequest,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
    x_dnaforge_compute_credential: str | None = Header(
        default=None, alias=CREDENTIAL_HEADER
    ),
) -> ValidateResponse:
    _enforce_session(x_dnaforge_session)
    _require_capability(body.granted_capabilities, ComputeOperation.VALIDATE)
    service = _service_or_raise()
    credential = _credential(service, provider_id, x_dnaforge_compute_credential)
    try:
        result = await service.validate(
            provider_id, credential, body.tool_id, body.settings
        )
    except ComputeProviderError as exc:
        raise _http_from_compute_error(exc, provider_id) from exc
    return ValidateResponse(
        provider=provider_id,
        tool_id=body.tool_id,
        ok=result.ok,
        problems=list(result.problems),
    )


@router.post(
    "/{provider_id}/estimate",
    response_model=EstimateResponse,
    summary=": estimate cost before spending",
)
async def estimate_cost(
    provider_id: str,
    body: SettingsRequest,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
    x_dnaforge_compute_credential: str | None = Header(
        default=None, alias=CREDENTIAL_HEADER
    ),
) -> EstimateResponse:
    _enforce_session(x_dnaforge_session)
    _require_capability(body.granted_capabilities, ComputeOperation.ESTIMATE)
    service = _service_or_raise()
    credential = _credential(service, provider_id, x_dnaforge_compute_credential)
    try:
        est = await service.estimate(
            provider_id, credential, body.tool_id, body.settings
        )
    except ComputeProviderError as exc:
        raise _http_from_compute_error(exc, provider_id) from exc
    return EstimateResponse(
        provider=provider_id,
        tool_id=body.tool_id,
        amount=est.amount,
        unit=est.unit,
        estimated_seconds=est.estimated_seconds,
        note=est.note,
        known=est.is_known(),
    )


@router.post(
    "/{provider_id}/submit",
    response_model=JobRefModel,
    summary=": submit a job (SPENDS the user's provider budget)",
)
async def submit_job(
    provider_id: str,
    body: SubmitRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
    x_dnaforge_compute_credential: str | None = Header(
        default=None, alias=CREDENTIAL_HEADER
    ),
) -> JobRefModel:
    _enforce_session(x_dnaforge_session)
    _require_capability(body.granted_capabilities, ComputeOperation.SUBMIT)
    service = _service_or_raise()
    credential = _credential(service, provider_id, x_dnaforge_compute_credential)
    request = SubmitRequest(
        tool_id=body.tool_id,
        settings=body.settings,
        files={name: text.encode("utf-8") for name, text in body.files.items()},
        idempotency_key=body.idempotency_key,
        label=body.label,
    )
    try:
        ref = await service.submit(provider_id, credential, request)
    except ComputeProviderError as exc:
        raise _http_from_compute_error(exc, provider_id) from exc
    logger.info(
        "compute.%s.submit tool=%s remote_id=%s action=%s",
        provider_id,
        ref.tool_id,
        ref.remote_id,
        body.action_id,
    )
    return _ref_model(ref)


@router.post(
    "/{provider_id}/status",
    response_model=JobStatusResponse,
    summary=": job status",
)
async def job_status(
    provider_id: str,
    body: JobRefRequest,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
    x_dnaforge_compute_credential: str | None = Header(
        default=None, alias=CREDENTIAL_HEADER
    ),
) -> JobStatusResponse:
    _enforce_session(x_dnaforge_session)
    _require_capability(body.granted_capabilities, ComputeOperation.STATUS)
    service = _service_or_raise()
    credential = _credential(service, provider_id, x_dnaforge_compute_credential)
    ref = ProviderJobRef(provider_id, body.remote_id, body.tool_id)
    try:
        st = await service.status(provider_id, credential, ref)
    except ComputeProviderError as exc:
        raise _http_from_compute_error(exc, provider_id) from exc
    return JobStatusResponse(
        ref=_ref_model(st.ref),
        state=st.state.value,
        provider_state=st.provider_state,
        progress_note=st.progress_note,
        cost_amount=st.cost.amount if st.cost else None,
        cost_unit=st.cost.unit if st.cost else None,
        terminal=st.is_terminal(),
    )


@router.post(
    "/{provider_id}/result",
    response_model=ResultResponse,
    summary=": fetch a finished job's result",
)
async def job_result(
    provider_id: str,
    body: JobRefRequest,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
    x_dnaforge_compute_credential: str | None = Header(
        default=None, alias=CREDENTIAL_HEADER
    ),
) -> ResultResponse:
    _enforce_session(x_dnaforge_session)
    _require_capability(body.granted_capabilities, ComputeOperation.FETCH_RESULT)
    service = _service_or_raise()
    credential = _credential(service, provider_id, x_dnaforge_compute_credential)
    ref = ProviderJobRef(provider_id, body.remote_id, body.tool_id)
    try:
        bundle = await service.fetch_result(provider_id, credential, ref)
    except ComputeProviderError as exc:
        raise _http_from_compute_error(exc, provider_id) from exc
    return ResultResponse(
        ref=_ref_model(bundle.ref),
        output_kind=bundle.output_kind.value,
        files=[
            ResultFileModel(
                name=f.name,
                media_type=f.media_type,
                size_bytes=f.size_bytes,
                content=(
                    f.content.decode("utf-8", "replace")
                    if f.content is not None
                    else None
                ),
                url=f.url,
            )
            for f in bundle.files
        ],
        metrics=dict(bundle.metrics),
        provenance=dict(bundle.provenance),
        provider_request=(
            dict(bundle.provider_request)
            if bundle.provider_request is not None
            else None
        ),
    )


@router.post(
    "/{provider_id}/cancel",
    response_model=JobStatusResponse,
    summary=": cancel a job",
)
async def cancel_job(
    provider_id: str,
    body: JobRefRequest,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
    x_dnaforge_compute_credential: str | None = Header(
        default=None, alias=CREDENTIAL_HEADER
    ),
) -> JobStatusResponse:
    _enforce_session(x_dnaforge_session)
    _require_capability(body.granted_capabilities, ComputeOperation.CANCEL)
    service = _service_or_raise()
    credential = _credential(service, provider_id, x_dnaforge_compute_credential)
    ref = ProviderJobRef(provider_id, body.remote_id, body.tool_id)
    try:
        st = await service.cancel(provider_id, credential, ref)
    except ComputeProviderError as exc:
        raise _http_from_compute_error(exc, provider_id) from exc
    return JobStatusResponse(
        ref=_ref_model(st.ref),
        state=st.state.value,
        provider_state=st.provider_state,
        progress_note=st.progress_note,
        cost_amount=None,
        cost_unit=None,
        terminal=st.is_terminal(),
    )
