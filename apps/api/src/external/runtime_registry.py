"""Process-local bridge from non-external routes to the external runtime.

The route module remains the composition root, while tile routes can resolve
ephemeral source grants without importing another router or duplicating state.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .service import ExternalResourcesService

_service: ExternalResourcesService | None = None


def set_external_runtime(service: ExternalResourcesService | None) -> None:
    global _service
    _service = service


def get_external_runtime() -> ExternalResourcesService:
    if _service is None:
        raise RuntimeError("external_resources service not initialized")
    return _service
