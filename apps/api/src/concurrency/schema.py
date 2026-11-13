"""Canonical DNAForge tool schema for the Phase 1 sidecar substrate.

The Pydantic model is the API-side source of truth for  Phase 1a. The
desktop bridge mirrors this later with TS+Zod for Phase 1b.
"""

from __future__ import annotations

import re
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class PoolName(str, Enum):
    CPU_FAST = "cpu_fast"
    CPU_SLOW = "cpu_slow"
    WARM_MODEL = "warm_model"
    NETWORK_IO = "network_io"
    GPU = "gpu"

    TILE_IO = "tile_io"

    ALIGNMENT_CONTROL = "alignment_control"


class ExpectedLatency(str, Enum):
    SUB_SECOND = "sub_second"
    SECONDS = "seconds"
    MINUTES = "minutes"


class ToolHome(str, Enum):
    RENDERER = "renderer"
    NATIVE = "native"
    PLUGIN = "plugin"
    IN_HOST_TRANSITIONAL = "in-host-transitional"


class ToolRuntime(str, Enum):
    SUBPROCESS = "subprocess"
    SERVICE = "service"
    IN_HOST = "in-host"


class ToolDuration(str, Enum):
    IMMEDIATE = "immediate"
    LONG_RUNNING = "long-running"
    STREAMING = "streaming"


class ToolEffect(str, Enum):
    READ_ONLY = "read-only"
    MUTATING = "mutating"
    UI_BOUND = "ui-bound"

    EXTERNAL_SUBMIT = "external-submit"


class ToolShape(str, Enum):
    APP_ACTION = "app-action"
    DATA_SERVICE = "data-service"
    ADAPTER = "adapter"
    VIZ_TAB_ACTION = "viz-tab-action"


class ResourceHints(BaseModel):
    """Advisory resource hints. Not OS-enforced in Phase 1."""

    model_config = ConfigDict(extra="allow")

    memory_gb: float | None = Field(default=None, ge=0)
    cpu_cores: float | None = Field(default=None, ge=0)


class ToolCategory(BaseModel):
    model_config = ConfigDict(use_enum_values=True)

    shape: ToolShape
    duration: ToolDuration
    effects: list[ToolEffect]
    cancelable: bool
    approval_gated: bool
    read_only_hint: bool | None = None
    destructive_hint: bool | None = None
    idempotent_hint: bool | None = None
    open_world_hint: bool | None = None


class PluginIdentityRef(BaseModel):
    id: str
    name: str
    version: str
    is_first_party: bool = False


class DNAForgeTool(BaseModel):
    """Merged v4.2 +  tool contract.

    Field mapping from the pre-reconciliation  `ToolSpec`:
    `transport` -> `home + runtime`; `pool`, `expected_latency`, `hints`,
    `cancelable`, `streams_progress`, and `idempotency_keyable` are retained
    directly. v4.2 adds protocol-neutral I/O, security, audit, and category
    metadata.
    """

    model_config = ConfigDict(use_enum_values=True)

    manifest_version: Literal[1] = 1
    name: str
    description: str
    inputs: dict[str, Any] = Field(default_factory=lambda: {"type": "object"})
    outputs: dict[str, Any] = Field(default_factory=lambda: {"type": "object"})
    home: ToolHome
    runtime: ToolRuntime | None = None
    handler_ref: str
    pool: PoolName
    expected_latency: ExpectedLatency
    hints: ResourceHints | None = None
    idempotency_keyable: bool = False
    streams_progress: bool = False
    category: ToolCategory
    required_capabilities: list[str]
    conditional_required_capabilities: list[str] = Field(default_factory=list)
    requires_workspace: bool = False
    conditionally_requires_workspace: bool = False
    audit_required: bool
    plugin_identity: PluginIdentityRef | None = None

    @field_validator("name")
    @classmethod
    def name_must_be_tool_identifier(cls, value: str) -> str:
        if not re.match(r"^[A-Za-z][A-Za-z0-9_.-]*$", value):
            raise ValueError("Tool name may contain letters, digits, . _ or -")
        return value

    @field_validator("required_capabilities")
    @classmethod
    def capabilities_must_be_explicit(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("required_capabilities must be explicit and non-empty")
        return value


class MCPTool(BaseModel):
    """MCP-facing projection of a DNAForgeTool."""

    name: str
    description: str
    inputSchema: dict[str, Any]
    outputSchema: dict[str, Any]
    annotations: dict[str, Any]


def to_mcp_format(tool: DNAForgeTool) -> dict[str, Any]:
    """Project internal schema into MCP wire format.

    Behavior annotations are forwarded so agents can plan calls. Routing and
    authorization internals stay server-side.
    """
    effects = [
        effect.value if isinstance(effect, ToolEffect) else str(effect)
        for effect in tool.category.effects
    ]
    default_read_only = effects == [ToolEffect.READ_ONLY.value]
    read_only_hint = (
        tool.category.read_only_hint
        if tool.category.read_only_hint is not None
        else default_read_only
    )
    destructive_hint = (
        tool.category.destructive_hint
        if tool.category.destructive_hint is not None
        else not read_only_hint
    )
    idempotent_hint = (
        tool.category.idempotent_hint
        if tool.category.idempotent_hint is not None
        else read_only_hint
    )

    return MCPTool(
        name=tool.name,
        description=tool.description,
        inputSchema=tool.inputs,
        outputSchema=tool.outputs,
        annotations={
            "duration": tool.category.duration,
            "effects": effects,
            "cancelable": tool.category.cancelable,
            "approval_gated": tool.category.approval_gated,
            "audited": tool.audit_required,
            "requiredCapabilities": tool.required_capabilities,
            "conditionalRequiredCapabilities": tool.conditional_required_capabilities,
            "requiresWorkspace": tool.requires_workspace,
            "conditionallyRequiresWorkspace": tool.conditionally_requires_workspace,
            "streams_progress": tool.streams_progress,
            "readOnlyHint": read_only_hint,
            "destructiveHint": destructive_hint,
            "idempotentHint": idempotent_hint,
            **(
                {"openWorldHint": tool.category.open_world_hint}
                if tool.category.open_world_hint is not None
                else {}
            ),
        },
    ).model_dump(mode="json")


def manifest_json_schema() -> dict[str, Any]:
    """Return the generated JSON Schema for the canonical tool manifest."""
    return DNAForgeTool.model_json_schema()
