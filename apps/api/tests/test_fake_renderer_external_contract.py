""" — pin the fake_renderer's contract for `external.*` tool calls.

The toolflow-coverage-manifest documents this gap: fake_renderer only
dispatches `get_workspace`; everything else (including the new
`external.fetch` and `external.xref` tools registered by 
returns 404 + UNKNOWN_TOOL. Without a test, a future fake_renderer
extension that silently starts handling `external.*` would diverge from
the real renderer's contract — and the harness's pass/fail signal would
quietly drift away from the real-renderer test surface.

These tests boot the fake_renderer subprocess, post tool calls with a
valid session header, and assert it 404s for `external.fetch` and
`external.xref`.
"""

from __future__ import annotations

import http.client
import json
import socket
import time

import pytest

from src.agent_workflow_harness.fake_renderer import start_fake_renderer


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for(url_path: str, port: int, timeout_s: float = 5.0) -> None:
    """Poll until the fake renderer responds. Pure stdlib — no httpx
    dependency for a tiny health check."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1.0)
            conn.request("GET", url_path)
            resp = conn.getresponse()
            resp.read()
            conn.close()
            if resp.status == 200:
                return
        except Exception:
            pass
        time.sleep(0.05)
    raise RuntimeError(f"fake renderer did not become ready on port {port}")


@pytest.fixture
def fake_renderer(tmp_path):
    port = _find_free_port()
    token = "fake-renderer-test-token"
    proc = start_fake_renderer(
        renderer_port=port,
        renderer_token=token,
        renderer_log=tmp_path / "renderer-calls.jsonl",
        stdout_log=tmp_path / "renderer-stdout.log",
    )
    try:
        _wait_for("/health", port)
        yield port, token
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except Exception:
            proc.kill()


def _post_tool_call(port: int, token: str, tool_name: str) -> tuple[int, dict]:
    body = json.dumps(
        {
            "tool_name": tool_name,
            "args": {},
            "agent_identity": "test-agent",
            "action_id": "test-action",
        }
    ).encode("utf-8")
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2.0)
    try:
        conn.request(
            "POST",
            "/__tools/call",
            body=body,
            headers={
                "content-type": "application/json",
                "content-length": str(len(body)),
                "x-dnaforge-session": token,
            },
        )
        resp = conn.getresponse()
        return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
    finally:
        conn.close()


def test_fake_renderer_returns_404_for_external_fetch(fake_renderer):
    """The toolflow tracker documents this gap. If a future change to
    fake_renderer silently accepts `external.fetch`, the harness would
    diverge from the real renderer's contract without anyone noticing."""
    port, token = fake_renderer
    status, body = _post_tool_call(port, token, "external.fetch")
    assert status == 404
    assert body["ok"] is False
    assert body["error"]["code"] == "UNKNOWN_TOOL"


def test_fake_renderer_returns_404_for_external_xref(fake_renderer):
    """Same contract as external.fetch — fake_renderer only handles
    `get_workspace`."""
    port, token = fake_renderer
    status, body = _post_tool_call(port, token, "external.xref")
    assert status == 404
    assert body["ok"] is False
    assert body["error"]["code"] == "UNKNOWN_TOOL"


def test_fake_renderer_still_dispatches_get_workspace(fake_renderer):
    """Sanity check — the existing get_workspace happy-path still works
    after the contract pin. Without this, a regression to the fake
    renderer's only working tool wouldn't surface in the new external.*
    tests above."""
    port, token = fake_renderer
    status, body = _post_tool_call(port, token, "get_workspace")
    assert status == 200
    assert body["ok"] is True
    assert body["audit_id"] == "renderer-audit-harness"
