"""Shared stdio helpers for the development DNAForge MCP companion."""

from __future__ import annotations

import json
import select
import subprocess
import sys
from pathlib import Path
from typing import Any


class MCPClientFailure(RuntimeError):
    pass


class MCPStdioClient:
    def __init__(self, process: subprocess.Popen[Any], *, timeout: float):
        self.process = process
        self.timeout = timeout
        self._next_id = 0

    def request(
        self, method: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        self._next_id += 1
        request_id = self._next_id
        write_stdio_message(
            self.process,
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params or {},
            },
        )
        response = read_stdio_message(self.process, timeout=self.timeout)
        if response.get("id") != request_id:
            raise MCPClientFailure(f"MCP response id mismatch: {response}")
        return response

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        write_stdio_message(
            self.process,
            {
                "jsonrpc": "2.0",
                "method": method,
                "params": params or {},
            },
        )


def start_mcp_companion(
    *,
    api_url: str,
    session_token: str,
    agent_identity: str,
    capabilities: list[str],
    stderr_log: Path,
) -> subprocess.Popen[Any]:
    stderr = stderr_log.open("w")
    return subprocess.Popen(
        [
            sys.executable,
            str(Path(__file__).resolve().parents[2] / "scripts/dnaforge_mcp.py"),
            "--api-url",
            api_url,
            "--session-token",
            session_token,
            "--agent-identity",
            agent_identity,
            "--agent-capabilities",
            json.dumps(capabilities),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=stderr,
        start_new_session=True,
    )


def write_stdio_message(
    process: subprocess.Popen[Any], message: dict[str, Any]
) -> None:
    if process.stdin is None:
        raise MCPClientFailure("MCP companion stdin is not available")
    payload = json.dumps(message, separators=(",", ":")).encode("utf-8")
    process.stdin.write(payload + b"\n")
    process.stdin.flush()


def read_stdio_message(
    process: subprocess.Popen[Any], *, timeout: float
) -> dict[str, Any]:
    if process.stdout is None:
        raise MCPClientFailure("MCP companion stdout is not available")
    ready, _, _ = select.select([process.stdout], [], [], timeout)
    if not ready:
        raise MCPClientFailure("timed out waiting for MCP companion response")

    payload = process.stdout.readline()
    if payload == b"":
        raise MCPClientFailure(
            f"MCP companion exited before response; returncode={process.poll()}"
        )
    try:
        message = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MCPClientFailure("MCP companion returned invalid newline JSON") from exc
    if not isinstance(message, dict):
        raise MCPClientFailure("MCP companion returned a non-object JSON message")
    return message
