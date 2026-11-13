from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from src.control_plane import initialize_control_plane
from src.main import app

MCP_TOKEN = "test-mcp-caller-token"
CALLER_ID = "local-in-app-chat"


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _seed_unrelated_identities(store, count: int) -> None:
    for index in range(count):
        store.ensure_agent_identity(
            f"agent_http_unrelated_{index:03d}",
            scope=["write-workspace"],
            label=f"Unrelated caller {index}",
            kind="http-api-key",
            origin="tool-key",
            created_at=f"2026-09-08T12:{index // 60:02d}:{index % 60:02d}Z",
        )


@pytest.mark.parametrize("unrelated_count", [199, 200])
def test_current_caller_resolves_exact_identity_across_display_page_boundary(
    tmp_path, monkeypatch, unrelated_count
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", CALLER_ID)
    store.ensure_agent_identity(
        CALLER_ID,
        scope=["read-workspace", "modify-tabs"],
        label="In-app Strider",
        kind="in-app",
        origin="app",
        created_at="2020-01-01T00:00:00Z",
    )
    _seed_unrelated_identities(store, unrelated_count)

    response = TestClient(app).get(
        "/mcp/caller",
        headers={"X-DNAForge-Session": MCP_TOKEN},
    )

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.json() == {
        "ok": True,
        "caller": {
            "agentIdentityId": CALLER_ID,
            "effectiveCapabilities": ["read-workspace", "modify-tabs"],
        },
    }


def test_current_caller_uses_bound_identity_and_attenuates_spoofed_scope(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", CALLER_ID)
    store.ensure_agent_identity(
        CALLER_ID,
        scope=["read-workspace", "modify-tabs"],
        kind="in-app",
        origin="app",
    )
    store.ensure_agent_identity(
        "spoofed-agent",
        scope=["write-workspace"],
        kind="stdio-mcp",
        origin="local-mcp",
    )

    response = TestClient(app).get(
        "/mcp/caller",
        headers={
            "X-DNAForge-Session": MCP_TOKEN,
            "X-DNAForge-Agent-Identity": "spoofed-agent",
            "X-DNAForge-Agent-Capabilities": "read-workspace,write-workspace",
        },
    )

    assert response.status_code == 200
    assert response.json()["caller"] == {
        "agentIdentityId": CALLER_ID,
        "effectiveCapabilities": ["read-workspace"],
    }


@pytest.mark.parametrize(
    ("grant_state", "expected_code"),
    [
        ("missing", "GRANT_MISSING"),
        ("revoked", "GRANT_REVOKED"),
        ("expired", "GRANT_EXPIRED"),
        ("malformed-expiry", "GRANT_EXPIRED"),
        ("blank-expiry", "GRANT_EXPIRED"),
    ],
)
def test_current_caller_preserves_persistent_grant_failures(
    tmp_path, monkeypatch, grant_state, expected_code
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", CALLER_ID)
    if grant_state != "missing":
        expires_at = None
        if grant_state == "expired":
            expires_at = _iso(datetime.now(timezone.utc) - timedelta(hours=1))
        elif grant_state == "malformed-expiry":
            expires_at = "not-a-timestamp"
        elif grant_state == "blank-expiry":
            expires_at = ""
        store.ensure_agent_identity(
            CALLER_ID,
            scope=["read-workspace"],
            expires_at=expires_at,
            revoked=grant_state == "revoked",
            kind="in-app",
            origin="app",
        )

    response = TestClient(app).get(
        "/mcp/caller",
        headers={"X-DNAForge-Session": MCP_TOKEN},
    )

    assert response.status_code == 401
    assert response.headers["Cache-Control"] == "no-store"
    assert response.json()["error"]["code"] == expected_code


def test_current_caller_has_no_header_identity_fallback(tmp_path, monkeypatch):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.delenv("DNAFORGE_MCP_AGENT_IDENTITY", raising=False)
    store.ensure_agent_identity(
        "header-only-agent",
        scope=["read-workspace"],
        kind="stdio-mcp",
        origin="local-mcp",
    )

    response = TestClient(app).get(
        "/mcp/caller",
        headers={
            "X-DNAForge-Session": MCP_TOKEN,
            "X-DNAForge-Agent-Identity": "header-only-agent",
        },
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "GRANT_MISSING"


def test_current_caller_session_rejection_is_not_cacheable(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)

    response = TestClient(app).get("/mcp/caller")

    assert response.status_code == 401
    assert response.headers["Cache-Control"] == "no-store"
    assert response.json()["error"]["code"] == "BAD_SESSION"
