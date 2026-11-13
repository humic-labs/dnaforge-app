from __future__ import annotations

import asyncio
import json
import threading
import time

import httpx
import pytest

from src.concurrency.pools import PoolConfig, PoolManager
from src.concurrency.schema import PoolName
from src.main import app
from src.tools import primer_design


def _request(length: int = 80) -> primer_design.PrimerDesignRequest:
    return primer_design.PrimerDesignRequest(sequence="A" * length)


def _no_pairs() -> dict[str, int]:
    return {"PRIMER_PAIR_NUM_RETURNED": 0}


async def _wait_until(predicate, timeout_seconds: float = 1.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    while not predicate():
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError("condition did not become true")
        await asyncio.sleep(0.005)


@pytest.mark.asyncio
async def test_design_route_keeps_health_responsive_while_primer3_is_held(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = PoolManager([PoolConfig(PoolName.CPU_SLOW.value, 1, 0, "thread")])
    monkeypatch.setattr(
        primer_design, "get_pool_manager", lambda: manager, raising=False
    )
    started = threading.Event()
    release = threading.Event()
    physical_start: list[float] = []

    def blocking_design(*_args: object) -> dict[str, int]:
        physical_start.append(time.monotonic())
        started.set()
        release.wait(timeout=1)
        return _no_pairs()

    monkeypatch.setattr(primer_design.primer3, "design_primers", blocking_design)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://sidecar.test",
        headers={"X-DNAForge-Session": "test-suite-sidecar-session"},
    ) as client:
        design_task = asyncio.create_task(
            client.post(
                "/api/tools/primers/design",
                json={"sequence": "A" * 80},
            )
        )
        try:
            await _wait_until(started.is_set, timeout_seconds=1.5)
            health = await client.get("/health")
            health_delay = time.monotonic() - physical_start[0]

            assert health.status_code == 200
            assert health_delay < 0.5
            assert manager.get(PoolName.CPU_SLOW.value).stats()["active"] == 1
        finally:
            release.set()

        response = await design_task
        assert response.status_code == 200


@pytest.mark.asyncio
async def test_design_admission_refuses_before_starting_an_unowned_worker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = PoolManager([PoolConfig(PoolName.CPU_SLOW.value, 1, 0, "thread")])
    monkeypatch.setattr(
        primer_design, "get_pool_manager", lambda: manager, raising=False
    )
    started = threading.Event()
    release = threading.Event()
    starts = 0

    def blocking_design(*_args: object) -> dict[str, int]:
        nonlocal starts
        starts += 1
        started.set()
        release.wait(timeout=1)
        return _no_pairs()

    monkeypatch.setattr(primer_design.primer3, "design_primers", blocking_design)
    first = asyncio.create_task(primer_design.design_primers(_request()))
    try:
        await _wait_until(started.is_set, timeout_seconds=1.5)
        refused = await primer_design.design_primers(_request())

        assert refused.status_code == 429
        assert refused.headers["retry-after"] == "8"
        assert json.loads(refused.body) == {
            "error": "queue_full",
            "refusal_kind": "saturated",
            "queue_depth": 0,
            "pool_capacity": 1,
            "retry_after_seconds": 8,
        }
        assert starts == 1
    finally:
        release.set()
        await first


@pytest.mark.asyncio
async def test_cancelled_design_retains_capacity_until_primer3_settles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = PoolManager([PoolConfig(PoolName.CPU_SLOW.value, 1, 0, "thread")])
    monkeypatch.setattr(
        primer_design, "get_pool_manager", lambda: manager, raising=False
    )
    started = threading.Event()
    release = threading.Event()
    starts = 0

    def noncooperative_design(*_args: object) -> dict[str, int]:
        nonlocal starts
        starts += 1
        started.set()
        release.wait(timeout=1)
        return _no_pairs()

    monkeypatch.setattr(primer_design.primer3, "design_primers", noncooperative_design)
    request_task = asyncio.create_task(primer_design.design_primers(_request()))
    try:
        await _wait_until(started.is_set, timeout_seconds=1.5)
        request_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request_task

        pool = manager.get(PoolName.CPU_SLOW.value)
        assert pool.stats()["active"] == 1
        refused = await primer_design.design_primers(_request())
        assert refused.status_code == 429
        assert starts == 1
    finally:
        release.set()

    await _wait_until(
        lambda: manager.get(PoolName.CPU_SLOW.value).stats()["active"] == 0
    )


@pytest.mark.asyncio
async def test_cancelled_queued_design_never_starts_primer3(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = PoolManager([PoolConfig(PoolName.CPU_SLOW.value, 1, 1, "thread")])
    monkeypatch.setattr(
        primer_design, "get_pool_manager", lambda: manager, raising=False
    )
    first_started = threading.Event()
    release_first = threading.Event()
    starts = 0

    def blocking_design(*_args: object) -> dict[str, int]:
        nonlocal starts
        starts += 1
        first_started.set()
        release_first.wait(timeout=1)
        return _no_pairs()

    monkeypatch.setattr(primer_design.primer3, "design_primers", blocking_design)
    first = asyncio.create_task(primer_design.design_primers(_request()))
    queued = asyncio.create_task(primer_design.design_primers(_request()))
    pool = manager.get(PoolName.CPU_SLOW.value)
    try:
        await _wait_until(first_started.is_set, timeout_seconds=1.5)
        await _wait_until(lambda: pool.stats()["queued"] == 1)

        queued.cancel()
        with pytest.raises(asyncio.CancelledError):
            await queued
        await _wait_until(lambda: pool.stats()["queued"] == 0)

        assert starts == 1
    finally:
        release_first.set()
        await first

    assert starts == 1


@pytest.mark.asyncio
async def test_design_api_enforces_published_template_limit_before_primer3(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    def controlled_design(*_args: object) -> dict[str, int]:
        nonlocal calls
        calls += 1
        return _no_pairs()

    monkeypatch.setattr(primer_design.primer3, "design_primers", controlled_design)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://sidecar.test",
        headers={"X-DNAForge-Session": "test-suite-sidecar-session"},
    ) as client:
        accepted = await client.post(
            "/api/tools/primers/design",
            json={"sequence": "A" * 50_000},
        )
        rejected = await client.post(
            "/api/tools/primers/design",
            json={"sequence": "A" * 50_001},
        )

    assert accepted.status_code == 200
    assert rejected.status_code == 422
    assert calls == 1


def test_design_openapi_declares_limit_and_capacity_refusal() -> None:
    app.openapi_schema = None
    schema = app.openapi()
    request_schema = schema["components"]["schemas"]["PrimerDesignRequest"]
    assert request_schema["properties"]["sequence"]["maxLength"] == 50_000

    responses = schema["paths"]["/api/tools/primers/design"]["post"]["responses"]
    refusal_schema = responses["429"]["content"]["application/json"]["schema"]
    assert refusal_schema == {"$ref": "#/components/schemas/QueueRefusalResponse"}
