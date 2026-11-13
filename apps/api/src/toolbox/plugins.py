"""Register external plugins as optional capabilities.

Plugins start as 'unavailable' -- health is checked lazily (on Toolbox open,
on first use, or via manual test button), never at startup.
"""

from ..plugins.registry import plugin_registry
from .registry import Capability, Component, toolbox_registry


def register_plugin_capabilities() -> None:
    """Register all loaded plugins as optional capabilities."""
    for name in plugin_registry.list_plugins():
        plugin = plugin_registry.get(name)
        if plugin is None:
            continue
        manifest = plugin["manifest"]
        url = plugin["url"]

        toolbox_registry.register(
            Capability(
                id=name,
                label=manifest.get("description", name),
                source="plugin",
                tier="optional",
                auto_install=False,
                components=[
                    Component(
                        id=f"{name}_service",
                        label=manifest.get("description", name),
                        status="unavailable",
                        source="plugin",
                        path=url,
                    ),
                ],
            )
        )
