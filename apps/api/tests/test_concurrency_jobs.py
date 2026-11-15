"""Tests for pool/job substrate behavior."""

import asyncio
import json

import pytest

from src.concurrency.job_manager import (
    IdempotencyConflict,
    JobEventSubscriberLimit,
    JobManager,
)
from src.concurrency.pools import PoolConfig, reset_pool_manager
from src.concurrency.refusals import QueueRefusal
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
from src.concurrency.tool_registry import (
    AUDIT_RESULT_PROJECTION_KEY,
    AgentToolRegistry,
    RegisteredTool,
    ToolContext,
    ToolReplayPolicy,
)
from src.control_plane import get_control_plane_store, initialize_control_plane


def _long_tool() -> DNAForgeTool:
    return DNAForgeTool(
        name="slow.echo",
        description="Slow test tool",
        inputs={"type": "object"},
        outputs={"type": "object"},
        home=ToolHome.IN_HOST_TRANSITIONAL,
        runtime=ToolRuntime.IN_HOST,
        handler_ref="test.slow",
        pool=PoolName.CPU_SLOW,
        expected_latency=ExpectedLatency.SECONDS,
        idempotency_keyable=True,
        streams_progress=False,
        category=ToolCategory(
            shape=ToolShape.DATA_SERVICE,
            duration=ToolDuration.LONG_RUNNING,
            effects=[ToolEffect.READ_ONLY],
            cancelable=True,
            approval_gated=False,
        ),
        required_capabilities=["debug.echo"],
        audit_required=False,
    )


def _immediate_tool() -> DNAForgeTool:
    return DNAForgeTool(
        name="immediate.echo",
        description="Immediate test tool",
        inputs={"type": "object"},
        outputs={"type": "object"},
        home=ToolHome.IN_HOST_TRANSITIONAL,
        runtime=ToolRuntime.IN_HOST,
        handler_ref="test.immediate",
        pool=PoolName.CPU_FAST,
        expected_latency=ExpectedLatency.SUB_SECOND,
        idempotency_keyable=True,
        streams_progress=False,
        category=ToolCategory(
            shape=ToolShape.DATA_SERVICE,
            duration=ToolDuration.IMMEDIATE,
            effects=[ToolEffect.READ_ONLY],
            cancelable=False,
            approval_gated=False,
        ),
        required_capabilities=["debug.echo"],
        audit_required=False,
    )


async def _sleepy_handler(args: dict, context: ToolContext) -> dict:
    await asyncio.sleep(args.get("sleep", 0.01))
    return {"ok": True, "jobId": context.job_id}


@pytest.mark.asyncio
async def test_slow_immediate_renderer_returns_its_owned_job_before_completion():
    manager = JobManager()
    started = asyncio.Event()
    release = asyncio.Event()
    executions = 0

    async def held_renderer(args, context):
        nonlocal executions
        executions += 1
        started.set()
        await release.wait()
        return {"ok": True, "jobId": context.job_id}

    spec = _immediate_tool().model_copy(
        update={"home": ToolHome.RENDERER, "runtime": ToolRuntime.SERVICE}
    )
    admission = asyncio.create_task(
        manager.submit(spec=spec, args={}, handler=held_renderer)
    )
    await asyncio.wait_for(started.wait(), timeout=2)
    try:
        job = await asyncio.wait_for(asyncio.shield(admission), timeout=2)
        assert job.status == "running"
        assert manager.get(job.id) is job
        assert job.task is not None and not job.task.done()
    finally:
        release.set()
        retained = await admission
        if retained.task is not None:
            await retained.task
    assert executions == 1
    assert retained.status == "completed"
    assert manager.snapshot(retained.id)["result"] == {"ok": True, "jobId": retained.id}


async def _wait_for_event_subscribers(job, expected: int) -> None:
    for _ in range(100):
        if len(job.event_subscribers) == expected:
            return
        await asyncio.sleep(0)
    raise AssertionError(
        f"expected {expected} event subscribers, got {len(job.event_subscribers)}"
    )


@pytest.fixture(autouse=True)
def substrate_state(tmp_path):
    initialize_control_plane(tmp_path / "control.sqlite3")
    reset_pool_manager(
        [
            PoolConfig("cpu_slow", size=1, max_queued_jobs=1, backing="asyncio-test"),
            PoolConfig("cpu_fast", size=1, max_queued_jobs=1, backing="asyncio-test"),
        ]
    )


@pytest.mark.asyncio
async def test_long_job_queues_then_completes():
    manager = JobManager()
    job = await manager.submit(
        spec=_long_tool(),
        args={"sleep": 0.01},
        handler=_sleepy_handler,
        idempotency_key="same",
    )

    assert job.status in ("queued", "running")
    admitted = get_control_plane_store().get_agent_action(job.id)
    assert admitted["job_duration"] == "long-running"
    await job.task
    assert job.status == "completed"
    assert manager.snapshot(job.id)["result"]["ok"] is True


@pytest.mark.asyncio
async def test_explicit_empty_capabilities_are_not_elevated_to_tool_requirements():
    manager = JobManager()
    observed: list[str] | None = None

    async def handler(args: dict, context: ToolContext) -> dict:
        nonlocal observed
        observed = context.agent_capabilities
        return {"ok": True}

    job = await manager.submit(
        spec=_immediate_tool(),
        args={},
        handler=handler,
        agent_capabilities=[],
    )

    assert job.agent_capabilities == []
    assert observed == []
    action = get_control_plane_store().get_agent_action(job.id)
    assert action["authorized_scope_json"] == []


@pytest.mark.asyncio
async def test_projected_audit_result_is_delivered_once_without_persisting_payload():
    manager = JobManager()
    marker = "SCIENTIFIC-RESULT-MARKER"
    registered = RegisteredTool(
        spec=_immediate_tool(),
        replay_policy=ToolReplayPolicy.EXECUTE,
        audit_result_projector=lambda _result: {
            "schema_version": 1,
            "payload_sha256": "sha256:projection",
        },
    )

    async def handler(_args: dict, _context: ToolContext) -> dict:
        return {"scientific": marker}

    job = await manager.submit(
        spec=registered.spec,
        args={},
        handler=handler,
        reuse_cached_result=False,
        persisted_result_projector=registered.persisted_result,
    )

    first = manager.snapshot(job.id)
    assert first is not None
    assert first["result"] == {"scientific": marker}
    action = get_control_plane_store().get_agent_action(job.id)
    assert action["result_json"] == {
        AUDIT_RESULT_PROJECTION_KEY: {
            "schema_version": 1,
            "payload_sha256": "sha256:projection",
        }
    }
    assert marker not in str(action)

    retained = manager.snapshot(job.id)
    assert retained is not None
    assert "result" not in retained
    assert retained["resultProjection"] == {
        "schema_version": 1,
        "payload_sha256": "sha256:projection",
    }


def test_audit_result_projection_requires_immediate_execute_replay():
    registry = AgentToolRegistry()

    with pytest.raises(ValueError, match="immediate tool with execute replay"):
        registry.register(
            _immediate_tool(),
            replay_policy=ToolReplayPolicy.REUSE_RESULT,
            audit_result_projector=lambda result: result,
        )
    with pytest.raises(ValueError, match="immediate tool with execute replay"):
        registry.register(
            _long_tool(),
            replay_policy=ToolReplayPolicy.EXECUTE,
            audit_result_projector=lambda result: result,
        )


@pytest.mark.asyncio
async def test_idempotency_returns_cached_completed_job():
    manager = JobManager()
    first = await manager.submit(
        spec=_long_tool(),
        args={"sleep": 0.0},
        handler=_sleepy_handler,
        idempotency_key="idem",
    )
    await first.task

    second = await manager.submit(
        spec=_long_tool(),
        args={"sleep": 0.0},
        handler=_sleepy_handler,
        idempotency_key="idem",
    )

    assert second.id == first.id
    assert second.status == "completed"
    assert manager.snapshot(second.id)["result"] == manager.snapshot(first.id)["result"]


@pytest.mark.asyncio
async def test_idempotency_collision_rejects_different_body():
    manager = JobManager()
    first = await manager.submit(
        spec=_long_tool(),
        args={"sleep": 0.0},
        handler=_sleepy_handler,
        idempotency_key="idem",
    )
    await first.task

    with pytest.raises(IdempotencyConflict):
        await manager.submit(
            spec=_long_tool(),
            args={"sleep": 0.01},
            handler=_sleepy_handler,
            idempotency_key="idem",
        )


@pytest.mark.asyncio
async def test_idempotency_returns_in_flight_job_for_concurrent_calls():
    manager = JobManager()
    runs = 0

    async def handler(args: dict, context: ToolContext) -> dict:
        nonlocal runs
        runs += 1
        await asyncio.sleep(args.get("sleep", 0.01))
        return {"ok": True, "jobId": context.job_id}

    first, second = await asyncio.gather(
        manager.submit(
            spec=_immediate_tool(),
            args={"sleep": 0.05},
            handler=handler,
            idempotency_key="idem",
        ),
        manager.submit(
            spec=_immediate_tool(),
            args={"sleep": 0.05},
            handler=handler,
            idempotency_key="idem",
        ),
    )

    assert first.id == second.id
    assert first.status == "completed"
    assert runs == 1


@pytest.mark.asyncio
async def test_idempotency_collision_rejects_different_body_while_in_flight():
    manager = JobManager()
    first_task = asyncio.create_task(
        manager.submit(
            spec=_immediate_tool(),
            args={"sleep": 0.05},
            handler=_sleepy_handler,
            idempotency_key="idem",
        )
    )
    await asyncio.sleep(0)

    with pytest.raises(IdempotencyConflict):
        await manager.submit(
            spec=_immediate_tool(),
            args={"sleep": 0.01},
            handler=_sleepy_handler,
            idempotency_key="idem",
        )

    await first_task


@pytest.mark.asyncio
async def test_idempotency_replays_terminal_failure_without_repeating_handler():
    manager = JobManager()
    runs = 0

    async def failing_handler(args: dict, context: ToolContext) -> dict:
        nonlocal runs
        runs += 1
        raise RuntimeError("durable partial mutation")

    first = await manager.submit(
        spec=_immediate_tool(),
        args={"value": 1},
        handler=failing_handler,
        idempotency_key="failed-idem",
    )
    second = await manager.submit(
        spec=_immediate_tool(),
        args={"value": 1},
        handler=failing_handler,
        idempotency_key="failed-idem",
    )

    assert runs == 1
    assert second.id == first.id
    assert second.status == "failed"
    assert manager.snapshot(second.id)["error"] == manager.snapshot(first.id)["error"]


@pytest.mark.asyncio
async def test_idempotency_keys_are_isolated_by_agent_identity_across_restart():
    manager = JobManager()
    runs = 0

    def handler(args: dict, context: ToolContext) -> dict:
        nonlocal runs
        runs += 1
        return {"value": args["value"], "identity": context.agent_identity_id}

    first = await manager.submit(
        spec=_immediate_tool(),
        args={"value": 1},
        handler=handler,
        agent_identity_id="agent-alpha",
        idempotency_key="shared-client-key",
    )
    second = await manager.submit(
        spec=_immediate_tool(),
        args={"value": 1},
        handler=handler,
        agent_identity_id="agent-beta",
        idempotency_key="shared-client-key",
    )

    assert first.id != second.id
    assert runs == 2

    restarted = JobManager()
    alpha_replay = await restarted.submit(
        spec=_immediate_tool(),
        args={"value": 1},
        handler=handler,
        agent_identity_id="agent-alpha",
        idempotency_key="shared-client-key",
    )
    beta_replay = await restarted.submit(
        spec=_immediate_tool(),
        args={"value": 1},
        handler=handler,
        agent_identity_id="agent-beta",
        idempotency_key="shared-client-key",
    )

    assert alpha_replay.id == first.id
    assert beta_replay.id == second.id
    assert runs == 2


@pytest.mark.asyncio
async def test_terminal_jobs_and_idempotency_entries_are_evicted_after_ttl(monkeypatch):
    now = 1_000.0
    monkeypatch.setattr("src.concurrency.job_manager.time.monotonic", lambda: now)
    monkeypatch.setattr("src.concurrency.job_manager.time.time", lambda: now)
    manager = JobManager(ttl_seconds=10)
    first = await manager.submit(
        spec=_immediate_tool(),
        args={"value": 1},
        handler=lambda args, context: {"payload": "x" * 100_000},
        idempotency_key="expiring",
    )
    assert manager.get(first.id) is first

    now += 11
    assert manager.counts()["completed"] == 0
    assert manager.get(first.id) is None
    assert not hasattr(first, "result")
    persisted = get_control_plane_store().get_agent_action(first.id)
    assert persisted["result_json"]["payload"] == "x" * 100_000

    second = await manager.submit(
        spec=_immediate_tool(),
        args={"value": 2},
        handler=lambda args, context: {"payload": "replacement"},
        idempotency_key="expiring",
    )
    assert second.id != first.id


@pytest.mark.asyncio
async def test_terminal_job_retention_is_entry_bounded(monkeypatch):
    now = 1_000.0
    monkeypatch.setattr("src.concurrency.job_manager.time.monotonic", lambda: now)
    monkeypatch.setattr("src.concurrency.job_manager.time.time", lambda: now)
    manager = JobManager(ttl_seconds=10, max_terminal_jobs=2)
    handler_runs = 0

    def handler(args: dict, context: ToolContext) -> dict:
        nonlocal handler_runs
        handler_runs += 1
        return {"value": args["value"]}

    first = await manager.submit(
        spec=_immediate_tool(),
        args={"value": 1},
        handler=handler,
        idempotency_key="bounded-first",
    )
    second = await manager.submit(
        spec=_immediate_tool(),
        args={"value": 2},
        handler=handler,
        idempotency_key="bounded-second",
    )
    third = await manager.submit(
        spec=_immediate_tool(),
        args={"value": 3},
        handler=handler,
        idempotency_key="bounded-third",
    )

    assert manager.counts()["completed"] == 2
    assert first.id not in manager._jobs
    assert not hasattr(manager, "_evicted_terminal_receipts")
    assert manager.get(first.id).id == first.id
    assert manager.get(second.id) is second
    assert manager.get(third.id) is third

    replay_after_eviction = await manager.submit(
        spec=_immediate_tool(),
        args={"value": 1},
        handler=handler,
        idempotency_key="bounded-first",
    )
    assert replay_after_eviction.id == first.id
    assert manager.snapshot(first.id)["result"] == {"value": 1}
    assert handler_runs == 3

    now += 11
    assert manager.get(first.id) is None
    replay_after_expiry = await manager.submit(
        spec=_immediate_tool(),
        args={"value": 1},
        handler=handler,
        idempotency_key="bounded-first",
    )
    assert replay_after_expiry.id != first.id
    assert handler_runs == 4


@pytest.mark.asyncio
async def test_incomplete_sidecar_action_is_reconciled_without_replay():
    store = get_control_plane_store()
    manager = JobManager()
    started = asyncio.Event()
    release = asyncio.Event()
    handler_runs = 0

    async def handler(args: dict, context: ToolContext) -> dict:
        nonlocal handler_runs
        handler_runs += 1
        started.set()
        await release.wait()
        return {"value": args["value"]}

    original_submission = asyncio.create_task(
        manager.submit(
            spec=_long_tool(),
            args={"value": 1},
            handler=handler,
            idempotency_key="crash-window",
        )
    )
    await started.wait()
    original = await original_submission
    owner = original.task
    assert owner is not None

    try:
        restarted = JobManager()
        assert store.get_agent_action(original.id)["completed_at"] is None
        restarted.reconcile_interrupted_actions()
        recovered_at_startup = store.get_agent_action(original.id)
        assert recovered_at_startup["completed_at"] is not None
        assert recovered_at_startup["error_json"]["code"] == "OUTCOME_UNRESOLVED"
        recovered_by_id = restarted.get(original.id)
        assert recovered_by_id is not None
        assert recovered_by_id.id == original.id
        assert recovered_by_id.status == "failed"
        assert restarted.snapshot(original.id)["error"] == {
            "code": "OUTCOME_UNRESOLVED",
            "details": {"actionId": original.id, "stateMayHaveChanged": True},
            "message": (
                "The sidecar lost this action's execution owner. Inspect the original "
                "action and any domain audit before repeating work."
            ),
            "retriable": False,
        }

        replay = await restarted.submit(
            spec=_long_tool(),
            args={"value": 1},
            handler=handler,
            idempotency_key="crash-window",
        )
        assert replay.id == original.id
        assert replay.status == "failed"
        assert handler_runs == 1
        assert store.get_agent_action(original.id)["completed_at"] is not None
    finally:
        release.set()

    await owner
    assert original.status == "completed"
    assert handler_runs == 1


@pytest.mark.asyncio
async def test_cancel_persists_terminal_error_and_retention_together():
    manager = JobManager()
    job = await manager.submit(
        spec=_long_tool(),
        args={"sleep": 60},
        handler=_sleepy_handler,
    )

    owner = job.task
    await manager.cancel(job.id)
    await owner

    action = get_control_plane_store().get_agent_action(job.id)
    assert action["completed_at"] is not None
    assert action["terminal_expires_at"] is not None
    assert action["error_json"] == {"code": "CANCELED", "message": "Job canceled"}


@pytest.mark.asyncio
async def test_terminal_store_failure_still_releases_cancel_owners_after_ttl(
    monkeypatch,
):
    now = 1_000.0
    monkeypatch.setattr("src.concurrency.job_manager.time.monotonic", lambda: now)
    monkeypatch.setattr("src.concurrency.job_manager.time.time", lambda: now)
    manager = JobManager(ttl_seconds=10)
    job = await manager.submit(
        spec=_long_tool(),
        args={"sleep": 60},
        handler=_sleepy_handler,
        idempotency_key="cancel-store-failure",
    )
    task = job.task
    store = get_control_plane_store()

    def fail_terminal_write(*args, **kwargs):
        raise RuntimeError("injected terminal-store failure")

    monkeypatch.setattr(store, "complete_agent_action", fail_terminal_write)
    assert await manager.cancel(job.id)
    if task is not None:
        with pytest.raises(RuntimeError, match="injected terminal-store failure"):
            await task

    assert job.status == "canceled"
    assert job.terminal_expires_at == 1_010.0
    assert job.task is None
    assert job.cancel_event is None
    assert job.event_subscribers == set()
    cache_key = ("local-agent", "cancel-store-failure")
    assert manager._idempotency_cache[cache_key].expires_at == 1_010.0

    now += 11
    manager.counts()
    assert job.id not in manager._jobs
    assert cache_key not in manager._idempotency_cache


@pytest.mark.asyncio
async def test_terminal_store_failure_still_releases_completed_owner_after_ttl(
    monkeypatch,
):
    now = 2_000.0
    monkeypatch.setattr("src.concurrency.job_manager.time.monotonic", lambda: now)
    monkeypatch.setattr("src.concurrency.job_manager.time.time", lambda: now)
    manager = JobManager(ttl_seconds=10)
    store = get_control_plane_store()

    def fail_terminal_write(*args, **kwargs):
        raise RuntimeError("injected terminal-store failure")

    monkeypatch.setattr(store, "complete_agent_action", fail_terminal_write)
    with pytest.raises(RuntimeError, match="injected terminal-store failure"):
        await manager.submit(
            spec=_immediate_tool(),
            args={"value": 1},
            handler=lambda args, context: {"value": args["value"]},
            idempotency_key="complete-store-failure",
        )

    job = next(iter(manager._jobs.values()))
    assert job.status == "failed"
    assert job.terminal_expires_at == 2_010.0
    assert job.task is None
    assert job.cancel_event is None
    assert job.event_subscribers == set()
    cache_key = ("local-agent", "complete-store-failure")
    assert manager._idempotency_cache[cache_key].expires_at == 2_010.0

    now += 11
    manager.counts()
    assert manager._jobs == {}
    assert manager._idempotency_cache == {}


@pytest.mark.asyncio
async def test_terminal_store_failure_wakes_every_existing_event_stream(monkeypatch):
    manager = JobManager()
    release_handler = asyncio.Event()

    async def handler(args: dict, context: ToolContext) -> dict:
        await release_handler.wait()
        return {"ok": True}

    job = await manager.submit(
        spec=_long_tool(),
        args={},
        handler=handler,
        idempotency_key="stream-store-failure",
    )

    async def collect_events() -> list[dict]:
        return [event async for event in manager.event_stream(job.id)]

    stream_tasks = [asyncio.create_task(collect_events()) for _ in range(2)]
    await _wait_for_event_subscribers(job, 2)
    store = get_control_plane_store()

    def fail_terminal_write(*args, **kwargs):
        raise RuntimeError("injected terminal-store failure")

    monkeypatch.setattr(store, "complete_agent_action", fail_terminal_write)
    release_handler.set()
    if job.task is not None:
        with pytest.raises(RuntimeError, match="injected terminal-store failure"):
            await job.task

    event_lists = await asyncio.wait_for(asyncio.gather(*stream_tasks), timeout=1)
    assert job.status == "failed"
    assert all(
        any(event["event"] == "failed" for event in events) for events in event_lists
    )
    assert job.event_subscribers == set()


@pytest.mark.asyncio
async def test_completion_wakes_every_existing_event_stream():
    manager = JobManager()
    release_handler = asyncio.Event()

    async def handler(args: dict, context: ToolContext) -> dict:
        await release_handler.wait()
        return {"ok": True}

    job = await manager.submit(spec=_long_tool(), args={}, handler=handler)

    async def collect_events() -> list[dict]:
        return [event async for event in manager.event_stream(job.id)]

    stream_tasks = [asyncio.create_task(collect_events()) for _ in range(2)]
    await _wait_for_event_subscribers(job, 2)
    release_handler.set()
    if job.task is not None:
        await job.task

    event_lists = await asyncio.wait_for(asyncio.gather(*stream_tasks), timeout=1)
    assert all(
        any(event["event"] == "completed" for event in events) for events in event_lists
    )
    assert job.event_subscribers == set()


@pytest.mark.asyncio
async def test_cancellation_wakes_every_existing_event_stream():
    manager = JobManager()
    job = await manager.submit(
        spec=_long_tool(),
        args={"sleep": 60},
        handler=_sleepy_handler,
    )

    async def collect_events() -> list[dict]:
        return [event async for event in manager.event_stream(job.id)]

    stream_tasks = [asyncio.create_task(collect_events()) for _ in range(2)]
    await _wait_for_event_subscribers(job, 2)
    await manager.cancel(job.id)

    event_lists = await asyncio.wait_for(asyncio.gather(*stream_tasks), timeout=1)
    assert all(
        any(event["event"] == "canceled" for event in events) for events in event_lists
    )
    assert job.event_subscribers == set()


@pytest.mark.asyncio
async def test_disconnected_event_stream_unregisters_its_queue():
    manager = JobManager()
    job = await manager.submit(
        spec=_long_tool(),
        args={"sleep": 60},
        handler=_sleepy_handler,
    )
    stream = manager.event_stream(job.id)

    assert (await anext(stream))["event"] == "queued"
    assert (await anext(stream))["event"] == "running"
    pending_event = asyncio.create_task(anext(stream))
    await _wait_for_event_subscribers(job, 1)
    pending_event.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending_event

    assert job.event_subscribers == set()
    await manager.cancel(job.id)


@pytest.mark.asyncio
async def test_event_subscriber_caps_refuse_then_release_capacity():
    manager = JobManager(
        max_event_subscribers_per_job=2,
        max_event_subscribers_per_agent=3,
    )
    first_job = await manager.submit(
        spec=_long_tool(), args={"sleep": 60}, handler=_sleepy_handler
    )
    second_job = await manager.submit(
        spec=_long_tool(), args={"sleep": 60}, handler=_sleepy_handler
    )

    first = manager.subscribe_events(first_job.id)
    second = manager.subscribe_events(first_job.id)
    assert first is not None and second is not None
    with pytest.raises(JobEventSubscriberLimit) as job_limit:
        manager.subscribe_events(first_job.id)
    assert (job_limit.value.scope, job_limit.value.limit) == ("job", 2)

    third = manager.subscribe_events(second_job.id)
    assert third is not None
    with pytest.raises(JobEventSubscriberLimit) as agent_limit:
        manager.subscribe_events(second_job.id)
    assert (agent_limit.value.scope, agent_limit.value.limit) == ("agent", 3)

    first.close()
    replacement = manager.subscribe_events(second_job.id)
    assert replacement is not None
    for subscription in (second, third, replacement):
        subscription.close()
    assert first_job.event_subscribers == set()
    assert second_job.event_subscribers == set()
    assert manager._event_subscriber_counts_by_agent == {}

    await manager.cancel(first_job.id)
    await manager.cancel(second_job.id)


@pytest.mark.asyncio
async def test_slow_event_subscriber_is_detached_when_its_queue_fills():
    manager = JobManager(event_subscriber_queue_size=1)
    job = await manager.submit(
        spec=_long_tool(), args={"sleep": 60}, handler=_sleepy_handler
    )
    subscription = manager.subscribe_events(job.id)
    assert subscription is not None

    manager._push_event(job, "progress", {"step": 1})
    manager._push_event(job, "progress", {"step": 2})

    assert job.event_subscribers == set()
    assert manager._event_subscriber_counts_by_agent == {"local-agent": 1}
    replayed = [event async for event in subscription]
    assert [event["event"] for event in replayed] == ["queued"]
    assert manager._event_subscriber_counts_by_agent == {}
    assert manager._event_subscriber_counts_by_job == {}
    await manager.cancel(job.id)


@pytest.mark.asyncio
async def test_terminal_event_streams_remain_admitted_until_the_subscription_closes():
    manager = JobManager(
        max_event_subscribers_per_job=1,
        max_event_subscribers_per_agent=1,
    )
    job = await manager.submit(
        spec=_immediate_tool(),
        args={"value": 1},
        handler=lambda args, context: {"value": args["value"]},
    )

    held = manager.subscribe_events(job.id)
    assert held is not None
    with pytest.raises(JobEventSubscriberLimit) as held_limit:
        manager.subscribe_events(job.id)
    assert (held_limit.value.scope, held_limit.value.limit) == ("job", 1)
    assert manager._event_subscriber_counts_by_job == {job.id: 1}
    assert manager._event_subscriber_counts_by_agent == {"local-agent": 1}

    held.close()
    replacement = manager.subscribe_events(job.id)
    assert replacement is not None
    replacement.close()
    assert manager._event_subscriber_counts_by_job == {}
    assert manager._event_subscriber_counts_by_agent == {}


@pytest.mark.asyncio
async def test_terminal_compaction_keeps_a_slow_physical_stream_admitted():
    manager = JobManager(max_event_subscribers_per_job=1)
    release_handler = asyncio.Event()

    async def handler(args: dict, context: ToolContext) -> dict:
        await release_handler.wait()
        return {"ok": True}

    job = await manager.submit(spec=_long_tool(), args={}, handler=handler)
    held = manager.subscribe_events(job.id)
    assert held is not None
    release_handler.set()
    if job.task is not None:
        await job.task

    assert job.status == "completed"
    assert manager._event_subscriber_counts_by_job == {job.id: 1}
    with pytest.raises(JobEventSubscriberLimit):
        manager.subscribe_events(job.id)

    replayed = [event async for event in held]
    assert any(event["event"] == "completed" for event in replayed)
    assert manager._event_subscriber_counts_by_job == {}
    assert manager._event_subscriber_counts_by_agent == {}


@pytest.mark.asyncio
async def test_terminal_job_entry_bound_never_evicts_an_active_job():
    manager = JobManager(max_terminal_jobs=1)
    active = await manager.submit(
        spec=_long_tool(),
        args={"sleep": 60},
        handler=_sleepy_handler,
    )

    first_terminal = await manager.submit(
        spec=_immediate_tool(),
        args={"value": 1},
        handler=lambda args, context: {"value": args["value"]},
    )
    second_terminal = await manager.submit(
        spec=_immediate_tool(),
        args={"value": 2},
        handler=lambda args, context: {"value": args["value"]},
    )

    assert manager.get(active.id) is active
    assert first_terminal.id not in manager._jobs
    assert manager.get(first_terminal.id).id == first_terminal.id
    assert manager.get(second_terminal.id) is second_terminal
    await manager.cancel(active.id)


@pytest.mark.asyncio
async def test_large_terminal_payload_is_not_duplicated_in_job_events_or_queue():
    manager = JobManager()
    job = await manager.submit(
        spec=_immediate_tool(),
        args={},
        handler=lambda args, context: {"payload": "x" * 100_000},
        idempotency_key="large-result",
    )

    assert not hasattr(job, "result")
    assert all("payload" not in repr(event) for event in job.events)
    assert manager.snapshot(job.id)["result"]["payload"] == "x" * 100_000


@pytest.mark.asyncio
async def test_terminal_job_releases_execution_only_runtime_owners():
    manager = JobManager()
    job = await manager.submit(
        spec=_long_tool(),
        args={"sleep": 0},
        handler=_sleepy_handler,
        idempotency_key="compact-terminal",
    )
    running_task = job.task
    assert running_task is not None

    await running_task

    assert job.status == "completed"
    assert job.task is None
    assert job.cancel_event is None
    assert job.event_subscribers == set()
    assert [event["event"] for event in job.events] == [
        "queued",
        "running",
        "completed",
    ]
    assert manager.snapshot(job.id)["result"]["ok"] is True

    replayed = [event async for event in manager.event_stream(job.id)]
    assert [event["event"] for event in replayed] == [
        "queued",
        "running",
        "completed",
    ]


@pytest.mark.asyncio
async def test_active_job_survives_terminal_retention_pruning(monkeypatch):
    now = 1_000.0
    monkeypatch.setattr("src.concurrency.job_manager.time.monotonic", lambda: now)
    monkeypatch.setattr("src.concurrency.job_manager.time.time", lambda: now)
    manager = JobManager(ttl_seconds=10)
    job = await manager.submit(
        spec=_long_tool(),
        args={"sleep": 60},
        handler=_sleepy_handler,
    )

    now += 1_000
    assert manager.get(job.id) is job
    await manager.cancel(job.id)


@pytest.mark.asyncio
async def test_pool_queue_cap_refuses_over_quota():
    manager = JobManager()
    first = await manager.submit(
        spec=_long_tool(),
        args={"sleep": 0.05},
        handler=_sleepy_handler,
    )
    second = await manager.submit(
        spec=_long_tool(),
        args={"sleep": 0.05},
        handler=_sleepy_handler,
    )
    with pytest.raises(QueueRefusal):
        await manager.submit(
            spec=_long_tool(),
            args={"sleep": 0.05},
            handler=_sleepy_handler,
        )
    await manager.cancel(first.id)
    await manager.cancel(second.id)


@pytest.mark.asyncio
async def test_external_job_observations_use_committed_authority_and_finish_cleanup_before_delivery(
    monkeypatch,
):
    from src import external_access_observation

    monkeypatch.setenv("DNAFORGE_EXTERNAL_ACCESS_OBSERVATIONS", "1")
    store = get_control_plane_store()
    store.create_agent_identity(
        identity_id="agent_http_private-client",
        kind="http-api-key",
        origin="tool-key",
        label="PRIVATE_LABEL",
        api_key_hash="PRIVATE_HASH",
        scope=["debug.echo"],
    )
    manager = JobManager()
    receipts = []

    async def delivered(receipt):
        assert external_access_observation.valid_observation(receipt)
        if receipt["access_stage"] == "request_outcome":
            owned = next(iter(manager._jobs.values()))
            assert owned.status == "completed"
            assert owned.cancel_event is None
            assert owned.task is None
            assert owned.terminal_expires_at is not None
        receipts.append(receipt)
        return True

    monkeypatch.setattr(
        external_access_observation, "emit_external_access_observation", delivered
    )
    job = await manager.submit(
        spec=_long_tool(),
        args={"sleep": 0},
        handler=_sleepy_handler,
        agent_identity_id="agent_http_private-client",
        agent_capabilities=["debug.echo"],
        idempotency_key="one-real-operation",
    )
    owner = job.task
    assert owner is not None
    await owner
    assert [value["access_stage"] for value in receipts] == [
        "request_admitted",
        "request_outcome",
    ]
    assert receipts[0]["access_result"] == "admitted"
    assert receipts[0]["access_execution"] == "queued"
    assert receipts[1]["access_result"] == "allowed"
    assert receipts[1]["access_execution"] == "completed"
    assert receipts[0]["operation_id"] == receipts[1]["operation_id"]
    assert job.id != receipts[0]["operation_id"]
    text = json.dumps(receipts)
    assert job.id not in text
    for private in ("PRIVATE_LABEL", "PRIVATE_HASH", "private-client", "slow.echo"):
        assert private not in text
    replay = await manager.submit(
        spec=_long_tool(),
        args={"sleep": 0},
        handler=_sleepy_handler,
        agent_identity_id="agent_http_private-client",
        agent_capabilities=["debug.echo"],
        idempotency_key="one-real-operation",
    )
    assert replay.id == job.id
    assert len(receipts) == 2


@pytest.mark.asyncio
async def test_optional_observation_transport_failure_preserves_job_result_and_cleanup(
    monkeypatch,
):
    from src import external_access_observation

    monkeypatch.setenv("DNAFORGE_EXTERNAL_ACCESS_OBSERVATIONS", "1")
    get_control_plane_store().create_agent_identity(
        identity_id="agent_http_optional-failure",
        kind="http-api-key",
        origin="tool-key",
        scope=["debug.echo"],
    )

    async def failed(_receipt):
        raise OSError("optional bridge unavailable")

    monkeypatch.setattr(
        external_access_observation, "emit_external_access_observation", failed
    )
    manager = JobManager()
    job = await manager.submit(
        spec=_immediate_tool(),
        args={},
        handler=_sleepy_handler,
        agent_identity_id="agent_http_optional-failure",
        agent_capabilities=["debug.echo"],
    )
    assert job.status == "completed"
    assert job.cancel_event is None
    assert job.task is None
    assert job.terminal_expires_at is not None
    assert manager.snapshot(job.id)["result"]["ok"] is True
