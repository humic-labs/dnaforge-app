"""Authenticated MCP job ownership and cancellation route tests."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from src.concurrency.builtins import echo_handler, echo_tool_spec
from src.concurrency.job_manager import get_job_manager, reset_job_manager
from src.concurrency.pools import reset_pool_manager
from src.control_plane import initialize_control_plane
from src.main import app

MCP_TOKEN = "test-mcp-token"
CALLER_ID = "job-caller"
OTHER_ID = "job-other"


@pytest.fixture
def job_client(tmp_path, monkeypatch):
    db_path = tmp_path / "control.sqlite3"
    monkeypatch.setenv("DNAFORGE_SIDECAR_DB_PATH", str(db_path))
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", CALLER_ID)
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "*")
    store = initialize_control_plane(db_path)
    store.ensure_agent_identity(CALLER_ID, scope=["debug.echo"])
    store.ensure_agent_identity(OTHER_ID, scope=["debug.echo"])
    reset_job_manager()
    reset_pool_manager()

    own_job = asyncio.run(
        get_job_manager().submit(
            spec=echo_tool_spec(),
            args={"message": "owned"},
            handler=echo_handler,
            agent_identity_id=CALLER_ID,
            agent_capabilities=["debug.echo"],
        )
    )
    cancelable_spec = echo_tool_spec().model_copy(
        update={
            "name": "test.cancelable",
            "category": echo_tool_spec().category.model_copy(
                update={"cancelable": True}
            ),
        }
    )
    cancelable_job = asyncio.run(
        get_job_manager().submit(
            spec=cancelable_spec,
            args={"message": "cancelable"},
            handler=echo_handler,
            agent_identity_id=CALLER_ID,
            agent_capabilities=["debug.echo"],
        )
    )
    foreign_job = asyncio.run(
        get_job_manager().submit(
            spec=echo_tool_spec(),
            args={"message": "foreign"},
            handler=echo_handler,
            agent_identity_id=OTHER_ID,
            agent_capabilities=["debug.echo"],
        )
    )
    headers = {
        "X-DNAForge-Session": MCP_TOKEN,
        "X-DNAForge-Agent-Identity": CALLER_ID,
    }
    yield (
        TestClient(app),
        store,
        headers,
        own_job.id,
        cancelable_job.id,
        foreign_job.id,
    )

    reset_job_manager()
    reset_pool_manager()


def test_mcp_job_get_returns_only_owned_job(job_client):
    client, _, headers, own_job_id, _, foreign_job_id = job_client

    own_response = client.get(f"/mcp/jobs/{own_job_id}", headers=headers)
    foreign_response = client.get(f"/mcp/jobs/{foreign_job_id}", headers=headers)
    missing_response = client.get("/mcp/jobs/missing", headers=headers)

    assert own_response.status_code == 200
    assert own_response.json()["jobId"] == own_job_id
    assert own_response.json()["status"] == "completed"
    assert foreign_response.status_code == 404
    assert foreign_response.json()["error"]["code"] == "UNKNOWN_JOB"
    assert missing_response.status_code == 404
    assert missing_response.json()["error"]["code"] == "UNKNOWN_JOB"


def test_mcp_job_delete_is_idempotent_for_terminal_owned_job(job_client):
    client, _, headers, _, cancelable_job_id, foreign_job_id = job_client

    first = client.delete(f"/mcp/jobs/{cancelable_job_id}", headers=headers)
    second = client.delete(f"/mcp/jobs/{cancelable_job_id}", headers=headers)
    foreign = client.delete(f"/mcp/jobs/{foreign_job_id}", headers=headers)

    assert first.status_code == 204
    assert second.status_code == 204
    assert foreign.status_code == 404
    assert get_job_manager().get(cancelable_job_id).status == "completed"


def test_mcp_job_delete_rejects_noncancelable_owned_job(job_client):
    client, _, headers, own_job_id, _, _ = job_client

    response = client.delete(f"/mcp/jobs/{own_job_id}", headers=headers)

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "JOB_NOT_CANCELABLE"
    assert get_job_manager().get(own_job_id).status == "completed"


def test_mcp_job_routes_revalidate_grant_state(job_client):
    client, store, headers, own_job_id, _, _ = job_client
    assert store.revoke_agent_identity(CALLER_ID) is True

    get_response = client.get(f"/mcp/jobs/{own_job_id}", headers=headers)
    delete_response = client.delete(f"/mcp/jobs/{own_job_id}", headers=headers)

    assert get_response.status_code == 401
    assert get_response.json()["error"]["code"] == "GRANT_REVOKED"
    assert delete_response.status_code == 401
    assert delete_response.json()["error"]["code"] == "GRANT_REVOKED"
