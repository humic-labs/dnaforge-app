from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from src.external.contract import FetchOptions, ProviderTimeoutError
from src.external.resilience import _CircuitBreaker
from src.external.service import CircuitOpen, ExternalResourcesService


@pytest.fixture
def clock(monkeypatch):
    now = [100.0]
    monkeypatch.setattr("src.external.resilience.time.monotonic", lambda: now[0])
    return now


@pytest.fixture
async def service():
    owner = ExternalResourcesService(None, rate_limit_per_s=1000, rate_limit_burst=1000)
    owner._breakers["transition-fixture"] = _CircuitBreaker(
        failure_threshold=2, recovery_timeout_s=30
    )
    try:
        yield owner
    finally:
        await owner.aclose()


async def unavailable():
    raise ProviderTimeoutError("Provider remains unavailable")


async def run(service, operation=unavailable):
    return await service._run_through_resilience(
        SimpleNamespace(provider_id="transition-fixture"),
        FetchOptions(max_retries=0),
        operation,
    )


async def open_circuit(service):
    for _ in range(2):
        with pytest.raises(ProviderTimeoutError):
            await run(service)
    with pytest.raises(CircuitOpen):
        await run(service)


async def test_failed_recovery_probe_starts_a_new_cooldown(service, clock):
    await open_circuit(service)
    clock[0] = 131.0
    with pytest.raises(ProviderTimeoutError):
        await run(service)
    for _ in range(3):
        with pytest.raises(CircuitOpen) as blocked:
            await run(service)
        assert blocked.value.opens_at_s == 30.0
    clock[0] = 162.0
    with pytest.raises(ProviderTimeoutError):
        await run(service)
    with pytest.raises(CircuitOpen):
        await run(service)


async def test_only_one_recovery_probe_can_run(service, clock):
    await open_circuit(service)
    clock[0] = 131.0
    started = asyncio.Event()
    finish = asyncio.Event()

    async def probe():
        started.set()
        await finish.wait()
        return "recovered"

    pending = asyncio.create_task(run(service, probe))
    await started.wait()
    try:
        with pytest.raises(CircuitOpen):
            await run(service)
    finally:
        finish.set()
        assert await pending == "recovered"
    assert service._breakers["transition-fixture"].is_open is False


async def test_late_success_cannot_close_a_newer_cooldown(service, clock):
    started = asyncio.Event()
    finish = asyncio.Event()

    async def old_request():
        started.set()
        await finish.wait()
        return "old-success"

    pending = asyncio.create_task(run(service, old_request))
    await started.wait()
    try:
        await open_circuit(service)
    finally:
        finish.set()
        assert await pending == "old-success"
    with pytest.raises(CircuitOpen):
        await run(service)


async def test_cancelled_probe_releases_its_ownership(service, clock):
    await open_circuit(service)
    clock[0] = 131.0
    started = asyncio.Event()

    async def probe():
        started.set()
        await asyncio.Event().wait()

    pending = asyncio.create_task(run(service, probe))
    await started.wait()
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    clock[0] = 162.0

    async def recovered():
        return "recovered"

    assert await run(service, recovered) == "recovered"
    assert service._breakers["transition-fixture"].is_open is False
