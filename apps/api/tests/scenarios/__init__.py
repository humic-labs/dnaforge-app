"""Composable test scenario fixtures for toolbox states."""

from .toolbox import (
    downloading_all,
    downloading_databases,
    downloading_tools,
    fresh_install,
    fully_ready,
    mixed_component_status,
    partial_ready,
    tools_error,
    with_mafft,
    with_plugin,
)

__all__ = [
    "fresh_install",
    "downloading_tools",
    "downloading_databases",
    "downloading_all",
    "fully_ready",
    "tools_error",
    "partial_ready",
    "mixed_component_status",
    "with_mafft",
    "with_plugin",
]
