"""Real SDK stdio contracts for modern and legacy MCP connections."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, TextIO

import pytest
from mcp import Client, StdioServerParameters, types
from mcp.client.stdio import stdio_client

API_ROOT = Path(__file__).resolve().parents[1]
SESSION_TOKEN = "subprocess-session"
PROCESS_STARTUP_TIMEOUT_SECONDS = 30


class _SidecarState:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.slow_polled = threading.Event()
        self.slow_canceled = threading.Event()


@pytest.fixture
def mock_loopback_sidecar() -> Iterator[tuple[str, _SidecarState]]:
    state = _SidecarState()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - stdlib hook
            body = self._body()
            state.requests.append(
                {
                    "method": "POST",
                    "path": self.path,
                    "body": body,
                    "session": self.headers.get("X-DNAForge-Session"),
                    "identity": self.headers.get("X-DNAForge-Agent-Identity"),
                    "capabilities": self.headers.get("X-DNAForge-Agent-Capabilities"),
                    "idempotency": self.headers.get("Idempotency-Key"),
                }
            )
            if self.path == "/mcp/discover":
                self._json(
                    200,
                    {
                        "ok": True,
                        "caller": {
                            "agentIdentityId": "grant-subprocess",
                            "requestedCapabilities": ["read-workspace"],
                            "grantedCapabilities": ["read-workspace"],
                            "effectiveCapabilities": ["read-workspace"],
                        },
                        "tools": [
                            {
                                "name": "fixture.echo",
                                "description": "Echo the deterministic fixture.",
                                "inputSchema": {"type": "object"},
                                "outputSchema": {
                                    "$defs": {
                                        "EchoResult": {
                                            "type": "object",
                                            "properties": {"echo": {"type": "object"}},
                                            "required": ["echo"],
                                        }
                                    },
                                    "oneOf": [{"$ref": "#/$defs/EchoResult"}],
                                },
                                "annotations": {
                                    "readOnlyHint": True,
                                    "cancelable": False,
                                },
                            },
                            {
                                "name": "fixture.slow",
                                "description": "Cancelable queued fixture.",
                                "inputSchema": {"type": "object"},
                                "annotations": {
                                    "readOnlyHint": True,
                                    "cancelable": True,
                                },
                            },
                        ],
                        "resources": [
                            {
                                "uri": "waypoint://selection/ref-1",
                                "name": "Fixture selection",
                                "mimeType": "application/json",
                            }
                        ],
                        "resourceTemplates": [
                            {
                                "uriTemplate": "waypoint://selection/{refId}",
                                "name": "DNAForge selection",
                                "mimeType": "application/json",
                            }
                        ],
                    },
                )
                return
            if self.path == "/mcp/call":
                name = body.get("params", {}).get("name")
                arguments = body.get("params", {}).get("arguments", {})
                if name == "fixture.slow":
                    self._json(
                        202,
                        {
                            "ok": True,
                            "jobId": "job-slow",
                            "status": "running",
                        },
                    )
                    return
                self._json(
                    200,
                    {
                        "ok": True,
                        "jobId": "job-inline",
                        "status": "completed",
                        "result": {"echo": arguments},
                    },
                )
                return
            if self.path == "/mcp/resources/read":
                uri = body.get("uri")
                self._json(
                    200,
                    {
                        "ok": True,
                        "contents": [
                            {
                                "uri": uri,
                                "mimeType": "application/json",
                                "text": '{"fixture":true}',
                            }
                        ],
                    },
                )
                return
            self._json(404, {"error": {"message": "unexpected path"}})

        def do_GET(self) -> None:  # noqa: N802 - stdlib hook
            state.requests.append(self._request_record("GET", None))
            if self.path == "/mcp/jobs/job-slow":
                state.slow_polled.set()
                if state.slow_canceled.is_set():
                    self._json(
                        200,
                        {
                            "ok": True,
                            "jobId": "job-slow",
                            "toolName": "fixture.slow",
                            "status": "completed",
                            "result": {"late": True},
                        },
                    )
                    return
                self._json(
                    200,
                    {
                        "ok": True,
                        "jobId": "job-slow",
                        "toolName": "fixture.slow",
                        "status": "running",
                    },
                )
                return
            self._json(404, {"error": {"message": "unexpected path"}})

        def do_DELETE(self) -> None:  # noqa: N802 - stdlib hook
            state.requests.append(self._request_record("DELETE", None))
            if self.path == "/mcp/jobs/job-slow":
                state.slow_canceled.set()
                self.send_response(204)
                self.end_headers()
                return
            self._json(404, {"error": {"message": "unexpected path"}})

        def _request_record(
            self, method: str, body: dict[str, Any] | None
        ) -> dict[str, Any]:
            return {
                "method": method,
                "path": self.path,
                "body": body,
                "session": self.headers.get("X-DNAForge-Session"),
                "identity": self.headers.get("X-DNAForge-Agent-Identity"),
                "capabilities": self.headers.get("X-DNAForge-Agent-Capabilities"),
                "idempotency": self.headers.get("Idempotency-Key"),
            }

        def _body(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            value = json.loads(raw)
            assert isinstance(value, dict)
            return value

        def _json(self, status: int, body: dict[str, Any]) -> None:
            payload = json.dumps(body, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    try:
        yield f"http://{host}:{port}", state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _transport(
    api_url: str,
    errlog: TextIO,
    *,
    expose_agent_user_input: bool = False,
    handoff_path: Path | None = None,
    handoff_token: str = "",
):
    environment: dict[str, str] | None = None
    if expose_agent_user_input:
        environment = {**os.environ, "DNAFORGE_MCP_EXPOSE_AGENT_USER_INPUT": "1"}
        if handoff_path is not None:
            environment["DNAFORGE_MCP_AGENT_USER_INPUT_HANDOFF_PATH"] = str(
                handoff_path
            )
            environment["DNAFORGE_MCP_AGENT_USER_INPUT_HANDOFF_TOKEN"] = handoff_token
    parameters = StdioServerParameters(
        command=sys.executable,
        args=[
            "-m",
            "src.mcp_companion",
            "--api-url",
            api_url,
            "--session-token",
            SESSION_TOKEN,
            "--agent-identity",
            "grant-subprocess",
            "--agent-capabilities",
            '["read-workspace"]',
        ],
        env=environment,
        cwd=API_ROOT,
    )
    return stdio_client(parameters, errlog=errlog)


def _packaged_transport(executable: Path, api_url: str, errlog: TextIO):
    """Launch the frozen sidecar exactly as Electron does, with env-only scope."""

    parameters = StdioServerParameters(
        command=str(executable),
        args=["--mcp-stdio"],
        env={
            "DNAFORGE_API_URL": api_url,
            "DNAFORGE_MCP_SESSION_TOKEN": SESSION_TOKEN,
            "DNAFORGE_MCP_AGENT_IDENTITY": "grant-subprocess",
            "DNAFORGE_MCP_GRANT_CAPABILITIES": '["read-workspace"]',
        },
        cwd=executable.parent,
    )
    return stdio_client(parameters, errlog=errlog)


async def _raw_stdio_requests(
    api_url: str,
    requests: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "src.mcp_companion",
        "--api-url",
        api_url,
        "--session-token",
        SESSION_TOKEN,
        "--agent-identity",
        "grant-subprocess",
        "--agent-capabilities",
        '["read-workspace"]',
        cwd=API_ROOT,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    assert process.stdin is not None
    assert process.stdout is not None
    assert process.stderr is not None
    values: list[dict[str, Any]] = []
    try:
        for index, request in enumerate(requests):
            process.stdin.write(
                json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
            )
            await process.stdin.drain()
            timeout = PROCESS_STARTUP_TIMEOUT_SECONDS if index == 0 else 3
            response_line = await asyncio.wait_for(
                process.stdout.readline(), timeout=timeout
            )
            assert response_line.endswith(b"\n")
            value = json.loads(response_line)
            assert isinstance(value, dict)
            values.append(value)
        process.stdin.close()
        await process.stdin.wait_closed()
        assert await asyncio.wait_for(process.stdout.read(), timeout=3) == b""
        await asyncio.wait_for(process.wait(), timeout=3)
        assert await process.stderr.read() == b""
        return values
    finally:
        if process.returncode is None:
            process.terminate()
            await asyncio.wait_for(process.wait(), timeout=3)


@pytest.mark.asyncio
async def test_modern_sdk_process_discovers_lists_reads_and_calls(
    mock_loopback_sidecar: tuple[str, _SidecarState],
    tmp_path: Path,
):
    api_url, state = mock_loopback_sidecar
    client_info = types.Implementation(name="modern-fixture", version="1.0.0")

    with (tmp_path / "modern-stderr.log").open("w+") as errlog:
        async with Client(
            _transport(api_url, errlog),
            mode="auto",
            client_info=client_info,
        ) as client:
            assert client.protocol_version == "2026-07-28"
            tools = await client.list_tools(cache_mode="reload")
            resources = await client.list_resources(cache_mode="reload")
            read = await client.read_resource(
                "waypoint://selection/ref-1", cache_mode="reload"
            )
            called = await client.call_tool("fixture.echo", {"value": 7})
        errlog.seek(0)
        stderr_text = errlog.read()

    assert [tool.name for tool in tools.tools] == ["fixture.echo", "fixture.slow"]
    assert tools.tools[0].output_schema is not None
    assert tools.tools[0].output_schema["type"] == "object"
    assert tools.ttl_ms == 0
    assert tools.cache_scope == "private"
    assert [str(resource.uri) for resource in resources.resources] == [
        "waypoint://selection/ref-1"
    ]
    assert read.contents[0].text == '{"fixture":true}'
    assert called.structured_content == {"echo": {"value": 7}}
    assert called.meta is not None
    assert called.meta["com.dnaforge/job"] == {
        "jobId": "job-inline",
        "status": "completed",
    }
    assert json.loads(called.content[0].text)["jobId"] == "job-inline"
    call_request = next(
        request for request in state.requests if request["path"] == "/mcp/call"
    )
    assert call_request["idempotency"].startswith("dnaforge-mcp:")

    discover_requests = [
        request for request in state.requests if request["path"] == "/mcp/discover"
    ]
    assert len(discover_requests) >= 3
    assert discover_requests[0]["body"] == {
        "clientInfo": {"name": "modern-fixture", "version": "1.0.0"}
    }
    assert (
        sum(
            request["body"].get("includeOpenWorkspaceResources") is True
            for request in discover_requests
        )
        == 1
    )
    assert all(request["session"] == SESSION_TOKEN for request in state.requests)
    assert all(request["identity"] == "grant-subprocess" for request in state.requests)
    assert all(
        request["capabilities"] == '["read-workspace"]' for request in state.requests
    )
    assert stderr_text == ""


@pytest.mark.asyncio
async def test_modern_sdk_process_relays_agent_user_input_over_elicitation(
    mock_loopback_sidecar: tuple[str, _SidecarState],
    tmp_path: Path,
):
    api_url, state = mock_loopback_sidecar
    requests: list[types.ElicitRequestFormParams] = []

    async def answer_elicitation(
        _context: object,
        params: types.ElicitRequestParams,
    ) -> types.ElicitResult:
        assert isinstance(params, types.ElicitRequestFormParams)
        requests.append(params)
        return types.ElicitResult(
            action="accept",
            content={"assembly": "Gibson"},
        )

    with (tmp_path / "user-input-stderr.log").open("w+") as errlog:
        async with Client(
            _transport(api_url, errlog, expose_agent_user_input=True),
            mode="legacy",
            client_info=types.Implementation(
                name="agent-user-input-fixture",
                version="1.0.0",
            ),
            elicitation_callback=answer_elicitation,
        ) as client:
            tools = await client.list_tools(cache_mode="reload")
            called = await client.call_tool(
                "request_user_input",
                {
                    "questions": [
                        {
                            "id": "assembly",
                            "header": "Assembly",
                            "question": "Which assembly method?",
                            "options": [
                                {"label": "Gibson", "description": "Overlap assembly."},
                                {
                                    "label": "Golden Gate",
                                    "description": "Type IIS assembly.",
                                },
                            ],
                        }
                    ]
                },
            )
        errlog.seek(0)
        stderr_text = errlog.read()

    assert "request_user_input" in [tool.name for tool in tools.tools]
    assert len(requests) == 1
    assert requests[0].message == "Which assembly method?"
    assert called.structured_content == {"answers": {"assembly": "Gibson"}}
    assert not any(
        request["path"] == "/mcp/call"
        and request["body"].get("params", {}).get("name") == "request_user_input"
        for request in state.requests
    )
    assert stderr_text == ""


@pytest.mark.asyncio
async def test_modern_sdk_process_consumes_grok_user_input_handoff(
    mock_loopback_sidecar: tuple[str, _SidecarState],
    tmp_path: Path,
):
    api_url, state = mock_loopback_sidecar
    handoff_path = tmp_path / "grok-user-input.json"
    questions = [
        {
            "id": "assembly",
            "header": "Assembly",
            "question": "Which assembly method?",
            "options": [
                {"label": "Gibson", "description": "Overlap assembly."},
                {"label": "Golden Gate", "description": "Type IIS assembly."},
            ],
        }
    ]
    handoff_path.write_text(
        json.dumps(
            {
                "schema": "dnaforge.grok-user-input-handoff/v1",
                "token": "subprocess-one-time-token",
                "arguments": {"questions": questions},
                "response": {
                    "outcome": "submitted",
                    "answers": {"assembly": {"selectedOptionIds": ["Gibson"]}},
                },
            }
        ),
        encoding="utf-8",
    )

    with (tmp_path / "grok-user-input-stderr.log").open("w+") as errlog:
        async with Client(
            _transport(
                api_url,
                errlog,
                expose_agent_user_input=True,
                handoff_path=handoff_path,
                handoff_token="subprocess-one-time-token",
            ),
            mode="legacy",
            client_info=types.Implementation(
                name="grok-user-input-fixture",
                version="1.0.0",
            ),
        ) as client:
            called = await client.call_tool(
                "request_user_input",
                {"questions": questions},
            )
        errlog.seek(0)
        stderr_text = errlog.read()

    assert called.structured_content == {"answers": {"assembly": "Gibson"}}
    assert not handoff_path.exists()
    assert not any(
        request["path"] == "/mcp/call"
        and request["body"].get("params", {}).get("name") == "request_user_input"
        for request in state.requests
    )
    assert stderr_text == ""


@pytest.mark.asyncio
async def test_raw_modern_newline_wire_enforces_metadata_version_and_results(
    mock_loopback_sidecar: tuple[str, _SidecarState],
):
    api_url, state = mock_loopback_sidecar
    modern_meta = {
        types.PROTOCOL_VERSION_META_KEY: "2026-07-28",
        types.CLIENT_CAPABILITIES_META_KEY: {},
        types.CLIENT_INFO_META_KEY: {"name": "raw-fixture", "version": "1.0.0"},
    }

    discovered, missing_meta = await _raw_stdio_requests(
        api_url,
        [
            {
                "jsonrpc": "2.0",
                "id": "discover-1",
                "method": "server/discover",
                "params": {"_meta": modern_meta},
            },
            {
                "jsonrpc": "2.0",
                "id": "discover-missing-meta",
                "method": "server/discover",
                "params": {},
            },
        ],
    )
    [unsupported] = await _raw_stdio_requests(
        api_url,
        [
            {
                "jsonrpc": "2.0",
                "id": "discover-unsupported",
                "method": "server/discover",
                "params": {
                    "_meta": {
                        **modern_meta,
                        types.PROTOCOL_VERSION_META_KEY: "2099-01-01",
                    }
                },
            }
        ],
    )

    result = discovered["result"]
    assert discovered["id"] == "discover-1"
    assert result["resultType"] == "complete"
    assert result["ttlMs"] == 0
    assert result["cacheScope"] == "private"
    assert result["supportedVersions"] == ["2026-07-28"]
    assert result["_meta"][types.SERVER_INFO_META_KEY] == {
        "name": "dnaforge-mcp",
        "version": "0.2.0",
    }
    assert missing_meta["error"]["code"] == -32602
    assert unsupported["error"]["code"] == types.UNSUPPORTED_PROTOCOL_VERSION
    assert unsupported["error"]["data"] == {
        "supported": ["2026-07-28"],
        "requested": "2099-01-01",
    }
    assert [request["path"] for request in state.requests] == ["/mcp/discover"]
    assert state.requests[0]["body"] == {
        "clientInfo": {"name": "raw-fixture", "version": "1.0.0"}
    }


@pytest.mark.asyncio
async def test_legacy_sdk_process_initializes_then_lists_and_calls(
    mock_loopback_sidecar: tuple[str, _SidecarState],
    tmp_path: Path,
):
    api_url, state = mock_loopback_sidecar

    with (tmp_path / "legacy-stderr.log").open("w+") as errlog:
        async with Client(
            _transport(api_url, errlog),
            mode="legacy",
            client_info=types.Implementation(name="legacy-fixture", version="1.0.0"),
        ) as client:
            assert client.protocol_version == "2025-11-25"
            tools = await client.list_tools(cache_mode="reload")
            called = await client.call_tool("fixture.echo", {"legacy": True})
        errlog.seek(0)
        stderr_text = errlog.read()

    assert [tool.name for tool in tools.tools] == ["fixture.echo", "fixture.slow"]
    assert called.is_error is False
    assert called.structured_content == {"echo": {"legacy": True}}
    assert called.meta is not None
    assert called.meta["com.dnaforge/job"] == {
        "jobId": "job-inline",
        "status": "completed",
    }
    assert [request["path"] for request in state.requests] == [
        "/mcp/discover",
        "/mcp/discover",
        "/mcp/call",
    ]
    assert state.requests[0]["body"] == {
        "clientInfo": {"name": "legacy-fixture", "version": "1.0.0"}
    }
    assert stderr_text == ""


@pytest.mark.asyncio
async def test_packaged_mcp_executable_serves_modern_and_legacy_in_separate_processes(
    mock_loopback_sidecar: tuple[str, _SidecarState],
    tmp_path: Path,
):
    """Opt-in acceptance proof for the exact signed/frozen sidecar artifact."""

    configured_executable = os.environ.get("DNAFORGE_PACKAGED_MCP_EXECUTABLE")
    if not configured_executable:
        pytest.skip("DNAFORGE_PACKAGED_MCP_EXECUTABLE is not set")

    executable = Path(configured_executable).expanduser().resolve()
    assert (
        executable.is_file()
    ), f"DNAFORGE_PACKAGED_MCP_EXECUTABLE is not a file: {executable}"
    api_url, state = mock_loopback_sidecar

    with (tmp_path / "packaged-modern-stderr.log").open("w+") as modern_errlog:
        async with Client(
            _packaged_transport(executable, api_url, modern_errlog),
            mode="auto",
            client_info=types.Implementation(
                name="packaged-modern-fixture",
                version="1.0.0",
            ),
        ) as modern:
            assert modern.protocol_version == "2026-07-28"
            modern_tools = await modern.list_tools(cache_mode="reload")
            modern_read = await modern.read_resource(
                "waypoint://selection/ref-1",
                cache_mode="reload",
            )
            modern_called = await modern.call_tool(
                "fixture.echo", {"packaged": "modern"}
            )
        modern_errlog.seek(0)
        modern_stderr = modern_errlog.read()

    modern_request_count = len(state.requests)

    with (tmp_path / "packaged-legacy-stderr.log").open("w+") as legacy_errlog:
        async with Client(
            _packaged_transport(executable, api_url, legacy_errlog),
            mode="legacy",
            client_info=types.Implementation(
                name="packaged-legacy-fixture",
                version="1.0.0",
            ),
        ) as legacy:
            assert legacy.protocol_version == "2025-11-25"
            legacy_tools = await legacy.list_tools(cache_mode="reload")
            legacy_called = await legacy.call_tool(
                "fixture.echo", {"packaged": "legacy"}
            )
        legacy_errlog.seek(0)
        legacy_stderr = legacy_errlog.read()

    assert [tool.name for tool in modern_tools.tools] == [
        "fixture.echo",
        "fixture.slow",
    ]
    assert modern_read.contents[0].text == '{"fixture":true}'
    assert modern_called.structured_content == {"echo": {"packaged": "modern"}}
    assert [tool.name for tool in legacy_tools.tools] == [
        "fixture.echo",
        "fixture.slow",
    ]
    assert legacy_called.structured_content == {"echo": {"packaged": "legacy"}}

    modern_requests = state.requests[:modern_request_count]
    legacy_requests = state.requests[modern_request_count:]
    assert any(request["path"] == "/mcp/resources/read" for request in modern_requests)
    assert any(request["path"] == "/mcp/call" for request in modern_requests)
    assert any(request["path"] == "/mcp/call" for request in legacy_requests)
    assert all(request["session"] == SESSION_TOKEN for request in state.requests)
    assert all(request["identity"] == "grant-subprocess" for request in state.requests)
    assert all(
        request["capabilities"] == '["read-workspace"]' for request in state.requests
    )
    assert modern_stderr == ""
    assert legacy_stderr == ""


@pytest.mark.asyncio
async def test_modern_sdk_cancellation_deletes_job_and_connection_stays_clean(
    mock_loopback_sidecar: tuple[str, _SidecarState],
    tmp_path: Path,
):
    api_url, state = mock_loopback_sidecar

    with (tmp_path / "cancel-stderr.log").open("w+") as errlog:
        async with Client(
            _transport(api_url, errlog),
            mode="auto",
            client_info=types.Implementation(name="cancel-fixture", version="1.0.0"),
        ) as client:
            call_task = asyncio.create_task(
                client.call_tool("fixture.slow", {"sleep": True})
            )
            assert await asyncio.to_thread(state.slow_polled.wait, 2)
            call_task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await call_task
            assert await asyncio.to_thread(state.slow_canceled.wait, 2)

            tools = await client.list_tools(cache_mode="reload")
        errlog.seek(0)
        stderr_text = errlog.read()

    assert [tool.name for tool in tools.tools] == ["fixture.echo", "fixture.slow"]
    delete_request = next(
        request
        for request in state.requests
        if request["method"] == "DELETE" and request["path"] == "/mcp/jobs/job-slow"
    )
    assert delete_request["session"] == SESSION_TOKEN
    assert delete_request["identity"] == "grant-subprocess"
    assert delete_request["capabilities"] == '["read-workspace"]'
    assert stderr_text == ""


@pytest.mark.asyncio
async def test_raw_modern_cancellation_emits_no_late_response_for_abandoned_id(
    mock_loopback_sidecar: tuple[str, _SidecarState],
):
    api_url, state = mock_loopback_sidecar
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "src.mcp_companion",
        "--api-url",
        api_url,
        "--session-token",
        SESSION_TOKEN,
        "--agent-identity",
        "grant-subprocess",
        "--agent-capabilities",
        '["read-workspace"]',
        cwd=API_ROOT,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    assert process.stdin is not None
    assert process.stdout is not None
    assert process.stderr is not None
    modern_meta = {
        types.PROTOCOL_VERSION_META_KEY: "2026-07-28",
        types.CLIENT_CAPABILITIES_META_KEY: {},
        types.CLIENT_INFO_META_KEY: {
            "name": "raw-cancel-fixture",
            "version": "1.0.0",
        },
    }

    async def send(message: dict[str, Any]) -> None:
        process.stdin.write(json.dumps(message, separators=(",", ":")).encode() + b"\n")
        await process.stdin.drain()

    async def receive(*, startup: bool = False) -> dict[str, Any]:
        timeout = PROCESS_STARTUP_TIMEOUT_SECONDS if startup else 3
        raw = await asyncio.wait_for(process.stdout.readline(), timeout=timeout)
        assert raw.endswith(b"\n")
        value = json.loads(raw)
        assert isinstance(value, dict)
        return value

    try:
        await send(
            {
                "jsonrpc": "2.0",
                "id": "discover-cancel",
                "method": "server/discover",
                "params": {"_meta": modern_meta},
            }
        )
        assert (await receive(startup=True))["id"] == "discover-cancel"
        await send(
            {
                "jsonrpc": "2.0",
                "id": "abandoned-call",
                "method": "tools/call",
                "params": {
                    "name": "fixture.slow",
                    "arguments": {"late": True},
                    "_meta": modern_meta,
                },
            }
        )
        assert await asyncio.to_thread(state.slow_polled.wait, 2)
        await send(
            {
                "jsonrpc": "2.0",
                "method": "notifications/cancelled",
                "params": {"requestId": "abandoned-call", "reason": "test"},
            }
        )
        assert await asyncio.to_thread(state.slow_canceled.wait, 2)

        await send(
            {
                "jsonrpc": "2.0",
                "id": "post-cancel-list",
                "method": "tools/list",
                "params": {"_meta": modern_meta},
            }
        )
        observed: list[dict[str, Any]] = []
        while True:
            response = await receive()
            observed.append(response)
            if response.get("id") == "post-cancel-list":
                break
        assert all(response.get("id") != "abandoned-call" for response in observed)
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(process.stdout.readline(), timeout=0.25)
    finally:
        process.stdin.close()
        await process.stdin.wait_closed()
        await asyncio.wait_for(process.wait(), timeout=3)

    assert await process.stderr.read() == b""
