""" sidecar concurrency substrate."""

from importlib import import_module
from typing import Any

_SOURCES = {
    "agent_tool_registry": ".tool_registry",
    "dispatch_tool": ".dispatcher",
    "get_job_manager": ".job_manager",
    "get_pool_manager": ".pools",
}


def __getattr__(name: str) -> Any:
    module = _SOURCES.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(module, __name__), name)
    globals()[name] = value
    return value


def register_builtin_agent_tools() -> None:
    from .builtins import register_builtin_agent_tools as register

    register()


__all__ = [
    "agent_tool_registry",
    "dispatch_tool",
    "get_job_manager",
    "get_pool_manager",
    "register_builtin_agent_tools",
]
