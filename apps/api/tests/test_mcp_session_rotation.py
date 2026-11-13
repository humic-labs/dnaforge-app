"""One connected delegated client survives an owning compute generation change."""

from __future__ import annotations

import json
import threading
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import AsyncMock

import httpx
import pytest

from src.mcp_companion.options import CompanionOptions
from src.mcp_companion.sidecar import SidecarClient, SidecarHTTPError


@pytest.mark.asyncio
async def test_connected_client_refreshes_only_rejected_admission_and_keeps_owner(
    tmp_path, monkeypatch
):
    state = {"token": "launch-one", "generation": 1, "mutations": 0}
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((dict(self.headers), body))
            authorized = self.headers.get("X-DNAForge-Session") == state["token"]
            if authorized:
                state["mutations"] += self.path == "/mcp/call"
                response = {"ok": True, "result": {"saved": True}}
            else:
                response = {"error": {"code": "BAD_SESSION", "retriable": True}}
            self.send_response(200 if authorized else 401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f"http://127.0.0.1:{server.server_port}"
    receipt = tmp_path / "owning-app.json"

    def publish():
        receipt.write_text(
            json.dumps(
                {
                    "version": 1,
                    "ownerId": "exact-app",
                    "apiUrl": origin,
                    "generation": state["generation"],
                    "state": "ready",
                    "sessionToken": state["token"],
                }
            )
        )
        receipt.chmod(0o600)

    monkeypatch.setenv("DNAFORGE_MCP_SESSION_AUTHORITY_PATH", str(receipt))
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_AUTHORITY_OWNER", "exact-app")
    publish()
    options = replace(
        CompanionOptions.from_env(),
        api_url=origin,
        session_token="launch-one",
        agent_identity="original-grant",
        agent_capabilities=("read-workspace", "write-workspace"),
        turn_id="original-turn",
    )
    try:
        async with SidecarClient(options) as client:
            assert (await client.discover())["ok"] is True
            state.update(token="launch-two", generation=2)
            publish()
            status, body = await client.call_tool(
                "mol_save_view",
                {"title": "native control"},
                idempotency_key="same-admission",
            )
            assert status == 200 and body["result"]["saved"] is True
        assert state["mutations"] == 1
        assert len(requests) == 3
        for headers, _body in requests:
            assert headers["X-DNAForge-Agent-Identity"] == "original-grant"
            assert headers["X-DNAForge-Turn-Id"] == "original-turn"
            assert json.loads(headers["X-DNAForge-Agent-Capabilities"]) == [
                "read-workspace",
                "write-workspace",
            ]
        assert (
            requests[1][0]["Idempotency-Key"]
            == requests[2][0]["Idempotency-Key"]
            == "same-admission"
        )
        assert requests[1][1] == requests[2][1]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.mark.asyncio
async def test_admitted_job_loss_is_explicit_and_never_resubmits_the_mutation(tmp_path):
    state = {"token": "one", "generation": 1, "admissions": 0}
    receipt = tmp_path / "authority.json"
    origin = "http://127.0.0.1:8107"

    def publish():
        receipt.write_text(
            json.dumps(
                {
                    "version": 1,
                    "ownerId": "same-host",
                    "apiUrl": origin,
                    "generation": state["generation"],
                    "state": "ready",
                    "sessionToken": state["token"],
                }
            )
        )
        receipt.chmod(0o600)

    def handler(request):
        if request.headers["X-DNAForge-Session"] != state["token"]:
            return httpx.Response(401, json={"error": {"code": "BAD_SESSION"}})
        if request.method == "POST":
            state["admissions"] += 1
            return httpx.Response(
                202, json={"ok": True, "jobId": "owned-job", "status": "running"}
            )
        return httpx.Response(404, json={"error": {"code": "UNKNOWN_JOB"}})

    publish()
    options = CompanionOptions(
        api_url=origin,
        session_token="one",
        session_authority_path=str(receipt),
        session_authority_owner="same-host",
        agent_identity="same-grant",
        turn_id="same-turn",
    )
    async with SidecarClient(options, transport=httpx.MockTransport(handler)) as client:
        assert (
            await client.call_tool("mol_save_view", {}, idempotency_key="original")
        )[0] == 202
        state.update(token="two", generation=2)
        publish()
        with pytest.raises(SidecarHTTPError) as caught:
            await client.get_job("owned-job")
        assert caught.value.body["error"]["code"] == "MCP_JOB_LOST_AFTER_RESTART"
        assert caught.value.body["error"]["details"]["stateMayHaveChanged"] is True
        assert caught.value.body["error"]["retriable"] is False
    assert state["admissions"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", ["other-host", "revoked-grant", "network-error"])
async def test_refresh_does_not_cross_authority_or_retry_uncertain_outcomes(
    tmp_path, boundary, monkeypatch
):
    receipt = tmp_path / "authority.json"
    receipt.write_text(
        json.dumps(
            {
                "version": 1,
                "ownerId": "another-host" if boundary == "other-host" else "same-host",
                "apiUrl": "http://127.0.0.1:8107",
                "generation": 2,
                "state": "ready",
                "sessionToken": "new",
            }
        )
    )
    receipt.chmod(0o600)
    calls = []

    def handler(request):
        calls.append(request)
        if boundary == "network-error":
            raise httpx.ReadError("Completion unknown", request=request)
        code = "GRANT_REVOKED" if boundary == "revoked-grant" else "BAD_SESSION"
        return httpx.Response(401, json={"error": {"code": code}})

    options = CompanionOptions(
        api_url="http://127.0.0.1:8107",
        session_token="old",
        session_authority_path=str(receipt),
        session_authority_owner="same-host",
        agent_identity="same-grant",
        turn_id="same-turn",
    )
    async with SidecarClient(options, transport=httpx.MockTransport(handler)) as client:
        if boundary == "network-error":
            refresh_session = AsyncMock(wraps=client._refresh_session)
            monkeypatch.setattr(client, "_refresh_session", refresh_session)
            with pytest.raises(SidecarHTTPError) as caught:
                await client.call_tool("mol_save_view", {}, idempotency_key="once")
            refresh_session.assert_not_called()
            assert caught.value.status_code == 502
            assert caught.value.body["error"]["code"] == "MCP_TRANSPORT_UNAVAILABLE"
            assert caught.value.body["error"]["details"] == {
                "method": "POST",
                "path": "/mcp/call",
                "exceptionType": "ReadError",
                "stateMayHaveChanged": True,
                "requestId": "once",
            }
            assert isinstance(caught.value.__cause__, httpx.ReadError)
            assert caught.value.__cause__.request is calls[0]
        else:
            assert (
                await client.call_tool("mol_save_view", {}, idempotency_key="once")
            )[0] == 401
    assert len(calls) == 1
    assert calls[0].headers["Idempotency-Key"] == "once"
    assert calls[0].headers["X-DNAForge-Session"] == "old"
    assert calls[0].headers["X-DNAForge-Agent-Identity"] == "same-grant"
    assert calls[0].headers["X-DNAForge-Turn-Id"] == "same-turn"
