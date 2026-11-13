"""Pydantic response models for /toolbox/* endpoints.

These are the single source of truth for the API contract.
The dataclasses in toolbox/registry.py remain the business logic layer;
these models handle serialization and provide factory methods for testing.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from ..operations import OperationState
from ..toolbox.registry import Capability, Component


class ProgressInfo(BaseModel):
    """Download progress details."""

    phase: str
    percent: float = 0
    detail: str = ""


class ComponentStatusResponse(BaseModel):
    """Response model for a single toolbox component."""

    id: str
    label: str
    status: Literal["ready", "downloading", "error", "unavailable"]
    source: str
    version: str | None = None
    path: str | None = None
    progress: ProgressInfo | None = None
    size_mb: float | None = None

    @classmethod
    def from_dataclass(cls, comp: Component) -> ComponentStatusResponse:
        """Convert a registry Component dataclass to a response model."""
        progress = None
        if comp.progress is not None:
            progress = ProgressInfo(**comp.progress)
        return cls(
            id=comp.id,
            label=comp.label,
            status=comp.status,
            source=comp.source,
            version=comp.version,
            path=comp.path,
            progress=progress,
            size_mb=comp.size_mb,
        )

    @classmethod
    def ready(
        cls, id: str, *, label: str | None = None, **kw
    ) -> ComponentStatusResponse:
        """Factory: a ready component."""
        return cls(
            id=id,
            label=label or id,
            status="ready",
            source=kw.pop("source", "downloaded"),
            **kw,
        )

    @classmethod
    def downloading(
        cls,
        id: str,
        *,
        percent: float = 0,
        detail: str = "",
        label: str | None = None,
        **kw,
    ) -> ComponentStatusResponse:
        """Factory: a component currently downloading."""
        return cls(
            id=id,
            label=label or id,
            status="downloading",
            source=kw.pop("source", "downloaded"),
            progress=ProgressInfo(phase="downloading", percent=percent, detail=detail),
            **kw,
        )

    @classmethod
    def error(
        cls, id: str, *, label: str | None = None, **kw
    ) -> ComponentStatusResponse:
        """Factory: a component in error state."""
        return cls(
            id=id,
            label=label or id,
            status="error",
            source=kw.pop("source", "downloaded"),
            **kw,
        )

    @classmethod
    def unavailable(
        cls, id: str, *, label: str | None = None, **kw
    ) -> ComponentStatusResponse:
        """Factory: an unavailable component."""
        return cls(
            id=id,
            label=label or id,
            status="unavailable",
            source=kw.pop("source", "downloaded"),
            **kw,
        )


class CapabilityStatusResponse(BaseModel):
    """Response model for a capability with its components."""

    id: str
    label: str
    status: Literal["ready", "downloading", "error", "unavailable"]
    source: str
    tier: Literal["base", "optional"]
    auto_install: bool
    components: list[ComponentStatusResponse]

    @classmethod
    def from_dataclass(cls, cap: Capability) -> CapabilityStatusResponse:
        """Convert a registry Capability dataclass to a response model."""
        return cls(
            id=cap.id,
            label=cap.label,
            status=cap.status,
            source=cap.source,
            tier=cap.tier,
            auto_install=cap.auto_install,
            components=[
                ComponentStatusResponse.from_dataclass(c) for c in cap.components
            ],
        )


class ToolDownloadStatus(BaseModel):
    """Per-tool download progress."""

    phase: Literal["pending", "downloading", "extracting", "done", "error"]
    percent: float = 0.0


class ToolboxStatusResponse(BaseModel):
    """Response model for GET /toolbox/status."""

    capabilities: list[CapabilityStatusResponse]
    downloads: dict[str, ToolDownloadStatus] | None = None

    @classmethod
    def from_registry_dict(cls, data: dict) -> ToolboxStatusResponse:
        """Parse a registry.to_dict() output into a validated response."""
        return cls.model_validate(data)


class ToolboxRetryResponse(BaseModel):
    """Response model for POST /toolbox/retry/{cap_id}."""

    retrying: bool
    capability: str
    operation_id: str
    state: OperationState


class ToolboxHealthResponse(BaseModel):
    """Response model for POST /toolbox/health/{cap_id}."""

    capability: str
    status: str
    url: str
