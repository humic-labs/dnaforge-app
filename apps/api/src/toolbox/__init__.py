"""Toolbox — unified capability management for all bioinformatics tools."""

from .registry import Capability, Component, ToolboxRegistry, toolbox_registry

__all__ = ["Component", "Capability", "ToolboxRegistry", "toolbox_registry"]
