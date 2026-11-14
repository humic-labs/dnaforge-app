import asyncio
from contextlib import suppress

import httpx
import pytest

from src.concurrency.builtins import echo_tool_spec
from src.concurrency.job_manager import get_job_manager, reset_job_manager
from src.concurrency.pools import PoolConfig, get_pool_manager, reset_pool_manager
from src.concurrency.schema import ExpectedLatency, ToolDuration, ToolHome
from src.control_plane import initialize_control_plane
from src.main import app


@pytest.fixture
async def cancellation(tmp_path, monkeypatch):
    store = initialize_control_plane(tmp_path / "cancellation.sqlite3")
    reset_job_manager()
    reset_pool_manager([PoolConfig("cpu_fast", 1, 4, "asyncio")])
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", "cancel-session")
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", "cancel-agent")
    store.ensure_agent_identity("cancel-agent", scope=["debug.echo"])
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app),
        base_url="http://sidecar.invalid",
        headers={
            "X-DNAForge-Session": "cancel-session",
            "X-DNAForge-Agent-Identity": "cancel-agent",
        },
    ) as client:
        yield client, get_job_manager(), store
    reset_job_manager()
    store.close()


def spec(*, cancelable=True, home=ToolHome.IN_HOST_TRANSITIONAL):
    base = echo_tool_spec()
    return base.model_copy(
        update={
            "name": "cancellation.acceptance",
            "home": home,
            "expected_latency": ExpectedLatency.SECONDS,
            "category": base.category.model_copy(
                update={"duration": ToolDuration.LONG_RUNNING, "cancelable": cancelable}
            ),
        }
    )


async def submit(manager, handler, **options):
    return await manager.submit(
        spec=spec(**options),
        args={},
        handler=handler,
        agent_identity_id="cancel-agent",
        agent_capabilities=["debug.echo"],
        completion_owner="renderer"
        if options.get("home") == ToolHome.RENDERER
        else "job",
    )


async def finish(owner, release):
    release.set()
    with suppress(asyncio.CancelledError):
        await asyncio.wait_for(owner, 1)


@pytest.mark.parametrize("route", ["/jobs", "/mcp/jobs"])
async def test_cancel_waits_for_cleanup_and_emits_one_terminal_event(
    cancellation, route
):
    client, manager, store = cancellation
    entered, cleaning, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    cleaned = []

    async def handler(args, context):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleaning.set()
            await release.wait()
            cleaned.append(True)

    job = await submit(manager, handler)
    owner = job.task
    await asyncio.wait_for(entered.wait(), 1)
    subscription = manager.subscribe_events(job.id)
    try:
        assert (await client.delete(f"{route}/{job.id}")).status_code == 204
        await asyncio.wait_for(cleaning.wait(), 1)
        pending = (await client.get(f"{route}/{job.id}")).json()
        assert pending["status"] == "running"
        assert pending["cancelRequested"] is True
        assert manager.get_live_owner(job.id) is job
        assert job.task is owner and not owner.done()
        assert store.get_agent_action(job.id)["completed_at"] is None
        assert get_pool_manager().stats()["cpu_fast"]["active"] == 1
        assert (await client.delete(f"{route}/{job.id}")).status_code == 204
        assert owner.cancelling() == 1
        assert cleaned == []
        assert not any(
            e["event"] in {"completed", "failed", "canceled"} for e in job.events
        )
        await finish(owner, release)
        events = [event async for event in subscription]
        assert [
            e["event"]
            for e in events
            if e["event"] in {"completed", "failed", "canceled"}
        ] == ["canceled"]
        assert events[-1]["data"]["error"]["code"] == "CANCELED"
        snapshot = manager.snapshot(job.id)
        assert snapshot["status"] == "canceled"
        assert "cancelRequested" not in snapshot
        assert cleaned == [True]
        assert job.task is None
        assert store.get_agent_action(job.id)["completion_state"] == "settled"
    finally:
        subscription.close()
        await finish(owner, release)


async def test_completion_wins_a_racing_cancel_request(cancellation):
    client, manager, store = cancellation
    entered, interrupted, release = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def handler(args, context):
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            interrupted.set()
            await release.wait()
            return {"echo": {"committed": True}, "jobId": context.job_id}

    job = await submit(manager, handler)
    owner = job.task
    await asyncio.wait_for(entered.wait(), 1)
    try:
        assert (await client.delete(f"/jobs/{job.id}")).status_code == 204
        await asyncio.wait_for(interrupted.wait(), 1)
        await finish(owner, release)
        snapshot = manager.snapshot(job.id)
        assert snapshot["status"] == "completed"
        assert snapshot["result"]["echo"] == {"committed": True}
        assert "cancelRequested" not in snapshot
        before = store.get_agent_action(job.id)
        assert (await client.delete(f"/jobs/{job.id}")).status_code == 204
        assert store.get_agent_action(job.id) == before
    finally:
        await finish(owner, release)


async def test_cleanup_failure_is_retained_after_cancel_request(cancellation):
    client, manager, store = cancellation
    entered, cleaning, release = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def handler(args, context):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleaning.set()
            await release.wait()
            raise RuntimeError("cleanup failed")

    job = await submit(manager, handler)
    owner = job.task
    await asyncio.wait_for(entered.wait(), 1)
    try:
        assert (await client.delete(f"/jobs/{job.id}")).status_code == 204
        await asyncio.wait_for(cleaning.wait(), 1)
        await finish(owner, release)
        snapshot = manager.snapshot(job.id)
        assert snapshot["status"] == "failed"
        assert snapshot["error"] == {
            "code": "HANDLER_ERROR",
            "message": "cleanup failed",
        }
        assert store.get_agent_action(job.id)["error_json"] == snapshot["error"]
    finally:
        await finish(owner, release)


async def test_cancel_before_runner_entry_never_starts_handler(cancellation):
    _, manager, store = cancellation
    invoked = []

    async def handler(args, context):
        invoked.append(True)
        return {"echo": {}, "jobId": context.job_id}

    job = await submit(manager, handler)
    owner = job.task
    assert await manager.cancel(job.id)
    await owner
    assert invoked == []
    assert manager.snapshot(job.id)["status"] == "canceled"
    assert store.get_agent_action(job.id)["error_json"]["code"] == "CANCELED"


@pytest.mark.parametrize("route", ["/jobs", "/mcp/jobs"])
async def test_noncancelable_request_preserves_execution(cancellation, route):
    client, manager, _ = cancellation
    entered, release = asyncio.Event(), asyncio.Event()

    async def handler(args, context):
        entered.set()
        await release.wait()
        return {"echo": {}, "jobId": context.job_id}

    job = await submit(manager, handler, cancelable=False)
    owner = job.task
    await asyncio.wait_for(entered.wait(), 1)
    try:
        assert (await client.delete(f"{route}/{job.id}")).status_code == 409
        assert await manager.cancel(job.id) is False
        assert not job.cancel_event.is_set()
        assert job.task is owner
        await finish(owner, release)
        assert manager.snapshot(job.id)["status"] == "completed"
    finally:
        await finish(owner, release)


async def test_transport_cancellation_keeps_renderer_outcome_unresolved(cancellation):
    _, manager, store = cancellation
    entered = asyncio.Event()

    async def handler(args, context):
        entered.set()
        await asyncio.Event().wait()

    job = await submit(manager, handler, cancelable=False, home=ToolHome.RENDERER)
    owner = job.task
    await asyncio.wait_for(entered.wait(), 1)
    owner.cancel()
    await owner
    snapshot = manager.snapshot(job.id)
    assert snapshot["status"] == "failed"
    assert snapshot["error"]["code"] == "OUTCOME_UNRESOLVED"
    assert store.get_agent_action(job.id)["completion_owner"] == "renderer"
    assert store.get_agent_action(job.id)["completion_state"] == "unresolved"
