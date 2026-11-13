"""Closed lifecycle receipts from real committed SQLite authority and bounded I/O."""

import asyncio
import json
import time
import uuid

import httpx
import pytest

from src import external_access_observation as observations
from src.control_plane import initialize_control_plane
from src.routes.mcp_auth import write_rejection_audit


@pytest.fixture
def store(tmp_path):
    value = initialize_control_plane(tmp_path / "authority.sqlite3")
    value.create_agent_identity(
        identity_id="agent_http_private-native-identity",
        kind="http-api-key",
        origin="tool-key",
        label="PRIVATE_CLIENT_LABEL",
        api_key_hash="PRIVATE_KEY_HASH",
        scope=["read-workspace", "create-entity"],
        created_at="2026-10-20T12:00:00.123Z",
    )
    return value


def assert_closed(receipt):
    assert observations.valid_observation(receipt)
    text = json.dumps(receipt)
    for secret in (
        "PRIVATE_CLIENT_LABEL",
        "PRIVATE_KEY_HASH",
        "private-native-identity",
        "PRIVATE_TOOL",
        "PRIVATE_ARGUMENT",
        "PRIVATE_RESULT",
    ):
        assert secret not in text
    assert uuid.UUID(receipt["operation_id"]).version == 4
    assert receipt["access_usefulness"] == "not_attested"


def test_committed_create_and_revoke_use_original_clocks_without_domain_identity(store):
    row = store.get_agent_identity("agent_http_private-native-identity")
    created = observations.committed_grant_observation("grant_create", row)
    assert_closed(created)
    assert created["occurred_at_ms"] == 1792497600123
    assert created["access_scope_class"] == "write"
    assert created["access_expiry_class"] == "none"
    assert store.revoke_agent_identity(row["id"])
    revoked_row = store.get_agent_identity(row["id"])
    revoked = observations.committed_grant_observation("selected_revoke", revoked_row)
    assert_closed(revoked)
    assert revoked["occurred_at_ms"] == observations._clock(revoked_row["revoked_at"])
    assert revoked["operation_id"] != created["operation_id"]
    assert revoked["access_authority"] == "committed_revoke"


def test_admission_is_not_permission_and_terminal_permission_requires_committed_audit(
    store,
):
    operation_id = str(uuid.uuid4())
    action_id = store.insert_agent_action(
        agent_identity_id="agent_http_private-native-identity",
        tool_name="PRIVATE_TOOL",
        parameters={"value": "PRIVATE_ARGUMENT"},
        authorized_scope=["read-workspace"],
        job_pool="cpu_fast",
    )
    admitted_row = store.get_agent_action(action_id)
    admitted = observations.action_observation(
        action_id, admitted=True, operation_id=operation_id
    )
    assert_closed(admitted)
    assert admitted["access_result"] == "admitted"
    assert admitted["access_scope_class"] == "read"
    assert admitted["access_execution"] == "queued"
    assert admitted["occurred_at_ms"] == observations._clock(
        admitted_row["requested_at"]
    )
    assert observations.action_observation(action_id) is None
    store.complete_agent_action(action_id, result={"value": "PRIVATE_RESULT"})
    unknown = observations.action_observation(
        action_id, operation_id=operation_id, execution="completed"
    )
    assert unknown["access_result"] == "unknown"
    store.insert_audit_record(
        action_id=action_id,
        actor_kind="agent",
        actor_identity="agent_http_private-native-identity",
        capability_check={"satisfied": True},
    )
    completed = observations.action_observation(
        action_id, operation_id=operation_id, execution="completed"
    )
    assert_closed(completed)
    assert completed["access_result"] == "allowed"
    assert completed["access_execution"] == "completed"
    assert completed["operation_id"] == admitted["operation_id"]
    assert completed["occurred_at_ms"] == observations._clock(
        store.get_agent_action(action_id)["completed_at"]
    )
    assert action_id not in json.dumps(completed)


def test_actual_scope_refusal_is_distinct_from_job_execution(store):
    action_id, _audit_id = write_rejection_audit(
        agent_identity_id="agent_http_private-native-identity",
        tool_name="PRIVATE_TOOL",
        args={"value": "PRIVATE_ARGUMENT"},
        actor_scope=["read-workspace"],
        required_capabilities=["create-entity"],
        parent_action_id=None,
    )
    receipt = observations.action_observation(action_id, execution="failed")
    assert_closed(receipt)
    assert receipt["access_result"] == "refused"
    assert receipt["access_execution"] == "not_observed"
    assert receipt["access_authority"] == "committed_action"


def test_renderer_refusal_cannot_be_overridden_by_outer_dispatch_execution_audit(store):
    action_id = store.insert_agent_action(
        agent_identity_id="agent_http_private-native-identity",
        tool_name="PRIVATE_TOOL",
        parameters={},
        authorized_scope=["read-workspace"],
        job_pool="cpu_fast",
    )
    store.complete_agent_action(action_id, error={"code": "INSUFFICIENT_SCOPE"})
    store.insert_audit_record(
        action_id=action_id,
        actor_kind="renderer",
        actor_identity="agent_http_private-native-identity",
        capability_check={"satisfied": False},
    )
    store.insert_audit_record(
        action_id=action_id,
        actor_kind="agent",
        actor_identity="agent_http_private-native-identity",
        capability_check={"satisfied": True, "reason": "tool_error_after_grant"},
    )
    receipt = observations.action_observation(action_id, execution="failed")
    assert_closed(receipt)
    assert receipt["access_result"] == "refused"
    assert receipt["access_execution"] == "failed"


@pytest.mark.parametrize(
    "field,value",
    [
        ("apiKey", "PRIVATE_KEY"),
        ("access_client", "PRIVATE_CLIENT_LABEL"),
        ("operation_id", "019c6e27-e55b-73d1-87d8-4e01f1f75043"),
        ("occurred_at_ms", True),
        ("access_usefulness", "useful"),
        ("access_authority", "native_configuration"),
    ],
)
def test_raw_or_misattributed_metadata_is_rejected(field, value):
    receipt = observations.transport_refusal_observation("GRANT_EXPIRED")
    assert_closed(receipt)
    receipt[field] = value
    assert not observations.valid_observation(receipt)


def bridge_env(monkeypatch):
    monkeypatch.setenv("DNAFORGE_EXTERNAL_ACCESS_OBSERVATIONS", "1")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_URL", "http://127.0.0.1:12345")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "fixture-bridge-token")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", "fixture-current-generation")


@pytest.mark.asyncio
async def test_delivery_uses_only_exact_loopback_and_private_generation_headers(
    monkeypatch,
):
    bridge_env(monkeypatch)
    calls = []
    real_client = httpx.AsyncClient

    async def handle(request):
        calls.append(request)
        return httpx.Response(200, json={"ok": True, "emitted": False})

    def client(**options):
        assert options == {
            "timeout": 0.25,
            "trust_env": False,
            "follow_redirects": False,
        }
        return real_client(**options, transport=httpx.MockTransport(handle))

    monkeypatch.setattr(observations.httpx, "AsyncClient", client)
    receipt = observations.transport_refusal_observation("GRANT_EXPIRED")
    assert await observations.emit_external_access_observation(receipt) is True
    assert len(calls) == 1
    request = calls[0]
    assert str(request.url) == "http://127.0.0.1:12345/__external-access/observe"
    assert request.headers["x-dnaforge-session"] == "fixture-bridge-token"
    assert request.headers["x-dnaforge-sidecar-session"] == "fixture-current-generation"
    assert json.loads(request.content) == receipt
    assert "fixture-" not in request.content.decode()
    monkeypatch.setenv("DNAFORGE_EXTERNAL_ACCESS_OBSERVATIONS", "0")
    assert await observations.emit_external_access_observation(receipt) is False
    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1:12345",
        "http://localhost:12345",
        "http://127.0.0.2:12345",
        "http://127.0.0.1",
        "http://user@127.0.0.1:12345",
        "http://127.0.0.1:12345/path",
        "http://127.0.0.1:12345/?private=value",
        "http://127.0.0.1:12345/#private",
    ],
)
async def test_foreign_or_payload_bearing_bridge_locators_never_start_io(
    monkeypatch, url
):
    bridge_env(monkeypatch)
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_URL", url)

    def forbidden(**_options):
        pytest.fail("foreign or payload-bearing bridge URL started I/O")

    monkeypatch.setattr(observations.httpx, "AsyncClient", forbidden)
    assert (
        await observations.emit_external_access_observation(
            observations.transport_refusal_observation("BAD_KEY")
        )
        is False
    )


@pytest.mark.asyncio
async def test_delivery_has_one_total_deadline_and_no_retry(monkeypatch):
    bridge_env(monkeypatch)
    calls = 0
    real_client = httpx.AsyncClient

    async def stalled(_request):
        nonlocal calls
        calls += 1
        await asyncio.sleep(10)
        return httpx.Response(200)

    monkeypatch.setattr(
        observations.httpx,
        "AsyncClient",
        lambda **options: real_client(
            **options, transport=httpx.MockTransport(stalled)
        ),
    )
    started = time.monotonic()
    assert (
        await observations.emit_external_access_observation(
            observations.transport_refusal_observation("BAD_KEY")
        )
        is False
    )
    assert time.monotonic() - started < 1.0
    assert calls == 1
