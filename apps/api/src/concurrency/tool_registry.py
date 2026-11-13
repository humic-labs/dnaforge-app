"""Tool registry for the sidecar concurrency substrate."""

from __future__ import annotations

import json
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from .schema import DNAForgeTool, ToolDuration

if TYPE_CHECKING:
    from ..operations import ManagedOperationService
    from ..security.native_document_authority import NativeDocumentAuthority

ToolHandler = Callable[[dict[str, Any], "ToolContext"], Awaitable[dict[str, Any]]]
AuditParameterProjector = Callable[[dict[str, Any]], dict[str, Any]]
AuditResultProjector = Callable[[dict[str, Any]], dict[str, Any]]

AUDIT_RESULT_PROJECTION_KEY = "_dnaforge_audit_result_projection_v1"
MAX_AUDIT_RESULT_PROJECTION_BYTES = 16 * 1024


class ToolReplayPolicy(str, Enum):
    REUSE_RESULT = "reuse_result"
    EXECUTE = "execute"


@dataclass
class ToolContext:
    job_id: str
    agent_identity_id: str
    agent_capabilities: list[str]
    cancel_event: Any
    turn_id: str | None = None
    cancelable: bool = False
    managed_operations: ManagedOperationService | None = None
    native_document_authority: NativeDocumentAuthority | None = None


@dataclass
class RegisteredTool:
    spec: DNAForgeTool
    handler: ToolHandler | None = None
    replay_policy: ToolReplayPolicy = ToolReplayPolicy.REUSE_RESULT
    audit_parameter_projector: AuditParameterProjector | None = None
    audit_result_projector: AuditResultProjector | None = None

    def audit_parameters(self, args: dict[str, Any]) -> dict[str, Any]:
        if self.audit_parameter_projector is None:
            return args
        projected = self.audit_parameter_projector(args)
        if not isinstance(projected, dict):
            raise TypeError("Tool audit parameter projector must return an object")
        return projected

    def persisted_result(self, result: dict[str, Any]) -> dict[str, Any]:
        if self.audit_result_projector is None:
            return result
        projected = self.audit_result_projector(result)
        if not isinstance(projected, dict):
            raise TypeError("Tool audit result projector must return an object")
        encoded = json.dumps(projected, sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
        if len(encoded) > MAX_AUDIT_RESULT_PROJECTION_BYTES:
            raise ValueError("Tool audit result projection exceeds its byte limit")
        return {AUDIT_RESULT_PROJECTION_KEY: projected}


class AgentToolRegistry:
    """Registry of DNAForgeTool specs and optional in-host handlers."""

    def __init__(self):
        self._tools: dict[str, RegisteredTool] = {}

    def register(
        self,
        spec: DNAForgeTool,
        handler: ToolHandler | None = None,
        *,
        replay_policy: ToolReplayPolicy = ToolReplayPolicy.REUSE_RESULT,
        audit_parameter_projector: AuditParameterProjector | None = None,
        audit_result_projector: AuditResultProjector | None = None,
    ) -> None:
        self.register_many(
            (
                RegisteredTool(
                    spec=spec,
                    handler=handler,
                    replay_policy=replay_policy,
                    audit_parameter_projector=audit_parameter_projector,
                    audit_result_projector=audit_result_projector,
                ),
            ),
            replace_existing=True,
        )

    def register_many(
        self,
        tools: Iterable[RegisteredTool],
        *,
        replace_existing: bool = False,
    ) -> None:
        batch = tuple(tools)
        names = [tool.spec.name for tool in batch]
        duplicates = sorted(name for name, count in Counter(names).items() if count > 1)
        if duplicates:
            raise ValueError(
                "Agent tool batch contains duplicate names: " + ", ".join(duplicates)
            )
        collisions = sorted(set(names) & set(self._tools))
        if collisions and not replace_existing:
            raise ValueError("Agent tools already registered: " + ", ".join(collisions))
        for tool in batch:
            if tool.audit_result_projector is not None and (
                tool.replay_policy != ToolReplayPolicy.EXECUTE
                or tool.spec.category.duration != ToolDuration.IMMEDIATE.value
            ):
                raise ValueError(
                    "Audit result projections require an immediate tool with execute replay"
                )
        self._tools.update((tool.spec.name, tool) for tool in batch)

    def get(self, name: str) -> RegisteredTool | None:
        return self._tools.get(name)

    def require(self, name: str) -> RegisteredTool:
        tool = self.get(name)
        if tool is None:
            raise KeyError(name)
        return tool

    def list(self) -> list[RegisteredTool]:
        return list(self._tools.values())

    def clear(self) -> None:
        self._tools.clear()


agent_tool_registry = AgentToolRegistry()
