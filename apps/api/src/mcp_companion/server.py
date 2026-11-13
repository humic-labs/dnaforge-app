"""Official SDK low-level server for DNAForge's scoped MCP projection."""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
from collections.abc import Callable, Mapping
from contextlib import suppress
from pathlib import Path
from typing import Any

import httpx
from mcp import MCPError, types
from mcp.server import CacheHint, Server, ServerRequestContext

from src.agent_manifest_paths import agent_tool_manifest_path

from ..mcp_tool_names import portable_tool_catalog
from .options import CompanionOptions
from .projection import (
    project_call_result,
    project_resource,
    project_resource_contents,
    project_resource_template,
    project_tool,
)
from .sidecar import SidecarClientProtocol, SidecarHTTPError, WorkspaceBindingRefresher

logger = logging.getLogger(__name__)

MCP_PROTOCOL_VERSION = "2026-07-28"
MCP_SERVER_NAME = "dnaforge-mcp"
MCP_SERVER_VERSION = "0.2.0"
GROK_USER_INPUT_HANDOFF_SCHEMA = "dnaforge.grok-user-input-handoff/v1"
MAX_USER_INPUT_HANDOFF_BYTES = 128 * 1024
PRIVATE_ZERO_TTL_METHODS = (
    "server/discover",
    "tools/list",
    "resources/list",
    "resources/templates/list",
    "resources/read",
)
ACTIVE_JOB_STATUSES = {"queued", "running"}
AGENT_USER_INPUT_TOOL_NAME = "request_user_input"


def _agent_user_input_tool() -> types.Tool:
    return types.Tool(
        name=AGENT_USER_INPUT_TOOL_NAME,
        title="Ask the user",
        description=(
            "Present one to three structured questions in DNAForge, wait for the "
            "user's selection, and then continue this same turn. Use this instead "
            "of guessing when the user asks to choose between options. In Grok, "
            "this is the only working structured user-choice primitive; do not "
            "call the built-in ask_user_question tool."
        ),
        inputSchema={
            "type": "object",
            "additionalProperties": False,
            "required": ["questions"],
            "properties": {
                "questions": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 3,
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["id", "header", "question", "options"],
                        "properties": {
                            "id": {"type": "string", "minLength": 1, "maxLength": 64},
                            "header": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 64,
                            },
                            "question": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 1000,
                            },
                            "options": {
                                "type": "array",
                                "minItems": 2,
                                "maxItems": 4,
                                "items": {
                                    "type": "object",
                                    "additionalProperties": False,
                                    "required": ["label", "description"],
                                    "properties": {
                                        "label": {
                                            "type": "string",
                                            "minLength": 1,
                                            "maxLength": 80,
                                        },
                                        "description": {
                                            "type": "string",
                                            "maxLength": 400,
                                        },
                                    },
                                },
                            },
                            "multiSelect": {"type": "boolean", "default": False},
                        },
                    },
                }
            },
        },
        outputSchema={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "answers": {
                    "type": "object",
                    "additionalProperties": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "array", "items": {"type": "string"}},
                        ],
                    },
                },
                "outcome": {
                    "type": "string",
                    "enum": ["decline", "cancel", "cancelled"],
                },
            },
            "oneOf": [{"required": ["answers"]}, {"required": ["outcome"]}],
        },
        annotations=types.ToolAnnotations(
            title="Ask the user",
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=False,
            openWorldHint=False,
        ),
        _meta={"com.dnaforge/tool": {"kind": "agent-user-input"}},
    )


SidecarResolver = Callable[[ServerRequestContext[Any]], SidecarClientProtocol]


class CompanionHandlers:
    """Request handlers that re-enter the authenticated sidecar on every call."""

    def __init__(
        self,
        sidecar: SidecarClientProtocol | None,
        options: CompanionOptions,
        *,
        sidecar_for: SidecarResolver | None = None,
    ) -> None:
        if (sidecar is None) == (sidecar_for is None):
            raise ValueError("Provide exactly one of sidecar or sidecar_for.")
        self.sidecar = sidecar
        self._sidecar_for = sidecar_for
        self.options = options
        self.server: Server[Any] | None = None
        self._process_nonce = secrets.token_hex(8)
        self.active_request_jobs: dict[str, str] = {}

    def _sidecar(self, ctx: ServerRequestContext[Any]) -> SidecarClientProtocol:
        if self._sidecar_for is not None:
            return self._sidecar_for(ctx)
        assert self.sidecar is not None
        return self.sidecar

    async def discover(
        self,
        ctx: ServerRequestContext[Any],
        _params: types.RequestParams,
    ) -> types.DiscoverResult:
        await self._catalog(ctx)
        if self.server is None:  # pragma: no cover - construction invariant
            raise RuntimeError("DNAForge MCP server is not attached.")
        return types.DiscoverResult(
            supportedVersions=[MCP_PROTOCOL_VERSION],
            capabilities=self.server.get_capabilities(
                protocol_version=ctx.protocol_version
            ),
            instructions=mcp_session_instructions(self.options),
            ttlMs=0,
            cacheScope="private",
        )

    async def list_tools(
        self,
        ctx: ServerRequestContext[Any],
        _params: types.PaginatedRequestParams | None,
    ) -> types.ListToolsResult:
        catalog = await self._catalog(ctx)
        raw_tools = _object_list(catalog, "tools")
        if self.options.portable_tool_names:
            raw_tools, _names = portable_tool_catalog(raw_tools)
        tools = [self.project_tool(raw) for raw in raw_tools]
        if self.options.expose_agent_user_input:
            tools.append(_agent_user_input_tool())
        tools.sort(key=lambda tool: tool.name)
        return types.ListToolsResult(tools=tools, ttlMs=0, cacheScope="private")

    async def list_resources(
        self,
        ctx: ServerRequestContext[Any],
        _params: types.PaginatedRequestParams | None,
    ) -> types.ListResourcesResult:
        catalog = await self._catalog(ctx, include_open_workspace_resources=True)
        resources = [
            project_resource(raw) for raw in _object_list(catalog, "resources")
        ]
        resources.sort(key=lambda resource: str(resource.uri))
        return types.ListResourcesResult(
            resources=resources,
            ttlMs=0,
            cacheScope="private",
        )

    async def list_resource_templates(
        self,
        ctx: ServerRequestContext[Any],
        _params: types.PaginatedRequestParams | None,
    ) -> types.ListResourceTemplatesResult:
        catalog = await self._catalog(ctx)
        templates = [
            project_resource_template(raw)
            for raw in _object_list(catalog, "resourceTemplates")
        ]
        templates.sort(key=lambda template: template.uri_template)
        return types.ListResourceTemplatesResult(
            resourceTemplates=templates,
            ttlMs=0,
            cacheScope="private",
        )

    async def call_tool(
        self,
        ctx: ServerRequestContext[Any],
        params: types.CallToolRequestParams,
    ) -> types.CallToolResult:
        arguments = params.arguments or {}
        if params.name == AGENT_USER_INPUT_TOOL_NAME:
            if not self.options.expose_agent_user_input:
                return _tool_error("The agent user-input bridge is not enabled.")

            await self._catalog(ctx)
            return await self._request_agent_user_input(ctx, arguments)
        sidecar = self._sidecar(ctx)
        for attempt in range(2):
            status_code, body = await self._call_tool_once(ctx, params)
            error = body.get("error")
            details = error.get("details") if isinstance(error, dict) else None
            if (
                attempt == 0
                and isinstance(error, dict)
                and error.get("code") == "WRONG_WORKSPACE"
                and isinstance(details, dict)
                and details.get("stateMayHaveChanged") is False
                and isinstance(sidecar, WorkspaceBindingRefresher)
                and await sidecar.refresh_workspace_binding()
            ):
                continue
            return project_call_result(
                status_code,
                body,
                client_surface=self.options.client_surface,
                tool_name=params.name,
            )
        raise AssertionError("The bounded MCP call retry returned no result.")

    async def _call_tool_once(
        self,
        ctx: ServerRequestContext[Any],
        params: types.CallToolRequestParams,
    ) -> tuple[int, dict[str, Any]]:
        arguments = params.arguments or {}
        tool_name, cancelability = await self._discovered_tool(ctx, params.name)
        sidecar = self._sidecar(ctx)
        request_key = self._request_key(ctx)
        idempotency_key = f"dnaforge-mcp:{self._process_nonce}:{secrets.token_hex(16)}"
        admission_task = asyncio.create_task(
            sidecar.call_tool(
                tool_name,
                arguments,
                idempotency_key=idempotency_key,
            )
        )
        job_id: str | None = None
        try:
            status_code, body = await asyncio.shield(admission_task)
            job_id = _optional_string(body.get("jobId"))
            if job_id is not None:
                self.active_request_jobs[request_key] = job_id
            if status_code < 400 and body.get("status") in ACTIVE_JOB_STATUSES:
                body = await self._poll_job(
                    sidecar, job_id, cancelability=cancelability
                )
                status_code = 200
            return status_code, body
        except httpx.TransportError as exc:
            timeout = isinstance(exc, httpx.TimeoutException)
            code = "MCP_TRANSPORT_TIMEOUT" if timeout else "MCP_TRANSPORT_UNAVAILABLE"
            stage = "job observation" if job_id is not None else "admission"
            details = {
                "toolName": tool_name,
                "requestId": idempotency_key,
                "stage": stage,
                "exceptionType": type(exc).__name__,
                "stateMayHaveChanged": True,
            }
            if job_id is not None:
                details["jobId"] = job_id
            raise _as_mcp_error(
                SidecarHTTPError(
                    f"DNAForge {tool_name} {stage} {'timed out' if timeout else 'lost its connection'}. "
                    "Completion is unknown; inspect the original operation before repeating a change.",
                    504 if timeout else 502,
                    {
                        "error": {
                            "code": code,
                            "message": f"{tool_name} {stage} failed.",
                            "details": details,
                        }
                    },
                )
            ) from exc
        except SidecarHTTPError as exc:
            if _sidecar_error_code(exc.body) in {
                "MCP_TRANSPORT_TIMEOUT",
                "MCP_TRANSPORT_UNAVAILABLE",
            }:
                error = exc.body["error"]
                details = {
                    **error.get("details", {}),
                    "toolName": tool_name,
                    "requestId": idempotency_key,
                    "stateMayHaveChanged": True,
                }
                if job_id is not None:
                    details["jobId"] = job_id
                exc = SidecarHTTPError(
                    f"{tool_name}: {exc.message} Completion is unknown; inspect the original operation before repeating a change.",
                    exc.status_code,
                    {**exc.body, "error": {**error, "details": details}},
                )
            raise _as_mcp_error(exc) from exc
        except asyncio.CancelledError:
            if job_id is None:
                try:
                    _status_code, admitted = await asyncio.shield(admission_task)
                    job_id = _optional_string(admitted.get("jobId"))
                    if job_id is not None:
                        self.active_request_jobs[request_key] = job_id
                except Exception:  # noqa: BLE001 - original cancellation wins
                    logger.exception(
                        "Failed to resolve DNAForge admission after MCP cancellation"
                    )
            if job_id is not None and cancelability is not False:
                await self._cancel_job_after_mcp_cancellation(sidecar, job_id)
            raise
        finally:
            self.active_request_jobs.pop(request_key, None)

    async def _request_agent_user_input(
        self,
        ctx: ServerRequestContext[Any],
        arguments: dict[str, Any],
    ) -> types.CallToolResult:
        requested_schema = _agent_user_input_schema(arguments)
        if requested_schema is None:
            return _tool_error("request_user_input received malformed questions.")
        handoff_result = self._consume_agent_user_input_handoff(arguments)
        if handoff_result is not None:
            return handoff_result
        questions = arguments["questions"]
        message = (
            questions[0]["question"]
            if len(questions) == 1
            else "Answer these structured questions to continue."
        )
        result = await ctx.session.elicit_form(
            message=message,
            requested_schema=requested_schema,
            related_request_id=ctx.request_id,
        )
        if result.action != "accept" or result.content is None:
            outcome = {"outcome": result.action}
            return types.CallToolResult(
                content=[types.TextContent(text=_compact_json(outcome))],
                structuredContent=outcome,
            )
        answers = {"answers": result.content}
        return types.CallToolResult(
            content=[types.TextContent(text=_compact_json(answers))],
            structuredContent=answers,
        )

    def _consume_agent_user_input_handoff(
        self, arguments: dict[str, Any]
    ) -> types.CallToolResult | None:
        path_value = self.options.agent_user_input_handoff_path
        token = self.options.agent_user_input_handoff_token
        if not path_value and not token:
            return None
        if not path_value or not token:
            return _tool_error(
                "The Grok user-input handoff is incompletely configured."
            )
        path = Path(path_value)
        try:
            payload_text = path.read_text(encoding="utf-8")
        except OSError:
            return _tool_error("The Grok user-input response was not available.")
        finally:
            with suppress(OSError):
                path.unlink(missing_ok=True)
        if len(payload_text.encode("utf-8")) > MAX_USER_INPUT_HANDOFF_BYTES:
            return _tool_error("The Grok user-input response exceeded its size limit.")
        try:
            payload = json.loads(payload_text)
        except json.JSONDecodeError:
            return _tool_error("The Grok user-input response was malformed.")
        if not isinstance(payload, dict):
            return _tool_error("The Grok user-input response was malformed.")
        payload_token = payload.get("token")
        if (
            payload.get("schema") != GROK_USER_INPUT_HANDOFF_SCHEMA
            or not isinstance(payload_token, str)
            or not secrets.compare_digest(payload_token, token)
            or payload.get("arguments") != arguments
        ):
            return _tool_error(
                "The Grok user-input response did not match this request."
            )
        response = payload.get("response")
        if not isinstance(response, dict) or response.get("outcome") != "submitted":
            outcome = {"outcome": "cancelled"}
            return types.CallToolResult(
                content=[types.TextContent(text=_compact_json(outcome))],
                structuredContent=outcome,
            )
        answers = response.get("answers")
        if not isinstance(answers, dict):
            return _tool_error(
                "The Grok user-input response contained invalid answers."
            )
        normalized: dict[str, str | list[str]] = {}
        for question in arguments["questions"]:
            answer = answers.get(question["id"])
            if not isinstance(answer, dict):
                return _tool_error("The Grok user-input response omitted an answer.")
            selected = answer.get("selectedOptionIds")
            labels = {option["label"] for option in question["options"]}
            if (
                not isinstance(selected, list)
                or not selected
                or any(
                    not isinstance(value, str) or value not in labels
                    for value in selected
                )
            ):
                return _tool_error(
                    "The Grok user-input response contained an invalid selection."
                )
            if question.get("multiSelect", False):
                normalized[question["id"]] = selected
            elif len(selected) == 1:
                normalized[question["id"]] = selected[0]
            else:
                return _tool_error(
                    "The Grok user-input response selected too many options."
                )
        result = {"answers": normalized}
        return types.CallToolResult(
            content=[types.TextContent(text=_compact_json(result))],
            structuredContent=result,
        )

    async def read_resource(
        self,
        ctx: ServerRequestContext[Any],
        params: types.ReadResourceRequestParams,
    ) -> types.ReadResourceResult:
        try:
            body = await self._sidecar(ctx).read_resource(str(params.uri))
        except SidecarHTTPError as exc:
            raise _as_mcp_error(exc) from exc
        return types.ReadResourceResult(
            contents=project_resource_contents(body),
            ttlMs=0,
            cacheScope="private",
        )

    @staticmethod
    def project_tool(raw: dict[str, Any]) -> types.Tool:
        return project_tool(raw)

    async def _catalog(
        self,
        ctx: ServerRequestContext[Any],
        *,
        include_open_workspace_resources: bool = False,
    ) -> dict[str, Any]:
        try:
            return await self._sidecar(ctx).discover(
                client_info=_client_info_from_context(ctx),
                include_open_workspace_resources=include_open_workspace_resources,
            )
        except SidecarHTTPError as exc:
            raise _as_mcp_error(exc) from exc

    async def _discovered_tool(
        self, ctx: ServerRequestContext[Any], tool_name: str
    ) -> tuple[str, bool | None]:
        try:
            tool = await self._sidecar(ctx).lookup_tool(
                tool_name,
                portable_names=self.options.portable_tool_names,
            )
        except SidecarHTTPError:
            return tool_name, None
        if tool is None:
            return tool_name, None
        return tool["name"], tool["cancelable"]

    async def _poll_job(
        self,
        sidecar: SidecarClientProtocol,
        job_id: str | None,
        *,
        cancelability: bool | None,
    ) -> dict[str, Any]:
        if job_id is None:
            return {
                "ok": False,
                "status": "failed",
                "error": {
                    "code": "MISSING_JOB_ID",
                    "message": "Queued DNAForge tool call did not return a job id.",
                },
            }
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.options.job_timeout_seconds
        while True:
            if loop.time() >= deadline:
                if cancelability is not False:
                    await self._cancel_job_after_poll_timeout(sidecar, job_id)
                return {
                    "ok": False,
                    "jobId": job_id,
                    "status": "failed",
                    "error": {
                        "code": "JOB_POLL_TIMEOUT",
                        "message": "DNAForge tool job did not finish before timeout.",
                    },
                }
            await asyncio.sleep(self.options.job_poll_interval_seconds)
            try:
                body = await sidecar.get_job(job_id)
            except SidecarHTTPError as exc:
                if (
                    exc.body.get("error", {}).get("code")
                    == "MCP_JOB_LOST_AFTER_RESTART"
                ):
                    return exc.body
                raise
            if body.get("status") not in ACTIVE_JOB_STATUSES:
                return body

    async def _cancel_job_after_mcp_cancellation(
        self, sidecar: SidecarClientProtocol, job_id: str
    ) -> None:
        await self._cancel_admitted_job(sidecar, job_id, reason="MCP cancellation")

    async def _cancel_job_after_poll_timeout(
        self, sidecar: SidecarClientProtocol, job_id: str
    ) -> None:
        await self._cancel_admitted_job(sidecar, job_id, reason="job polling timeout")

    async def _cancel_admitted_job(
        self, sidecar: SidecarClientProtocol, job_id: str, *, reason: str
    ) -> None:
        try:
            await asyncio.shield(sidecar.cancel_job(job_id))
        except SidecarHTTPError as exc:
            if exc.status_code == 409:
                return
            logger.exception(
                "Failed to cancel DNAForge sidecar job %s after %s",
                job_id,
                reason,
            )
        except Exception:  # noqa: BLE001 - original MCP cancellation must win
            logger.exception(
                "Failed to cancel DNAForge sidecar job %s after %s",
                job_id,
                reason,
            )

    @staticmethod
    def _request_key(ctx: ServerRequestContext[Any]) -> str:
        request_id = getattr(ctx, "request_id", None)
        if isinstance(request_id, (str, int)):
            return str(request_id)
        return secrets.token_hex(8)


def native_authoring_instructions() -> str:
    contract = json.loads(
        agent_tool_manifest_path("native-authoring-contract.json").read_text(
            encoding="utf-8"
        )
    )
    instructions = contract.get("instructions")
    if (
        contract.get("schemaVersion") != 1
        or not isinstance(instructions, str)
        or not instructions.strip()
    ):
        raise RuntimeError("Invalid native scientific authoring contract")
    return instructions


def mcp_session_instructions(options: CompanionOptions) -> str:
    link_instructions = (
        "This client renders DNAForge chat chips: use the returned inlineLink for in-app references."
        if options.client_surface == "dnaforge-chat"
        else "This client is external: use the returned externalUrl or inlineLink as a clickable Markdown hyperlink, and shellCommand for shell opens. Private dnaforge-chat links do not open DNAForge from this client."
    )
    return (
        native_authoring_instructions()
        + "\n"
        + link_instructions
        + "\nCatalog visibility and execution are constrained to the current persistent "
        "agent grant and revalidated on every request."
    )


def create_mcp_server(
    sidecar: SidecarClientProtocol | None,
    options: CompanionOptions,
    *,
    sidecar_for: SidecarResolver | None = None,
) -> Server[Any]:
    """Build one dual-era SDK server; no framing or version serialization here."""

    handlers = CompanionHandlers(sidecar, options, sidecar_for=sidecar_for)
    cache_hints = {
        method: CacheHint(ttl_ms=0, scope="private")
        for method in PRIVATE_ZERO_TTL_METHODS
    }
    server: Server[Any] = Server(
        MCP_SERVER_NAME,
        version=MCP_SERVER_VERSION,
        instructions=mcp_session_instructions(options),
        cache_hints=cache_hints,
        on_list_tools=handlers.list_tools,
        on_call_tool=handlers.call_tool,
        on_list_resources=handlers.list_resources,
        on_list_resource_templates=handlers.list_resource_templates,
        on_read_resource=handlers.read_resource,
    )
    handlers.server = server
    server.add_request_handler(
        "server/discover", types.RequestParams, handlers.discover
    )
    server._dnaforge_handlers = handlers  # type: ignore[attr-defined]
    return server


def _client_info_from_context(
    ctx: ServerRequestContext[Any],
) -> dict[str, Any] | None:
    meta = getattr(ctx, "meta", None)
    if isinstance(meta, Mapping):
        per_request = meta.get(types.CLIENT_INFO_META_KEY)
        if isinstance(per_request, dict):
            try:
                validated = types.Implementation.model_validate(per_request)
            except ValueError:
                pass
            else:
                return validated.model_dump(
                    by_alias=True,
                    mode="json",
                    exclude_none=True,
                )
    client_params = getattr(ctx.session, "client_params", None)
    client_info = getattr(client_params, "client_info", None)
    if client_info is None:
        return None
    if hasattr(client_info, "model_dump"):
        value = client_info.model_dump(
            by_alias=True,
            mode="json",
            exclude_none=True,
        )
        return value if isinstance(value, dict) else None
    return None


def _object_list(catalog: dict[str, Any], key: str) -> list[dict[str, Any]]:
    raw = catalog.get(key)
    if not isinstance(raw, list) or not all(isinstance(item, dict) for item in raw):
        raise MCPError(
            -32000,
            f"DNAForge sidecar discovery returned an invalid {key} catalog.",
        )
    return raw


def _as_mcp_error(exc: SidecarHTTPError) -> MCPError:
    error_code = _sidecar_error_code(exc.body)
    message = f"{error_code}: {exc.message}" if error_code else exc.message
    return MCPError(
        -32000,
        message,
        {"statusCode": exc.status_code, "body": exc.body},
    )


def _sidecar_error_code(body: dict[str, Any]) -> str | None:
    for envelope_key in ("error", "detail"):
        envelope = body.get(envelope_key)
        if isinstance(envelope, dict):
            code = _optional_string(envelope.get("code"))
            if code is not None:
                return code
    return None


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _bounded_text(value: Any, maximum: int, *, allow_empty: bool = False) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if (not text and not allow_empty) or len(text) > maximum:
        return None
    return text


def _safe_question_id(value: Any) -> str | None:
    question_id = _bounded_text(value, 64)
    if question_id is None or not all(
        character.isalnum() or character in "_-" for character in question_id
    ):
        return None
    return question_id


def _agent_user_input_schema(arguments: dict[str, Any]) -> dict[str, Any] | None:
    if set(arguments) != {"questions"}:
        return None
    questions = arguments.get("questions")
    if not isinstance(questions, list) or not 1 <= len(questions) <= 3:
        return None
    properties: dict[str, Any] = {}
    required: list[str] = []
    for question in questions:
        if not isinstance(question, dict) or not {
            "id",
            "header",
            "question",
            "options",
        }.issubset(question):
            return None
        if set(question) - {"id", "header", "question", "options", "multiSelect"}:
            return None
        question_id = _safe_question_id(question["id"])
        header = _bounded_text(question["header"], 64)
        prompt = _bounded_text(question["question"], 1000)
        multi_select = question.get("multiSelect", False)
        options = question["options"]
        if (
            question_id is None
            or question_id in properties
            or header is None
            or prompt is None
            or not isinstance(multi_select, bool)
            or not isinstance(options, list)
            or not 2 <= len(options) <= 4
        ):
            return None
        choices: list[dict[str, str]] = []
        labels: set[str] = set()
        for option in options:
            if not isinstance(option, dict) or set(option) != {"label", "description"}:
                return None
            label = _bounded_text(option["label"], 80)
            description = _bounded_text(option["description"], 400, allow_empty=True)
            if label is None or description is None or label in labels:
                return None
            labels.add(label)
            choices.append({"const": label, "title": label, "description": description})
        if multi_select:
            properties[question_id] = {
                "type": "array",
                "title": header,
                "description": prompt,
                "items": {"anyOf": choices},
                "minItems": 1,
                "maxItems": len(choices),
            }
        else:
            properties[question_id] = {
                "type": "string",
                "title": header,
                "description": prompt,
                "oneOf": choices,
            }
        required.append(question_id)
    return {"type": "object", "properties": properties, "required": required}


def _compact_json(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _tool_error(message: str) -> types.CallToolResult:
    return types.CallToolResult(
        content=[types.TextContent(text=message)],
        isError=True,
    )
