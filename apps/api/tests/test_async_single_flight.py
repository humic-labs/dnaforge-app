from __future__ import annotations

import asyncio

import pytest

from src.external.async_single_flight import AsyncSingleFlight


@pytest.mark.asyncio
async def test_identical_concurrent_calls_share_one_producer():
    flights = AsyncSingleFlight[str, str]()
    started = asyncio.Event()
    release = asyncio.Event()
    producer_calls = 0

    async def produce() -> str:
        nonlocal producer_calls
        producer_calls += 1
        started.set()
        await release.wait()
        return "snapshot"

    first = asyncio.create_task(flights.run("same-source", produce))
    await started.wait()
    second = asyncio.create_task(flights.run("same-source", produce))
    await asyncio.sleep(0)
    release.set()

    assert await asyncio.gather(first, second) == ["snapshot", "snapshot"]
    assert producer_calls == 1


@pytest.mark.asyncio
async def test_cancelled_waiter_does_not_cancel_the_shared_producer():
    flights = AsyncSingleFlight[str, str]()
    started = asyncio.Event()
    release = asyncio.Event()

    async def produce() -> str:
        started.set()
        await release.wait()
        return "snapshot"

    cancelled_waiter = asyncio.create_task(flights.run("same-source", produce))
    await started.wait()
    surviving_waiter = asyncio.create_task(flights.run("same-source", produce))
    cancelled_waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancelled_waiter
    release.set()

    assert await surviving_waiter == "snapshot"


@pytest.mark.asyncio
async def test_failed_producer_is_retired_for_an_explicit_retry():
    flights = AsyncSingleFlight[str, str]()
    producer_calls = 0

    async def produce() -> str:
        nonlocal producer_calls
        producer_calls += 1
        if producer_calls == 1:
            raise RuntimeError("temporary failure")
        return "recovered"

    with pytest.raises(RuntimeError, match="temporary failure"):
        await flights.run("same-source", produce)

    assert await flights.run("same-source", produce) == "recovered"
    assert producer_calls == 2


@pytest.mark.asyncio
async def test_completed_key_is_retired_without_a_fire_and_forget_cleanup_task(
    monkeypatch,
):
    original_create_task = asyncio.create_task
    created_tasks = []

    def tracked_create_task(coro):
        task = original_create_task(coro)
        created_tasks.append(task)
        return task

    monkeypatch.setattr(asyncio, "create_task", tracked_create_task)
    flights = AsyncSingleFlight[str, str]()

    assert (
        await flights.run("one-shot", lambda: asyncio.sleep(0, result="done")) == "done"
    )
    await asyncio.sleep(0)

    assert flights._tasks == {}
    assert len(created_tasks) == 1
