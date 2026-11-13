#!/usr/bin/env python3
"""Exercise the exact packaged sidecar through modern, legacy, and real routes.

This is intentionally a standalone release-gate probe rather than a pytest
wrapper: build-sidecar.sh installs the runtime MCP SDK but release jobs do not
install the API dev/test extra. The probe owns a loopback HTTP fixture and
launches the executable path supplied by verify-package.cjs, so the tested
binary is the one embedded in the app bundle. The deterministic fixture proves
wire projection; isolated frozen HTTP sidecars prove the real persistent-grant,
denial-audit, job polling, and cancellation routes.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from mcp import Client, MCPError, StdioServerParameters, types
from mcp.client.stdio import stdio_client

SESSION_TOKEN = "packaged-mcp-probe-session"
AGENT_IDENTITY = "packaged-mcp-probe-agent"
CAPABILITIES = '["read-workspace"]'
REAL_CAPABILITIES = '["debug.echo","read-workspace"]'


class ProbeFailure(RuntimeError):
    """A release-blocking packaged MCP contract failure."""


class ProbeState:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []


@contextmanager
def loopback_fixture() -> Iterator[tuple[str, ProbeState]]:
    state = ProbeState()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - stdlib hook
            body = self._body()
            state.requests.append(
                {
                    "path": self.path,
                    "body": body,
                    "session": self.headers.get("X-DNAForge-Session"),
                    "identity": self.headers.get("X-DNAForge-Agent-Identity"),
                    "capabilities": self.headers.get("X-DNAForge-Agent-Capabilities"),
                }
            )
            if self.path == "/mcp/discover":
                self._json(
                    200,
                    {
                        "ok": True,
                        "tools": [
                            {
                                "name": "probe.echo",
                                "description": "Echo the packaged MCP probe.",
                                "inputSchema": {"type": "object"},
                                "outputSchema": {
                                    "type": "object",
                                    "required": ["echo"],
                                },
                                "annotations": {
                                    "readOnlyHint": True,
                                    "cancelable": False,
                                },
                            }
                        ],
                        "resources": [
                            {
                                "uri": "waypoint://selection/package-probe",
                                "name": "Packaged MCP probe selection",
                                "mimeType": "application/json",
                            }
                        ],
                        "resourceTemplates": [],
                    },
                )
                return
            if self.path == "/mcp/call":
                arguments = body.get("params", {}).get("arguments", {})
                self._json(
                    200,
                    {
                        "ok": True,
                        "jobId": "package-probe-job",
                        "status": "completed",
                        "result": {
                            "content": [
                                {"type": "text", "text": "packaged-fidelity"},
                                {
                                    "type": "image",
                                    "data": "iVBORw0KGgo=",
                                    "mimeType": "image/png",
                                },
                                {
                                    "type": "resource",
                                    "resource": {
                                        "uri": "waypoint://artifact/package-probe",
                                        "mimeType": "application/json",
                                        "text": '{"artifact":true}',
                                    },
                                },
                                {
                                    "type": "resource_link",
                                    "name": "Packaged probe artifact",
                                    "uri": "waypoint://artifact/package-probe",
                                    "mimeType": "application/json",
                                },
                            ],
                            "structuredContent": {"echo": arguments},
                        },
                    },
                )
                return
            if self.path == "/mcp/resources/read":
                self._json(
                    200,
                    {
                        "ok": True,
                        "contents": [
                            {
                                "uri": body.get("uri"),
                                "mimeType": "application/json",
                                "text": '{"packaged":true}',
                            }
                        ],
                    },
                )
                return
            self._json(404, {"error": {"message": "unexpected probe path"}})

        def _body(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ProbeFailure("Packaged MCP probe received a non-object body")
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


def packaged_transport(
    executable: Path,
    api_url: str,
    errlog: Any,
    *,
    identity: str = AGENT_IDENTITY,
    capabilities: str = CAPABILITIES,
):
    return stdio_client(
        StdioServerParameters(
            command=str(executable),
            args=["--mcp-stdio"],
            env=probe_env(
                api_url,
                identity=identity,
                capabilities=capabilities,
            ),
            cwd=executable.parent,
        ),
        errlog=errlog,
    )


def probe_env(
    api_url: str,
    *,
    identity: str = AGENT_IDENTITY,
    capabilities: str = CAPABILITIES,
) -> dict[str, str]:
    return {
        "DNAFORGE_API_URL": api_url,
        "DNAFORGE_MCP_SESSION_TOKEN": SESSION_TOKEN,
        "DNAFORGE_MCP_API_KEY": "",
        "DNAFORGE_MCP_AGENT_IDENTITY": identity,
        "DNAFORGE_MCP_GRANT_CAPABILITIES": capabilities,
    }


def _free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _json_request(
    method: str,
    url: str,
    *,
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, Any]]:
    payload = (
        json.dumps(body, separators=(",", ":")).encode() if body is not None else None
    )
    request = Request(
        url,
        data=payload,
        method=method,
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urlopen(request, timeout=5) as response:  # noqa: S310 - loopback only
            status = response.status
            raw = response.read()
    except HTTPError as exc:
        status = exc.code
        raw = exc.read()
    value = json.loads(raw or b"{}")
    require(isinstance(value, dict), f"{method} {url} returned non-object JSON")
    return status, value


@contextmanager
def frozen_http_sidecar(
    executable: Path,
    root: Path,
    *,
    identity: str,
    capabilities: str = REAL_CAPABILITIES,
) -> Iterator[tuple[str, Path]]:
    port = _free_loopback_port()
    api_url = f"http://127.0.0.1:{port}"
    db_path = root / "control-plane.sqlite3"
    log_path = root / f"sidecar-{port}.log"
    data_dir = root / "data"
    binaries_dir = root / "binaries"
    data_dir.mkdir(parents=True, exist_ok=True)
    binaries_dir.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.update(
        {
            "PYTHONUNBUFFERED": "1",
            "DNAFORGE_MCP_SESSION_TOKEN": SESSION_TOKEN,
            "DNAFORGE_MCP_API_KEY": "",
            "DNAFORGE_MCP_AGENT_IDENTITY": identity,
            "DNAFORGE_MCP_GRANT_CAPABILITIES": capabilities,
            "DNAFORGE_MCP_CONTRACT_PROBE": "1",
            "DNAFORGE_SIDECAR_DB_PATH": str(db_path),
            "DNAFORGE_OFFLINE_ANNOTATION": "1",
            "WAYPOINT_DATA_DIR": str(data_dir),
            "WAYPOINT_BINARIES_PATH": str(binaries_dir),
            "WAYPOINT_ENVIRONMENT": "test",
            "ENV": "test",
        }
    )
    with log_path.open("w+") as log:
        process = subprocess.Popen(
            [str(executable), "--host", "127.0.0.1", "--port", str(port)],
            cwd=executable.parent,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            deadline = time.monotonic() + 35
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    break
                try:
                    status, _body = _json_request("GET", f"{api_url}/health")
                    if status == 200:
                        yield api_url, db_path
                        return
                except (URLError, TimeoutError, json.JSONDecodeError):
                    pass
                time.sleep(0.1)
            log.flush()
            log.seek(0)
            raise ProbeFailure(
                f"frozen HTTP sidecar did not become healthy (exit={process.poll()}): "
                f"{log.read().strip()}"
            )
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


def _wait_for_canceled_action(db_path: Path) -> None:
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        with closing(sqlite3.connect(db_path)) as connection:
            row = connection.execute("""
                SELECT error_json
                FROM agent_action
                WHERE tool_name = 'echo'
                  AND parameters_json LIKE '%_contractProbeDelayMs%'
                ORDER BY requested_at DESC
                LIMIT 1
                """).fetchone()
        if row is not None and row[0]:
            error = json.loads(row[0])
            if error.get("code") == "CANCELED":
                return
        time.sleep(0.05)
    raise ProbeFailure("real MCP cancellation did not persist CANCELED on the job")


def _wait_for_delayed_action_admission(db_path: Path) -> None:
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        with closing(sqlite3.connect(db_path)) as connection:
            row = connection.execute("""
                SELECT id
                FROM agent_action
                WHERE tool_name = 'echo'
                  AND parameters_json LIKE '%_contractProbeDelayMs%'
                ORDER BY requested_at DESC
                LIMIT 1
                """).fetchone()
        if row is not None:
            return
        time.sleep(0.05)
    raise ProbeFailure("real cancelable echo job was never admitted")


def _assert_denial_audit(db_path: Path) -> None:
    with closing(sqlite3.connect(db_path)) as connection:
        row = connection.execute("""
            SELECT a.authorization_state, a.error_json, r.capability_check_json
            FROM agent_action AS a
            JOIN audit_record AS r ON r.action_id = a.id
            WHERE a.tool_name = 'artifact.register'
            ORDER BY a.requested_at DESC
            LIMIT 1
            """).fetchone()
    require(row is not None, "excluded direct call wrote no denial audit")
    assert row is not None
    require(row[0] == "denied", "excluded direct call authorization state")
    require(json.loads(row[1]).get("code") == "INSUFFICIENT_SCOPE", "denial code")
    require(
        json.loads(row[2]).get("satisfied") is False,
        "excluded direct call denial audit capability result",
    )


async def _expect_catalog_denied(
    client: Client,
    *,
    expected_code: str,
) -> None:
    try:
        await client.list_tools(cache_mode="reload")
    except MCPError as exc:
        require(
            _mcp_error_code(exc) == expected_code,
            f"catalog denial should report {expected_code}, got {exc}",
        )
        return
    raise ProbeFailure(f"catalog remained accessible after {expected_code}")


def _mcp_error_code(exc: MCPError) -> str | None:
    data = exc.data
    if not isinstance(data, dict):
        return None
    body = data.get("body")
    if not isinstance(body, dict):
        return None
    error = body.get("error")
    return error.get("code") if isinstance(error, dict) else None


def _mcp_error_codes(exc: BaseException) -> set[str]:
    codes: set[str] = set()
    pending = [exc]
    seen: set[int] = set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, MCPError):
            code = _mcp_error_code(current)
            if code is not None:
                codes.add(code)
        if isinstance(current, BaseExceptionGroup):
            pending.extend(current.exceptions)
        if current.__cause__ is not None:
            pending.append(current.__cause__)
        if current.__context__ is not None:
            pending.append(current.__context__)
    return codes


async def verify_modern(executable: Path, api_url: str) -> None:
    with tempfile.TemporaryFile(mode="w+") as errlog:
        async with Client(
            packaged_transport(executable, api_url, errlog),
            mode="auto",
            client_info=types.Implementation(
                name="dnaforge-package-verifier",
                version="1.0.0",
            ),
        ) as client:
            require(
                client.protocol_version == "2026-07-28",
                f"modern negotiation returned {client.protocol_version}",
            )
            tools = await client.list_tools(cache_mode="reload")
            resource = await client.read_resource(
                "waypoint://selection/package-probe",
                cache_mode="reload",
            )
            called = await client.call_tool("probe.echo", {"era": "modern"})
        errlog.seek(0)
        stderr = errlog.read()

    require([tool.name for tool in tools.tools] == ["probe.echo"], "modern tools/list")
    require(resource.contents[0].text == '{"packaged":true}', "modern resources/read")
    require(
        called.structured_content == {"echo": {"era": "modern"}},
        "modern tools/call structuredContent",
    )
    require(
        [block.type for block in called.content]
        == ["text", "image", "resource", "resource_link"],
        "modern tools/call full content fidelity",
    )
    require(
        called.content[1].data == "iVBORw0KGgo=",
        "modern tools/call image payload",
    )
    require(
        str(called.content[2].resource.uri) == "waypoint://artifact/package-probe",
        "modern tools/call embedded resource payload",
    )
    require(
        str(called.content[3].uri) == "waypoint://artifact/package-probe",
        "modern tools/call resource-link payload",
    )
    require(stderr == "", f"modern companion stderr was not empty: {stderr!r}")


async def verify_legacy_2024(executable: Path, api_url: str) -> None:
    env = os.environ.copy()
    env.update(probe_env(api_url))
    process = await asyncio.create_subprocess_exec(
        str(executable),
        "--mcp-stdio",
        cwd=executable.parent,
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    require(process.stdin is not None, "legacy companion stdin")
    require(process.stdout is not None, "legacy companion stdout")
    require(process.stderr is not None, "legacy companion stderr")

    async def request(
        request_id: int, method: str, params: dict[str, Any]
    ) -> dict[str, Any]:
        assert process.stdin is not None
        assert process.stdout is not None
        process.stdin.write(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": method,
                    "params": params,
                },
                separators=(",", ":"),
            ).encode()
            + b"\n"
        )
        await process.stdin.drain()
        raw = await asyncio.wait_for(process.stdout.readline(), timeout=15)
        require(raw.endswith(b"\n"), f"legacy {method} returned no newline response")
        value = json.loads(raw)
        require(isinstance(value, dict), f"legacy {method} returned non-object JSON")
        require(value.get("id") == request_id, f"legacy {method} response id mismatch")
        require("error" not in value, f"legacy {method} failed: {value.get('error')}")
        return value

    initialized = await request(
        1,
        "initialize",
        {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "dnaforge-package-legacy-probe", "version": "1"},
        },
    )
    require(
        initialized.get("result", {}).get("protocolVersion") == "2024-11-05",
        "raw 2024 initialize negotiation",
    )
    process.stdin.write(
        b'{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n'
    )
    await process.stdin.drain()
    listed = await request(2, "tools/list", {})
    called = await request(
        3,
        "tools/call",
        {"name": "probe.echo", "arguments": {"era": "legacy-2024"}},
    )
    require(
        [tool.get("name") for tool in listed.get("result", {}).get("tools", [])]
        == ["probe.echo"],
        "raw 2024 tools/list",
    )
    require(
        called.get("result", {}).get("structuredContent")
        == {"echo": {"era": "legacy-2024"}},
        "raw 2024 tools/call structuredContent",
    )

    process.stdin.close()
    await process.stdin.wait_closed()
    extra_stdout = await asyncio.wait_for(process.stdout.read(), timeout=15)
    stderr = (await asyncio.wait_for(process.stderr.read(), timeout=15)).decode()
    return_code = await asyncio.wait_for(process.wait(), timeout=15)
    require(return_code == 0, f"legacy companion exited {return_code}: {stderr}")
    require(
        extra_stdout == b"", f"legacy companion emitted extra stdout: {extra_stdout!r}"
    )
    require(stderr == "", f"legacy companion stderr was not empty: {stderr!r}")


async def verify_real_routes(executable: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="dnaforge-packaged-mcp-real-") as raw_root:
        root = Path(raw_root)
        active_root = root / "active"
        active_root.mkdir()
        identity = "packaged-mcp-real-agent"
        with frozen_http_sidecar(
            executable,
            active_root,
            identity=identity,
        ) as (api_url, db_path):
            with tempfile.TemporaryFile(mode="w+") as errlog:
                async with Client(
                    packaged_transport(
                        executable,
                        api_url,
                        errlog,
                        identity=identity,
                        capabilities=REAL_CAPABILITIES,
                    ),
                    mode="auto",
                    client_info=types.Implementation(
                        name="dnaforge-package-real-route-verifier",
                        version="1.0.0",
                    ),
                ) as client:
                    tools = await client.list_tools(cache_mode="reload")
                    tool_names = [tool.name for tool in tools.tools]
                    require("echo" in tool_names, "real route discovery includes echo")
                    require(
                        "artifact.register" in tool_names,
                        "complete authenticated discovery omitted write tool",
                    )
                    resource = await client.read_resource(
                        "waypoint://workflow/manifest",
                        cache_mode="reload",
                    )
                    require(
                        len(resource.contents) > 0,
                        "real workflow manifest resource read returned no content",
                    )
                    completed = await client.call_tool("echo", {"realRoute": True})
                    require(
                        completed.structured_content is not None
                        and completed.structured_content.get("echo")
                        == {"realRoute": True},
                        "real route echo result",
                    )

                    denied = await client.call_tool(
                        "artifact.register",
                        {"kind": "external", "name": "must-not-register"},
                    )
                    require(
                        denied.is_error is True, "excluded direct call was not denied"
                    )
                    require(
                        "INSUFFICIENT_SCOPE"
                        in " ".join(
                            block.text
                            for block in denied.content
                            if isinstance(block, types.TextContent)
                        ),
                        "excluded direct call did not preserve denial code",
                    )
                    _assert_denial_audit(db_path)

                    delayed = asyncio.create_task(
                        client.call_tool("echo", {"_contractProbeDelayMs": 30_000})
                    )
                    await asyncio.to_thread(_wait_for_delayed_action_admission, db_path)
                    delayed.cancel()
                    try:
                        await delayed
                    except asyncio.CancelledError:
                        pass
                    else:
                        raise ProbeFailure(
                            "real cancelable call returned after cancellation"
                        )
                    await asyncio.to_thread(_wait_for_canceled_action, db_path)
                    clean = await client.list_tools(cache_mode="reload")
                    require(
                        "echo" in [tool.name for tool in clean.tools],
                        "connection was not clean after real cancellation",
                    )

                    revoke_status, revoke_body = await asyncio.to_thread(
                        _json_request,
                        "DELETE",
                        f"{api_url}/agent-grants/{identity}",
                        headers={"X-DNAForge-Session": SESSION_TOKEN},
                    )
                    require(
                        revoke_status == 200 and revoke_body.get("ok") is True,
                        "real grant revocation route",
                    )
                    await _expect_catalog_denied(
                        client,
                        expected_code="GRANT_REVOKED",
                    )
                errlog.seek(0)
                require(
                    errlog.read() == "",
                    "real-route companion wrote unexpected stderr",
                )

        expiry_root = root / "expiry"
        expiry_root.mkdir()
        expiry_identity = "packaged-mcp-expired-agent"
        with frozen_http_sidecar(
            executable,
            expiry_root,
            identity=expiry_identity,
        ) as (api_url, db_path):
            with tempfile.TemporaryFile(mode="w+") as errlog:
                async with Client(
                    packaged_transport(
                        executable,
                        api_url,
                        errlog,
                        identity=expiry_identity,
                        capabilities=REAL_CAPABILITIES,
                    ),
                    mode="auto",
                    client_info=types.Implementation(
                        name="dnaforge-package-expiry-seed",
                        version="1.0.0",
                    ),
                ) as client:
                    seeded = await client.list_tools(cache_mode="reload")
                    require(
                        "echo" in [tool.name for tool in seeded.tools],
                        "expiry fixture grant did not start authorized",
                    )

        _expire_agent_identity(
            expiry_root / "control-plane.sqlite3",
            expiry_identity,
        )

        with frozen_http_sidecar(
            executable,
            expiry_root,
            identity=expiry_identity,
        ) as (api_url, _db_path):
            try:
                with tempfile.TemporaryFile(mode="w+") as errlog:
                    async with Client(
                        packaged_transport(
                            executable,
                            api_url,
                            errlog,
                            identity=expiry_identity,
                            capabilities=REAL_CAPABILITIES,
                        ),
                        mode="auto",
                        client_info=types.Implementation(
                            name="dnaforge-package-expiry-verifier",
                            version="1.0.0",
                        ),
                    ):
                        pass
            except Exception as exc:
                require(
                    "GRANT_EXPIRED" in _mcp_error_codes(exc),
                    f"expired catalog denial should report GRANT_EXPIRED, got {exc}",
                )
            else:
                raise ProbeFailure("expired packaged grant completed MCP negotiation")


def _expire_agent_identity(db_path: Path, identity: str) -> None:
    expired_at = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    with closing(sqlite3.connect(db_path)) as connection:
        cursor = connection.execute(
            "UPDATE agent_identity SET expires_at = ? WHERE id = ?",
            (expired_at, identity),
        )
        if cursor.rowcount != 1:
            raise ProbeFailure(
                "expected one agent_identity row for expiry probe, "
                f"updated {cursor.rowcount}: {identity}"
            )
        connection.commit()


def require(condition: bool, label: str) -> None:
    if not condition:
        raise ProbeFailure(label)


async def run(executable: Path) -> None:
    require(executable.is_file(), f"packaged sidecar is not a file: {executable}")
    with loopback_fixture() as (api_url, state):
        await verify_modern(executable, api_url)
        modern_count = len(state.requests)
        await verify_legacy_2024(executable, api_url)

    require(modern_count > 0, "modern probe made no loopback requests")
    require(
        len(state.requests) > modern_count, "legacy probe made no loopback requests"
    )
    require(
        all(request["session"] == SESSION_TOKEN for request in state.requests),
        "probe session header mismatch",
    )
    require(
        all(request["identity"] == AGENT_IDENTITY for request in state.requests),
        "probe identity header mismatch",
    )
    require(
        all(request["capabilities"] == CAPABILITIES for request in state.requests),
        "probe capability header mismatch",
    )
    await verify_real_routes(executable)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("executable", type=Path)
    args = parser.parse_args()
    asyncio.run(run(args.executable.resolve()))
    print("packaged MCP modern + raw 2024 legacy + real grant/job route probe passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
