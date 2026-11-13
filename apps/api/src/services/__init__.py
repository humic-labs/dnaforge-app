"""Service infrastructure for bioinformatics tools."""

from __future__ import annotations

from importlib import import_module
from typing import Any

__all__ = ["ServiceDefinition", "ServiceRegistry", "registry", "PlannotateService"]

_SOURCES = {
    "ServiceDefinition": ".base",
    "ServiceRegistry": ".registry",
    "PlannotateService": ".plannotate",
}


def __getattr__(name: str) -> Any:
    if name == "registry":
        value = import_module(".registry", __name__).registry
        value.register(import_module(".plannotate", __name__).PlannotateService)
    elif name in _SOURCES:
        value = getattr(import_module(_SOURCES[name], __name__), name)
    else:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    globals()[name] = value
    return value
