from __future__ import annotations

import asyncio
import hashlib
import os
import socket
import threading
from collections.abc import Awaitable, Callable
from pathlib import Path

import httpx
import pytest

import src.external.remote_range as remote_range_module
from src.external.persistent_track_cache import PersistentTrackCache
from src.external.remote_range import RemoteRangeService, RemoteRangeSourceError
from src.external.service import UCSC_REMOTE_RANGE_HOSTS
from src.storage_capacity import StorageCapacity, StorageCapacityUnknown

BIGWIG_MAGIC = bytes.fromhex("26fc8f88")


@pytest.fixture(autouse=True)
def deterministic_capacity(monkeypatch):
    remote_range_module._snapshot_macos_capacity.cache_clear()
    monkeypatch.setattr(
        remote_range_module,
        "read_storage_capacity",
        lambda path, *, purpose: StorageCapacity(
            str(path), 789331063752, 0, 3996329328640, "macos-important-usage", purpose
        ),
    )


def test_requested_snapshot_uses_important_capacity_and_refreshes_after_one_second(
    monkeypatch,
):
    monkeypatch.setattr(remote_range_module.sys, "platform", "darwin")
    calls = []
    now = [1000.1]
    monkeypatch.setattr(remote_range_module.time, "monotonic", lambda: now[0])

    def capacity(path, *, purpose):
        calls.append((path, purpose))
        return StorageCapacity(
            path, 789331063752, 0, 3996329328640, "macos-important-usage", purpose
        )

    monkeypatch.setattr(remote_range_module, "read_storage_capacity", capacity)
    assert (
        remote_range_module._snapshot_free_bytes("/requested/snapshot") == 789331063752
    )
    assert (
        remote_range_module._snapshot_free_bytes("/requested/snapshot") == 789331063752
    )
    assert calls == [("/requested/snapshot", "important")]
    now[0] += 1
    assert (
        remote_range_module._snapshot_free_bytes("/requested/snapshot") == 789331063752
    )
    assert len(calls) == 2


def test_unknown_snapshot_capacity_is_not_a_disk_full_claim_or_cached(monkeypatch):
    monkeypatch.setattr(remote_range_module.sys, "platform", "darwin")
    calls = []

    def capacity(*args, **kwargs):
        calls.append(True)
        raise StorageCapacityUnknown("Available storage capacity is unknown.")

    monkeypatch.setattr(remote_range_module, "read_storage_capacity", capacity)
    for _ in range(2):
        with pytest.raises(RemoteRangeSourceError, match="capacity is unknown"):
            remote_range_module._snapshot_free_bytes("/requested/snapshot")
    assert len(calls) == 2


@pytest.mark.parametrize(
    ("format_id", "probe"),
    [
        ("bam", bytes.fromhex("1f8b08040000000000ff0600424302007f00") + bytes(46)),
        ("cram", b"CRAM" + bytes(60)),
        ("bai", b"BAI\x01" + bytes(60)),
        ("crai", bytes.fromhex("1f8b08") + bytes(61)),
        ("csi", b"CSI\x01" + bytes(60)),
        ("vcf", bytes.fromhex("1f8b08040000000000ff0600424302007f00") + bytes(46)),
        ("bcf", bytes.fromhex("1f8b08040000000000ff0600424302007f00") + bytes(46)),
        ("tbi", bytes.fromhex("1f8b08040000000000ff0600424302007f00") + bytes(46)),
    ],
)
@pytest.mark.asyncio
async def test_admission_accepts_indexed_alignment_source_formats(format_id, probe):
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["range"] == "bytes=0-63"
        return httpx.Response(
            206,
            content=probe,
            headers={
                "Content-Range": "bytes 0-63/1024",
                "Content-Length": "64",
                "Accept-Ranges": "bytes",
                "ETag": '"alignment-v1"',
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(client, resolver=_public_resolver)

    grant = await service.admit(
        f"https://data.example.org/sample.{format_id}",
        expected_format=format_id,
        provenance_id=f"test:{format_id}",
        allow_any_public_host=True,
    )

    assert grant.format == format_id
    assert grant.byte_length == 1024
    await service.aclose()
    await client.aclose()


@pytest.mark.asyncio
async def test_admission_accepts_a_probe_truncated_exactly_at_eof():
    probe = bytes.fromhex("1f8b08") + bytes(39)

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["range"] == "bytes=0-63"
        return httpx.Response(
            206,
            content=probe,
            headers={
                "Content-Range": "bytes 0-41/42",
                "Content-Length": "42",
                "Accept-Ranges": "bytes",
                "ETag": '"small-crai-v1"',
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(client, resolver=_public_resolver)

    grant = await service.admit(
        "https://data.example.org/sample.cram.crai",
        expected_format="crai",
        provenance_id="test:small-crai",
        allow_any_public_host=True,
    )

    assert grant.byte_length == 42
    assert grant.format == "crai"
    await service.aclose()


class _BlockingPersistentCache:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()
        self.put_calls = 0

    def get(self, _source: str, _generation: str, _start: int, _length: int):
        return None

    def put(self, _source: str, _generation: str, _start: int, _payload: bytes) -> bool:
        self.put_calls += 1
        self.started.set()
        assert self.release.wait(timeout=5)
        return True

    def close(self) -> None:
        return None


class _CountingBody(httpx.AsyncByteStream):
    def __init__(self) -> None:
        self.chunks_read = 0

    async def __aiter__(self):
        self.chunks_read += 1
        yield bytes(1024 * 1024)


async def _public_resolver(
    _host: str, _port: int, *, type: socket.SocketKind
) -> list[tuple]:
    assert type == socket.SOCK_STREAM
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))]


def _weak_snapshot_handler(
    payload: bytes,
    requested_ranges: list[str | None],
    *,
    on_full_request: Callable[[], Awaitable[None]] | None = None,
) -> Callable[[httpx.Request], Awaitable[httpx.Response]]:
    async def handler(request: httpx.Request) -> httpx.Response:
        requested_range = request.headers.get("range")
        requested_ranges.append(requested_range)
        if requested_range is None:
            if on_full_request is not None:
                await on_full_request()
            return httpx.Response(
                200,
                content=payload,
                headers={
                    "Content-Length": str(len(payload)),
                    "ETag": 'W/"generation-1"',
                },
            )
        start_text, end_text = requested_range.removeprefix("bytes=").split("-")
        start, end = int(start_text), int(end_text)
        body = payload[start : end + 1]
        return httpx.Response(
            206,
            content=body,
            headers={
                "Content-Range": f"bytes {start}-{end}/{len(payload)}",
                "Content-Length": str(len(body)),
                "ETag": 'W/"generation-1"',
            },
        )

    return handler


@pytest.mark.asyncio
async def test_admission_proves_range_magic_and_validator_then_reads_by_opaque_token():
    requests: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.headers["range"])
        if request.headers["range"] == "bytes=0-63":
            return httpx.Response(
                206,
                content=BIGWIG_MAGIC + bytes(60),
                headers={
                    "Content-Range": "bytes 0-63/1764507851",
                    "Content-Length": "64",
                    "Accept-Ranges": "bytes",
                    "ETag": '"gc-v1"',
                },
            )
        return httpx.Response(
            206,
            content=b"abcdefgh",
            headers={
                "Content-Range": "bytes 1024-1031/1764507851",
                "Content-Length": "8",
                "ETag": '"gc-v1"',
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(client, resolver=_public_resolver)

    grant = await service.admit(
        "https://hgdownload.soe.ucsc.edu/gbdb/hg38/bbi/gc5Base.bw",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:gc5BaseBw",
    )
    payload = await service.read(grant.source_token, 1024, 8)

    assert grant.accepts_ranges is True
    assert grant.byte_length == 1_764_507_851
    assert grant.etag == '"gc-v1"'
    assert grant.format == "bigwig"
    assert payload == b"abcdefgh"
    assert requests == ["bytes=0-63", "bytes=1024-1031"]
    assert "gc5Base" not in grant.source_token
    await client.aclose()


@pytest.mark.asyncio
async def test_content_sha256_reads_current_bytes_without_trusting_range_caches(
    tmp_path,
):
    original = BIGWIG_MAGIC + bytes(range(4, 128))
    replacement = BIGWIG_MAGIC + bytes(reversed(range(4, 128)))
    current = {"payload": original}
    requested_ranges: list[str | None] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requested_range = request.headers.get("range")
        requested_ranges.append(requested_range)
        if requested_range is None:
            return httpx.Response(
                200,
                content=current["payload"],
                headers={
                    "Content-Length": str(len(current["payload"])),
                    "ETag": 'W/"generation-1"',
                },
            )
        start_text, end_text = requested_range.removeprefix("bytes=").split("-")
        start, end = int(start_text), int(end_text)
        payload = current["payload"][start : end + 1]
        return httpx.Response(
            206,
            content=payload,
            headers={
                "Content-Range": f"bytes {start}-{end}/{len(current['payload'])}",
                "Content-Length": str(len(payload)),
                "ETag": 'W/"generation-1"',
            },
        )

    cache = PersistentTrackCache(tmp_path / "range-cache", max_bytes=1024)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(
        client,
        resolver=_public_resolver,
        persistent_cache=cache,
    )
    grant = await service.admit(
        "https://hgdownload.soe.ucsc.edu/public/signal.bw",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:signal",
    )
    assert await service.read(grant.source_token, 0, 32) == original[:32]
    await service._persistence_queue.join()

    current["payload"] = replacement
    digest = await service.content_sha256(grant.source_token)
    snapshot_path = service._sources[grant.source_token].canonical_path

    assert digest == hashlib.sha256(replacement).hexdigest()
    assert snapshot_path is not None and os.path.isfile(snapshot_path)
    current["payload"] = original
    assert await service.read(grant.source_token, 0, 32) == replacement[:32]
    assert requested_ranges == [
        "bytes=0-63",
        "bytes=0-31",
        None,
    ]
    await service.aclose()
    assert not os.path.exists(snapshot_path)
    await client.aclose()


@pytest.mark.asyncio
async def test_materialize_pins_a_remote_native_index_to_owned_temporary_storage(
    tmp_path,
    monkeypatch,
):
    payload = b"BAI\x01" + bytes(range(4, 128))
    requested_ranges: list[str | None] = []
    monkeypatch.setattr(
        remote_range_module, "_managed_snapshot_directory", lambda: str(tmp_path)
    )
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(_weak_snapshot_handler(payload, requested_ranges))
    )
    service = RemoteRangeService(client, resolver=_public_resolver)
    grant = await service.admit(
        "https://hgdownload.soe.ucsc.edu/public/reads.bam.bai",
        expected_format="bai",
        provenance_id="reads-index",
    )

    materialized = await service.materialize(grant.source_token)

    assert Path(materialized.source_path).read_bytes() == payload
    assert materialized.source_path.endswith(".bai")
    assert materialized.representation_sha256 == hashlib.sha256(payload).hexdigest()
    assert materialized.grant.canonical_url_hash == grant.canonical_url_hash
    assert requested_ranges == ["bytes=0-63", None]
    await service.aclose()
    assert not Path(materialized.source_path).exists()
    await client.aclose()


@pytest.mark.asyncio
async def test_materialize_refuses_a_remote_alignment_body_before_full_download():
    payload = bytes.fromhex("1f8b08040000000000ff0600424302007f00") + bytes(110)
    requested_ranges: list[str | None] = []
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(_weak_snapshot_handler(payload, requested_ranges))
    )
    service = RemoteRangeService(client, resolver=_public_resolver)
    grant = await service.admit(
        "https://hgdownload.soe.ucsc.edu/public/reads.bam",
        expected_format="bam",
        provenance_id="reads-body",
    )

    with pytest.raises(RemoteRangeSourceError, match="native index"):
        await service.materialize(grant.source_token)

    assert requested_ranges == ["bytes=0-63"]
    await service.aclose()
    await client.aclose()


@pytest.mark.asyncio
async def test_content_sha256_rejects_a_snapshot_above_the_managed_byte_quota(
    monkeypatch,
):
    payload = BIGWIG_MAGIC + bytes(range(4, 96))
    requested_ranges: list[str | None] = []
    monkeypatch.setattr(
        remote_range_module,
        "_MANAGED_SNAPSHOT_QUOTA_BYTES",
        len(payload) - 1,
    )
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(_weak_snapshot_handler(payload, requested_ranges))
    )
    service = RemoteRangeService(client, resolver=_public_resolver)
    grant = await service.admit(
        "https://hgdownload.soe.ucsc.edu/public/oversized-signal.bw",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:oversized-signal",
    )

    with pytest.raises(RemoteRangeSourceError, match="snapshot byte quota") as caught:
        await service.content_sha256(grant.source_token)

    assert caught.value.failure_kind == "snapshot_quota_exceeded"
    assert caught.value.retryable is False
    assert requested_ranges == ["bytes=0-63"]
    assert service._managed_snapshot_bytes == 0
    await service.aclose()
    await client.aclose()


@pytest.mark.asyncio
async def test_concurrent_content_snapshots_share_one_process_byte_quota(monkeypatch):
    payload = BIGWIG_MAGIC + bytes(range(4, 96))
    requested_ranges: list[str | None] = []
    first_full_response_started = asyncio.Event()
    allow_first_full_response = asyncio.Event()

    async def block_first_full_response() -> None:
        first_full_response_started.set()
        await allow_first_full_response.wait()

    monkeypatch.setattr(
        remote_range_module,
        "_MANAGED_SNAPSHOT_QUOTA_BYTES",
        len(payload),
    )
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(
            _weak_snapshot_handler(
                payload,
                requested_ranges,
                on_full_request=block_first_full_response,
            )
        )
    )
    service = RemoteRangeService(client, resolver=_public_resolver)
    first_grant = await service.admit(
        "https://hgdownload.soe.ucsc.edu/public/first-signal.bw",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:first-signal",
    )
    second_grant = await service.admit(
        "https://hgdownload.soe.ucsc.edu/public/second-signal.bw",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:second-signal",
    )

    first_digest = asyncio.create_task(service.content_sha256(first_grant.source_token))
    await first_full_response_started.wait()
    with pytest.raises(RemoteRangeSourceError, match="quota is currently exhausted"):
        await service.content_sha256(second_grant.source_token)
    assert requested_ranges.count(None) == 1

    allow_first_full_response.set()
    assert await first_digest == hashlib.sha256(payload).hexdigest()
    assert service._managed_snapshot_bytes == len(payload)
    await service.aclose()
    assert service._managed_snapshot_bytes == 0
    await client.aclose()


@pytest.mark.asyncio
async def test_content_sha256_checks_free_space_before_starting_the_full_download(
    monkeypatch,
):
    payload = BIGWIG_MAGIC + bytes(range(4, 96))
    requested_ranges: list[str | None] = []
    monkeypatch.setattr(
        remote_range_module,
        "_snapshot_free_bytes",
        lambda _directory: (
            len(payload) + remote_range_module._MIN_MANAGED_SNAPSHOT_FREE_BYTES - 1
        ),
    )
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(_weak_snapshot_handler(payload, requested_ranges))
    )
    service = RemoteRangeService(client, resolver=_public_resolver)
    grant = await service.admit(
        "https://hgdownload.soe.ucsc.edu/public/low-disk-signal.bw",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:low-disk-signal",
    )

    with pytest.raises(RemoteRangeSourceError, match="free space") as caught:
        await service.content_sha256(grant.source_token)

    assert caught.value.failure_kind == "snapshot_storage_unavailable"
    assert caught.value.retryable is True
    assert requested_ranges == ["bytes=0-63"]
    assert service._managed_snapshot_bytes == 0
    await service.aclose()
    await client.aclose()


@pytest.mark.asyncio
async def test_content_sha256_rechecks_free_space_during_spooling_and_cleans_up(
    tmp_path,
    monkeypatch,
):
    payload = BIGWIG_MAGIC + bytes(range(4, 96))
    requested_ranges: list[str | None] = []
    free_space_checks = 0

    def staged_free_space(_directory: str) -> int:
        nonlocal free_space_checks
        free_space_checks += 1
        required = len(payload) + remote_range_module._MIN_MANAGED_SNAPSHOT_FREE_BYTES
        return required if free_space_checks <= 2 else required - 1

    monkeypatch.setattr(
        remote_range_module, "_managed_snapshot_directory", lambda: str(tmp_path)
    )
    monkeypatch.setattr(remote_range_module, "_snapshot_free_bytes", staged_free_space)
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(_weak_snapshot_handler(payload, requested_ranges))
    )
    service = RemoteRangeService(client, resolver=_public_resolver)
    grant = await service.admit(
        "https://hgdownload.soe.ucsc.edu/public/vanishing-disk-signal.bw",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:vanishing-disk-signal",
    )

    with pytest.raises(RemoteRangeSourceError, match="free space") as caught:
        await service.content_sha256(grant.source_token)

    assert caught.value.failure_kind == "snapshot_storage_unavailable"
    assert free_space_checks >= 3
    assert list(tmp_path.iterdir()) == []
    assert service._managed_snapshot_bytes == 0
    await service.aclose()
    await client.aclose()


@pytest.mark.asyncio
async def test_content_sha256_runs_snapshot_file_operations_off_the_event_loop(
    monkeypatch,
):
    payload = BIGWIG_MAGIC + bytes(range(4, 96))
    requested_ranges: list[str | None] = []
    event_loop_thread = threading.get_ident()
    helper_threads: dict[str, int] = {}

    def observe_helper(name: str) -> None:
        original = getattr(remote_range_module, name)

        def observed(*args, **kwargs):
            helper_threads[name] = threading.get_ident()
            return original(*args, **kwargs)

        monkeypatch.setattr(remote_range_module, name, observed)

    for helper_name in (
        "_create_managed_snapshot",
        "_write_managed_snapshot_batch",
        "_finalize_managed_snapshot",
    ):
        observe_helper(helper_name)

    client = httpx.AsyncClient(
        transport=httpx.MockTransport(_weak_snapshot_handler(payload, requested_ranges))
    )
    service = RemoteRangeService(client, resolver=_public_resolver)
    grant = await service.admit(
        "https://hgdownload.soe.ucsc.edu/public/threaded-signal.bw",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:threaded-signal",
    )

    assert (
        await service.content_sha256(grant.source_token)
        == hashlib.sha256(payload).hexdigest()
    )
    assert set(helper_threads) == {
        "_create_managed_snapshot",
        "_write_managed_snapshot_batch",
        "_finalize_managed_snapshot",
    }
    assert all(thread_id != event_loop_thread for thread_id in helper_threads.values())
    await service.aclose()
    assert service._managed_snapshot_bytes == 0
    await client.aclose()


@pytest.mark.asyncio
async def test_cancelled_snapshot_write_settles_before_abort_and_releases_storage(
    tmp_path,
    monkeypatch,
):
    payload = BIGWIG_MAGIC + bytes(range(4, 96))
    requested_ranges: list[str | None] = []
    write_started = threading.Event()
    allow_write = threading.Event()
    write_finished = threading.Event()
    abort_started = threading.Event()
    original_write = remote_range_module._write_managed_snapshot_batch
    original_abort = remote_range_module._abort_managed_snapshot

    def blocked_write(*args, **kwargs):
        write_started.set()
        assert allow_write.wait(timeout=5)
        try:
            return original_write(*args, **kwargs)
        finally:
            write_finished.set()

    def observed_abort(*args, **kwargs):
        assert write_finished.is_set()
        abort_started.set()
        return original_abort(*args, **kwargs)

    monkeypatch.setattr(
        remote_range_module, "_managed_snapshot_directory", lambda: str(tmp_path)
    )
    monkeypatch.setattr(
        remote_range_module, "_write_managed_snapshot_batch", blocked_write
    )
    monkeypatch.setattr(remote_range_module, "_abort_managed_snapshot", observed_abort)
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(_weak_snapshot_handler(payload, requested_ranges))
    )
    service = RemoteRangeService(client, resolver=_public_resolver)
    grant = await service.admit(
        "https://hgdownload.soe.ucsc.edu/public/cancelled-signal.bw",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:cancelled-signal",
    )
    source = service._sources[grant.source_token]

    cancelled_hash = asyncio.create_task(service._content_sha256_for_source(source))
    assert await asyncio.to_thread(write_started.wait, 5)
    cancelled_hash.cancel()
    await asyncio.sleep(0)

    assert not abort_started.is_set()
    assert not cancelled_hash.done()
    allow_write.set()
    with pytest.raises(asyncio.CancelledError):
        await cancelled_hash

    assert write_finished.is_set()
    assert abort_started.is_set()
    assert list(tmp_path.iterdir()) == []
    assert service._managed_snapshot_bytes == 0
    await service.aclose()
    await client.aclose()


@pytest.mark.asyncio
async def test_cancelled_snapshot_creation_captures_and_aborts_the_created_file(
    tmp_path,
    monkeypatch,
):
    payload = BIGWIG_MAGIC + bytes(range(4, 96))
    requested_ranges: list[str | None] = []
    create_finished = threading.Event()
    allow_create_to_return = threading.Event()
    created_paths: list[str] = []
    original_create = remote_range_module._create_managed_snapshot

    def blocked_create(*args, **kwargs):
        snapshot, snapshot_path = original_create(*args, **kwargs)
        created_paths.append(snapshot_path)
        create_finished.set()
        assert allow_create_to_return.wait(timeout=5)
        return snapshot, snapshot_path

    monkeypatch.setattr(
        remote_range_module, "_managed_snapshot_directory", lambda: str(tmp_path)
    )
    monkeypatch.setattr(remote_range_module, "_create_managed_snapshot", blocked_create)
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(_weak_snapshot_handler(payload, requested_ranges))
    )
    service = RemoteRangeService(client, resolver=_public_resolver)
    grant = await service.admit(
        "https://hgdownload.soe.ucsc.edu/public/cancelled-create-signal.bw",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:cancelled-create-signal",
    )
    source = service._sources[grant.source_token]

    cancelled_hash = asyncio.create_task(service._content_sha256_for_source(source))
    assert await asyncio.to_thread(create_finished.wait, 5)
    assert len(created_paths) == 1
    assert os.path.isfile(created_paths[0])
    cancelled_hash.cancel()
    await asyncio.sleep(0)

    assert not cancelled_hash.done()
    allow_create_to_return.set()
    with pytest.raises(asyncio.CancelledError):
        await cancelled_hash

    assert list(tmp_path.iterdir()) == []
    assert service._managed_snapshot_bytes == 0
    await service.aclose()
    await client.aclose()


@pytest.mark.asyncio
async def test_content_sha256_fails_closed_when_full_response_validator_changed():
    payload = BIGWIG_MAGIC + bytes(range(4, 96))

    async def handler(request: httpx.Request) -> httpx.Response:
        requested_range = request.headers.get("range")
        if requested_range is None:
            return httpx.Response(
                200,
                content=payload,
                headers={
                    "Content-Length": str(len(payload)),
                    "ETag": 'W/"generation-2"',
                },
            )
        start_text, end_text = requested_range.removeprefix("bytes=").split("-")
        start, end = int(start_text), int(end_text)
        body = payload[start : end + 1]
        return httpx.Response(
            206,
            content=body,
            headers={
                "Content-Range": f"bytes {start}-{end}/{len(payload)}",
                "Content-Length": str(len(body)),
                "ETag": 'W/"generation-1"',
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(client, resolver=_public_resolver)
    grant = await service.admit(
        "https://hgdownload.soe.ucsc.edu/public/signal.bw",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:signal",
    )

    with pytest.raises(RemoteRangeSourceError, match="validator changed"):
        await service.content_sha256(grant.source_token)

    await service.aclose()
    await client.aclose()


@pytest.mark.asyncio
async def test_concurrent_content_sha256_calls_share_one_full_scan():
    payload = BIGWIG_MAGIC + bytes(range(4, 96))
    first_full_response_started = asyncio.Event()
    allow_hash_to_continue = asyncio.Event()
    requested_ranges: list[str | None] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requested_range = request.headers.get("range")
        requested_ranges.append(requested_range)
        if requested_range is None:
            first_full_response_started.set()
            await allow_hash_to_continue.wait()
            return httpx.Response(
                200,
                content=payload,
                headers={
                    "Content-Length": str(len(payload)),
                    "ETag": 'W/"generation-1"',
                },
            )
        start_text, end_text = requested_range.removeprefix("bytes=").split("-")
        start, end = int(start_text), int(end_text)
        body = payload[start : end + 1]
        return httpx.Response(
            206,
            content=body,
            headers={
                "Content-Range": f"bytes {start}-{end}/{len(payload)}",
                "Content-Length": str(len(body)),
                "ETag": 'W/"generation-1"',
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(client, resolver=_public_resolver)
    grant = await service.admit(
        "https://hgdownload.soe.ucsc.edu/public/signal.bw",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:signal",
    )

    first = asyncio.create_task(service.content_sha256(grant.source_token))
    await first_full_response_started.wait()
    second = asyncio.create_task(service.content_sha256(grant.source_token))
    await asyncio.sleep(0)
    allow_hash_to_continue.set()
    first_digest, second_digest = await asyncio.gather(first, second)

    assert first_digest == second_digest == hashlib.sha256(payload).hexdigest()
    assert requested_ranges == [
        "bytes=0-63",
        None,
    ]
    await service.aclose()
    await client.aclose()


@pytest.mark.asyncio
async def test_slow_content_sha256_refreshes_expiry_and_survives_concurrent_pruning():
    payload = BIGWIG_MAGIC + bytes(range(4, 96))
    now = [0.0]
    full_response_started = asyncio.Event()
    allow_full_response = asyncio.Event()
    requested_ranges: list[str | None] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requested_range = request.headers.get("range")
        requested_ranges.append(requested_range)
        if requested_range is None:
            full_response_started.set()
            await allow_full_response.wait()
            return httpx.Response(
                200,
                content=payload,
                headers={
                    "Content-Length": str(len(payload)),
                    "ETag": 'W/"generation-1"',
                },
            )
        start_text, end_text = requested_range.removeprefix("bytes=").split("-")
        start, end = int(start_text), int(end_text)
        body = payload[start : end + 1]
        return httpx.Response(
            206,
            content=body,
            headers={
                "Content-Range": f"bytes {start}-{end}/{len(payload)}",
                "Content-Length": str(len(body)),
                "ETag": 'W/"generation-1"',
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(
        client,
        resolver=_public_resolver,
        clock=lambda: now[0],
    )
    grant = await service.admit(
        "https://hgdownload.soe.ucsc.edu/public/signal.bw",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:signal",
    )

    digest_task = asyncio.create_task(service.content_sha256(grant.source_token))
    await full_response_started.wait()
    now[0] = 30 * 60 + 1
    with pytest.raises(RemoteRangeSourceError) as missing:
        await service.read("missing-token", 0, 4)
    assert missing.value.failure_kind == "grant_expired"
    allow_full_response.set()

    assert await digest_task == hashlib.sha256(payload).hexdigest()
    refreshed_grant = await service.current_grant(grant.source_token)
    assert refreshed_grant.expires_at == now[0] + 30 * 60
    assert refreshed_grant.expires_in_seconds == 30 * 60
    assert await service.read(grant.source_token, 0, 4) == BIGWIG_MAGIC
    assert requested_ranges == ["bytes=0-63", None]

    await service.aclose()
    await client.aclose()


@pytest.mark.asyncio
async def test_persistent_range_survives_service_restart_without_redownloading(
    tmp_path,
):
    requests: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requested_range = request.headers["range"]
        requests.append(requested_range)
        if requested_range == "bytes=0-63":
            return httpx.Response(
                206,
                content=BIGWIG_MAGIC + bytes(60),
                headers={
                    "Content-Range": "bytes 0-63/2048",
                    "Content-Length": "64",
                    "ETag": '"generation-1"',
                },
            )
        return httpx.Response(
            206,
            content=b"abcdefgh",
            headers={
                "Content-Range": "bytes 1024-1031/2048",
                "Content-Length": "8",
                "ETag": '"generation-1"',
            },
        )

    root = tmp_path / "range-cache"
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    first = RemoteRangeService(
        client,
        resolver=_public_resolver,
        persistent_cache=PersistentTrackCache(root, max_bytes=1024),
    )
    first_grant = await first.admit(
        "https://hgdownload.soe.ucsc.edu/public/signal.bw",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:signal",
    )
    assert await first.read(first_grant.source_token, 1024, 8) == b"abcdefgh"
    await first.aclose()

    reopened = RemoteRangeService(
        client,
        resolver=_public_resolver,
        persistent_cache=PersistentTrackCache(root, max_bytes=1024),
    )
    reopened_grant = await reopened.admit(
        "https://hgdownload.soe.ucsc.edu/public/signal.bw",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:signal",
    )
    assert await reopened.read(reopened_grant.source_token, 1024, 8) == b"abcdefgh"
    await reopened.aclose()

    assert requests == ["bytes=0-63", "bytes=1024-1031", "bytes=0-63"]
    await client.aclose()


@pytest.mark.asyncio
async def test_token_expiry_does_not_evict_generation_valid_memory_blocks():
    now = 100.0
    requests: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requested_range = request.headers["range"]
        requests.append(requested_range)
        if requested_range == "bytes=0-63":
            return httpx.Response(
                206,
                content=BIGWIG_MAGIC + bytes(60),
                headers={
                    "Content-Range": "bytes 0-63/2048",
                    "Content-Length": "64",
                    "ETag": '"generation-1"',
                },
            )
        return httpx.Response(
            206,
            content=b"abcdefgh",
            headers={
                "Content-Range": "bytes 1024-1031/2048",
                "Content-Length": "8",
                "ETag": '"generation-1"',
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(
        client,
        resolver=_public_resolver,
        clock=lambda: now,
    )
    first = await service.admit(
        "https://hgdownload.soe.ucsc.edu/public/signal.bw",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:signal",
    )
    assert await service.read(first.source_token, 1024, 8) == b"abcdefgh"

    now += 31 * 60
    renewed = await service.admit(
        "https://hgdownload.soe.ucsc.edu/public/signal.bw",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:signal",
    )
    assert await service.read(renewed.source_token, 1024, 8) == b"abcdefgh"

    assert requests == ["bytes=0-63", "bytes=1024-1031", "bytes=0-63"]
    await client.aclose()


@pytest.mark.asyncio
async def test_slow_persistent_writer_has_one_worker_and_a_bounded_payload_queue(
    monkeypatch,
):
    monkeypatch.setattr(remote_range_module, "_MAX_PERSISTENCE_QUEUE_BYTES", 16)
    monkeypatch.setattr(remote_range_module, "_MAX_PERSISTENCE_QUEUE_ITEMS", 2)
    persistent_cache = _BlockingPersistentCache()

    async def handler(request: httpx.Request) -> httpx.Response:
        byte_range = request.headers["range"]
        if byte_range == "bytes=0-63":
            return httpx.Response(
                206,
                content=BIGWIG_MAGIC + bytes(60),
                headers={"Content-Range": "bytes 0-63/100000", "ETag": '"v1"'},
            )
        start, end = (
            int(value)
            for value in byte_range.removeprefix("bytes=").split("-", maxsplit=1)
        )
        return httpx.Response(
            206,
            content=bytes(end - start + 1),
            headers={
                "Content-Range": f"bytes {start}-{end}/100000",
                "ETag": '"v1"',
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(
        client,
        resolver=_public_resolver,
        persistent_cache=persistent_cache,
    )
    grant = await service.admit(
        "https://example.org/signal.bw",
        expected_format="bigwig",
        provenance_id="direct-url",
    )

    assert await service.read(grant.source_token, 128, 8) == bytes(8)
    assert await asyncio.to_thread(persistent_cache.started.wait, 1)
    await asyncio.gather(
        *[service.read(grant.source_token, 136 + index * 8, 8) for index in range(6)]
    )

    assert service._persistence_worker is not None
    assert service._persistence_queued_bytes == 16
    assert service._persistence_queue.qsize() == 1

    persistent_cache.release.set()
    await service.aclose()
    assert persistent_cache.put_calls == 2
    await client.aclose()


@pytest.mark.asyncio
async def test_changed_validator_uses_a_fresh_memory_and_persistent_generation(
    tmp_path,
):
    validator = '"generation-1"'
    requests: list[tuple[str, str]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requested_range = request.headers["range"]
        requests.append((validator, requested_range))
        if requested_range == "bytes=0-63":
            return httpx.Response(
                206,
                content=BIGWIG_MAGIC + bytes(60),
                headers={
                    "Content-Range": "bytes 0-63/2048",
                    "Content-Length": "64",
                    "ETag": validator,
                },
            )
        payload = b"abcdefgh" if validator == '"generation-1"' else b"ABCDEFGH"
        return httpx.Response(
            206,
            content=payload,
            headers={
                "Content-Range": "bytes 1024-1031/2048",
                "Content-Length": "8",
                "ETag": validator,
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(
        client,
        resolver=_public_resolver,
        persistent_cache=PersistentTrackCache(tmp_path / "range-cache", max_bytes=1024),
    )
    first = await service.admit(
        "https://hgdownload.soe.ucsc.edu/public/signal.bw",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:signal",
    )
    assert await service.read(first.source_token, 1024, 8) == b"abcdefgh"

    validator = '"generation-2"'
    changed = await service.admit(
        "https://hgdownload.soe.ucsc.edu/public/signal.bw",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:signal",
    )
    assert await service.read(changed.source_token, 1024, 8) == b"ABCDEFGH"

    assert requests == [
        ('"generation-1"', "bytes=0-63"),
        ('"generation-1"', "bytes=1024-1031"),
        ('"generation-2"', "bytes=0-63"),
        ('"generation-2"', "bytes=1024-1031"),
    ]
    await service.aclose()
    await client.aclose()


@pytest.mark.asyncio
async def test_admission_rejects_a_non_public_destination_before_network_io():
    called = False

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(500)

    async def private_resolver(
        _host: str, _port: int, *, type: socket.SocketKind
    ) -> list[tuple]:
        assert type == socket.SOCK_STREAM
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(client, resolver=private_resolver)

    with pytest.raises(RemoteRangeSourceError, match="public host"):
        await service.admit(
            "https://localhost/private.bw",
            expected_format="bigwig",
            provenance_id="direct-url",
        )

    assert called is False
    await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("dns_error", "expected_retryable"),
    [
        (socket.gaierror(socket.EAI_NONAME, "name does not exist"), False),
        (socket.gaierror(socket.EAI_AGAIN, "temporary DNS failure"), True),
    ],
)
async def test_dns_failures_distinguish_terminal_names_from_temporary_resolution(
    dns_error, expected_retryable
):
    async def resolver(
        _host: str, _port: int, *, type: socket.SocketKind
    ) -> list[tuple]:
        assert type == socket.SOCK_STREAM
        raise dns_error

    client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(500))
    )
    service = RemoteRangeService(client, resolver=resolver)

    with pytest.raises(RemoteRangeSourceError) as raised:
        await service.admit(
            "https://missing.example.org/signal.bw",
            expected_format="bigwig",
            provenance_id="direct-url",
        )

    assert raised.value.failure_kind == "remote_unreachable"
    assert raised.value.retryable is expected_retryable
    await client.aclose()


@pytest.mark.asyncio
async def test_certificate_failure_is_terminal():
    async def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("certificate verify failed", request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(client, resolver=_public_resolver)

    with pytest.raises(RemoteRangeSourceError) as raised:
        await service.admit(
            "https://example.org/signal.bw",
            expected_format="bigwig",
            provenance_id="direct-url",
        )

    assert raised.value.failure_kind == "remote_unreachable"
    assert raised.value.retryable is False
    await client.aclose()


@pytest.mark.asyncio
async def test_admission_rejects_a_public_host_outside_the_release_allowlist():
    called = False

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(500)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(
        client,
        resolver=_public_resolver,
        allowed_hosts=frozenset({"hgdownload.soe.ucsc.edu"}),
    )

    with pytest.raises(RemoteRangeSourceError, match="not approved"):
        await service.admit(
            "https://example.org/signal.bw",
            expected_format="bigwig",
            provenance_id="direct-url",
        )

    assert called is False
    await client.aclose()


@pytest.mark.asyncio
async def test_explicit_url_rejects_cloud_signature_parameters_before_network_io():
    called = False

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(500)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(client, resolver=_public_resolver)

    with pytest.raises(RemoteRangeSourceError, match="credential parameters"):
        await service.admit(
            "https://bucket.example.org/sample.bw?X-Amz-Signature=secret",
            expected_format="bigwig",
            provenance_id="explicit-url",
            allow_any_public_host=True,
        )

    assert called is False
    await client.aclose()


@pytest.mark.asyncio
async def test_release_ucsc_policy_admits_an_encode_bigwig_delegated_by_the_catalog():
    requests: list[tuple[str, str, str | None]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(
            (
                str(request.url),
                request.headers["host"],
                request.extensions.get("sni_hostname"),
            )
        )
        return httpx.Response(
            206,
            content=BIGWIG_MAGIC + bytes(60),
            headers={
                "Content-Range": "bytes 0-63/629843840",
                "ETag": '"encff230lau-v1"',
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(
        client,
        resolver=_public_resolver,
        allowed_hosts=UCSC_REMOTE_RANGE_HOSTS,
    )

    grant = await service.admit(
        "https://encode-public.s3.amazonaws.com/2021/11/30/"
        "ebf9d085-b2ab-4c2c-bd6e-c6663c77de48/ENCFF230LAU.bigWig",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:wgEncodeReg4Epigenetics_ENCFF230LAU",
    )

    assert grant.byte_length == 629_843_840
    assert grant.format == "bigwig"
    assert requests == [
        (
            "https://1.1.1.1/2021/11/30/ebf9d085-b2ab-4c2c-bd6e-c6663c77de48/ENCFF230LAU.bigWig",
            "encode-public.s3.amazonaws.com",
            "encode-public.s3.amazonaws.com",
        )
    ]
    await client.aclose()


@pytest.mark.asyncio
async def test_explicit_user_url_may_use_another_public_host_without_weakening_dns_checks():
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            206,
            content=BIGWIG_MAGIC + bytes(60),
            headers={
                "Content-Range": "bytes 0-63/100000",
                "ETag": '"explicit-v1"',
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(
        client,
        resolver=_public_resolver,
        allowed_hosts=UCSC_REMOTE_RANGE_HOSTS,
    )

    grant = await service.admit(
        "https://workflow.example.org/results/sample.bigWig",
        expected_format="bigwig",
        provenance_id="explicit-url",
        allow_any_public_host=True,
    )

    assert grant.byte_length == 100_000
    assert grant.format == "bigwig"
    await client.aclose()


@pytest.mark.parametrize(
    ("source_url", "expected_connect_url", "expected_host", "expected_port"),
    (
        (
            "https://workflow.example.org:80/results/sample.bigWig",
            "https://1.1.1.1:80/results/sample.bigWig",
            "workflow.example.org:80",
            80,
        ),
        (
            "http://workflow.example.org:443/results/sample.bigWig",
            "http://1.1.1.1:443/results/sample.bigWig",
            "workflow.example.org:443",
            443,
        ),
    ),
)
@pytest.mark.asyncio
async def test_explicit_nondefault_allowed_port_is_preserved_for_the_pinned_ip(
    source_url: str,
    expected_connect_url: str,
    expected_host: str,
    expected_port: int,
):
    resolved_ports: list[int] = []
    requests: list[tuple[str, str, str | None]] = []

    async def resolver(
        _host: str, port: int, *, type: socket.SocketKind
    ) -> list[tuple]:
        assert type == socket.SOCK_STREAM
        resolved_ports.append(port)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", port))]

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(
            (
                str(request.url),
                request.headers["host"],
                request.extensions.get("sni_hostname"),
            )
        )
        return httpx.Response(
            206,
            content=BIGWIG_MAGIC + bytes(60),
            headers={
                "Content-Range": "bytes 0-63/100000",
                "ETag": '"explicit-v1"',
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(client, resolver=resolver)

    grant = await service.admit(
        source_url,
        expected_format="bigwig",
        provenance_id="explicit-url",
        allow_any_public_host=True,
    )

    assert resolved_ports == [expected_port]
    assert requests == [(expected_connect_url, expected_host, "workflow.example.org")]
    assert grant.source_uri == source_url
    await client.aclose()


@pytest.mark.asyncio
async def test_range_ignoring_server_is_rejected_without_consuming_the_full_response_body():
    body = _CountingBody()

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            stream=body,
            headers={"Content-Length": str(50 * 1024 * 1024 * 1024)},
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(client, resolver=_public_resolver)

    with pytest.raises(
        RemoteRangeSourceError, match="does not support byte ranges"
    ) as caught:
        await service.admit(
            "https://workflow.example.org/results/sample.bigWig",
            expected_format="bigwig",
            provenance_id="explicit-url",
            allow_any_public_host=True,
        )

    assert caught.value.failure_kind == "range_unsupported"
    assert caught.value.retryable is False
    assert caught.value.status_code == 200
    assert body.chunks_read == 0
    await client.aclose()


@pytest.mark.asyncio
async def test_local_admission_and_reads_are_bounded_by_an_opaque_grant(tmp_path):
    source = tmp_path / "sample.bigWig"
    source.write_bytes(BIGWIG_MAGIC + bytes(124) + b"abcdefgh" + bytes(64))
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(500))
    )
    service = RemoteRangeService(client, resolver=_public_resolver)

    grant = await service.admit_local(
        str(source),
        expected_format="bigwig",
        provenance_id="local-file",
    )
    payload = await service.read(grant.source_token, 128, 8)

    assert payload == b"abcdefgh"
    assert grant.byte_length == source.stat().st_size
    assert grant.format == "bigwig"
    assert str(source) not in grant.source_token
    await client.aclose()


@pytest.mark.asyncio
async def test_local_read_fails_closed_after_same_path_replacement(tmp_path):
    source = tmp_path / "sample.bigWig"
    source.write_bytes(BIGWIG_MAGIC + bytes(252))
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(500))
    )
    service = RemoteRangeService(client, resolver=_public_resolver)
    grant = await service.admit_local(
        str(source),
        expected_format="bigwig",
        provenance_id="local-file",
    )

    source.write_bytes(BIGWIG_MAGIC + bytes(508))

    with pytest.raises(RemoteRangeSourceError, match="changed after admission"):
        await service.read(grant.source_token, 128, 8)
    await client.aclose()


@pytest.mark.asyncio
async def test_warm_local_read_fails_closed_after_same_path_replacement(tmp_path):
    source = tmp_path / "sample.bigWig"
    source.write_bytes(BIGWIG_MAGIC + bytes(124) + b"abcdefgh")
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(500))
    )
    service = RemoteRangeService(client, resolver=_public_resolver)
    grant = await service.admit_local(
        str(source),
        expected_format="bigwig",
        provenance_id="local-file",
    )
    assert await service.read(grant.source_token, 128, 8) == b"abcdefgh"

    source.write_bytes(BIGWIG_MAGIC + bytes(124) + b"ABCDEFGH")

    with pytest.raises(RemoteRangeSourceError, match="changed after admission"):
        await service.read(grant.source_token, 128, 8)
    await client.aclose()


@pytest.mark.asyncio
async def test_admission_rejects_a_source_without_a_stable_validator():
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            206,
            content=BIGWIG_MAGIC + bytes(60),
            headers={
                "Content-Range": "bytes 0-63/1764507851",
                "Content-Length": "64",
                "Accept-Ranges": "bytes",
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(client, resolver=_public_resolver)

    with pytest.raises(RemoteRangeSourceError, match="no ETag or Last-Modified"):
        await service.admit(
            "https://hgdownload.soe.ucsc.edu/gbdb/hg38/bbi/gc5Base.bw",
            expected_format="bigwig",
            provenance_id="ucsc:hg38:gc5BaseBw",
        )

    await client.aclose()


@pytest.mark.asyncio
async def test_read_fails_closed_when_the_source_validator_changes():
    request_count = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        return httpx.Response(
            206,
            content=BIGWIG_MAGIC + bytes(60) if request_count == 1 else b"abcdefgh",
            headers={
                "Content-Range": (
                    "bytes 0-63/100000"
                    if request_count == 1
                    else "bytes 128-135/100000"
                ),
                "ETag": '"v1"' if request_count == 1 else '"v2"',
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(client, resolver=_public_resolver)
    grant = await service.admit(
        "https://example.org/signal.bw",
        expected_format="bigwig",
        provenance_id="direct-url",
    )

    with pytest.raises(RemoteRangeSourceError, match="changed"):
        await service.read(grant.source_token, 128, 8)
    await client.aclose()


@pytest.mark.asyncio
async def test_read_checks_last_modified_even_when_the_source_also_has_an_etag():
    request_count = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        return httpx.Response(
            206,
            content=BIGWIG_MAGIC + bytes(60) if request_count == 1 else b"abcdefgh",
            headers={
                "Content-Range": (
                    "bytes 0-63/100000"
                    if request_count == 1
                    else "bytes 128-135/100000"
                ),
                "ETag": '"v1"',
                "Last-Modified": (
                    "Mon, 17 Aug 2026 00:00:00 GMT"
                    if request_count == 1
                    else "Tue, 18 Aug 2026 00:00:00 GMT"
                ),
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(client, resolver=_public_resolver)
    grant = await service.admit(
        "https://example.org/signal.bw",
        expected_format="bigwig",
        provenance_id="direct-url",
    )

    with pytest.raises(RemoteRangeSourceError, match="changed"):
        await service.read(grant.source_token, 128, 8)
    await client.aclose()


@pytest.mark.asyncio
async def test_distinct_ranges_across_grants_share_four_upstream_reads_per_source():
    active_reads = 0
    maximum_active_reads = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal active_reads, maximum_active_reads
        byte_range = request.headers["range"]
        if byte_range == "bytes=0-63":
            return httpx.Response(
                206,
                content=BIGWIG_MAGIC + bytes(60),
                headers={
                    "Content-Range": "bytes 0-63/100000",
                    "ETag": '"v1"',
                },
            )
        start, end = (
            int(value)
            for value in byte_range.removeprefix("bytes=").split("-", maxsplit=1)
        )
        active_reads += 1
        maximum_active_reads = max(maximum_active_reads, active_reads)
        try:
            await asyncio.sleep(0.01)
        finally:
            active_reads -= 1
        return httpx.Response(
            206,
            content=bytes(end - start + 1),
            headers={
                "Content-Range": f"bytes {start}-{end}/100000",
                "ETag": '"v1"',
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(client, resolver=_public_resolver)
    first_grant = await service.admit(
        "https://example.org/signal.bw",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:signal",
    )
    second_grant = await service.admit(
        "https://example.org/signal.bw",
        expected_format="bigwig",
        provenance_id="ucsc:hg38:signal",
    )

    await asyncio.gather(
        *[
            service.read(
                (
                    first_grant.source_token
                    if index % 2 == 0
                    else second_grant.source_token
                ),
                128 + index * 8,
                8,
            )
            for index in range(12)
        ]
    )

    assert maximum_active_reads == 4
    await client.aclose()


@pytest.mark.asyncio
async def test_cancelled_waiter_does_not_cancel_or_leak_the_shared_range_fetch():
    release = asyncio.Event()
    range_requests = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal range_requests
        if request.headers["range"] == "bytes=0-63":
            return httpx.Response(
                206,
                content=BIGWIG_MAGIC + bytes(60),
                headers={"Content-Range": "bytes 0-63/100000", "ETag": '"v1"'},
            )
        range_requests += 1
        await release.wait()
        return httpx.Response(
            206,
            content=b"abcdefgh",
            headers={"Content-Range": "bytes 128-135/100000", "ETag": '"v1"'},
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(client, resolver=_public_resolver)
    grant = await service.admit(
        "https://example.org/signal.bw",
        expected_format="bigwig",
        provenance_id="direct-url",
    )

    cancelled_waiter = asyncio.create_task(service.read(grant.source_token, 128, 8))
    await asyncio.sleep(0)
    cancelled_waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancelled_waiter
    release.set()
    await asyncio.sleep(0.01)

    assert await service.read(grant.source_token, 128, 8) == b"abcdefgh"
    assert range_requests == 1
    await client.aclose()


@pytest.mark.asyncio
async def test_cancelled_waiter_keeps_pinned_snapshot_alive_until_producer_finishes(
    monkeypatch,
):
    payload = BIGWIG_MAGIC + bytes(range(4, 128))

    async def handler(request: httpx.Request) -> httpx.Response:
        requested_range = request.headers.get("range")
        if requested_range is None:
            return httpx.Response(
                200,
                content=payload,
                headers={
                    "Content-Length": str(len(payload)),
                    "ETag": 'W/"generation-1"',
                },
            )
        start_text, end_text = requested_range.removeprefix("bytes=").split("-")
        start, end = int(start_text), int(end_text)
        body = payload[start : end + 1]
        return httpx.Response(
            206,
            content=body,
            headers={
                "Content-Range": f"bytes {start}-{end}/{len(payload)}",
                "Content-Length": str(len(body)),
                "ETag": 'W/"generation-1"',
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = RemoteRangeService(client, resolver=_public_resolver)
    grant = await service.admit(
        "https://example.org/signal.bw",
        expected_format="bigwig",
        provenance_id="direct-url",
    )
    await service.content_sha256(grant.source_token)
    source = service._sources[grant.source_token]
    snapshot_path = source.canonical_path
    assert snapshot_path is not None and os.path.isfile(snapshot_path)

    producer_started = asyncio.Event()
    release_producer = asyncio.Event()
    producer_finished = asyncio.Event()
    original_fetch_range = service._fetch_range

    async def blocked_fetch_range(source, *, start: int, length: int) -> bytes:
        producer_started.set()
        await release_producer.wait()
        try:
            return await original_fetch_range(source, start=start, length=length)
        finally:
            producer_finished.set()

    monkeypatch.setattr(service, "_fetch_range", blocked_fetch_range)
    cancelled_waiter = asyncio.create_task(service.read(grant.source_token, 16, 8))
    await producer_started.wait()
    cancelled_waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancelled_waiter

    assert source.read_limiter.active_reads == 1
    await service.aclose()
    assert os.path.isfile(snapshot_path)

    release_producer.set()
    await producer_finished.wait()
    for _ in range(20):
        if not os.path.exists(snapshot_path):
            break
        await asyncio.sleep(0)
    assert not os.path.exists(snapshot_path)
    await client.aclose()
