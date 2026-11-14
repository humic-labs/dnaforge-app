import asyncio
import threading

import pytest
from starlette.requests import Request

from src.concurrency.pools import PoolConfig, PoolManager
from src.routes import tiles


def request_with_disconnect():
    messages = asyncio.Queue()
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/tiles/alignment/0/0",
            "headers": [],
            "query_string": b"",
        },
        receive=messages.get,
    )
    return request, messages


def local_route(monkeypatch, worker):
    manager = PoolManager([PoolConfig("tile_io", 1, 8, "asyncio")])
    monkeypatch.setattr(tiles, "get_pool_manager", lambda: manager)
    monkeypatch.setattr(tiles, "_validate_aligned_read_source_generation", lambda *_: None)
    monkeypatch.setattr(tiles, "_compute_alignment_tile", worker)
    return manager.get("tile_io"), tiles._TileSourceBody(
        bamPath="/local/whole-genome.bam", chrom="chr1"
    )


async def wait_for_queue(pool, count):
    for _ in range(100):
        if pool.stats()["queued"] == count:
            return
        await asyncio.sleep(0)
    raise AssertionError(pool.stats())


@pytest.mark.asyncio
async def test_disconnected_queued_local_read_does_not_start_native_work(monkeypatch):
    calls = []

    def worker(*args):
        calls.append(args[5])
        return {"reads": [], "count": 0}

    pool, body = local_route(monkeypatch, worker)
    obsolete_request, disconnected = request_with_disconnect()
    current_request, _ = request_with_disconnect()
    async with pool.slot():
        obsolete = asyncio.create_task(
            tiles.alignment_tile_route(0, 0, body, obsolete_request)
        )
        await wait_for_queue(pool, 1)
        disconnected.put_nowait({"type": "http.disconnect"})
        current = asyncio.create_task(
            tiles.alignment_tile_route(0, 1, body, current_request)
        )
        await wait_for_queue(pool, 2)
    closed = await obsolete
    assert closed.status_code == 499
    response = await current
    assert response.status_code == 200
    assert calls == [1]
    assert pool.stats()["active"] == 0
    assert pool.stats()["queued"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bam_path", ["/local/whole-genome.bam", "https://source/reads.bam"]
)
async def test_real_alignment_task_cancellation_is_not_a_client_closed_response(
    monkeypatch, bam_path
):
    async def cancelled(*_):
        raise asyncio.CancelledError

    monkeypatch.setattr(tiles, "_run_alignment_request", cancelled)
    body = tiles._TileSourceBody(bamPath=bam_path, chrom="chr1")
    request, _ = request_with_disconnect()
    with pytest.raises(asyncio.CancelledError):
        await tiles.alignment_tile_route(0, 0, body, request)


@pytest.mark.asyncio
async def test_disconnected_running_local_read_keeps_capacity_until_thread_finishes(monkeypatch):
    started = threading.Event()
    release = threading.Event()
    calls = []

    def worker(*args):
        calls.append(args[5])
        if args[5] == 0:
            started.set()
            if not release.wait(2):
                raise AssertionError("The test did not release its owned worker")
        return {"reads": [], "count": 0}

    pool, body = local_route(monkeypatch, worker)
    old_request, disconnected = request_with_disconnect()
    current_request, _ = request_with_disconnect()
    old = asyncio.create_task(tiles.alignment_tile_route(0, 0, body, old_request))
    current = None
    try:
        assert await asyncio.to_thread(started.wait, 1)
        disconnected.put_nowait({"type": "http.disconnect"})
        current = asyncio.create_task(
            tiles.alignment_tile_route(0, 1, body, current_request)
        )
        await wait_for_queue(pool, 1)
        assert not old.done()
        assert calls == [0]
        assert pool.stats()["active"] == 1
    finally:
        release.set()
        await asyncio.gather(old, *([current] if current else []))
    assert calls == [0, 1]
    assert pool.stats()["active"] == 0


@pytest.mark.asyncio
async def test_disconnected_local_extraction_stops_before_current_worker_starts(monkeypatch):
    started = threading.Event()
    acknowledged = threading.Event()
    release = threading.Event()
    calls = []

    def worker(*args):
        tile_index = args[5]
        calls.append(tile_index)
        if tile_index == 0:
            started.set()
            check_cancelled = args[8] if len(args) > 8 else None
            try:
                while not release.wait(0.001):
                    if check_cancelled is not None:
                        check_cancelled()
            except tiles._LocalAlignmentClientClosed:
                acknowledged.set()
                raise
        else:
            assert acknowledged.is_set()
        return {"reads": [], "count": 0}

    pool, body = local_route(monkeypatch, worker)
    old_request, disconnected = request_with_disconnect()
    current_request, _ = request_with_disconnect()
    old = asyncio.create_task(tiles.alignment_tile_route(0, 0, body, old_request))
    current = None
    try:
        assert await asyncio.to_thread(started.wait, 1)
        disconnected.put_nowait({"type": "http.disconnect"})
        current = asyncio.create_task(
            tiles.alignment_tile_route(0, 1, body, current_request)
        )
        closed = await asyncio.wait_for(asyncio.shield(old), 0.5)
        assert closed.status_code == 499
        assert (await current).status_code == 200
        assert calls == [0, 1]
        assert pool.stats()["active"] == 0
        assert pool.stats()["queued"] == 0
    finally:
        release.set()
        await asyncio.gather(old, *([current] if current else []), return_exceptions=True)


@pytest.mark.asyncio
async def test_cancelled_local_owner_waits_for_noncooperative_worker_ack(monkeypatch):
    started = threading.Event()
    release = threading.Event()
    calls = []

    def worker(*args):
        calls.append(args[5])
        if args[5] == 0:
            started.set()
            if not release.wait(2):
                raise AssertionError("The test did not release its owned worker")
        return {"reads": [], "count": 0}

    pool, body = local_route(monkeypatch, worker)
    old_request, _ = request_with_disconnect()
    current_request, _ = request_with_disconnect()
    old = asyncio.create_task(tiles.alignment_tile_route(0, 0, body, old_request))
    current = None
    try:
        assert await asyncio.to_thread(started.wait, 1)
        old.cancel()
        current = asyncio.create_task(
            tiles.alignment_tile_route(0, 1, body, current_request)
        )
        await wait_for_queue(pool, 1)
        assert not old.done()
        assert pool.stats()["active"] == 1
        assert calls == [0]
    finally:
        release.set()
        await asyncio.gather(old, *([current] if current else []), return_exceptions=True)
    with pytest.raises(asyncio.CancelledError):
        await old
    assert calls == [0, 1]
    assert pool.stats()["active"] == 0
