""": MCP Streamable HTTP on the loopback sidecar.

A real uvicorn server hosts the sidecar's own access middleware, grant routes,
MCP dispatch routes, and the HTTP endpoint. A real MCP SDK client connects over
HTTP with a key minted by the same route Settings uses.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import threading
import time
from collections.abc import Iterator
from contextlib import asynccontextmanager

import httpx
import httpx2
import pytest
import uvicorn
from fastapi import FastAPI
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from starlette.routing import Route

from src.concurrency.builtins import echo_handler, echo_tool_spec
from src.concurrency.job_manager import reset_job_manager
from src.concurrency.pools import reset_pool_manager
from src.concurrency.tool_registry import agent_tool_registry
from src.control_plane import initialize_control_plane
from src.main import app as sidecar_app
from src.mcp_companion.http_endpoint import (
    MCP_HTTP_PATH,
    McpHttpEndpoint,
    serve_mcp_only_port,
)
from src.mcp_companion.options import CompanionOptions
from src.mcp_companion.server import CompanionHandlers
from src.mcp_companion.sidecar import SidecarClient
from src.routes.agent_grants import router as agent_grants_router
from src.routes.mcp import router as mcp_router
from src.routes.mcp_auth import hash_api_key
from src.routes.mcp_discovery import router as mcp_discovery_router
from src.routes.mcp_jobs import router as mcp_jobs_router
from src.security.local_access import LocalAccessMiddleware

SESSION = "test-http-mcp-session"
ECHO_KEY = "dna_key_http-echo-client-test-key"


@pytest.mark.asyncio
async def test_http_sidecar_clients_live_only_for_their_request(monkeypatch):
    from src.mcp_companion import http_endpoint

    clients = []
    entered = asyncio.Event()
    release = asyncio.Event()

    class Client:
        def __init__(self, _options):
            self.closed = False
            clients.append(self)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            self.closed = True

    class Manager:
        async def handle_request(self, scope, _receive, _send):
            client = scope["state"][http_endpoint._CLIENT_STATE_KEY]
            assert not client.closed
            if scope["path"] == "/first":
                entered.set()
                await release.wait()
                assert not client.closed
            else:
                raise RuntimeError("synthetic request failure")

    monkeypatch.setattr(http_endpoint, "SidecarClient", Client)
    monkeypatch.setattr(
        http_endpoint, "get_identity_for_api_key", lambda _key: ({"id": "one"}, None)
    )
    endpoint = McpHttpEndpoint()
    endpoint._manager = Manager()

    def scope(path):
        return {
            "type": "http",
            "path": path,
            "server": ("127.0.0.1", 8123),
            "headers": [
                (b"host", b"127.0.0.1:8123"),
                (b"authorization", f"Bearer {ECHO_KEY}".encode()),
            ],
        }

    first = asyncio.create_task(endpoint(scope("/first"), None, None))
    try:
        await asyncio.wait_for(entered.wait(), timeout=2)
        with pytest.raises(RuntimeError, match="synthetic request failure"):
            await endpoint(scope("/second"), None, None)
        assert len(clients) == 2
        assert clients[1].closed and not clients[0].closed
    finally:
        release.set()
        await first
    assert all(client.closed for client in clients)


@pytest.fixture
def live_sidecar(tmp_path, monkeypatch) -> Iterator[tuple[str, str]]:
    agent_tool_registry.clear()
    agent_tool_registry.register(echo_tool_spec(), echo_handler)
    reset_job_manager()
    reset_pool_manager()
    db_path = tmp_path / "control.sqlite3"
    monkeypatch.setenv("DNAFORGE_SIDECAR_DB_PATH", str(db_path))
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", SESSION)
    monkeypatch.delenv("DNAFORGE_MCP_AGENT_IDENTITY", raising=False)
    store = initialize_control_plane(db_path)

    store.ensure_agent_identity(
        "http-echo-client",
        scope=["debug.echo"],
        label="HTTP echo client",
        kind="http-api-key",
        origin="tool-key",
        api_key_hash=hash_api_key(ECHO_KEY),
    )

    endpoint = McpHttpEndpoint()
    internal = socket.socket()
    internal.bind(("127.0.0.1", 0))
    internal_port = internal.getsockname()[1]
    internal.close()
    monkeypatch.setenv("DNAFORGE_MCP_HTTP_INTERNAL_PORT", str(internal_port))

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        async with endpoint.run(), serve_mcp_only_port(endpoint):
            yield

    app = FastAPI(lifespan=lifespan)
    app.add_middleware(LocalAccessMiddleware)
    for router in (
        agent_grants_router,
        mcp_router,
        mcp_discovery_router,
        mcp_jobs_router,
    ):
        app.include_router(router)
    app.router.routes.append(
        Route(MCP_HTTP_PATH, endpoint=endpoint, methods=["GET", "POST", "DELETE"])
    )

    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False))
    thread = threading.Thread(
        target=lambda: server.run(sockets=[listener]), daemon=True
    )
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.01)
    assert server.started
    base = f"http://127.0.0.1:{port}"
    monkeypatch.setenv("DNAFORGE_OPERATION_URL", base)
    created = httpx.post(
        f"{base}/agent-grants/api-keys",
        json={"label": "HTTP MCP client", "scopes": ["read-workspace"]},
        headers={"X-DNAForge-Session": SESSION},
    )
    assert created.status_code == 200, created.text
    try:
        yield base, created.json()["apiKey"]
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        agent_tool_registry.clear()
        reset_job_manager()
        reset_pool_manager()


def _client(api_key: str | None) -> httpx2.AsyncClient:
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    return httpx2.AsyncClient(headers=headers, timeout=30)


async def _session_tools_and_echo(url: str, api_key: str) -> tuple[list[str], object]:
    async with (
        _client(api_key) as http,
        streamable_http_client(url, http_client=http) as (read, write),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        tools = sorted(tool.name for tool in (await session.list_tools()).tools)
        called = await session.call_tool("echo", {"message": "over http"})
        return tools, called


def test_http_client_lists_the_stdio_catalog_and_runs_a_tool(live_sidecar):
    base, _settings_key = live_sidecar

    tools, called = asyncio.run(_session_tools_and_echo(f"{base}/mcp", ECHO_KEY))

    async def stdio_catalog() -> list[str]:
        options = CompanionOptions(api_url=base, api_key=ECHO_KEY)
        async with SidecarClient(options) as sidecar:
            handlers = CompanionHandlers(sidecar, options)
            listed = await handlers.list_tools(_Context(), None)
        return sorted(tool.name for tool in listed.tools)

    assert "echo" in tools
    assert tools == asyncio.run(stdio_catalog())
    assert called.is_error is not True, called
    assert "over http" in str(called.structured_content)


def test_the_grant_scope_applies_over_http(live_sidecar):
    base, settings_key = live_sidecar

    _tools, called = asyncio.run(_session_tools_and_echo(f"{base}/mcp", settings_key))

    assert called.is_error is True
    assert "INSUFFICIENT_SCOPE" in str(called.content)


@pytest.mark.parametrize(
    ("headers", "status"),
    [
        ({}, 401),
        ({"Authorization": "Bearer dna_key_not-a-real-key"}, 401),
        ({"Authorization": "Basic dXNlcjpwYXNz"}, 401),
    ],
)
def test_requests_without_a_valid_key_are_refused(live_sidecar, headers, status):
    base, _api_key = live_sidecar
    response = httpx.post(
        f"{base}/mcp", json=_INITIALIZE, headers=_MCP_HEADERS | headers
    )
    assert response.status_code == status
    assert response.headers["www-authenticate"].startswith("Bearer")


def test_browser_origins_and_foreign_hosts_are_refused(live_sidecar):
    base, api_key = live_sidecar
    auth = _MCP_HEADERS | {"Authorization": f"Bearer {api_key}"}

    from_page = httpx.post(
        f"{base}/mcp",
        json=_INITIALIZE,
        headers=auth | {"Origin": "https://evil.example"},
    )
    rebound = httpx.post(
        f"{base}/mcp", json=_INITIALIZE, headers=auth | {"Host": "evil.example:80"}
    )

    assert from_page.status_code == 403
    assert rebound.status_code == 421


def test_a_session_cannot_be_used_with_another_key(live_sidecar):
    base, api_key = live_sidecar
    other = httpx.post(
        f"{base}/agent-grants/api-keys",
        json={"label": "Other client", "scopes": ["read-workspace"]},
        headers={"X-DNAForge-Session": SESSION},
    ).json()["apiKey"]
    opened = httpx.post(
        f"{base}/mcp",
        json=_INITIALIZE,
        headers=_MCP_HEADERS | {"Authorization": f"Bearer {api_key}"},
    )
    session_id = opened.headers["mcp-session-id"]

    hijack = httpx.post(
        f"{base}/mcp",
        json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        headers=_MCP_HEADERS
        | {"Authorization": f"Bearer {other}", "Mcp-Session-Id": session_id},
    )

    assert hijack.status_code == 404


def test_a_revoked_key_loses_access_at_the_next_request(live_sidecar):
    base, api_key = live_sidecar
    grants = httpx.get(
        f"{base}/agent-grants", headers={"X-DNAForge-Session": SESSION}
    ).json()["grants"]
    grant_id = next(g["id"] for g in grants if g["label"] == "HTTP MCP client")
    revoked = httpx.delete(
        f"{base}/agent-grants/{grant_id}", headers={"X-DNAForge-Session": SESSION}
    )
    assert revoked.status_code == 200, revoked.text

    response = httpx.post(
        f"{base}/mcp",
        json=_INITIALIZE,
        headers=_MCP_HEADERS | {"Authorization": f"Bearer {api_key}"},
    )
    assert response.status_code == 401


def test_revocation_refuses_an_already_open_http_session(live_sidecar, monkeypatch):
    from src.external_access_observation import valid_observation
    from src.mcp_companion import http_endpoint

    monkeypatch.setenv("DNAFORGE_EXTERNAL_ACCESS_OBSERVATIONS", "1")
    observations = []

    async def observed(receipt):
        assert valid_observation(receipt)
        observations.append(receipt)
        return True

    monkeypatch.setattr(http_endpoint, "emit_external_access_observation", observed)
    base, api_key = live_sidecar
    auth = _MCP_HEADERS | {"Authorization": f"Bearer {api_key}"}
    opened = httpx.post(f"{base}/mcp", json=_INITIALIZE, headers=auth)
    assert opened.status_code == 200, opened.text
    auth["Mcp-Session-Id"] = opened.headers["mcp-session-id"]
    initialized = httpx.post(
        f"{base}/mcp",
        json={"jsonrpc": "2.0", "method": "notifications/initialized"},
        headers=auth,
    )
    assert initialized.status_code == 202, initialized.text
    tools = {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}
    before = httpx.post(f"{base}/mcp", json=tools, headers=auth)
    assert before.status_code == 200, before.text

    grants = httpx.get(
        f"{base}/agent-grants", headers={"X-DNAForge-Session": SESSION}
    ).json()["grants"]
    grant_id = next(g["id"] for g in grants if g["label"] == "HTTP MCP client")
    revoked = httpx.delete(
        f"{base}/agent-grants/{grant_id}", headers={"X-DNAForge-Session": SESSION}
    )
    assert revoked.status_code == 200, revoked.text

    refused = httpx.post(f"{base}/mcp", json=tools | {"id": 3}, headers=auth)
    assert refused.status_code == 401, refused.text
    assert refused.json()["error"]["code"] == "GRANT_REVOKED"
    assert refused.json()["error"]["retriable"] is False

    deadline = time.monotonic() + 1
    while not observations and time.monotonic() < deadline:
        time.sleep(0.01)
    assert len(observations) == 1
    assert observations[0]["access_result"] == "refused"
    assert observations[0]["access_authority"] == "transport_gate"
    assert observations[0]["access_execution"] == "not_observed"
    assert api_key not in json.dumps(observations)
    assert grant_id not in json.dumps(observations)


def test_the_sidecar_app_serves_the_endpoint_at_the_exact_path():
    paths = {getattr(route, "path", None) for route in sidecar_app.router.routes}
    assert MCP_HTTP_PATH in paths


class _Context:
    meta = None
    session = None
    request_id = "stdio-comparison"


_MCP_HEADERS = {"Accept": "application/json, text/event-stream"}
_INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "fixture-test", "version": "1"},
    },
}


def test_host_names_added_in_settings_are_accepted(live_sidecar, tmp_path, monkeypatch):
    base, api_key = live_sidecar
    hosts = tmp_path / "allowed-hosts.json"
    hosts.write_text(
        json.dumps(["MyLaptop.tailnet.ts.net", "relay.example:443", "bad host!", 7])
    )
    monkeypatch.setenv("DNAFORGE_MCP_HTTP_ALLOWED_HOSTS_FILE", str(hosts))
    auth = _MCP_HEADERS | {"Authorization": f"Bearer {api_key}"}

    def status_for(host: str) -> int:
        return httpx.post(
            f"{base}/mcp", json=_INITIALIZE, headers=auth | {"Host": host}
        ).status_code

    assert status_for("mylaptop.tailnet.ts.net") == 200
    assert status_for("mylaptop.tailnet.ts.net:8443") == 200
    assert status_for("relay.example:443") == 200
    assert status_for("relay.example:444") == 421
    assert status_for("other.tailnet.ts.net") == 421
    assert status_for("bad host!") == 421

    hosts.unlink()
    assert status_for("mylaptop.tailnet.ts.net") == 421


def test_the_private_port_serves_only_mcp(live_sidecar):
    port = int(os.environ["DNAFORGE_MCP_HTTP_INTERNAL_PORT"])
    tools, called = asyncio.run(
        _session_tools_and_echo(f"http://127.0.0.1:{port}/mcp", ECHO_KEY)
    )
    assert "echo" in tools
    assert called.is_error is not True

    for path in ("/mcp/discover", "/mcp/call", "/agent-grants", "/health"):
        response = httpx.post(
            f"http://127.0.0.1:{port}{path}",
            json={},
            headers={"X-DNAForge-API-Key": ECHO_KEY, "X-DNAForge-Session": SESSION},
        )
        assert response.status_code == 404, path


def test_private_listener_owns_an_os_assigned_port_before_startup_completes(
    monkeypatch,
):
    monkeypatch.setenv("DNAFORGE_MCP_HTTP_INTERNAL_PORT", "0")

    async def exercise():
        endpoint = McpHttpEndpoint()
        async with endpoint.run(), serve_mcp_only_port(endpoint) as port:
            assert isinstance(port, int) and 1024 <= port <= 65535
            with socket.socket() as contender:
                with pytest.raises(OSError):
                    contender.bind(("127.0.0.1", port))
            async with httpx.AsyncClient() as client:
                for path in ("/health", "/mcp/discover", "/agent-grants"):
                    response = await client.post(f"http://127.0.0.1:{port}{path}")
                    assert response.status_code == 404
                response = await client.post(f"http://127.0.0.1:{port}/mcp")
                assert response.status_code == 401
        with socket.socket() as successor:
            successor.bind(("127.0.0.1", port))

    asyncio.run(exercise())
