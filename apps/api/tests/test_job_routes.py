"""Route-level tests for job status, events, and cancellation."""

import asyncio
import time
from typing import Any

import pytest
from fastapi.testclient import TestClient

from src.concurrency.job_manager import get_job_manager, reset_job_manager
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

MCP_TOKEN = "test-mcp-token"
JOB_AGENT_ID = "job-route-test-agent"


def setup_function():
    agent_tool_registry.clear()
    reset_job_manager()
    reset_pool_manager(
        [
            PoolConfig("cpu_slow", size=1, max_queued_jobs=1, backing="asyncio-test"),
            PoolConfig("cpu_fast", size=1, max_queued_jobs=1, backing="asyncio-test"),
        ]
    )


@pytest.fixture(autouse=True)
def configured_session_grant(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "*")
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", JOB_AGENT_ID)


def auth_headers() -> dict[str, str]:
    get_control_plane_store().ensure_agent_identity(
        JOB_AGENT_ID,
        scope=["*"],
    )
    return {
        "X-DNAForge-Session": MCP_TOKEN,
        "X-DNAForge-Agent-Identity": JOB_AGENT_ID,
        "X-DNAForge-Agent-Capabilities": "debug.echo",
    }


def _slow_tool_spec(*, cancelable: bool = True) -> DNAForgeTool:
    return DNAForgeTool(
        name="route.slow",
        description="Long-running route test tool",
        inputs={"type": "object"},
        outputs={"type": "object"},
        home=ToolHome.IN_HOST_TRANSITIONAL,
        runtime=ToolRuntime.IN_HOST,
        handler_ref="tests.test_job_routes._slow_handler",
        pool=PoolName.CPU_SLOW,
        expected_latency=ExpectedLatency.SECONDS,
        streams_progress=False,
        category=ToolCategory(
            shape=ToolShape.DATA_SERVICE,
            duration=ToolDuration.LONG_RUNNING,
            effects=[ToolEffect.READ_ONLY],
            cancelable=cancelable,
            approval_gated=False,
        ),
        required_capabilities=["debug.echo"],
        audit_required=True,
    )


async def _slow_handler(args: dict[str, Any], context: ToolContext) -> dict[str, Any]:
    await asyncio.sleep(args.get("sleep", 0.01))
    return {"ok": True, "jobId": context.job_id}


def _register_slow_tool() -> None:
    agent_tool_registry.register(_slow_tool_spec(), _slow_handler)


def test_get_job_returns_route_submitted_job(tmp_path, monkeypatch):
    monkeypatch.setenv("DNAFORGE_SIDECAR_DB_PATH", str(tmp_path / "control.sqlite3"))
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)

    with TestClient(app) as client:
        _register_slow_tool()
        submitted = client.post(
            "/api/tools/route.slow/execute",
            json={"sleep": 0.01},
            headers=auth_headers(),
        )
        job_id = submitted.json()["jobId"]

        response = client.get(f"/jobs/{job_id}", headers=auth_headers())

    assert response.status_code == 200
    data = response.json()
    assert data["jobId"] == job_id
    assert data["toolName"] == "route.slow"
    assert data["status"] in ("queued", "running", "completed")


def test_get_unknown_job_returns_404(tmp_path):
    initialize_control_plane(tmp_path / "control.sqlite3")
    client = TestClient(app)

    response = client.get("/jobs/missing", headers=auth_headers())

    assert response.status_code == 404


def test_cancel_job_marks_job_canceled(tmp_path, monkeypatch):
    monkeypatch.setenv("DNAFORGE_SIDECAR_DB_PATH", str(tmp_path / "control.sqlite3"))
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)

    with TestClient(app) as client:
        _register_slow_tool()
        submitted = client.post(
            "/api/tools/route.slow/execute",
            json={"sleep": 5},
            headers=auth_headers(),
        )
        assert submitted.status_code == 202
        job_id = submitted.json()["jobId"]
        assert client.get(f"/jobs/{job_id}", headers=auth_headers()).json()[
            "status"
        ] in (
            "queued",
            "running",
        )

        canceled = client.delete(f"/jobs/{job_id}", headers=auth_headers())
        status = client.get(f"/jobs/{job_id}", headers=auth_headers())

    assert canceled.status_code == 204
    assert status.json()["status"] == "canceled"


def test_cancel_unknown_job_returns_404(tmp_path):
    initialize_control_plane(tmp_path / "control.sqlite3")
    client = TestClient(app)

    response = client.delete("/jobs/missing", headers=auth_headers())

    assert response.status_code == 404


def test_completed_job_events_are_served_as_sse(tmp_path, monkeypatch):
    monkeypatch.setenv("DNAFORGE_SIDECAR_DB_PATH", str(tmp_path / "control.sqlite3"))
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)

    with TestClient(app) as client:
        _register_slow_tool()
        submitted = client.post(
            "/api/tools/route.slow/execute",
            json={"sleep": 0},
            headers=auth_headers(),
        )
        job_id = submitted.json()["jobId"]
        deadline = time.monotonic() + 2

        async def wait_for_completion() -> None:
            job = get_job_manager().get(job_id)
            assert job is not None
            if job.task is not None:
                await asyncio.wait_for(
                    asyncio.shield(job.task),
                    timeout=max(0, deadline - time.monotonic()),
                )
            assert job.status == "completed", job.snapshot()

        assert client.portal is not None
        client.portal.call(wait_for_completion)

        response = client.get(f"/jobs/{job_id}/events", headers=auth_headers())

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert "event: queued" in response.text
    assert "event: running" in response.text
    assert "event: completed" in response.text


def test_job_event_subscriber_limit_returns_429(tmp_path, monkeypatch):
    monkeypatch.setenv("DNAFORGE_SIDECAR_DB_PATH", str(tmp_path / "control.sqlite3"))
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)

    with TestClient(app) as client:
        _register_slow_tool()
        submitted = client.post(
            "/api/tools/route.slow/execute",
            json={"sleep": 5},
            headers=auth_headers(),
        )
        job_id = submitted.json()["jobId"]
        manager = get_job_manager()
        manager.max_event_subscribers_per_job = 1
        held_subscription = manager.subscribe_events(job_id)
        assert held_subscription is not None

        response = client.get(f"/jobs/{job_id}/events", headers=auth_headers())

        held_subscription.close()
        client.delete(f"/jobs/{job_id}", headers=auth_headers())

    assert response.status_code == 429
    assert response.headers["retry-after"] == "1"
    assert response.json()["error"] == {
        "code": "JOB_EVENT_SUBSCRIBER_LIMIT",
        "message": "Too many live event streams for this job or agent identity.",
        "retriable": True,
        "details": {"scope": "job", "limit": 1},
    }


def test_unknown_job_events_return_404(tmp_path):
    initialize_control_plane(tmp_path / "control.sqlite3")
    client = TestClient(app)

    response = client.get("/jobs/missing/events", headers=auth_headers())

    assert response.status_code == 404


def test_job_routes_require_persistent_authentication(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.delenv("DNAFORGE_MCP_AGENT_IDENTITY", raising=False)
    client = TestClient(app)

    response = client.get(
        "/jobs/missing",
        headers={"X-DNAForge-Session": MCP_TOKEN},
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "GRANT_MISSING"


def test_job_routes_hide_foreign_ownership(tmp_path):
    initialize_control_plane(tmp_path / "control.sqlite3")
    foreign_job = asyncio.run(
        get_job_manager().submit(
            spec=_slow_tool_spec(),
            args={"sleep": 0},
            handler=_slow_handler,
            agent_identity_id="foreign-job-agent",
            agent_capabilities=["debug.echo"],
        )
    )
    client = TestClient(app)

    missing = client.get("/jobs/missing", headers=auth_headers())
    foreign = client.get(f"/jobs/{foreign_job.id}", headers=auth_headers())
    foreign_events = client.get(
        f"/jobs/{foreign_job.id}/events",
        headers=auth_headers(),
    )
    foreign_cancel = client.delete(
        f"/jobs/{foreign_job.id}",
        headers=auth_headers(),
    )

    assert foreign.status_code == missing.status_code == 404
    assert foreign.json()["detail"].startswith("Unknown job: ")
    assert missing.json()["detail"].startswith("Unknown job: ")
    assert foreign_events.status_code == 404
    assert foreign_cancel.status_code == 404


def test_cancel_job_rejects_non_cancelable_tool(tmp_path):
    initialize_control_plane(tmp_path / "control.sqlite3")
    job = asyncio.run(
        get_job_manager().submit(
            spec=_slow_tool_spec(cancelable=False),
            args={"sleep": 0},
            handler=_slow_handler,
            agent_identity_id=JOB_AGENT_ID,
            agent_capabilities=["debug.echo"],
        )
    )
    client = TestClient(app)

    response = client.delete(f"/jobs/{job.id}", headers=auth_headers())

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "JOB_NOT_CANCELABLE"
