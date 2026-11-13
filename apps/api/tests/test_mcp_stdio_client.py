"""Tests for shared MCP stdio framing helpers."""

from __future__ import annotations

import io
import json
import os
from typing import Any

import pytest

from src.agent_workflow_harness.stdio_client import (
    MCPClientFailure,
    MCPStdioClient,
    read_stdio_message,
    write_stdio_message,
)


class FlushableBytesIO(io.BytesIO):
    def flush(self) -> None:
        return None


class FakeProcess:
    def __init__(self, stdout: Any | None = None):
        self.stdin = FlushableBytesIO()
        self.stdout = stdout

    def poll(self) -> int | None:
        return None


def framed_message(message: dict[str, Any]) -> bytes:
    return json.dumps(message, separators=(",", ":")).encode("utf-8") + b"\n"


def stdout_pipe_with(message: dict[str, Any]) -> Any:
    reader, writer = os.pipe()
    os.write(writer, framed_message(message))
    os.close(writer)
    return os.fdopen(reader, "rb")


def test_write_stdio_message_uses_mcp_newline_json_framing():
    process = FakeProcess()

    write_stdio_message(process, {"jsonrpc": "2.0", "method": "ping"})

    assert process.stdin.getvalue() == b'{"jsonrpc":"2.0","method":"ping"}\n'


def test_read_stdio_message_decodes_single_newline_json_response():
    stdout = stdout_pipe_with({"jsonrpc": "2.0", "id": 1, "result": {"ok": True}})
    process = FakeProcess(stdout=stdout)

    assert read_stdio_message(process, timeout=1.0) == {
        "jsonrpc": "2.0",
        "id": 1,
        "result": {"ok": True},
    }


def test_stdio_client_request_writes_request_and_validates_response_id():
    stdout = stdout_pipe_with({"jsonrpc": "2.0", "id": 1, "result": {"ok": True}})
    process = FakeProcess(stdout=stdout)
    client = MCPStdioClient(process, timeout=1.0)

    response = client.request("ping", {})

    assert response["result"] == {"ok": True}
    assert b'"method":"ping"' in process.stdin.getvalue()


def test_stdio_client_rejects_mismatched_response_id():
    stdout = stdout_pipe_with({"jsonrpc": "2.0", "id": 999, "result": {}})
    process = FakeProcess(stdout=stdout)
    client = MCPStdioClient(process, timeout=1.0)

    with pytest.raises(MCPClientFailure, match="response id mismatch"):
        client.request("ping", {})
