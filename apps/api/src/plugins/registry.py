"""Plugin registry for external services."""

from typing import Any


class PluginRegistry:
    """Registry for external plugin services."""

    def __init__(self):
        self._plugins: dict[str, dict[str, Any]] = {}

    def register(self, name: str, url: str, manifest: dict) -> None:
        self._plugins[name] = {"url": url, "manifest": manifest}

    def unregister(self, name: str) -> None:
        self._plugins.pop(name, None)

    def get(self, name: str) -> dict[str, Any] | None:
        return self._plugins.get(name)

    def list_plugins(self) -> list[str]:
        return list(self._plugins.keys())

    def list_schemas(self) -> list[dict]:
        return [p["manifest"] for p in self._plugins.values()]


plugin_registry = PluginRegistry()
