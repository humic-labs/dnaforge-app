"""Tests for plugin registration and proxy routing."""

from unittest.mock import patch

import httpx
import pytest


class TestPluginRegistry:
    def test_register_plugin(self):
        from src.plugins.registry import PluginRegistry

        reg = PluginRegistry()
        reg.register(
            "my_tool",
            "http://localhost:9001",
            {
                "name": "my_tool",
                "description": "Test tool",
                "version": "1.0.0",
                "input_types": {},
                "return_types": {},
            },
        )
        assert "my_tool" in reg.list_plugins()

    def test_get_plugin(self):
        from src.plugins.registry import PluginRegistry

        reg = PluginRegistry()
        reg.register(
            "my_tool",
            "http://localhost:9001",
            {
                "name": "my_tool",
                "description": "Test tool",
                "version": "1.0.0",
                "input_types": {},
                "return_types": {},
            },
        )
        plugin = reg.get("my_tool")
        assert plugin is not None
        assert plugin["url"] == "http://localhost:9001"

    def test_builtin_services_take_precedence(self):
        """If a plugin name collides with a built-in service, built-in wins."""
        from src.plugins.registry import PluginRegistry

        reg = PluginRegistry()
        reg.register(
            "plannotate_service",
            "http://localhost:9001",
            {
                "name": "plannotate_service",
                "description": "Fake",
                "version": "0.0.1",
                "input_types": {},
                "return_types": {},
            },
        )

        plugin = reg.get("plannotate_service")
        assert plugin is not None

    def test_unregister_plugin(self):
        from src.plugins.registry import PluginRegistry

        reg = PluginRegistry()
        reg.register(
            "my_tool",
            "http://localhost:9001",
            {
                "name": "my_tool",
                "description": "Test",
                "version": "1.0.0",
                "input_types": {},
                "return_types": {},
            },
        )
        reg.unregister("my_tool")
        assert "my_tool" not in reg.list_plugins()

    def test_list_schemas(self):
        from src.plugins.registry import PluginRegistry

        reg = PluginRegistry()
        manifest = {
            "name": "my_tool",
            "description": "Test tool",
            "version": "1.0.0",
            "input_types": {},
            "return_types": {},
        }
        reg.register("my_tool", "http://localhost:9001", manifest)
        schemas = reg.list_schemas()
        assert len(schemas) == 1
        assert schemas[0]["name"] == "my_tool"


class TestPluginProxy:
    @pytest.mark.asyncio
    async def test_proxy_to_plugin(self):
        from src.main import app
        from src.plugins.registry import plugin_registry
        from tests.sidecar_test_client import (
            AuthenticatedSidecarTestClient as TestClient,
        )

        plugin_registry.register(
            "custom_tool", "http://localhost:9999", {"name": "custom_tool"}
        )
        upstream = httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    200, stream=httpx.ByteStream(b'{"output":"result"}')
                )
            )
        )
        try:
            with patch("src.routes.services.httpx.AsyncClient", return_value=upstream):
                response = TestClient(app).post(
                    "/services/custom_tool/execute", json={"input": "test"}
                )
        finally:
            plugin_registry.unregister("custom_tool")
        assert response.status_code == 200
        assert response.json() == {"output": "result"}

    @pytest.mark.parametrize(
        ("failure", "expected_detail"),
        [
            ("http_500", "Plugin 'custom_tool' returned HTTP 500"),
            ("invalid_json", "Plugin 'custom_tool' returned invalid JSON"),
            ("oversize", "Plugin 'custom_tool' response exceeds"),
            ("unreachable", "Plugin 'custom_tool' is unreachable"),
        ],
    )
    def test_plugin_transport_failures_are_bad_gateway_with_a_reason(
        self, failure, expected_detail
    ):
        from src.main import app
        from src.plugins.registry import plugin_registry
        from tests.sidecar_test_client import (
            AuthenticatedSidecarTestClient as TestClient,
        )

        plugin_registry.register(
            "custom_tool", "http://localhost:9999", {"name": "custom_tool"}
        )

        def handler(request):
            if failure == "unreachable":
                raise httpx.ConnectError("connection refused")
            status = 500 if failure == "http_500" else 200
            body = (
                b"not json"
                if failure == "invalid_json"
                else b"x" * 65 if failure == "oversize" else b"{}"
            )
            return httpx.Response(status, stream=httpx.ByteStream(body))

        upstream = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        try:
            with (
                patch("src.routes.services.httpx.AsyncClient", return_value=upstream),
                patch("src.routes.services.PLUGIN_RESPONSE_MAX_BYTES", 64),
            ):
                response = TestClient(app).post(
                    "/services/custom_tool/execute", json={"input": "test"}
                )
        finally:
            plugin_registry.unregister("custom_tool")
        assert response.status_code == 502
        assert expected_detail in response.json()["detail"]
