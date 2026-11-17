import hashlib
import json
from typing import Any

from .agent_workspace_authority import agent_project_scope
from .concurrency.renderer_bridge import RENDERER_TOOL_SPECS, _renderer_tool_spec
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

_COMMANDS = {
    "search_workspace": "workspace.search",
    "project_history": "project-history.execute",
    "import_review": "import-review.execute",
    "administration": "administration.execute",
    "sequence_document": "sequence.execute",
    "notebook_document": "notebook.execute",
    "inventory": "inventory.execute",
}


def administration_audit_parameters(args: dict[str, Any]) -> dict[str, Any]:
    operation = args.get("operation")
    if not isinstance(operation, dict) or operation.get("kind") != "prepare-share-import":
        return args
    source = operation.get("sourceUrl")
    return {
        **args,
        "operation": {
            **operation,
            "sourceUrl": "[private share capability]",
            "sourceSha256": (
                hashlib.sha256(source.encode()).hexdigest() if isinstance(source, str) else None
            ),
        },
    }


def administration_audit_result(result: dict[str, Any]) -> dict[str, Any]:
    value = result.get("result")
    if not isinstance(value, dict):
        return {"ok": result.get("ok") is True}
    action = value.get("action")
    return {
        "ok": result.get("ok") is True,
        "kind": value.get("kind"),
        "action": (
            {
                key: action[key]
                for key in ("id", "revision", "state", "createdAt", "expiresAt")
                if key in action
            }
            if isinstance(action, dict)
            else None
        ),
        "code": value.get("code"),
        "stateChanged": value.get("stateChanged"),
    }


def _required(name: str, args: dict[str, Any]) -> list[str]:
    required = ["read-workspace"]
    operation = args.get("operation")
    if name == "search_workspace":
        return required
    if not isinstance(operation, dict):
        raise ToolExecutionFailure(
            code="INVALID_NATIVE_COMMAND",
            message="Choose a typed operation.",
            retriable=False,
        )
    kind = operation.get("kind")
    if name == "sequence_document":
        required.append("read-sequences")
        if kind != "inspect":
            required.append("write-workspace")
    elif name == "inventory":
        if kind in {
            "execute",
            "apply-import",
            "apply-table",
            "apply-stocktake",
            "apply-hierarchy",
            "apply-mapped-table",
            "apply-benchling-capture",
            "apply-arrival",
            "acknowledge-source",
        }:
            required.append("write-workspace")
    elif name == "notebook_document":
        command = operation.get("command")
        reading = kind in {"inspect", "schema", "search", "list"} or (
            kind == "table" and isinstance(command, dict) and command.get("kind") == "inspect"
        )
        if not reading:
            required.append("write-workspace")
        if kind == "create":
            required.append("create-entity")
    elif name == "project_history":
        if kind != "inspect":
            required.append("write-workspace")
    elif name == "import_review":
        command = operation.get("command")
        if not (
            kind == "execute" and isinstance(command, dict) and command.get("kind") == "inspect"
        ):
            required.append("write-workspace")
    elif name == "administration":
        if kind in {"update-settings", "retry-settings"}:
            required.append("modify-settings")
        elif kind in {"prepare-share", "prepare-share-import", "prepare-migration"}:
            required.append("write-workspace")
        elif (
            kind == "prepare-handoff"
            and isinstance(operation.get("target"), dict)
            and operation["target"].get("purpose") == "agent-access"
        ):
            required.append("manage-agent-access")
    return required


def _current_agent(context: ToolContext, required: list[str]) -> dict[str, Any]:
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
            message="The current agent grant is unavailable.",
            retriable=False,
        )
    current = resolve_identity_context(
        identity, json.dumps(context.agent_capabilities), auth_method="session"
    )
    capabilities = current["effective_capabilities"]
    if not has_required_capabilities(capabilities, required):
        raise ToolExecutionFailure(
            code="INSUFFICIENT_SCOPE",
            message="The current grant does not permit this operation.",
            retriable=False,
        )
    return {
        "identityId": context.agent_identity_id,
        "capabilities": capabilities,
        "projectScope": agent_project_scope(identity),
    }


async def execute_native_workflow(
    name: str, args: dict[str, Any], context: ToolContext
) -> dict[str, Any]:
    if name not in _COMMANDS:
        raise ToolExecutionFailure(
            code="NATIVE_COMMAND_UNAVAILABLE",
            message="This native command is unavailable.",
            retriable=False,
        )
    agent = _current_agent(context, _required(name, args))
    if context.cancel_event.is_set():
        raise ToolExecutionFailure(
            code="CANCELLED",
            message="The request was cancelled before native dispatch.",
            retriable=False,
        )
    authority = context.native_document_authority
    if authority is None:
        raise ToolExecutionFailure(
            code="NATIVE_DOCUMENT_OWNER_UNAVAILABLE",
            message="No native command owner is connected.",
            retriable=False,
        )
    request = dict(args)
    native_command = _COMMANDS[name]
    if name == "inventory":
        operation = args.get("operation")
        if not isinstance(operation, dict) or operation.get("kind") not in {
            "projects",
            "catalog",
            "catalog-update-preview",
            "resolve-item-code",
            "prepare-label",
            "storage-conditions",
            "export-snapshot",
            "preview-import",
            "apply-import",
            "preview-table",
            "apply-table",
            "preview-stocktake",
            "preview-hierarchy",
            "preview-mapped-table",
            "preview-source-revision",
            "acknowledge-source",
            "apply-stocktake",
            "apply-hierarchy",
            "apply-mapped-table",
            "materials",
            "inspect",
            "inspect-benchling-capture",
            "preview-benchling-capture",
            "apply-benchling-capture",
            "preview-arrival",
            "apply-arrival",
            "arrival-document",
            "stockroom",
            "availability",
            "execute",
            "operation",
            "history",
        }:
            raise ToolExecutionFailure(
                code="INVALID_INVENTORY_OPERATION",
                message="Choose a supported inventory operation.",
                retriable=False,
                details={"stateChanged": False},
            )
        request = {key: value for key, value in operation.items() if key != "kind"}
        if operation["kind"] == "apply-arrival":
            request["kind"] = "receive-arrival"
        elif operation["kind"] == "apply-import":
            request["kind"] = "adopt-archive"
        elif operation["kind"] == "apply-table":
            request["kind"] = "receive-table"
        elif operation["kind"] == "apply-mapped-table":
            request["kind"] = "receive-mapped-table"
        elif operation["kind"] == "apply-benchling-capture":
            request["kind"] = "import-benchling-capture"
        elif operation["kind"] == "apply-hierarchy":
            request["kind"] = "import-hierarchy"
        elif operation["kind"] == "apply-stocktake":
            request["kind"] = "apply-stocktake"
        elif operation["kind"] == "acknowledge-source":
            request["kind"] = "acknowledge-table-source"
        native_command = f"inventory.{operation['kind']}"
    if name == "notebook_document":
        request.setdefault("requestId", context.job_id)
    command: dict[str, Any] = {
        "command": native_command,
        "request": request,
        "projectScope": agent.pop("projectScope"),
    }
    if name in {"administration", "import_review", "inventory"}:
        command["agent"] = agent
    outcome = await dispatch_native_document_command(authority, command)
    if outcome.disposition != "completed" or outcome.result is None:
        raise ToolExecutionFailure(
            code=(
                "NATIVE_COMMAND_REFUSED"
                if outcome.disposition == "refused"
                else "OUTCOME_UNRESOLVED"
            ),
            message=outcome.reason,
            retriable=False,
            details={
                "stateChanged": (False if outcome.disposition == "refused" else "unknown"),
                "actionId": context.job_id,
            },
        )
    result = outcome.result
    if name == "inventory" and result.get("kind") == "execution":
        execution = result.get("execution")
        if isinstance(execution, dict) and execution.get("status") == "rejected":
            raise ToolExecutionFailure(
                code=execution.get("code", "INVENTORY_REJECTED"),
                message=execution.get("message", "The inventory owner refused this command."),
                retriable=False,
                details={
                    "stateChanged": False,
                    "operationId": execution.get("operationId"),
                    "inventoryId": execution.get("inventoryId"),
                    "currentRevision": execution.get("currentRevision"),
                },
            )
    operation = args.get("operation")
    import_apply = (
        name == "import_review"
        and isinstance(operation, dict)
        and operation.get("kind") == "execute"
        and isinstance(operation.get("command"), dict)
        and operation["command"].get("kind") == "apply"
    )
    if import_apply and result.get("phase") in {"partial", "failed"}:
        receipt = result.get("receipt")
        receipt = receipt if isinstance(receipt, dict) else {}
        raise ToolExecutionFailure(
            code=(
                "IMPORT_REVIEW_PARTIAL" if result["phase"] == "partial" else "IMPORT_REVIEW_FAILED"
            ),
            message=result.get(
                "error",
                "The import did not complete. Inspect its retained review before continuing.",
            ),
            retriable=False,
            details={
                "stateChanged": receipt.get("changed", "unknown"),
                "partialEffects": [receipt] if receipt else [],
                "reviewId": result.get("id"),
                "reviewRevision": result.get("revision"),
            },
        )
    if (
        result.get("ok") is False
        or result.get("status") == "failed"
        or result.get("kind") == "failed"
    ):
        changed = result.get("stateChanged", "unknown")
        raise ToolExecutionFailure(
            code=result.get("code", "NATIVE_COMMAND_FAILED"),
            message=result.get(
                "error", result.get("message", "The native owner refused this command.")
            ),
            retriable=False,
            details={
                "stateChanged": changed,
                "partialEffects": result.get("partialEffects", [result] if changed else []),
            },
        )
    return {"ok": True, "result": {**result, "ok": True}}


def register_native_workflow_tools() -> None:
    for name in _COMMANDS:
        config = next(spec for spec in RENDERER_TOOL_SPECS if spec["name"] == name)
        spec = _renderer_tool_spec(config).model_copy(
            update={
                "home": ToolHome.NATIVE.value,
                "handler_ref": "src.native_workflow_tools.execute_native_workflow",
            }
        )

        async def handler(
            args: dict[str, Any], context: ToolContext, tool_name: str = name
        ) -> dict[str, Any]:
            return await execute_native_workflow(tool_name, args, context)

        agent_tool_registry.register(
            spec,
            handler,
            replay_policy=ToolReplayPolicy.EXECUTE,
            audit_parameter_projector=(
                administration_audit_parameters if name == "administration" else None
            ),
            audit_result_projector=(
                administration_audit_result if name == "administration" else None
            ),
        )
