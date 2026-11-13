from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from src.control_plane import get_control_plane_store, initialize_control_plane
from src.routes.mcp_auth import (
    bootstrap_session_grant,
    check_grant,
    check_grant_from_env,
    check_session,
    resolve_identity_context,
)

MCP_TOKEN = "test-mcp-token"
IDENTITY = "local-in-app-chat"


@pytest.fixture(autouse=True)
def _isolated_control_plane(tmp_path, monkeypatch):
    db_path = tmp_path / "control.sqlite3"
    monkeypatch.setenv("DNAFORGE_SIDECAR_DB_PATH", str(db_path))
    initialize_control_plane(db_path)
    yield


def _seed_identity(
    identity_id: str = IDENTITY,
    *,
    scope: list[str] | None = None,
    expires_at: str | None = None,
    revoked: bool = False,
) -> None:
    get_control_plane_store().ensure_agent_identity(
        identity_id,
        scope=scope or ["debug.echo"],
        expires_at=expires_at,
        revoked=revoked,
    )


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def test_check_grant_returns_none_for_active_identity():
    _seed_identity()
    assert check_grant(IDENTITY) is None


def test_check_grant_reports_missing_row():
    err = check_grant("never-seeded")
    assert err is not None
    assert err["ok"] is False
    assert err["error"]["code"] == "GRANT_MISSING"
    assert err["error"]["retriable"] is False
    assert err["error"]["details"]["agent_identity_id"] == "never-seeded"


def test_check_grant_reports_revoked_row():
    _seed_identity(revoked=True)
    err = check_grant(IDENTITY)
    assert err is not None
    assert err["error"]["code"] == "GRANT_REVOKED"
    assert err["error"]["retriable"] is False


def test_check_grant_reports_expired_row():
    _seed_identity(expires_at=_iso(datetime.now(timezone.utc) - timedelta(hours=1)))
    err = check_grant(IDENTITY)
    assert err is not None
    assert err["error"]["code"] == "GRANT_EXPIRED"
    assert err["error"]["retriable"] is False
    assert "expires_at" in err["error"]["details"]


def test_check_grant_accepts_future_expiry():
    _seed_identity(expires_at=_iso(datetime.now(timezone.utc) + timedelta(hours=1)))
    assert check_grant(IDENTITY) is None


def test_check_grant_treats_null_expiry_as_no_expiry():
    _seed_identity(expires_at=None)
    assert check_grant(IDENTITY) is None


def test_check_grant_handles_plus_offset_expiry_format():

    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    assert "+00:00" in future and "Z" not in future
    _seed_identity(expires_at=future)
    assert check_grant(IDENTITY) is None


@pytest.mark.parametrize("expires_at", ["not-a-timestamp", "", "   "])
def test_check_grant_rejects_malformed_expiry_safely(expires_at):
    _seed_identity(expires_at=expires_at)
    result = check_grant(IDENTITY)
    assert result is not None
    assert result["ok"] is False
    assert result["error"]["code"] == "GRANT_EXPIRED"
    assert result["error"]["retriable"] is False
    assert result["error"]["details"]["agent_identity_id"] == IDENTITY
    assert result["error"]["details"]["expires_at"] == expires_at


def test_check_session_enforces_grant_when_identity_env_set(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", IDENTITY)
    _seed_identity(revoked=True)
    err = check_session(MCP_TOKEN)
    assert err is not None
    assert err["error"]["code"] == "GRANT_REVOKED"


def test_check_session_skips_grant_check_when_identity_env_unset(monkeypatch):

    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.delenv("DNAFORGE_MCP_AGENT_IDENTITY", raising=False)

    assert check_session(MCP_TOKEN) is None


def test_check_session_still_reports_bad_token_first(monkeypatch):

    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", "never-seeded")
    err = check_session("wrong-token")
    assert err is not None
    assert err["error"]["code"] == "BAD_SESSION"


def test_check_grant_from_env_returns_none_when_identity_env_unset(monkeypatch):
    monkeypatch.delenv("DNAFORGE_MCP_AGENT_IDENTITY", raising=False)
    assert check_grant_from_env() is None


def test_bootstrap_session_grant_creates_row_when_absent(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", IDENTITY)
    monkeypatch.setenv(
        "DNAFORGE_MCP_GRANT_CAPABILITIES",
        "debug.echo,read-workspace",
    )
    assert get_control_plane_store().get_agent_identity(IDENTITY) is None

    bootstrap_session_grant()

    row = get_control_plane_store().get_agent_identity(IDENTITY)
    assert row is not None
    assert row["revoked"] == 0
    assert row["expires_at"] is None

    assert "debug.echo" in row["scope_json"]
    assert "read-workspace" in row["scope_json"]


def test_bootstrap_session_grant_is_idempotent(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", IDENTITY)
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "debug.echo")
    bootstrap_session_grant()
    bootstrap_session_grant()
    row = get_control_plane_store().get_agent_identity(IDENTITY)
    assert row is not None


def test_bootstrap_session_grant_widens_active_managed_identity(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", IDENTITY)
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "*,read-workspace")
    get_control_plane_store().ensure_agent_identity(
        IDENTITY,
        scope=["read-workspace"],
        label="In-app Strider",
        kind="in-app",
        origin="app",
    )

    bootstrap_session_grant()

    row = get_control_plane_store().get_agent_identity(IDENTITY)
    assert row is not None
    assert row["scope_json"] == ["*", "read-workspace"]


def test_bootstrap_session_grant_does_not_widen_external_identity(monkeypatch):
    external_identity = "agent-http-external"
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", external_identity)
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "*")
    get_control_plane_store().ensure_agent_identity(
        external_identity,
        scope=["read-workspace"],
        label="External key",
        kind="http-api-key",
        api_key_hash="sha256:external",
        origin="tool-key",
    )

    bootstrap_session_grant()

    row = get_control_plane_store().get_agent_identity(external_identity)
    assert row is not None
    assert row["scope_json"] == ["read-workspace"]


def test_bootstrap_session_grant_does_not_override_revoked_row(monkeypatch):

    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", IDENTITY)
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "debug.echo")
    _seed_identity(revoked=True)

    bootstrap_session_grant()

    row = get_control_plane_store().get_agent_identity(IDENTITY)
    assert row is not None
    assert row["revoked"] == 1


def test_bootstrap_session_grant_noop_when_env_unset(monkeypatch):
    monkeypatch.delenv("DNAFORGE_MCP_AGENT_IDENTITY", raising=False)
    bootstrap_session_grant()


def test_requested_narrow_capability_can_be_attenuated_from_legacy_broad_grant():
    context = resolve_identity_context(
        {
            "id": IDENTITY,
            "scope_json": ["read-workspace", "write-workspace"],
        },
        '["read-workspace", "edit-primers"]',
        auth_method="session",
    )

    assert context["effective_capabilities"] == [
        "read-workspace",
        "edit-primers",
    ]


def test_requested_broad_capability_cannot_be_attenuated_from_narrow_grant():
    context = resolve_identity_context(
        {"id": IDENTITY, "scope_json": ["edit-primers"]},
        '["write-workspace"]',
        auth_method="session",
    )

    assert context["effective_capabilities"] == []


def test_wildcard_grant_attenuates_to_the_concrete_capabilities_requested():
    context = resolve_identity_context(
        {"id": IDENTITY, "scope_json": ["*"]},
        '["read-workspace", "edit-primers"]',
        auth_method="session",
    )

    assert context["effective_capabilities"] == [
        "read-workspace",
        "edit-primers",
    ]
