import asyncio
import threading

import numpy as np
import pytest
from starlette.requests import Request

from src.concurrency.pools import PoolConfig, PoolManager
from src.routes import tiles
from src.services import coverage_pyramid as cp
from src.services import pileup


def request_with_disconnect():
    messages = asyncio.Queue()
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/tiles/coverage/0/0",
            "headers": [],
            "query_string": b"",
        },
        receive=messages.get,
    ), messages


def coverage_route(monkeypatch, kind, worker, bam_path="/local/reads.bam"):
    manager = PoolManager([PoolConfig("tile_io", 1, 8, "asyncio")])
    monkeypatch.setattr(tiles, "get_pool_manager", lambda: manager)
    monkeypatch.setattr(tiles, "_validate_aligned_read_source_generation", lambda *_, **__: None)
    monkeypatch.setattr(pileup, "_resolve_bam_path", lambda p: p)
    monkeypatch.setattr(pileup, "_resolve_index_path", lambda _: None)
    monkeypatch.setattr(pileup, "_resolve_reference_path", lambda _: None)
    monkeypatch.setattr(cp, "cached_reference_lengths", lambda _: {"chr1": 100_000})
    monkeypatch.setattr(
        cp, "coverage_tile" if kind == "coverage" else "coverage_assembly_tile", worker
    )
    monkeypatch.setattr(tiles, "_assembly_depth_scale", lambda *_, **__: None)
    monkeypatch.setattr(tiles, "_assembly_depth_percentiles", lambda *_, **__: None)

    def route(index, request):
        if kind == "coverage":
            return tiles.coverage_tile_route(
                0, index, tiles._TileSourceBody(bamPath=bam_path, chrom="chr1"), request
            )
        body = tiles.CoverageAssemblyTileBody(
            bamPath=bam_path,
            segments=[
                {
                    "chrom": "chr1",
                    "start": index * 1024,
                    "end": (index + 1) * 1024,
                    "chromGlobalStart": 0,
                }
            ],
        )
        return tiles.coverage_assembly_tile_route(0, index, body, request)

    return manager.get("tile_io"), route


async def queued(pool, count):
    for _ in range(200):
        if pool.stats()["queued"] == count:
            return
        await asyncio.sleep(0)
    raise AssertionError(pool.stats())


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["coverage", "assembly"])
async def test_disconnected_queued_coverage_never_starts_worker(monkeypatch, kind):
    calls = []

    def worker(*args, **kwargs):
        calls.append(args)
        return {"maxDepth": 0}

    pool, route = coverage_route(monkeypatch, kind, worker)
    request, messages = request_with_disconnect()
    async with pool.slot():
        old = asyncio.create_task(route(0, request))
        await queued(pool, 1)
        messages.put_nowait({"type": "http.disconnect"})
        await asyncio.sleep(0.06)
    closed = await old
    assert closed.status_code == 499
    assert calls == []
    assert pool.stats()["active"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["coverage", "assembly"])
async def test_running_coverage_disconnect_acknowledges_before_releasing_capacity(
    monkeypatch, kind
):
    started, release, acknowledged = threading.Event(), threading.Event(), threading.Event()
    calls = []

    def worker(*args, **kwargs):
        index = args[2] if kind == "coverage" else args[1][0]["start"]
        calls.append(index)
        if index == 0:
            started.set()
            try:
                while not release.wait(0.001):
                    check = kwargs.get("check_cancelled")
                    if check is not None:
                        check()
            except tiles._LocalAlignmentClientClosed:
                acknowledged.set()
                raise
        else:
            assert acknowledged.is_set()
        return {"maxDepth": 0}

    pool, route = coverage_route(monkeypatch, kind, worker)
    request, messages = request_with_disconnect()
    current_request, _ = request_with_disconnect()
    old = asyncio.create_task(route(0, request))
    current = None
    try:
        assert await asyncio.to_thread(started.wait, 0.5)
        messages.put_nowait({"type": "http.disconnect"})
        current = asyncio.create_task(route(1, current_request))
        closed = await asyncio.wait_for(asyncio.shield(old), 0.5)
        assert closed.status_code == 499
        assert (await current).status_code == 200
        assert acknowledged.is_set()
        assert pool.stats()["active"] == 0
    finally:
        release.set()
        await asyncio.gather(old, *([current] if current else []), return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["coverage", "assembly"])
async def test_cancelled_coverage_owner_keeps_capacity_until_worker_ack(monkeypatch, kind):
    started, release = threading.Event(), threading.Event()

    def worker(*args, **kwargs):
        started.set()
        assert release.wait(1)
        return {"maxDepth": 0}

    pool, route = coverage_route(monkeypatch, kind, worker)
    request, _ = request_with_disconnect()
    old = asyncio.create_task(route(0, request))
    try:
        assert await asyncio.to_thread(started.wait, 0.5)
        old.cancel()
        for _ in range(10):
            await asyncio.sleep(0)
        assert not old.done()
        assert pool.stats()["active"] == 1
    finally:
        release.set()
        await asyncio.gather(old, return_exceptions=True)
    with pytest.raises(asyncio.CancelledError):
        await old
    assert pool.stats()["active"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["coverage", "assembly"])
async def test_unexpected_coverage_failure_is_not_client_closed(monkeypatch, kind):
    def worker(*args, **kwargs):
        raise ValueError("coverage sentinel failure")

    _, route = coverage_route(monkeypatch, kind, worker)
    request, _ = request_with_disconnect()
    with pytest.raises(ValueError, match="coverage sentinel failure"):
        await route(0, request)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["coverage", "assembly"])
async def test_worker_cancelled_error_is_not_client_closed(monkeypatch, kind):
    def worker(*args, **kwargs):
        raise asyncio.CancelledError

    _, route = coverage_route(monkeypatch, kind, worker)
    request, _ = request_with_disconnect()
    with pytest.raises(asyncio.CancelledError):
        await route(0, request)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["coverage", "assembly"])
async def test_remote_coverage_preserves_existing_worker_contract(monkeypatch, kind):
    calls = []

    def worker(*args, **kwargs):
        assert "check_cancelled" not in kwargs
        calls.append(True)
        return {"maxDepth": 0}

    _, route = coverage_route(monkeypatch, kind, worker, "https://reads.example/sample.bam")
    monkeypatch.setattr(tiles, "_assembly_depth_scale", lambda body: None)
    monkeypatch.setattr(tiles, "_assembly_depth_percentiles", lambda body: None)
    request, messages = request_with_disconnect()
    messages.put_nowait({"type": "http.disconnect"})
    assert (await route(0, request)).status_code == 200
    assert calls == [True]


class Stopped(Exception):
    pass


def test_cached_coverage_reduction_observes_cancellation():
    calls = 0

    def check():
        nonlocal calls
        calls += 1
        if calls == 3:
            raise Stopped

    with pytest.raises(Stopped):
        cp._coverage_tile_from_base_layer(
            chrom="chr1",
            start=0,
            end=256,
            bins=256,
            base=np.ones(256, dtype=np.float32),
            chrom_len=256,
            check_cancelled=check,
        )


def test_assembly_cancellation_skips_remaining_segments(monkeypatch, tmp_path):
    bam = tmp_path / "reads.bam"
    bam.touch()
    monkeypatch.setattr(cp, "_resolve_bam_path", lambda _: str(bam))
    monkeypatch.setattr(cp, "_resolve_index_path", lambda _: None)
    monkeypatch.setattr(cp, "_resolve_reference_path", lambda _: None)
    monkeypatch.setattr(cp, "cached_reference_lengths", lambda _: {"a": 100, "b": 100})
    stopped = False
    calls = []

    def check():
        if stopped:
            raise Stopped

    def segment(**kwargs):
        nonlocal stopped
        calls.append(kwargs["chrom"])
        stopped = True
        return {"start": 0, "end": 100, "bins": [1], "binSize": 100, "maxDepth": 1}

    monkeypatch.setattr(cp, "_coverage_tile_from_cached_base_layer", segment)
    with pytest.raises(Stopped):
        cp.coverage_assembly_tile(
            str(bam),
            [{"chrom": c, "start": 0, "end": 100, "globalStart": 0} for c in ["a", "b"]],
            bins=1,
            check_cancelled=check,
        )
    assert calls == ["a"]


@pytest.mark.parametrize(
    "function,cache_function",
    [
        ("genome_wide_depth_scale", "_depth_scale_cache_path"),
        ("genome_wide_depth_percentiles", "_depth_percentiles_cache_path"),
    ],
)
def test_cancelled_depth_summary_does_not_publish_partial_cache(
    monkeypatch, tmp_path, function, cache_function
):
    cache = tmp_path / "summary.json"
    layer = tmp_path / "layer.npy"
    layer.touch()
    monkeypatch.setattr(cp, cache_function, lambda *_: cache)
    monkeypatch.setattr(cp, "_base_layer_cache_path", lambda *_: layer)
    monkeypatch.setattr(cp, "_load_cached_base_layer", lambda _: np.ones(4))
    monkeypatch.setattr(cp, "cached_reference_lengths", lambda _: {})
    memo_writes = []
    monkeypatch.setattr(cp, "_store_depth_summary_memo", lambda *_: memo_writes.append(True))
    stopped = False
    original = np.bincount

    def count(values):
        nonlocal stopped
        result = original(values)
        stopped = True
        return result

    monkeypatch.setattr(np, "bincount", count)

    def check():
        if stopped:
            raise Stopped

    with pytest.raises(Stopped):
        getattr(cp, function)("/local/reads.bam", ["chr1"], check_cancelled=check)
    assert not cache.exists()
    assert memo_writes == []


def test_python_local_cancellation_closes_its_owned_bam(monkeypatch, tmp_path):
    bam_path = tmp_path / "reads.bam"
    bam_path.touch()
    stopped = False
    closed = []

    class Bam:
        references = ("chr1",)

        def __enter__(self):
            return self

        def __exit__(self, *_):
            closed.append(True)

        def fetch(self, *_):
            nonlocal stopped
            stopped = True
            yield None

    monkeypatch.setattr(cp, "_resolve_bam_path", lambda _: str(bam_path))
    monkeypatch.setattr(cp, "_resolve_index_path", lambda _: None)
    monkeypatch.setattr(cp, "_resolve_reference_path", lambda _: None)
    monkeypatch.setattr(cp, "_open_alignment", lambda *_: Bam())
    monkeypatch.setenv("DNA_COVERAGE_USE_RUST", "0")

    def check():
        if stopped:
            raise Stopped

    with pytest.raises(Stopped):
        cp._local_coverage_tile(
            str(bam_path),
            "chr1",
            0,
            100,
            bins=10,
            index_path=None,
            reference_fasta=None,
            check_cancelled=check,
        )
    assert closed == [True]
