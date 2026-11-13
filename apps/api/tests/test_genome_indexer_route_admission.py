from __future__ import annotations

import asyncio
import threading

import pytest

from src.concurrency.pools import PoolConfig, PoolManager
from src.concurrency.schema import PoolName
from src.routes import genome


class _ConnectedRequest:
    async def is_disconnected(self) -> bool:
        return False


def _request() -> genome.IndexGenomeRequest:
    return genome.IndexGenomeRequest(
        input="/workspace/reference.gb",
        outputDir="/workspace/derived",
        name="reference",
        workspaceRoot="/workspace",
    )


def _response() -> genome.IndexGenomeResponse:
    return genome.IndexGenomeResponse(
        fastaPath="/workspace/derived/reference.fa",
        faiPath="/workspace/derived/reference.fa.fai",
        gffPath=None,
        tbiPath=None,
        metadata=genome.GenomeMetadataResponse(
            length=4,
            circular=False,
            featureCount=0,
            annotationTypes=[],
            annotationRasterReady=True,
        ),
    )


async def _wait_until(predicate, timeout_seconds: float = 1.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    while not predicate():
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError("condition did not become true")
        await asyncio.sleep(0.005)


@pytest.mark.asyncio
async def test_index_admission_refuses_before_submitting_an_unbounded_worker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = PoolManager([PoolConfig(PoolName.CPU_SLOW.value, 1, 0, "thread")])
    monkeypatch.setattr(genome, "get_pool_manager", lambda: manager)
    started = threading.Event()
    release = threading.Event()

    def blocking_index(*_args: object) -> genome.IndexGenomeResponse:
        started.set()
        release.wait(timeout=2)
        return _response()

    monkeypatch.setattr(genome, "_index_genome_route_sync", blocking_index)
    first = asyncio.create_task(
        genome.index_genome_route(_request(), _ConnectedRequest())
    )
    await _wait_until(started.is_set)

    refused = await genome.index_genome_route(_request(), _ConnectedRequest())
    assert refused.status_code == 429
    assert refused.headers["retry-after"] == "8"
    assert b'"error":"queue_full"' in refused.body
    assert manager.get(PoolName.CPU_SLOW.value).stats() == {
        "size": 1,
        "active": 1,
        "queued": 0,
        "backing": "thread",
        "max_queued_jobs": 0,
    }

    release.set()
    assert (await first).metadata.length == 4


@pytest.mark.asyncio
async def test_cancelled_request_retains_capacity_until_worker_settles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = PoolManager([PoolConfig(PoolName.CPU_SLOW.value, 1, 0, "thread")])
    monkeypatch.setattr(genome, "get_pool_manager", lambda: manager)
    started = threading.Event()
    release = threading.Event()

    def noncooperative_index(*_args: object) -> genome.IndexGenomeResponse:
        started.set()
        release.wait(timeout=2)
        return _response()

    monkeypatch.setattr(genome, "_index_genome_route_sync", noncooperative_index)
    request_task = asyncio.create_task(
        genome.index_genome_route(_request(), _ConnectedRequest())
    )
    await _wait_until(started.is_set)
    request_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request_task

    pool = manager.get(PoolName.CPU_SLOW.value)
    assert pool.stats()["active"] == 1
    release.set()
    await _wait_until(lambda: pool.stats()["active"] == 0)
