import json
from typing import Any

from .agent_workspace_authority import agent_project_scope
from .concurrency.renderer_bridge import (
    RENDERER_TOOL_SPECS,
    _renderer_tool_spec,
    call_renderer_bridge,
)
from .concurrency.schema import ToolHome
from .concurrency.tool_errors import ToolExecutionFailure
from .concurrency.tool_registry import (
    ToolContext,
    ToolReplayPolicy,
    agent_tool_registry,
)
from .control_plane import get_control_plane_store
from .mcp_discovery import has_required_capabilities
from .native_document_dispatch import dispatch_native_document_command
from .routes.mcp_auth import check_grant, resolve_identity_context


def _reading(operation: dict[str, Any]) -> bool:
    kind = operation.get("kind")
    if kind in {"inspect", "list-dirty"}:
        return True
    command = operation.get("command")
    if not isinstance(command, dict):
        return False
    if kind in {"table", "sequence"}:
        return command.get("kind") == "inspect"
    if kind == "notebook":
        return command.get("kind") in {"inspect", "schema"} or (
            command.get("kind") == "table"
            and isinstance(command.get("command"), dict)
            and command["command"].get("kind") == "inspect"
        )
    return False


def _required(args: dict[str, Any]) -> list[str]:
    operation = args.get("operation")
    if not isinstance(operation, dict):
        raise ToolExecutionFailure(
            code="INVALID_FILE_DOCUMENT_REQUEST",
            message="Choose a typed file operation.",
            retriable=False,
        )
    kind = operation.get("kind")
    if kind not in {
        "inspect",
        "list-dirty",
        "notebook",
        "sequence",
        "replace-text",
        "replace-string",
        "table",
        "undo",
        "redo",
        "save",
        "reload",
        "discard",
        "restore-recovery",
    }:
        raise ToolExecutionFailure(
            code="INVALID_FILE_DOCUMENT_REQUEST",
            message="That operation is not an agent file command.",
            retriable=False,
        )
    required = ["read-workspace"]
    if kind == "sequence":
        required.append("read-sequences")
    if not _reading(operation):
        required.append("write-workspace")
    return required


async def native_file_document_handler(
    args: dict[str, Any], context: ToolContext
) -> dict[str, Any]:
    required = _required(args)
    error = check_grant(context.agent_identity_id)
    if error is not None:
        failure = error["error"]
        raise ToolExecutionFailure(
            code=failure["code"], message=failure["message"], retriable=False
        )
    identity = get_control_plane_store().get_agent_identity(context.agent_identity_id)
    if identity is None:
        raise ToolExecutionFailure(
            code="GRANT_MISSING",
            message="This agent grant is unavailable.",
            retriable=False,
        )
    current = resolve_identity_context(
        identity, json.dumps(context.agent_capabilities), auth_method="session"
    )
    if not has_required_capabilities(current["effective_capabilities"], required):
        raise ToolExecutionFailure(
            code="INSUFFICIENT_SCOPE",
            message="The current grant does not permit this file operation.",
            retriable=False,
        )
    if context.cancel_event.is_set():
        raise ToolExecutionFailure(
            code="CANCELLED",
            message="The file request was cancelled before dispatch.",
            retriable=False,
        )
    listing = args["operation"]["kind"] == "list-dirty"
    if _uses_renderer(args):
        return await call_renderer_bridge("file_document", args, context)
    if "target" not in args and not listing:
        raise ToolExecutionFailure(
            code="FILE_TARGET_REQUIRED",
            message="Use an admitted file path or the documentId returned by inspection. A tab locator requires the graphical app.",
            retriable=False,
        )
    authority = context.native_document_authority
    if authority is None:
        raise ToolExecutionFailure(
            code="NATIVE_DOCUMENT_OWNER_UNAVAILABLE",
            message="No native document owner is connected.",
            retriable=False,
        )
    request = {
        key: value
        for key, value in args.items()
        if key in {"target", "project", "operation", "expectedRevision", "requestId"}
    }
    if not listing:
        request.setdefault("requestId", context.job_id)
    outcome = await dispatch_native_document_command(
        authority,
        {
            "command": "file.execute",
            "projectScope": agent_project_scope(identity),
            "request": request,
            "agent": {
                "identityId": context.agent_identity_id,
                "capabilities": current["effective_capabilities"],
            },
        },
    )
    if outcome.disposition != "completed" or outcome.result is None:
        raise ToolExecutionFailure(
            code=(
                "FILE_DOCUMENT_REFUSED"
                if outcome.disposition == "refused"
                else "OUTCOME_UNRESOLVED"
            ),
            message=outcome.reason,
            retriable=False,
            details={
                "stateChanged": (
                    False if outcome.disposition == "refused" else "unknown"
                ),
                "requestId": request.get("requestId"),
            },
        )
    result = outcome.result
    if result.get("ok") is False:
        raise ToolExecutionFailure(
            code=result.get("code", "FILE_DOCUMENT_FAILED"),
            message=result.get("error", "The native owner refused the file request."),
            retriable=False,
            details={
                "stateChanged": result.get("stateChanged", "unknown"),
                "partialEffects": result.get("partialEffects", []),
            },
        )
    public = {
        key: value
        for key, value in result.items()
        if key
        not in {
            "content",
            "persistedContent",
            "diskContent",
            "tableData",
            "headerRowValues",
            "firstRowAsHeader",
        }
    }
    return {"ok": True, "result": {**public, "ok": True}}


def _uses_renderer(args: dict[str, Any]) -> bool:
    return (
        "target" not in args
        and args["operation"]["kind"] != "list-dirty"
        and isinstance(args.get("tabId"), str)
    )


def register_native_file_document_tool() -> None:
    config = next(
        spec for spec in RENDERER_TOOL_SPECS if spec["name"] == "file_document"
    )
    spec = _renderer_tool_spec(config).model_copy(
        update={
            "home": ToolHome.NATIVE.value,
            "handler_ref": "src.native_file_document_tools.native_file_document_handler",
        }
    )
    agent_tool_registry.register(
        spec,
        native_file_document_handler,
        replay_policy=ToolReplayPolicy.EXECUTE,
        completion_owner=lambda args: "renderer" if _uses_renderer(args) else "job",
    )
