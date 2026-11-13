"""Central registry for all bioinformatics capabilities.

Each service registers a Capability with its Components at startup.
The ToolboxRegistry aggregates status for the /toolbox/status endpoint.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field, fields


@dataclass
class Component:
    """A single binary, database, or service that a capability depends on."""

    id: str
    label: str
    status: str
    source: str
    version: str | None = None
    path: str | None = None
    progress: dict | None = None
    size_mb: int | None = None

    def to_dict(self) -> dict:
        d = asdict(self)
        return {k: v for k, v in d.items() if v is not None}


def derive_capability_status(statuses: list[str]) -> str:
    """Derive aggregate capability status from component statuses.

    This is the single source of truth for status derivation.
    Used by Capability.status, mock sidecar, and scenario builders.

    Rules:
      - Empty list → "unavailable" (nothing to be ready)
      - All "ready" → "ready"
      - Any "downloading" → "downloading"
      - Any "error" → "error"
      - Otherwise → "unavailable"
    """
    if not statuses:
        return "unavailable"
    if all(s == "ready" for s in statuses):
        return "ready"
    if any(s == "downloading" for s in statuses):
        return "downloading"
    if any(s == "error" for s in statuses):
        return "error"
    return "unavailable"


@dataclass
class Capability:
    """A user-facing capability (e.g., 'Annotation Engine') with components."""

    id: str
    label: str
    source: str
    tier: str
    auto_install: bool
    components: list[Component] = field(default_factory=list)

    @property
    def status(self) -> str:
        """Derived from component statuses. No 'degraded' — partial = error."""
        return derive_capability_status([c.status for c in self.components])

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "status": self.status,
            "source": self.source,
            "tier": self.tier,
            "auto_install": self.auto_install,
            "components": [c.to_dict() for c in self.components],
        }


class ToolboxRegistry:
    """Central registry for all capabilities."""

    def __init__(self):
        self._capabilities: dict[str, Capability] = {}

    def register(self, capability: Capability) -> None:
        """Register or replace a capability."""
        self._capabilities[capability.id] = capability

    def get_capability(self, cap_id: str) -> Capability | None:
        """Get a capability by ID."""
        return self._capabilities.get(cap_id)

    def update_component(self, cap_id: str, comp_id: str, **kwargs) -> None:
        """Update a component's fields. Silently ignores missing cap/comp.

        Raises ValueError for unknown field names to catch typos early.
        """
        cap = self._capabilities.get(cap_id)
        if cap is None:
            return
        valid_fields = {f.name for f in fields(Component)}
        invalid = set(kwargs) - valid_fields
        if invalid:
            raise ValueError(f"Unknown Component fields: {invalid}")
        for comp in cap.components:
            if comp.id == comp_id:
                for key, value in kwargs.items():
                    setattr(comp, key, value)
                return

    def get_status(self) -> list[Capability]:
        """Return all registered capabilities."""
        return list(self._capabilities.values())

    def to_dict(self) -> dict:
        """Serialize for JSON response."""
        return {
            "capabilities": [cap.to_dict() for cap in self._capabilities.values()],
        }


toolbox_registry = ToolboxRegistry()
