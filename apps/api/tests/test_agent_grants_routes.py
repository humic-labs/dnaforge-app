from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from src.control_plane import initialize_control_plane
from src.main import app
from src.routes.agent_grants import ALLOWED_API_KEY_SCOPES, DEFAULT_LOCAL_MCP_SCOPES
from src.routes.mcp_auth import get_identity_for_api_key, hash_api_key

MCP_TOKEN = "test-mcp-token"


def test_committed_grant_lifecycle_observations_do_not_export_keys_or_binding_identity(
    tmp_path, monkeypatch
):
    from src.external_access_observation import valid_observation
    from src.routes import agent_grants

    store = initialize_control_plane(tmp_path / "lifecycle.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_EXTERNAL_ACCESS_OBSERVATIONS", "1")
    receipts = []

    async def delivered(receipt):
        assert valid_observation(receipt)
        receipts.append(receipt)
        return True

    monkeypatch.setattr(agent_grants, "emit_external_access_observation", delivered)
    client = TestClient(app)
    created = client.post(
        "/agent-grants/api-keys",
        headers=_auth_headers(),
        json={"label": "PRIVATE_SCRIPT_LABEL", "scopes": ["read-workspace"]},
    )
    assert created.status_code == 200
    script = created.json()
    local_response = client.post(
        "/agent-grants/local-mcp",
        headers=_auth_headers(),
        json={"label": "PRIVATE_LOCAL_LABEL"},
    )
    assert local_response.status_code == 200
    local = local_response.json()
    bound = client.post(
        "/agent-grants/local-mcp/bind",
        headers=_auth_headers(),
        json={
            "grantId": local["grant"]["id"],
            "workspaceId": "PRIVATE_WORKSPACE_ID",
            "workspaceLabel": "PRIVATE_WORKSPACE_LABEL",
        },
    )
    assert bound.status_code == 200
    revoked = client.delete(
        f'/agent-grants/{script["grant"]["id"]}', headers=_auth_headers()
    )
    assert revoked.status_code == 200
    assert [value["access_stage"] for value in receipts] == [
        "grant_create",
        "grant_create",
        "workspace_bind",
        "selected_revoke",
    ]
    assert receipts[0]["access_scope_class"] == "read"
    assert receipts[1]["access_expiry_class"] == "twelve_hours"
    assert receipts[2]["access_authority"] == "committed_binding"
    assert len({value["operation_id"] for value in receipts}) == 4
    text = json.dumps(receipts)
    for secret in (
        script["apiKey"],
        local["apiKey"],
        script["grant"]["id"],
        local["grant"]["id"],
        "PRIVATE_SCRIPT_LABEL",
        "PRIVATE_LOCAL_LABEL",
        "PRIVATE_WORKSPACE_ID",
        "PRIVATE_WORKSPACE_LABEL",
    ):
        assert secret not in text
    assert store.get_agent_identity(script["grant"]["id"])["revoked"]
    assert (
        store.get_agent_identity(local["grant"]["id"])["bound_workspace_id"]
        == "PRIVATE_WORKSPACE_ID"
    )


def test_optional_observation_failure_cannot_replace_one_time_key_or_revocation(
    tmp_path, monkeypatch
):
    from src.routes import agent_grants

    initialize_control_plane(tmp_path / "optional-failure.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_EXTERNAL_ACCESS_OBSERVATIONS", "1")

    def failed(*_args, **_kwargs):
        raise OSError("optional observation unavailable")

    monkeypatch.setattr(agent_grants, "committed_grant_observation", failed)
    client = TestClient(app)
    response = client.post(
        "/agent-grants/api-keys",
        headers=_auth_headers(),
        json={"label": "Private script", "scopes": ["read-workspace"]},
    )
    assert response.status_code == 200
    created = response.json()
    assert get_identity_for_api_key(created["apiKey"])[0] is not None
    assert (
        client.delete(
            f'/agent-grants/{created["grant"]["id"]}', headers=_auth_headers()
        ).status_code
        == 200
    )
    assert get_identity_for_api_key(created["apiKey"])[0] is None


def _auth_headers(token: str = MCP_TOKEN) -> dict[str, str]:
    return {"X-DNAForge-Session": token}


def _timestamp(seconds: int) -> str:
    value = datetime(2026, 9, 8, tzinfo=timezone.utc) + timedelta(seconds=seconds)
    return value.isoformat().replace("+00:00", "Z")


def _seed_list_grant(
    store,
    identity_id: str,
    *,
    created_at: str,
    expires_at: str | None = None,
    origin: str = "tool-key",
) -> None:
    store.ensure_agent_identity(
        identity_id,
        scope=["read-workspace"],
        label=identity_id,
        kind="http-api-key" if origin == "tool-key" else "stdio-mcp",
        origin=origin,
        created_at=created_at,
        expires_at=expires_at,
    )


def test_agent_grants_list_returns_active_rows_with_last_used(tmp_path, monkeypatch):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", "local-in-app-chat")
    store.ensure_agent_identity(
        "local-in-app-chat",
        scope=["read-workspace", "modify-tabs"],
        label="In-app Strider",
        kind="in-app",
    )
    store.ensure_agent_identity(
        "agent_stdio_bridge",
        scope=["read-workspace"],
        label="MCP stdio bridge",
        kind="stdio-mcp",
    )
    store.insert_agent_action(
        agent_identity_id="agent_stdio_bridge",
        tool_name="echo",
        parameters={"message": "used"},
        authorized_scope=["read-workspace"],
    )
    client = TestClient(app)

    response = client.get("/agent-grants", headers=_auth_headers())

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    by_id = {grant["id"]: grant for grant in body["grants"]}
    assert by_id["local-in-app-chat"]["kind"] == "in-app"
    assert by_id["local-in-app-chat"]["origin"] == "app"
    assert by_id["local-in-app-chat"]["isDevelopment"] is False
    assert by_id["local-in-app-chat"]["label"] == "In-app Strider"
    assert by_id["local-in-app-chat"]["scopes"] == ["read-workspace", "modify-tabs"]
    assert by_id["agent_stdio_bridge"]["origin"] == "local-mcp"
    assert by_id["agent_stdio_bridge"]["lastUsedAt"] is not None
    assert body["hiddenDevelopmentGrantCount"] == 0


def test_agent_identity_management_columns_migrate_existing_database(tmp_path):
    db_path = tmp_path / "control.sqlite3"
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE agent_identity (
          id TEXT PRIMARY KEY,
          parent_human_identity_id TEXT NOT NULL,
          scope_json TEXT NOT NULL,
          expires_at TEXT,
          revoked INTEGER NOT NULL DEFAULT 0
        )
        """)
    conn.execute("""
        INSERT INTO agent_identity (
          id, parent_human_identity_id, scope_json, expires_at, revoked
        )
        VALUES ('legacy-agent', 'local-human', '["read-workspace"]', NULL, 0)
        """)
    conn.commit()
    conn.close()

    store = initialize_control_plane(db_path)
    row = store.get_agent_identity("legacy-agent")

    assert row is not None
    assert row["kind"] == "stdio-mcp"
    assert row["created_at"] is not None
    assert row["api_key_hash"] is None
    assert "origin" in row
    assert "environment_id" in row
    assert "created_by" in row
    assert "client_name" in row
    assert "client_version" in row
    assert "bound_workspace_id" in row
    assert "bound_workspace_label" in row


def test_agent_grants_list_coerces_env_identity_to_in_app(tmp_path, monkeypatch):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", "local-in-app-chat")
    store.ensure_agent_identity(
        "local-in-app-chat",
        scope=["read-workspace"],
        label=None,
        kind="stdio-mcp",
    )
    client = TestClient(app)

    response = client.get("/agent-grants", headers=_auth_headers())

    assert response.status_code == 200
    grant = response.json()["grants"][0]
    assert grant["id"] == "local-in-app-chat"
    assert grant["kind"] == "in-app"
    assert grant["origin"] == "app"
    assert grant["label"] == "In-app Strider"


def test_agent_grants_hide_dev_test_rows_by_default(tmp_path, monkeypatch):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", "local-in-app-chat")
    store.ensure_agent_identity(
        "local-in-app-chat",
        scope=["read-workspace"],
        label="In-app Strider",
        kind="in-app",
        origin="app",
    )
    store.ensure_agent_identity(
        "agent_stdio_bridge",
        scope=["read-workspace"],
        label="MCP stdio bridge",
        kind="stdio-mcp",
        origin="local-mcp",
    )
    store.ensure_agent_identity(
        "local-agent",
        scope=["modify-tabs"],
        label="Local agent",
        kind="stdio-mcp",
    )
    store.ensure_agent_identity(
        "dna114-live-mcp-e2e",
        scope=["*"],
        label=" E2E",
        kind="stdio-mcp",
        origin="dev-test",
    )
    client = TestClient(app)

    response = client.get("/agent-grants", headers=_auth_headers())

    assert response.status_code == 200
    body = response.json()
    ids = {grant["id"] for grant in body["grants"]}
    assert ids == {"agent_stdio_bridge", "local-in-app-chat"}
    assert body["hiddenDevelopmentGrantCount"] == 2


def test_agent_grants_include_dev_test_rows_when_requested(tmp_path, monkeypatch):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    store.ensure_agent_identity(
        "local-agent",
        scope=["modify-tabs"],
        label="Local agent",
        kind="stdio-mcp",
    )
    store.ensure_agent_identity(
        "agent_stdio_bridge",
        scope=["read-workspace"],
        label="MCP stdio bridge",
        kind="stdio-mcp",
    )
    client = TestClient(app)

    response = client.get("/agent-grants?includeDevTest=true", headers=_auth_headers())

    assert response.status_code == 200
    body = response.json()
    by_id = {grant["id"]: grant for grant in body["grants"]}
    assert by_id["local-agent"]["origin"] == "dev-test"
    assert by_id["local-agent"]["isDevelopment"] is True
    assert by_id["agent_stdio_bridge"]["origin"] == "local-mcp"
    assert by_id["agent_stdio_bridge"]["isDevelopment"] is False
    assert body["hiddenDevelopmentGrantCount"] == 0


@pytest.mark.parametrize(
    ("newer_count", "expected_has_more"), [(199, False), (200, True)]
)
def test_agent_grants_page_boundary_is_explicit(
    tmp_path, monkeypatch, newer_count, expected_has_more
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    _seed_list_grant(
        store,
        "agent_http_oldest",
        created_at=_timestamp(0),
    )
    for index in range(newer_count):
        _seed_list_grant(
            store,
            f"agent_http_newer_{index:03d}",
            created_at=_timestamp(index + 1),
        )
    client = TestClient(app)

    first = client.get("/agent-grants", headers=_auth_headers())

    assert first.status_code == 200
    first_body = first.json()
    assert len(first_body["grants"]) == 200
    assert first_body["hasMore"] is expected_has_more
    assert (first_body["nextCursor"] is not None) is expected_has_more
    if not expected_has_more:
        assert "agent_http_oldest" in {grant["id"] for grant in first_body["grants"]}
        return

    second = client.get(
        "/agent-grants",
        params={"cursor": first_body["nextCursor"]},
        headers=_auth_headers(),
    )
    assert second.status_code == 200
    second_body = second.json()
    assert [grant["id"] for grant in second_body["grants"]] == ["agent_http_oldest"]
    assert second_body["hasMore"] is False
    assert second_body["nextCursor"] is None


@pytest.mark.parametrize("crowding_kind", ["expired", "hidden"])
def test_agent_grants_filters_expired_and_hidden_rows_before_page_selection(
    tmp_path, monkeypatch, crowding_kind
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    _seed_list_grant(
        store,
        "agent_http_active_oldest",
        created_at=_timestamp(0),
    )
    for index in range(200):
        _seed_list_grant(
            store,
            f"{crowding_kind}-newer-{index:03d}",
            created_at=_timestamp(index + 1),
            expires_at=("2020-01-01T00:00:00Z" if crowding_kind == "expired" else None),
            origin="dev-test" if crowding_kind == "hidden" else "tool-key",
        )
    client = TestClient(app)

    response = client.get("/agent-grants", headers=_auth_headers())

    assert response.status_code == 200
    body = response.json()
    assert [grant["id"] for grant in body["grants"]] == ["agent_http_active_oldest"]
    assert body["hasMore"] is False
    assert body["nextCursor"] is None
    assert body["hiddenDevelopmentGrantCount"] == (
        200 if crowding_kind == "hidden" else 0
    )


def test_agent_grants_rejects_bad_session(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app)

    response = client.get("/agent-grants", headers=_auth_headers("wrong"))

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "BAD_SESSION"


@pytest.mark.parametrize("expiry", ["", "not-a-timestamp"])
def test_agent_grants_excludes_invalid_expiry_from_list_and_hidden_count(
    tmp_path, monkeypatch, expiry
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    for origin in ["tool-key", "dev-test"]:
        _seed_list_grant(
            store, origin, created_at=_timestamp(0), expires_at=expiry, origin=origin
        )
    client = TestClient(app)
    for include_dev in [False, True]:
        body = client.get(
            "/agent-grants",
            params={"includeDevTest": include_dev},
            headers=_auth_headers(),
        ).json()
        assert body["grants"] == []
        assert body["hiddenDevelopmentGrantCount"] == 0


def test_agent_grants_continues_without_omissions_after_activity_and_insert(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    for index in range(4):
        _seed_list_grant(store, f"grant-{index}", created_at=_timestamp(index))
    client = TestClient(app)
    first = client.get(
        "/agent-grants", params={"pageSize": 2}, headers=_auth_headers()
    ).json()
    assert [grant["id"] for grant in first["grants"]] == ["grant-3", "grant-2"]
    store.insert_agent_action(
        agent_identity_id="grant-1",
        tool_name="echo",
        parameters={},
        authorized_scope=["read-workspace"],
    )
    _seed_list_grant(store, "newly-created", created_at=_timestamp(5))
    second = client.get(
        "/agent-grants",
        params={"pageSize": 2, "cursor": first["nextCursor"]},
        headers=_auth_headers(),
    ).json()
    assert [grant["id"] for grant in second["grants"]] == ["grant-1", "grant-0"]
    assert second["hasMore"] is False
    assert second["nextCursor"] is None
    assert second["grants"][0]["lastUsedAt"] is not None


@pytest.mark.parametrize("cursor", ["garbage", "LTE", "W10", "WyJkYXRlIiwxXQ"])
def test_agent_grants_rejects_invalid_cursor(tmp_path, monkeypatch, cursor):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    response = TestClient(app).get(
        "/agent-grants", params={"cursor": cursor}, headers=_auth_headers()
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_GRANT_CURSOR"


def test_agent_grants_create_api_key_stores_hash_only(tmp_path, monkeypatch):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app)

    response = client.post(
        "/agent-grants/api-keys",
        json={
            "label": "Nightly import job",
            "scopes": [
                "read-workspace",
                "write-workspace",
                "edit-primers",
                "finalize-assembly",
                "external-fetch:annotation",
            ],
        },
        headers=_auth_headers(),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["apiKey"].startswith("dna_key_")
    assert body["grant"]["label"] == "Nightly import job"
    assert body["grant"]["origin"] == "tool-key"
    assert body["grant"]["isDevelopment"] is False
    assert "edit-primers" in body["grant"]["scopes"]
    assert "finalize-assembly" in body["grant"]["scopes"]
    row = store.get_agent_identity(body["grant"]["id"])
    assert row is not None
    assert row["kind"] == "http-api-key"
    assert row["api_key_hash"] == hash_api_key(body["apiKey"])
    assert row["api_key_hash"] != body["apiKey"]
    assert row["origin"] == "tool-key"
    assert row["created_by"] == "local-human"


def test_app_mints_expiring_local_mcp_discovery_grant_without_returning_launch_token(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app)

    earliest_expiry = datetime.now(timezone.utc) + timedelta(hours=12)
    response = client.post(
        "/agent-grants/local-mcp",
        json={"label": "External MCP client"},
        headers=_auth_headers(),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["apiKey"].startswith("dna_key_")
    assert MCP_TOKEN not in response.text
    assert body["grant"]["kind"] == "stdio-mcp"
    assert body["grant"]["origin"] == "local-mcp"
    assert body["grant"]["scopes"] == sorted(DEFAULT_LOCAL_MCP_SCOPES)
    assert {"edit-primers", "edit-assembly", "edit-protocols"}.issubset(
        body["grant"]["scopes"]
    )
    assert "external-compute:discover" in body["grant"]["scopes"]
    expires_at = datetime.fromisoformat(
        body["grant"]["expiresAt"].replace("Z", "+00:00")
    )
    assert (
        earliest_expiry
        <= expires_at
        <= datetime.now(timezone.utc) + timedelta(hours=12)
    )
    assert "external-compute:submit" not in body["grant"]["scopes"]
    assert "external-compute:manage" not in body["grant"]["scopes"]
    assert "submit-feedback" in body["grant"]["scopes"]
    assert body["grant"]["expiresAt"] is not None
    assert "finalize-assembly" in body["grant"]["scopes"]
    assert "write-workspace" in body["grant"]["scopes"]
    assert "modify-settings" not in body["grant"]["scopes"]
    row = store.get_agent_identity(body["grant"]["id"])
    assert row is not None
    assert row["api_key_hash"] == hash_api_key(body["apiKey"])
    assert row["api_key_hash"] != body["apiKey"]


def test_app_binds_local_mcp_grant_to_exact_workspace_and_lists_connection_status(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app)
    minted = client.post(
        "/agent-grants/local-mcp",
        json={"label": "External MCP client"},
        headers=_auth_headers(),
    ).json()
    grant_id = minted["grant"]["id"]

    bound = client.post(
        "/agent-grants/local-mcp/bind",
        json={
            "grantId": grant_id,
            "workspaceId": 'folders:["/Users/scientist/project"]',
            "workspaceLabel": "/Users/scientist/project",
        },
        headers=_auth_headers(),
    )
    action_id = store.insert_agent_action(
        agent_identity_id=grant_id,
        tool_name="get_workspace",
        parameters={},
        authorized_scope=["read-workspace"],
    )
    store.complete_agent_action(action_id, result={"workspace": "project"})
    listed = client.get("/agent-grants", headers=_auth_headers()).json()

    assert bound.status_code == 200
    row = store.get_agent_identity(grant_id)
    assert row is not None
    assert row["bound_workspace_id"] == 'folders:["/Users/scientist/project"]'
    grant = next(item for item in listed["grants"] if item["id"] == grant_id)
    assert grant["boundWorkspace"] == "/Users/scientist/project"
    assert grant["lastCallStatus"] == "completed"
    assert grant["lastToolName"] == "get_workspace"

    refused_action_id = store.insert_agent_action(
        agent_identity_id=grant_id,
        tool_name="modify_settings",
        parameters={},
        authorized_scope=["read-workspace"],
        authorization_state="denied",
    )
    store.complete_agent_action(
        refused_action_id,
        error={"code": "INSUFFICIENT_SCOPE", "message": "Not authorized"},
    )
    relisted = client.get("/agent-grants", headers=_auth_headers()).json()
    grant = next(item for item in relisted["grants"] if item["id"] == grant_id)
    assert grant["lastCallStatus"] == "refused"
    assert grant["lastToolName"] == "modify_settings"


def test_agent_grants_default_api_key_has_every_supported_scope(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app)

    response = client.post(
        "/agent-grants/api-keys",
        json={"label": "Broad external agent"},
        headers=_auth_headers(),
    )

    assert response.status_code == 200
    assert response.json()["grant"]["scopes"] == sorted(ALLOWED_API_KEY_SCOPES)
    assert "modify-settings" in ALLOWED_API_KEY_SCOPES
    assert "external-fetch:homology-search" in ALLOWED_API_KEY_SCOPES
    assert "external-compute:tm" in ALLOWED_API_KEY_SCOPES


def test_agent_grants_rejects_explicitly_empty_api_key_scope(tmp_path, monkeypatch):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app)

    response = client.post(
        "/agent-grants/api-keys",
        json={"label": "No permissions", "scopes": []},
        headers=_auth_headers(),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_GRANT_SCOPE"
    assert store.list_agent_identities() == []


def test_agent_grants_rejects_unsupported_api_key_scope(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app)

    response = client.post(
        "/agent-grants/api-keys",
        json={"label": "Too powerful", "scopes": ["grant-admin"]},
        headers=_auth_headers(),
    )

    assert response.status_code == 400
    body = response.json()
    assert body["error"]["code"] == "BAD_GRANT_SCOPE"
    assert body["error"]["details"]["invalid_scopes"] == ["grant-admin"]


def test_agent_grants_revoke_hides_grant_from_active_list(tmp_path, monkeypatch):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    store.ensure_agent_identity(
        "agent_http_old",
        scope=["read-workspace"],
        label="Old import key",
        kind="http-api-key",
    )
    client = TestClient(app)

    revoke_response = client.delete(
        "/agent-grants/agent_http_old", headers=_auth_headers()
    )
    list_response = client.get("/agent-grants", headers=_auth_headers())

    assert revoke_response.status_code == 200
    row = store.get_agent_identity("agent_http_old")
    assert row is not None
    assert row["revoked"] == 1
    assert row["revoked_at"] is not None
    assert list_response.status_code == 200
    assert list_response.json()["grants"] == []


@pytest.mark.parametrize("invalidation", ["revoked", "expired"])
def test_local_mcp_authority_stays_invalid_after_control_store_reopen(
    tmp_path, monkeypatch, invalidation
):
    db_path = tmp_path / "control.sqlite3"
    initialize_control_plane(db_path)
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app)
    created = client.post(
        "/agent-grants/local-mcp",
        json={"label": "Durable local caller"},
        headers=_auth_headers(),
    )
    assert created.status_code == 200, created.text
    body = created.json()
    api_key, grant_id = body["apiKey"], body["grant"]["id"]
    workspace_id = 'folders:["/fixture/exact-workspace"]'
    bound = client.post(
        "/agent-grants/local-mcp/bind",
        json={
            "grantId": grant_id,
            "workspaceId": workspace_id,
            "workspaceLabel": "/fixture/exact-workspace",
        },
        headers=_auth_headers(),
    )
    assert bound.status_code == 200, bound.text
    active, error = get_identity_for_api_key(api_key)
    assert error is None
    assert active is not None and active["id"] == grant_id

    if invalidation == "revoked":
        removed = client.delete(f"/agent-grants/{grant_id}", headers=_auth_headers())
        assert removed.status_code == 200, removed.text
    else:
        with sqlite3.connect(db_path) as db:
            changed = db.execute(
                "UPDATE agent_identity SET expires_at = ? WHERE id = ?",
                ("2020-01-01T00:00:00Z", grant_id),
            )
            assert changed.rowcount == 1

    for reopen in (False, True):
        if reopen:
            initialize_control_plane(db_path)
        identity, refused = get_identity_for_api_key(api_key)
        assert identity is None
        assert refused is not None
        assert refused["error"]["code"] == f"GRANT_{invalidation.upper()}"
        assert refused["error"]["retriable"] is False
        listed = client.get("/agent-grants", headers=_auth_headers())
        assert listed.status_code == 200, listed.text
        assert all(grant["id"] != grant_id for grant in listed.json()["grants"])
        assert api_key not in listed.text

    with sqlite3.connect(db_path) as db:
        row = db.execute(
            "SELECT bound_workspace_id, api_key_hash FROM agent_identity WHERE id = ?",
            (grant_id,),
        ).fetchone()
    assert row == (workspace_id, hash_api_key(api_key))
    assert api_key.encode() not in db_path.read_bytes()


def test_agent_access_scope_is_grantable_but_never_automatic():
    assert "manage-agent-access" in ALLOWED_API_KEY_SCOPES
    assert "manage-agent-access" not in DEFAULT_LOCAL_MCP_SCOPES
