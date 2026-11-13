"""Human Jobs projection for durable agent actions ."""

import asyncio
from typing import Any

from fastapi.testclient import TestClient

from src.concurrency.job_manager import reset_job_manager
from src.concurrency.pools import PoolConfig, reset_pool_manager
from src.concurrency.schema import (
    DNAForgeTool,
    ExpectedLatency,
    PoolName,
    ToolCategory,
    ToolDuration,
    ToolEffect,
    ToolHome,
    ToolRuntime,
    ToolShape,
)
from src.concurrency.tool_registry import ToolContext, agent_tool_registry
from src.control_plane import get_control_plane_store, initialize_control_plane
from src.main import app

SESSION_TOKEN = "agent-jobs-session"
HUMAN_TOKEN = "agent-jobs-human"
RUNTIME_SCOPE = "agent-jobs-runtime"
HUMAN_OWNER = "human-owner"


def setup_function():
    agent_tool_registry.clear()
    reset_job_manager()
    reset_pool_manager(
        [PoolConfig("cpu_slow", size=1, max_queued_jobs=1, backing="asyncio-test")]
    )


def human_headers() -> dict[str, str]:
    return {
        "X-DNAForge-Session": SESSION_TOKEN,
        "X-DNAForge-Operation-Authority": HUMAN_TOKEN,
    }


def agent_headers(identity_id: str) -> dict[str, str]:
    return {
        "X-DNAForge-Session": SESSION_TOKEN,
        "X-DNAForge-Agent-Identity": identity_id,
        "X-DNAForge-Agent-Capabilities": "debug.echo",
    }


def slow_tool() -> DNAForgeTool:
    return DNAForgeTool(
        name="analysis.long",
        description="Long-running collection proof",
        inputs={"type": "object"},
        outputs={"type": "object"},
        home=ToolHome.IN_HOST_TRANSITIONAL,
        runtime=ToolRuntime.IN_HOST,
        handler_ref="tests.test_agent_job_collection.slow_handler",
        pool=PoolName.CPU_SLOW,
        expected_latency=ExpectedLatency.SECONDS,
        category=ToolCategory(
            shape=ToolShape.DATA_SERVICE,
            duration=ToolDuration.LONG_RUNNING,
            effects=[ToolEffect.READ_ONLY],
            cancelable=True,
            approval_gated=False,
        ),
        required_capabilities=["debug.echo"],
        audit_required=True,
    )


async def slow_handler(args: dict[str, Any], _context: ToolContext) -> dict[str, Any]:
    await asyncio.sleep(args.get("sleep", 60))
    return {"ok": True}


def test_agent_job_collection_requires_human_authority_and_minimizes_payload(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("DNAFORGE_SIDECAR_DB_PATH", str(tmp_path / "control.sqlite3"))
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", SESSION_TOKEN)
    monkeypatch.setenv("DNAFORGE_HUMAN_OPERATION_TOKEN", HUMAN_TOKEN)
    monkeypatch.setenv("DNAFORGE_OPERATION_SCOPE", RUNTIME_SCOPE)
    monkeypatch.setenv("DNAFORGE_OPERATION_OWNER_ID", HUMAN_OWNER)

    with TestClient(app) as client:
        store = get_control_plane_store()
        store.ensure_agent_identity(
            "agent-owned",
            parent_human_identity_id=HUMAN_OWNER,
            environment_id=RUNTIME_SCOPE,
            label="Research CLI",
            kind="cli",
            scope=["debug.echo"],
        )
        action_id = store.insert_agent_action(
            agent_identity_id="agent-owned",
            tool_name="analysis.long",
            parameters={"private_sequence": "must-not-leak"},
            job_pool="cpu_slow",
            job_cancelable=True,
            job_duration="long-running",
        )
        store.complete_agent_action(
            action_id,
            result={"private_result": "must-not-leak"},
            terminal_expires_at=9_000_000_000.0,
        )

        def reject_payload_lookup(_action_id: str):
            raise AssertionError(
                "the collection route must not load full action payloads"
            )

        monkeypatch.setattr(store, "get_agent_action", reject_payload_lookup)

        agent_only = client.get(
            "/operations/agent-jobs",
            headers={"X-DNAForge-Session": SESSION_TOKEN},
        )
        response = client.get("/operations/agent-jobs", headers=human_headers())

    assert agent_only.status_code == 403
    assert response.status_code == 200
    assert response.json() == {
        "jobs": [
            {
                "id": action_id,
                "tool_name": "analysis.long",
                "duration": "long-running",
                "pool": "cpu_slow",
                "state": "succeeded",
                "cancelable": True,
                "can_cancel": False,
                "requested_at": response.json()["jobs"][0]["requested_at"],
                "completed_at": response.json()["jobs"][0]["completed_at"],
                "error_code": None,
                "agent_identity": {
                    "id": "agent-owned",
                    "label": "Research CLI",
                    "kind": "cli",
                },
            }
        ],
        "job_count": 1,
        "active_count": 0,
        "terminal_count": 1,
        "history_complete": True,
    }
    encoded = response.text
    assert "private_sequence" not in encoded
    assert "private_result" not in encoded


def test_agent_job_collection_routes_cancel_to_the_live_owner(tmp_path, monkeypatch):
    database = tmp_path / "control.sqlite3"
    monkeypatch.setenv("DNAFORGE_SIDECAR_DB_PATH", str(database))
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", SESSION_TOKEN)
    monkeypatch.setenv("DNAFORGE_HUMAN_OPERATION_TOKEN", HUMAN_TOKEN)
    monkeypatch.setenv("DNAFORGE_OPERATION_SCOPE", RUNTIME_SCOPE)
    monkeypatch.setenv("DNAFORGE_OPERATION_OWNER_ID", HUMAN_OWNER)
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", "agent-owned")

    store = initialize_control_plane(database)
    store.ensure_agent_identity(
        "agent-owned",
        parent_human_identity_id=HUMAN_OWNER,
        environment_id=RUNTIME_SCOPE,
        label="Research CLI",
        kind="cli",
        scope=["debug.echo"],
    )

    with TestClient(app) as client:
        agent_tool_registry.register(slow_tool(), slow_handler)
        submitted = client.post(
            "/api/tools/analysis.long/execute",
            json={"sleep": 60},
            headers=agent_headers("agent-owned"),
        )
        assert submitted.status_code == 202, submitted.text
        action_id = submitted.json()["jobId"]

        before = client.get("/operations/agent-jobs", headers=human_headers())
        canceled = client.delete(
            f"/operations/agent-jobs/{action_id}", headers=human_headers()
        )
        after = client.get("/operations/agent-jobs", headers=human_headers())

    before_job = before.json()["jobs"][0]
    assert before_job["id"] == action_id
    assert before_job["state"] in {"queued", "running"}
    assert before_job["can_cancel"] is True
    assert canceled.status_code == 204
    assert after.json()["jobs"][0]["state"] == "canceled"
    assert after.json()["jobs"][0]["can_cancel"] is False


def test_restart_projects_ownerless_admission_as_interrupted_without_replay(
    tmp_path, monkeypatch
):
    database = tmp_path / "control.sqlite3"
    monkeypatch.setenv("DNAFORGE_SIDECAR_DB_PATH", str(database))
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", SESSION_TOKEN)
    monkeypatch.setenv("DNAFORGE_HUMAN_OPERATION_TOKEN", HUMAN_TOKEN)
    monkeypatch.setenv("DNAFORGE_OPERATION_SCOPE", RUNTIME_SCOPE)
    monkeypatch.setenv("DNAFORGE_OPERATION_OWNER_ID", HUMAN_OWNER)
    store = initialize_control_plane(database)
    store.ensure_agent_identity(
        "agent-owned",
        parent_human_identity_id=HUMAN_OWNER,
        environment_id=RUNTIME_SCOPE,
        label="Research CLI",
        kind="cli",
        scope=["debug.echo"],
    )
    action_id = store.insert_agent_action(
        agent_identity_id="agent-owned",
        tool_name="analysis.long",
        parameters={"private": "never replay"},
        job_pool="cpu_slow",
        job_cancelable=True,
        job_duration="long-running",
    )

    with TestClient(app) as client:
        response = client.get("/operations/agent-jobs", headers=human_headers())

    assert response.status_code == 200
    assert response.json()["jobs"][0]["id"] == action_id
    assert response.json()["jobs"][0]["state"] == "interrupted"
    assert response.json()["jobs"][0]["error_code"] == "OUTCOME_UNRESOLVED"
    assert (
        get_control_plane_store().get_agent_action(action_id)["completed_at"]
        is not None
    )
