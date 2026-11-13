"""Dispatch registered tools through the universal job substrate."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ..agent_design_authority import design_authoring_scope
from .job_manager import get_job_manager
from .tool_registry import ToolReplayPolicy, agent_tool_registry
from .tool_validation import schema_validator, validate_tool_value

if TYPE_CHECKING:
    from ..operations import ManagedOperationService
    from ..security.native_document_authority import NativeDocumentAuthority


class UnknownToolError(Exception):
    def __init__(self, tool_name: str):
        super().__init__(f"Unknown tool: {tool_name}")
        self.tool_name = tool_name


async def dispatch_tool(
    tool_name: str,
    args: dict[str, Any],
    *,
    agent_identity_id: str = "local-agent",
    agent_capabilities: list[str] | None = None,
    idempotency_key: str | None = None,
    parent_action_id: str | None = None,
    turn_id: str | None = None,
    prefer_async: bool = False,
    managed_operations: ManagedOperationService | None = None,
    native_document_authority: NativeDocumentAuthority | None = None,
):
    registered = agent_tool_registry.get(tool_name)
    if registered is None or registered.handler is None:
        raise UnknownToolError(tool_name)
    schema_validator(registered.spec.outputs)
    validate_tool_value(args, registered.spec.inputs)
    if agent_capabilities is not None and registered.spec.home == "renderer":
        agent_capabilities = design_authoring_scope(
            tool_name, args, agent_identity_id, agent_capabilities
        )
    return await get_job_manager().submit(
        spec=registered.spec,
        args=args,
        audit_parameters=registered.audit_parameters(args),
        handler=registered.handler,
        agent_identity_id=agent_identity_id,
        agent_capabilities=agent_capabilities,
        idempotency_key=idempotency_key,
        parent_action_id=parent_action_id,
        turn_id=turn_id,
        prefer_async=prefer_async,
        managed_operations=managed_operations,
        native_document_authority=native_document_authority,
        reuse_cached_result=registered.replay_policy == ToolReplayPolicy.REUSE_RESULT,
        persisted_result_projector=(
            registered.persisted_result
            if registered.audit_result_projector is not None
            else None
        ),
    )
