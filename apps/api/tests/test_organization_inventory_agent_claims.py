from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from src.control_plane import ControlPlaneStore
from src.organization_inventory_agent_claims import (
    MAX_ORGANIZATION_INVENTORY_AGENT_LEASE_MS,
    OrganizationInventoryAgentClaimService,
    OrganizationInventoryAgentLeaseRequest,
    OrganizationInventoryGrantAuthorityUnavailable,
)
from src.routes import agent_grants
from src.security.native_document_authority import NativeDocumentAuthority

READ = "read-organization-inventory"
USE = "use-organization-inventory"
POLICY = "agent_organization_inventory_claim_policy"


@pytest.fixture
def store(tmp_path):
    value = ControlPlaneStore(tmp_path / "owned.sqlite3")
    value.initialize()
    yield value
    value.close()


def create(store, identity="selected", scopes=None, expires=None):
    store.create_agent_identity(
        identity_id=identity,
        scope=[READ, USE] if scopes is None else scopes,
        expires_at=expires,
        kind="http-api-key",
        origin="tool-key",
    )


def binding(purpose=None):
    return OrganizationInventoryAgentLeaseRequest.model_validate(
        {
            "schema": "dnaforge.organization-inventory-agent-lease.v1",
            "delegationId": "delegation-one",
            "delegationIncarnation": "opaque:incarnation/100",
            "accountId": "11111111-1111-4111-8111-111111111111",
            "desktopSessionId": "22222222-2222-4222-8222-222222222222",
            "target": {
                "kind": "organization-inventory",
                "orgId": "33333333-3333-4333-8333-333333333333",
                "inventoryId": "44444444-4444-4444-8444-444444444444",
            },
            "flightId": "flight-one",
            "purpose": purpose or {"kind": "observe", "operation": "snapshot"},
        }
    )


def test_old_writers_preserve_unguarded_operations_but_cannot_bypass_policy(store):
    for name in ["ordinary", "removable", "selected"]:
        create(store, name)
    old = sqlite3.connect(store.db_path, isolation_level=None)
    old.execute("PRAGMA foreign_keys=ON")
    try:
        old.execute("UPDATE agent_identity SET label='ordinary' WHERE id='ordinary'")
        old.execute("UPDATE agent_identity SET revoked=1 WHERE id='ordinary'")
        old.execute("DELETE FROM agent_identity WHERE id='removable'")
        assert store.get_agent_identity("ordinary")["revoked"] == 1
        assert store.get_agent_identity("removable") is None
        with pytest.raises(sqlite3.IntegrityError, match="TRANSITION_DENIED"):
            with store.transaction():
                store._conn.execute(
                    f"INSERT INTO {POLICY} VALUES('selected','dnaforge.organization-inventory-agent-lease.v1',5000,'live')"
                )
        assert (
            OrganizationInventoryAgentClaimService(store).enroll("selected", "owner").policy.state
            == "live"
        )
        for statement in [
            "UPDATE agent_identity SET revoked=1 WHERE id='selected'",
            "DELETE FROM agent_identity WHERE id='selected'",
        ]:
            with pytest.raises(
                sqlite3.IntegrityError, match="ORGANIZATION_CLAIM_PROTOCOL_REQUIRED"
            ):
                old.execute(statement)
        old.execute("UPDATE agent_identity SET label='metadata' WHERE id='selected'")
        for statement in [
            f"INSERT INTO {POLICY} VALUES('ordinary','dnaforge.organization-inventory-agent-lease.v1',5000,'live')",
            f"UPDATE {POLICY} SET state='complete' WHERE grant_id='selected'",
            f"DELETE FROM {POLICY} WHERE grant_id='selected'",
        ]:
            with pytest.raises(sqlite3.OperationalError, match="no such function"):
                old.execute(statement)
        store.initialize()
        assert store.get_agent_identity("selected")["label"] == "metadata"
    finally:
        old.close()


def test_enrollment_serializes_with_cached_old_revoke_and_old_writer_lock(store):
    create(store)
    create(store, "revoke-first")
    old = sqlite3.connect(store.db_path, isolation_level=None)
    try:
        sql = "UPDATE agent_identity SET revoked=1 WHERE id=?"
        old.execute(sql, ("absent",))
        service = OrganizationInventoryAgentClaimService(store)
        service.enroll("selected", "owner")
        with pytest.raises(sqlite3.IntegrityError, match="PROTOCOL_REQUIRED"):
            old.execute(sql, ("selected",))
        old.execute("BEGIN IMMEDIATE")
        old.execute(sql, ("revoke-first",))
        store._conn.execute("PRAGMA busy_timeout=0")
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            service.enroll("revoke-first", "owner")
        old.execute("COMMIT")
        assert service.enroll("revoke-first", "owner").code == "GRANT_REVOKED"
        assert store.organization_inventory_claims.get("revoke-first") is None
    finally:
        if old.in_transaction:
            old.rollback()
        old.close()


def test_exact_purpose_capabilities_expiry_and_no_implicit_enrollment(store):
    create(store, scopes=[READ])
    create(store, "wildcard", ["*"])
    create(store, "workspace-only", ["read-workspace", "write-workspace"])
    service = OrganizationInventoryAgentClaimService(store)
    assert service.lease("selected", "owner", binding()).code == "ORGANIZATION_CLAIM_NOT_LIVE"
    assert service.enroll("workspace-only", "owner").code == "INSUFFICIENT_SCOPE"
    service.enroll("selected", "owner")
    observed = service.lease("selected", "actual-owner", binding())
    assert observed.kind == "granted" and observed.validForMs == 5000
    assert observed.binding.model_dump(by_alias=True) == {
        **binding().model_dump(by_alias=True),
        "agentIdentityId": "selected",
        "nativeOwnerInstanceId": "actual-owner",
    }
    for purpose in [
        {"kind": "preview-use"},
        {
            "kind": "send",
            "mode": "submit",
            "operationId": "operation-one",
            "requestSha256": "sha256:" + "a" * 64,
        },
    ]:
        assert service.lease("selected", "owner", binding(purpose)).code == "INSUFFICIENT_SCOPE"
    service.enroll("wildcard", "owner")
    assert service.lease("wildcard", "owner", binding({"kind": "preview-use"})).kind == "granted"
    now = datetime.now(timezone.utc)
    create(store, "expiring", expires=(now + timedelta(seconds=2)).isoformat())
    clamped = OrganizationInventoryAgentClaimService(store, now=lambda: now + timedelta(seconds=1))
    clamped.enroll("expiring", "owner")
    assert clamped.lease("expiring", "owner", binding()).validForMs == 1000
    create(store, "expired", expires=(now - timedelta(seconds=1)).isoformat())
    assert service.enroll("expired", "owner").code == "GRANT_EXPIRED"


def test_deny_drain_runs_outside_transaction_and_revoke_completes_once(store):
    create(store)
    create(store, "ordinary")
    clock = [10.0]
    pauses = []
    service = None

    async def pause(seconds):
        assert not store._conn.in_transaction and not store._tx_lock._is_owned()
        assert service.lease("selected", "owner", binding()).code == "ORGANIZATION_CLAIM_NOT_LIVE"
        assert store.organization_inventory_claims.get("selected")["state"] == "denying"
        assert store.get_agent_identity("selected")["revoked"] == 0
        pauses.append(seconds)
        clock[0] += seconds

    service = OrganizationInventoryAgentClaimService(store, monotonic=lambda: clock[0], sleep=pause)
    service.enroll("selected", "owner")
    raw = binding(
        {
            "kind": "send",
            "mode": "retry-exact",
            "operationId": "original",
            "requestSha256": "sha256:" + "b" * 64,
        }
    ).model_dump_json(by_alias=True)
    digest = hashlib.sha256(raw.encode()).hexdigest()
    assert asyncio.run(service.revoke("ordinary"))
    assert pauses == []
    assert asyncio.run(service.revoke("selected"))
    assert pauses == [MAX_ORGANIZATION_INVENTORY_AGENT_LEASE_MS / 1000]
    assert store.organization_inventory_claims.get("selected")["state"] == "complete"
    assert store.get_agent_identity("selected")["revoked"] == 1
    assert asyncio.run(service.revoke("selected")) and pauses == [5.0]
    assert service.lease("selected", "owner", binding()).code == "GRANT_REVOKED"
    assert hashlib.sha256(raw.encode()).hexdigest() == digest
    with pytest.raises(sqlite3.IntegrityError, match="PROTOCOL_REQUIRED"):
        store._conn.execute("UPDATE agent_identity SET revoked=0 WHERE id='selected'")


def test_cancelled_or_short_drain_and_failed_final_write_never_expose_completion(store):
    create(store)

    async def short(_):
        return None

    service = OrganizationInventoryAgentClaimService(store, monotonic=lambda: 1.0, sleep=short)
    service.enroll("selected", "owner")
    with pytest.raises(OrganizationInventoryGrantAuthorityUnavailable, match="pending"):
        asyncio.run(service.revoke("selected"))
    assert store.organization_inventory_claims.get("selected")["state"] == "denying"
    assert store.get_agent_identity("selected")["revoked"] == 0

    async def cancelled(_):
        raise asyncio.CancelledError()

    interrupted = OrganizationInventoryAgentClaimService(store, sleep=cancelled)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(interrupted.revoke("selected"))
    assert store.organization_inventory_claims.get("selected")["state"] == "denying"
    assert store.get_agent_identity("selected")["revoked"] == 0
    store._conn.execute(
        "CREATE TRIGGER refuse_final BEFORE UPDATE OF revoked ON agent_identity WHEN NEW.revoked=1 BEGIN SELECT RAISE(ABORT,'injected'); END"
    )
    clock = [0.0]

    async def full(seconds):
        clock[0] += seconds

    retry = OrganizationInventoryAgentClaimService(store, monotonic=lambda: clock[0], sleep=full)
    with pytest.raises(OrganizationInventoryGrantAuthorityUnavailable):
        asyncio.run(retry.revoke("selected"))
    assert store.organization_inventory_claims.get("selected")["state"] == "denying"
    assert store.get_agent_identity("selected")["revoked"] == 0
    store._conn.execute("DROP TRIGGER refuse_final")
    assert asyncio.run(retry.revoke("selected"))


def test_private_routes_are_strict_and_bind_path_identity_to_actual_native_owner(
    store, monkeypatch
):
    create(store)
    monkeypatch.setattr(agent_grants, "get_control_plane_store", lambda: store)
    app = FastAPI()
    app.include_router(agent_grants.router)
    app.state.native_document_authority = NativeDocumentAuthority(
        "private-test-secret", "actual-native-owner", "http://127.0.0.1:12345"
    )
    client = TestClient(app, client=("127.0.0.1", 50000))
    path = "/agent-grants/selected/organization-inventory"
    header = {"X-DNAForge-Native-Document-Authority": "private-test-secret"}
    assert (
        client.post(
            path + "/claim-policy", json={}, headers={"X-DNAForge-Session": "not-native"}
        ).status_code
        == 403
    )
    assert client.get(path + "/claim-policy", headers=header).json()["policy"] is None
    assert (
        client.post(
            path + "/claim-policy", json={"agentIdentityId": "forged"}, headers=header
        ).status_code
        == 422
    )
    assert client.post(path + "/claim-policy", json={}, headers=header).json()["policy"] == {
        "protocolVersion": 1,
        "state": "live",
        "maxLeaseMs": 5000,
    }
    request = binding().model_dump(by_alias=True)
    response = client.post(path + "/lease", json=request, headers=header)
    assert response.status_code == 200
    assert response.json()["binding"] == {
        **request,
        "agentIdentityId": "selected",
        "nativeOwnerInstanceId": "actual-native-owner",
    }
    for change in [
        {"nativeOwnerInstanceId": "forged"},
        {"purpose": {"kind": "send", "mode": "submit"}},
        {"delegationIncarnation": 1},
        {"schema": "unknown"},
    ]:
        assert (
            client.post(path + "/lease", json={**request, **change}, headers=header).status_code
            == 422
        )
    app.state.native_document_authority = NativeDocumentAuthority(
        "private-test-secret", "actual-native-owner", None
    )
    assert (
        client.post(path + "/lease", json=request, headers=header).json()["kind"] == "unavailable"
    )
    with pytest.raises(ValidationError):
        OrganizationInventoryAgentLeaseRequest.model_validate(
            {**request, "purpose": {"kind": "observe", "operation": "submit"}}
        )


def test_existing_delete_returns_old_body_only_after_guarded_drain(store, monkeypatch):
    create(store)
    clock = [0.0]

    async def pause(seconds):
        assert not store._conn.in_transaction
        clock[0] += seconds

    class TestService(OrganizationInventoryAgentClaimService):
        def __init__(self, value):
            super().__init__(value, monotonic=lambda: clock[0], sleep=pause)

    monkeypatch.setattr(agent_grants, "get_control_plane_store", lambda: store)
    monkeypatch.setattr(agent_grants, "OrganizationInventoryAgentClaimService", TestService)
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", "human-test-session")
    TestService(store).enroll("selected", "owner")
    app = FastAPI()
    app.include_router(agent_grants.router)
    client = TestClient(app)
    response = client.delete(
        "/agent-grants/selected", headers={"X-DNAForge-Session": "human-test-session"}
    )
    assert response.status_code == 200 and response.json() == {"ok": True}
    assert clock[0] == 5.0 and store.get_agent_identity("selected")["revoked"] == 1
    assert json.loads(json.dumps(response.json())) == {"ok": True}
