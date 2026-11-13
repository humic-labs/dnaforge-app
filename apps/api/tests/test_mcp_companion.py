"""Compatibility and launch-option contracts for the MCP companion."""

from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

from scripts import dnaforge_mcp
from src.mcp_companion import CompanionOptions
from src.mcp_companion.options import parse_capabilities
from src.mcp_companion.sidecar import SidecarClient, SidecarHTTPError


@pytest.mark.asyncio
async def test_discovery_recovers_one_interrupted_catalog_read():
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if len(requests) == 1:
            raise httpx.ReadError("", request=request)
        return httpx.Response(200, json={"ok": True, "tools": []})

    async with SidecarClient(
        CompanionOptions(), transport=httpx.MockTransport(handler)
    ) as client:
        assert await client.discover(client_info={"name": "journey"}) == {
            "ok": True,
            "tools": [],
        }
    assert len(requests) == 2
    assert all(request.url.path == "/mcp/discover" for request in requests)
    assert requests[0].content == requests[1].content


@pytest.mark.asyncio
async def test_repeated_catalog_read_failure_has_a_bounded_informative_error():
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        raise httpx.ReadError("", request=request)

    async with SidecarClient(
        CompanionOptions(), transport=httpx.MockTransport(handler)
    ) as client:
        with pytest.raises(SidecarHTTPError, match="ReadError") as error:
            await client.discover()
    assert len(requests) == 2
    assert error.value.body["error"]["code"] == "MCP_DISCOVERY_TRANSPORT_UNAVAILABLE"


@pytest.mark.asyncio
async def test_catalog_recovery_does_not_retry_authorization_refusal_or_tool_submission():
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/mcp/discover":
            return httpx.Response(403, json={"error": {"code": "PERMISSION_DENIED"}})
        raise httpx.ReadError("", request=request)

    async with SidecarClient(
        CompanionOptions(), transport=httpx.MockTransport(handler)
    ) as client:
        with pytest.raises(SidecarHTTPError):
            await client.discover()
        with pytest.raises(SidecarHTTPError, match="ReadError"):
            await client.call_tool("write_file", {}, idempotency_key="same-operation")
    assert [request.url.path for request in requests] == ["/mcp/discover", "/mcp/call"]


def test_development_script_is_only_an_sdk_companion_shim():
    assert not hasattr(dnaforge_mcp, "DNAForgeMCPCompanion")
    assert not hasattr(dnaforge_mcp, "read_mcp_message")
    assert not hasattr(dnaforge_mcp, "write_mcp_message")


def test_development_script_preserves_legacy_env_attenuation(monkeypatch):
    captured: dict[str, object] = {}

    def fake_sdk_main(argv):
        captured["argv"] = argv
        captured["identity"] = os.environ["DNAFORGE_MCP_AGENT_IDENTITY"]
        captured["capabilities"] = os.environ["DNAFORGE_MCP_GRANT_CAPABILITIES"]
        return 17

    monkeypatch.setattr(dnaforge_mcp, "sdk_main", fake_sdk_main)
    monkeypatch.setenv("DNAFORGE_AGENT_IDENTITY", "legacy-agent")
    monkeypatch.setenv("DNAFORGE_AGENT_CAPABILITIES", "read-workspace")
    monkeypatch.delenv("DNAFORGE_MCP_AGENT_IDENTITY", raising=False)
    monkeypatch.delenv("DNAFORGE_MCP_GRANT_CAPABILITIES", raising=False)

    assert dnaforge_mcp.main(["--api-url", "http://127.0.0.1:8000"]) == 17
    assert captured == {
        "argv": ["--api-url", "http://127.0.0.1:8000"],
        "identity": "legacy-agent",
        "capabilities": "read-workspace",
    }


def test_development_script_defaults_missing_legacy_scope_to_explicit_empty(
    monkeypatch,
):
    captured: dict[str, str] = {}

    def fake_sdk_main(_argv):
        captured["identity"] = os.environ["DNAFORGE_MCP_AGENT_IDENTITY"]
        captured["capabilities"] = os.environ["DNAFORGE_MCP_GRANT_CAPABILITIES"]
        return 0

    monkeypatch.setattr(dnaforge_mcp, "sdk_main", fake_sdk_main)
    for name in (
        "DNAFORGE_AGENT_IDENTITY",
        "DNAFORGE_AGENT_CAPABILITIES",
        "DNAFORGE_MCP_AGENT_IDENTITY",
        "DNAFORGE_MCP_GRANT_CAPABILITIES",
    ):
        monkeypatch.delenv(name, raising=False)

    assert dnaforge_mcp.main([]) == 0
    assert captured == {"identity": "local-agent", "capabilities": ""}


def test_development_script_restores_derived_env_after_sdk_returns(monkeypatch):
    captured: dict[str, str] = {}

    def fake_sdk_main(_argv):
        captured["identity"] = os.environ["DNAFORGE_MCP_AGENT_IDENTITY"]
        captured["capabilities"] = os.environ["DNAFORGE_MCP_GRANT_CAPABILITIES"]
        return 0

    monkeypatch.setattr(dnaforge_mcp, "sdk_main", fake_sdk_main)
    monkeypatch.setenv("DNAFORGE_AGENT_IDENTITY", "legacy-agent")
    monkeypatch.setenv("DNAFORGE_AGENT_CAPABILITIES", "read-workspace")
    monkeypatch.delenv("DNAFORGE_MCP_AGENT_IDENTITY", raising=False)
    monkeypatch.delenv("DNAFORGE_MCP_GRANT_CAPABILITIES", raising=False)

    try:
        assert dnaforge_mcp.main([]) == 0
        assert captured == {
            "identity": "legacy-agent",
            "capabilities": "read-workspace",
        }
        assert "DNAFORGE_MCP_AGENT_IDENTITY" not in os.environ
        assert "DNAFORGE_MCP_GRANT_CAPABILITIES" not in os.environ
    finally:
        os.environ.pop("DNAFORGE_MCP_AGENT_IDENTITY", None)
        os.environ.pop("DNAFORGE_MCP_GRANT_CAPABILITIES", None)


def test_capability_parser_preserves_unspecified_vs_explicit_empty():
    assert parse_capabilities(None) is None
    assert parse_capabilities("") == ()
    assert parse_capabilities("[]") == ()
    assert parse_capabilities('["write-workspace", "read-workspace"]') == (
        "read-workspace",
        "write-workspace",
    )


def test_agent_user_input_bridge_requires_exact_environment_opt_in(monkeypatch):
    monkeypatch.delenv("DNAFORGE_MCP_EXPOSE_AGENT_USER_INPUT", raising=False)
    assert CompanionOptions.from_env().expose_agent_user_input is False

    monkeypatch.setenv("DNAFORGE_MCP_EXPOSE_AGENT_USER_INPUT", "true")
    assert CompanionOptions.from_env().expose_agent_user_input is False

    monkeypatch.setenv("DNAFORGE_MCP_EXPOSE_AGENT_USER_INPUT", "1")
    assert CompanionOptions.from_env().expose_agent_user_input is True


def test_agent_user_input_handoff_stays_in_launch_owned_environment(monkeypatch):
    monkeypatch.setenv(
        "DNAFORGE_MCP_AGENT_USER_INPUT_HANDOFF_PATH", "/private/app/response.json"
    )
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_USER_INPUT_HANDOFF_TOKEN", "one-time-token")

    options = CompanionOptions.from_env()

    assert options.agent_user_input_handoff_path == "/private/app/response.json"
    assert options.agent_user_input_handoff_token == "one-time-token"


@pytest.mark.asyncio
async def test_sidecar_omits_unspecified_capability_header_and_audits_client_info():
    captured: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={
                "ok": True,
                "caller": {},
                "tools": [],
                "resources": [],
                "resourceTemplates": [],
            },
        )

    options = CompanionOptions(
        session_token="session",
        agent_identity="grant-1",
        agent_capabilities=None,
    )
    async with SidecarClient(
        options, transport=httpx.MockTransport(handler)
    ) as sidecar:
        await sidecar.discover(
            client_info={"name": "audit-only", "version": "1.0.0"},
            include_open_workspace_resources=True,
        )

    request = captured[0]
    assert request.url.path == "/mcp/discover"
    assert request.headers["X-DNAForge-Session"] == "session"
    assert request.headers["X-DNAForge-Agent-Identity"] == "grant-1"
    assert "X-DNAForge-Agent-Capabilities" not in request.headers
    assert request.read() == (
        b'{"clientInfo":{"name":"audit-only","version":"1.0.0"},'
        b'"includeOpenWorkspaceResources":true}'
    )


@pytest.mark.asyncio
async def test_tool_admission_requests_async_response_before_waiting_for_job():
    captured: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            202, json={"ok": True, "jobId": "original", "status": "running"}
        )

    async with SidecarClient(
        CompanionOptions(), transport=httpx.MockTransport(handler)
    ) as sidecar:
        status, body = await sidecar.call_tool(
            "create_strain", {}, idempotency_key="same-save"
        )

    assert status == 202
    assert body["jobId"] == "original"
    assert captured[0].headers.get("Prefer") == "respond-async"
    assert captured[0].headers["Idempotency-Key"] == "same-save"


@pytest.mark.asyncio
async def test_sidecar_sends_explicit_zero_capability_request():
    captured: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={
                "ok": True,
                "caller": {},
                "tools": [],
                "resources": [],
                "resourceTemplates": [],
            },
        )

    async with SidecarClient(
        CompanionOptions(agent_capabilities=()),
        transport=httpx.MockTransport(handler),
    ) as sidecar:
        await sidecar.discover()

    assert captured[0].headers["X-DNAForge-Agent-Capabilities"] == "[]"


@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1:8000",
        "http://example.com:8000",
        "http://127.0.0.1:8000/nested",
    ],
)
def test_sidecar_rejects_non_loopback_or_non_root_api_urls(url: str):
    with pytest.raises(ValueError):
        SidecarClient(CompanionOptions(api_url=url))


@pytest.mark.asyncio
async def test_sidecar_loopback_auth_never_uses_ambient_http_proxy(monkeypatch):
    target_seen = threading.Event()
    proxy_seen = threading.Event()

    def server(handler_event: threading.Event) -> ThreadingHTTPServer:
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - stdlib hook
                handler_event.set()
                payload = json.dumps(
                    {
                        "ok": True,
                        "caller": {},
                        "tools": [],
                        "resources": [],
                        "resourceTemplates": [],
                    }
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, _format: str, *_args: object) -> None:
                return

        return ThreadingHTTPServer(("127.0.0.1", 0), Handler)

    target = server(target_seen)
    proxy = server(proxy_seen)
    target_thread = threading.Thread(target=target.serve_forever, daemon=True)
    proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
    target_thread.start()
    proxy_thread.start()
    target_host, target_port = target.server_address
    proxy_host, proxy_port = proxy.server_address
    proxy_url = f"http://{proxy_host}:{proxy_port}"
    for name in ("HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.setenv(name, proxy_url)
    for name in ("NO_PROXY", "no_proxy"):
        monkeypatch.delenv(name, raising=False)

    try:
        async with SidecarClient(
            CompanionOptions(
                api_url=f"http://{target_host}:{target_port}",
                session_token="must-stay-loopback",
            )
        ) as sidecar:
            await sidecar.discover()
    finally:
        target.shutdown()
        proxy.shutdown()
        target.server_close()
        proxy.server_close()
        target_thread.join(timeout=2)
        proxy_thread.join(timeout=2)

    assert target_seen.is_set()
    assert not proxy_seen.is_set()


@pytest.mark.asyncio
async def test_compact_lookup_sends_only_the_requested_name_and_has_no_cached_authority():
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if len(requests) == 1:
            return httpx.Response(
                200, json={"ok": True, "tool": {"name": "echo", "cancelable": False}}
            )
        return httpx.Response(401, json={"error": {"code": "GRANT_REVOKED"}})

    async with SidecarClient(
        CompanionOptions(), transport=httpx.MockTransport(handler)
    ) as client:
        assert await client.lookup_tool("echo", portable_names=True) == {
            "name": "echo",
            "cancelable": False,
        }
        with pytest.raises(SidecarHTTPError) as denied:
            await client.lookup_tool("echo", portable_names=True)
        assert denied.value.status_code == 401
    assert len(requests) == 2
    assert all(
        json.loads(request.content)
        == {"toolLookup": {"name": "echo", "portableNames": True}}
        for request in requests
    )
