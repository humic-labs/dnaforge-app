from __future__ import annotations

import pytest

from src.control_plane import ControlPlaneStore, initialize_control_plane
from src.routes.mcp_auth import _grant_error_for_identity, hash_api_key

LEGACY_SCOPES = [
    "create-entity",
    "external-fetch:annotation",
    "modify-tabs",
    "read-sequences",
    "read-workspace",
]


def _local_grant(store, **overrides):
    values = {
        "identity_id": "agent_stdio_permission-policy",
        "scope": LEGACY_SCOPES,
        "expires_at": "2026-10-11T15:29:45.408924Z",
        "label": "Permission policy regression",
        "kind": "stdio-mcp",
        "origin": "local-mcp",
        "environment_id": "permission-policy-test",
        "created_by": "app-owned-mcp-bootstrap",
        "api_key_hash": hash_api_key("permission-policy-test-key"),
    }
    values.update(overrides)
    store.create_agent_identity(**values)
    return values["identity_id"]


def test_explicit_local_discovery_authorization_persists_and_preserves_identity(
    tmp_path,
):
    path = tmp_path / "control.sqlite3"
    store = initialize_control_plane(path)
    identity = _local_grant(store)
    before = store.get_agent_identity(identity)
    assert (
        _grant_error_for_identity(identity, before)["error"]["code"] == "GRANT_EXPIRED"
    )

    assert store.authorize_local_mcp_discovery(
        identity, environment_id="permission-policy-test"
    )
    reopened = ControlPlaneStore(path)
    try:
        after = reopened.get_agent_identity(identity)
        assert _grant_error_for_identity(identity, after) is None
        assert after["expires_at"] is None
        assert set(after["scope_json"]) == {
            *LEGACY_SCOPES,
            "external-compute:discover",
        }
        changed = {key for key in before if before[key] != after[key]}
        assert changed == {"scope_json", "expires_at"}
        assert reopened.authorize_local_mcp_discovery(
            identity, environment_id="permission-policy-test"
        )
        assert reopened.get_agent_identity(identity) == after

        assert reopened.revoke_agent_identity(identity)
        assert not reopened.authorize_local_mcp_discovery(
            identity, environment_id="permission-policy-test"
        )
        revoked = reopened.get_agent_identity(identity)
        assert (
            _grant_error_for_identity(identity, revoked)["error"]["code"]
            == "GRANT_REVOKED"
        )
    finally:
        reopened.close()


@pytest.mark.parametrize(
    "overrides,environment",
    [
        ({"kind": "http-api-key", "origin": "tool-key"}, "permission-policy-test"),
        ({"origin": "dev-test"}, "permission-policy-test"),
        ({"created_by": "local-human"}, "permission-policy-test"),
        ({"api_key_hash": None}, "permission-policy-test"),
        ({}, "another-environment"),
    ],
)
def test_local_discovery_repair_does_not_change_other_grant_classes(
    tmp_path, overrides, environment
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    identity = _local_grant(store, **overrides)
    before = store.get_agent_identity(identity)
    assert not store.authorize_local_mcp_discovery(identity, environment_id=environment)
    assert store.get_agent_identity(identity) == before
    assert (
        _grant_error_for_identity(identity, before)["error"]["code"] == "GRANT_EXPIRED"
    )
