from __future__ import annotations

import hashlib
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from pathlib import Path

import pytest

import src.external.persistent_track_cache as persistent_track_cache_module
from src.external.persistent_track_cache import PersistentTrackCache
from src.external.service import _persistent_track_cache_from_env


def test_cache_reuses_a_validator_generation_across_instances(tmp_path: Path):
    root = tmp_path / "range-cache"
    first = PersistentTrackCache(root, max_bytes=1024)

    assert first.put("source-a", "generation-1", 1024, b"abcdefgh") is True

    reopened = PersistentTrackCache(root, max_bytes=1024)
    assert reopened.get("source-a", "generation-1", 1024, 8) == b"abcdefgh"
    assert reopened.get("source-a", "generation-2", 1024, 8) is None
    assert reopened.get("source-b", "generation-1", 1024, 8) is None


def test_cache_reuses_typed_blobs_through_the_same_registry_and_payload_store(
    tmp_path: Path,
):
    root = tmp_path / "track-cache"
    first = PersistentTrackCache(root, max_bytes=1024)

    assert (
        first.put_blob(
            "ucsc-sparse-snapshot",
            "hg38:cpgIslandExt:v1",
            b'{"records":[{"chrom":"chr1"}]}',
        )
        is True
    )
    first.close()

    reopened = PersistentTrackCache(root, max_bytes=1024)
    assert (
        reopened.get_blob(
            "ucsc-sparse-snapshot",
            "hg38:cpgIslandExt:v1",
        )
        == b'{"records":[{"chrom":"chr1"}]}'
    )
    assert (
        reopened.get_blob(
            "ucsc-sparse-snapshot",
            "hg38:otherTrack:v1",
        )
        is None
    )


def test_range_blocks_and_typed_blobs_share_one_lru_byte_budget(tmp_path: Path):
    now = iter((1, 2, 3, 4, 5, 6, 7, 8))
    cache = PersistentTrackCache(
        tmp_path / "track-cache",
        max_bytes=8,
        clock_ns=lambda: next(now),
    )

    assert cache.put("source", "generation", 0, b"12345678") is True
    assert cache.put_blob("ucsc-sparse-snapshot", "hg38:cpg:v1", b"abcdefgh") is True

    assert cache.get("source", "generation", 0, 8) is None
    assert cache.get_blob("ucsc-sparse-snapshot", "hg38:cpg:v1") == b"abcdefgh"


def test_cache_evicts_least_recently_used_blocks_to_its_byte_budget(tmp_path: Path):
    now = iter((1, 2, 3, 4, 5, 6))
    cache = PersistentTrackCache(
        tmp_path / "range-cache",
        max_bytes=8,
        clock_ns=lambda: next(now),
    )

    assert cache.put("source", "generation", 0, b"12345678") is True
    assert cache.put("source", "generation", 8, b"abcdefgh") is True

    assert cache.get("source", "generation", 0, 8) is None
    assert cache.get("source", "generation", 8, 8) == b"abcdefgh"


def test_missing_or_corrupt_payload_is_removed_and_becomes_a_miss(tmp_path: Path):
    root = tmp_path / "range-cache"
    cache = PersistentTrackCache(root, max_bytes=1024)
    assert cache.put("source", "generation", 0, b"abcdefgh") is True

    payload = _only_payload(root)
    payload.write_bytes(b"corrupt!")
    assert cache.get("source", "generation", 0, 8) is None

    assert cache.put("source", "generation", 0, b"abcdefgh") is True
    _only_payload(root).unlink()
    assert cache.get("source", "generation", 0, 8) is None


def test_deferred_repair_removes_orphans_and_enforces_a_reduced_budget(
    tmp_path: Path,
):
    root = tmp_path / "range-cache"
    first = PersistentTrackCache(root, max_bytes=1024)
    assert first.put("source", "generation", 0, b"abcdefgh") is True
    first.close()

    orphan = b"orphan"
    orphan_hash = hashlib.sha256(orphan).hexdigest()
    orphan_path = (
        root / "hot-cache-v1" / "payloads" / orphan_hash[:2] / f"{orphan_hash}.block"
    )
    orphan_path.parent.mkdir(parents=True)
    orphan_path.write_bytes(orphan)

    reopened = PersistentTrackCache(root, max_bytes=4)
    assert reopened.get("source", "generation", 0, 8) is None
    assert orphan_path.is_file()
    assert reopened.repair() is True
    assert list((root / "hot-cache-v1" / "payloads").rglob("*.block")) == []


def test_deferred_repair_serializes_shared_connection_cleanup_with_reads(
    tmp_path: Path, monkeypatch
):
    root = tmp_path / "range-cache"
    cache = PersistentTrackCache(root, max_bytes=1024)
    assert cache.put("source", "generation", 0, b"abcdefgh") is True

    orphan = b"orphan"
    orphan_hash = hashlib.sha256(orphan).hexdigest()
    orphan_path = (
        root / "hot-cache-v1" / "payloads" / orphan_hash[:2] / f"{orphan_hash}.block"
    )
    orphan_path.parent.mkdir(parents=True)
    orphan_path.write_bytes(orphan)

    cleanup_started = threading.Event()
    resume_cleanup = threading.Event()
    original_delete = cache._delete_payload_if_unreferenced

    def delayed_delete(relative_payload_path: str) -> None:
        cleanup_started.set()
        assert resume_cleanup.wait(timeout=5)
        original_delete(relative_payload_path)

    monkeypatch.setattr(cache, "_delete_payload_if_unreferenced", delayed_delete)

    with ThreadPoolExecutor(max_workers=2) as executor:
        repair = executor.submit(cache.repair)
        assert cleanup_started.wait(timeout=5)
        read = executor.submit(cache.get, "source", "generation", 0, 8)
        with pytest.raises(TimeoutError):
            read.result(timeout=0.2)
        resume_cleanup.set()
        assert repair.result(timeout=5) is True
        assert read.result(timeout=5) == b"abcdefgh"


def test_normal_reopen_does_not_walk_the_payload_tree(tmp_path: Path, monkeypatch):
    root = tmp_path / "range-cache"
    first = PersistentTrackCache(root, max_bytes=1024)
    assert first.put("source", "generation", 0, b"abcdefgh") is True
    first.close()

    def reject_recursive_scan(_path: Path, _pattern: str):
        raise AssertionError("normal cache reads must not scan the payload tree")

    monkeypatch.setattr(Path, "rglob", reject_recursive_scan)
    reopened = PersistentTrackCache(root, max_bytes=1024)

    assert reopened.get("source", "generation", 0, 8) == b"abcdefgh"


def test_cache_recreates_its_registry_after_connection_reset(tmp_path: Path):
    root = tmp_path / "range-cache"
    cache = PersistentTrackCache(root, max_bytes=1024)
    assert cache.put("source", "generation-1", 0, b"abcdefgh") is True

    cache.close()
    (root / "hot-cache-v1" / "registry.sqlite3").unlink()

    assert cache.put("source", "generation-2", 8, b"ijklmnop") is True
    assert cache.get("source", "generation-2", 8, 8) == b"ijklmnop"


def test_two_cache_instances_cannot_publish_a_row_after_payload_eviction(
    tmp_path: Path, monkeypatch
):
    root = tmp_path / "range-cache"
    initial = PersistentTrackCache(root, max_bytes=16)
    contender = PersistentTrackCache(root, max_bytes=16)
    evictor = PersistentTrackCache(root, max_bytes=16)
    shared_payload = b"abcdefgh"
    assert initial.put("initial", "generation", 0, shared_payload) is True

    validation_started = threading.Event()
    resume_validation = threading.Event()
    original_validation = persistent_track_cache_module._valid_existing_payload
    pause_once = True

    def delayed_validation(path: Path, expected_hash: str, expected_size: int) -> bool:
        nonlocal pause_once
        if pause_once:
            pause_once = False
            validation_started.set()
            assert resume_validation.wait(timeout=5)
        return original_validation(path, expected_hash, expected_size)

    monkeypatch.setattr(
        persistent_track_cache_module,
        "_valid_existing_payload",
        delayed_validation,
    )

    with ThreadPoolExecutor(max_workers=2) as executor:
        contender_put = executor.submit(
            contender.put, "contender", "generation", 8, shared_payload
        )
        assert validation_started.wait(timeout=5)
        evictor_put = executor.submit(
            evictor.put, "evictor", "generation", 16, b"ijklmnop"
        )
        try:
            evictor_put.result(timeout=0.2)
        except TimeoutError:
            pass
        resume_validation.set()
        assert contender_put.result(timeout=5) is True
        assert evictor_put.result(timeout=5) is True

    assert contender.get("contender", "generation", 8, 8) == shared_payload


def test_unavailable_cache_fails_open_without_creating_partial_state(tmp_path: Path):
    root = tmp_path / "not-a-directory"
    root.write_text("occupied", encoding="utf-8")
    cache = PersistentTrackCache(root, max_bytes=1024)

    assert cache.get("source", "generation", 0, 8) is None
    assert cache.put("source", "generation", 0, b"abcdefgh") is False
    assert root.read_text(encoding="utf-8") == "occupied"


def test_service_cache_factory_uses_the_profile_route_and_rejects_an_invalid_budget(
    tmp_path: Path, monkeypatch
):
    root = tmp_path / "profile-range-cache"
    monkeypatch.setenv("WAYPOINT_INDEXED_TRACK_RANGE_CACHE_DIR", str(root))
    monkeypatch.setenv("WAYPOINT_INDEXED_TRACK_RANGE_CACHE_BYTES", "64")

    cache = _persistent_track_cache_from_env()
    assert cache is not None
    assert cache.put("source", "generation", 0, b"abcdefgh") is True
    assert cache.get("source", "generation", 0, 8) == b"abcdefgh"

    monkeypatch.setenv("WAYPOINT_INDEXED_TRACK_RANGE_CACHE_BYTES", "not-a-number")
    assert _persistent_track_cache_from_env() is None


def _only_payload(root: Path) -> Path:
    payloads = list((root / "hot-cache-v1" / "payloads").rglob("*.block"))
    assert len(payloads) == 1
    return payloads[0]
