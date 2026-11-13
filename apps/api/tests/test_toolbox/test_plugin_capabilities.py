"""Tests for plugin capability registration."""

from src.plugins.registry import plugin_registry
from src.toolbox.plugins import register_plugin_capabilities
from src.toolbox.registry import toolbox_registry


class TestPluginCapabilities:

    def setup_method(self):
        toolbox_registry._capabilities.clear()
        plugin_registry._plugins.clear()

    def test_no_plugins_registered(self):
        register_plugin_capabilities()
        caps = [c for c in toolbox_registry.get_status() if c.source == "plugin"]
        assert len(caps) == 0

    def test_registers_plugin_as_optional(self):
        plugin_registry.register(
            "alphafold_service",
            "http://localhost:9001",
            {
                "name": "alphafold_service",
                "description": "Structure prediction",
                "version": "1.0.0",
                "input_types": {},
                "return_types": {},
            },
        )
        register_plugin_capabilities()
        cap = toolbox_registry.get_capability("alphafold_service")
        assert cap is not None
        assert cap.tier == "optional"
        assert cap.auto_install is False
        assert cap.source == "plugin"

    def test_plugin_starts_as_unavailable(self):
        """Plugins start unavailable -- health checked lazily, not at startup."""
        plugin_registry.register(
            "alphafold_service",
            "http://localhost:9001",
            {
                "name": "alphafold_service",
                "description": "Structure prediction",
                "version": "1.0.0",
                "input_types": {},
                "return_types": {},
            },
        )
        register_plugin_capabilities()
        cap = toolbox_registry.get_capability("alphafold_service")
        assert cap.status == "unavailable"

    def test_idempotent(self):
        plugin_registry.register(
            "x",
            "http://localhost:1234",
            {
                "name": "x",
                "description": "",
                "version": "1.0",
                "input_types": {},
                "return_types": {},
            },
        )
        register_plugin_capabilities()
        register_plugin_capabilities()
        caps = [c for c in toolbox_registry.get_status() if c.id == "x"]
        assert len(caps) == 1
