""" — coverage pyramid cold-build singleflight.

The Electron G7 gate can ask for several coverage tiles on the same chromosome at
once. A cold cache miss must build the chromosome base layer ONCE and make the
other requests wait; otherwise every visible tile streams the same 122 GB HG002
BAM concurrently, wedging the sidecar and making /health time out.
"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np


class _FakeBam:
    references = ("chrT",)

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def get_reference_length(self, chrom: str) -> int:
        assert chrom == "chrT"
        return 10_000


def test_concurrent_cold_base_layer_builds_once(monkeypatch, tmp_path):
    from src.services import coverage_pyramid as cp

    cache_dir = tmp_path / "cov-pyramid-cache"
    cache_dir.mkdir()
    fake_bam = tmp_path / "reads.bam"
    fake_bam.write_bytes(b"fake-bam")

    monkeypatch.setenv("WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR", str(cache_dir))
    monkeypatch.setattr(cp, "_resolve_bam_path", lambda p: str(fake_bam))
    monkeypatch.setattr(cp, "_resolve_index_path", lambda p: None)
    monkeypatch.setattr(cp, "_resolve_reference_path", lambda p: None)
    monkeypatch.setattr(cp, "_open_alignment", lambda *_args, **_kwargs: _FakeBam())

    build_started = threading.Event()
    release_build = threading.Event()
    build_calls: list[str] = []

    def fake_build(_resolved, _index, _reference, chrom, _chrom_len):
        build_calls.append(chrom)
        build_started.set()
        assert release_build.wait(timeout=2), "test bug: build was never released"
        return np.arange(cp.BASE_BINS, dtype=np.float32), None

    monkeypatch.setattr(cp, "_build_base_layer", fake_build)

    def load_layer():
        base, chrom_len = cp._load_or_build_base_layer(
            str(fake_bam),
            "chrT",
            index_path=None,
            reference_fasta=None,
            no_cache=False,
        )
        return len(base), chrom_len, float(base[42])

    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(load_layer) for _ in range(4)]
        assert build_started.wait(timeout=2), "cold build never started"
        release_build.set()
        results = [f.result(timeout=5) for f in futures]

    assert results == [(cp.BASE_BINS, 10_000, 42.0)] * 4
    assert build_calls == ["chrT"]
    assert len(list(cache_dir.glob("*.npy"))) == 1
    assert list(cache_dir.glob("*.tmp")) == []


def test_base_layer_cache_key_treats_index_as_accessory_but_reference_as_semantic(
    monkeypatch, tmp_path
):
    from src.services import coverage_pyramid as cp

    cache_dir = tmp_path / "cov-pyramid-cache"
    cache_dir.mkdir()
    fake_bam = tmp_path / "reads.bam"
    index_a = tmp_path / "reads.a.bai"
    index_b = tmp_path / "reads.b.bai"
    reference_a = tmp_path / "ref-a.fa"
    reference_b = tmp_path / "ref-b.fa"
    fake_bam.write_bytes(b"fake-bam")
    index_a.write_bytes(b"index-a")
    index_b.write_bytes(b"index-b")
    reference_a.write_bytes(b">chrT\nA\n")
    reference_b.write_bytes(b">chrT\nC\n")

    monkeypatch.setenv("WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR", str(cache_dir))

    base = cp._base_layer_cache_path(
        str(fake_bam), "chrT", str(index_a), str(reference_a)
    )
    changed_index = cp._base_layer_cache_path(
        str(fake_bam), "chrT", str(index_b), str(reference_a)
    )
    changed_reference = cp._base_layer_cache_path(
        str(fake_bam), "chrT", str(index_a), str(reference_b)
    )

    assert base is not None
    assert changed_index is not None
    assert changed_reference is not None
    assert changed_index == base
    assert changed_reference != base


def test_base_layer_cache_key_survives_same_volume_rename(monkeypatch, tmp_path):
    from src.services import coverage_pyramid as cp

    cache_dir = tmp_path / "cov-pyramid-cache"
    cache_dir.mkdir()
    original = tmp_path / "reads-original.bam"
    renamed = tmp_path / "reads-renamed.bam"
    original.write_bytes(b"fake-bam")
    monkeypatch.setenv("WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR", str(cache_dir))
    monkeypatch.setattr(cp, "coverage_engine_identity", lambda: "engine-a")

    before = cp._base_layer_cache_path(str(original), "chrT")
    original.rename(renamed)
    after = cp._base_layer_cache_path(str(renamed), "chrT")

    assert before == after


def test_base_layer_cache_key_changes_with_exact_engine_identity(monkeypatch, tmp_path):
    from src.services import coverage_pyramid as cp

    cache_dir = tmp_path / "cov-pyramid-cache"
    cache_dir.mkdir()
    fake_bam = tmp_path / "reads.bam"
    fake_bam.write_bytes(b"fake-bam")
    monkeypatch.setenv("WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR", str(cache_dir))
    monkeypatch.setattr(cp, "use_rust_coverage", lambda: True)
    monkeypatch.setattr(cp, "coverage_engine_identity", lambda: "engine-a")

    engine_a = cp._base_layer_cache_path(str(fake_bam), "chrT")
    monkeypatch.setattr(cp, "coverage_engine_identity", lambda: "engine-b")
    engine_b = cp._base_layer_cache_path(str(fake_bam), "chrT")

    assert engine_a is not None
    assert engine_b is not None
    assert engine_a != engine_b
