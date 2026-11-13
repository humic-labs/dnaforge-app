""" — coverage pyramid readiness is a fast cache truth oracle."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest


@dataclass
class _Read:
    reference_start: int
    reference_end: int
    is_unmapped: bool = False
    is_secondary: bool = False
    is_supplementary: bool = False

    def get_blocks(self):
        return [(self.reference_start, self.reference_end)]


class _FakeBam:
    references = ("chrT",)

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def fetch(self, chrom: str, start: int, end: int):
        raise AssertionError("readiness must not scan alignments")

    def get_reference_length(self, chrom: str) -> int:
        assert chrom == "chrT"
        return 100_000_000

    def get_index_statistics(self):
        return [SimpleNamespace(contig="chrT", mapped=50_000_000)]


def test_coverage_pyramid_readiness_reports_missing_and_present_cache(
    monkeypatch, tmp_path
):
    from src.services import coverage_pyramid as cp

    cache_dir = tmp_path / "cov-pyramid-cache"
    cache_dir.mkdir()
    fake_bam = tmp_path / "reads.bam"
    fake_bam.write_bytes(b"fake-bam")

    monkeypatch.setenv("WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR", str(cache_dir))
    monkeypatch.setattr(cp, "_open_alignment", lambda *_args, **_kwargs: _FakeBam())
    monkeypatch.setattr(cp, "_resolve_bam_path", lambda p: str(fake_bam))
    monkeypatch.setattr(cp, "_resolve_index_path", lambda p: None)
    monkeypatch.setattr(cp, "_resolve_reference_path", lambda p: None)

    cold = cp.coverage_pyramid_readiness(str(fake_bam), ["chrT", "missing"])

    assert cold[0]["chrom"] == "chrT"
    assert cold[0]["present"] is False
    assert cold[0]["chromLength"] == 100_000_000
    assert cold[0]["baseBinBp"] == max(1, -(-100_000_000 // cp.BASE_BINS))
    assert cold[0]["sizeBytes"] == 0
    assert cold[0]["cachePath"].endswith(".npy")
    assert cold[1] == {
        "chrom": "missing",
        "present": False,
        "reason": "chrom not in BAM",
    }

    np.save(
        cold[0]["cachePath"],
        np.ones(cp.BASE_BINS // 2, dtype=np.float32),
        allow_pickle=False,
    )

    stale = cp.coverage_pyramid_readiness(str(fake_bam), ["chrT"])
    assert stale[0]["present"] is False
    assert "shape mismatch" in stale[0]["reason"]

    np.save(
        cold[0]["cachePath"],
        np.ones(cp.BASE_BINS, dtype=np.float32),
        allow_pickle=False,
    )

    warm = cp.coverage_pyramid_readiness(str(fake_bam), ["chrT"])
    assert warm[0]["present"] is True
    assert warm[0]["sizeBytes"] > 0


def test_coverage_pyramid_readiness_never_waits_on_cold_build_lock(
    monkeypatch, tmp_path
):
    from src.services import coverage_pyramid as cp

    cache_dir = tmp_path / "cov-pyramid-cache"
    cache_dir.mkdir()
    fake_bam = tmp_path / "reads.bam"
    fake_bam.write_bytes(b"fake-bam")

    monkeypatch.setenv("WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR", str(cache_dir))
    monkeypatch.setattr(cp, "_open_alignment", lambda *_args, **_kwargs: _FakeBam())
    monkeypatch.setattr(cp, "_resolve_bam_path", lambda p: str(fake_bam))
    monkeypatch.setattr(cp, "_resolve_index_path", lambda p: None)
    monkeypatch.setattr(cp, "_resolve_reference_path", lambda p: None)
    monkeypatch.setattr(
        cp,
        "_base_layer_lock",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("readiness must never enter the producer lock")
        ),
    )

    rows = cp.coverage_pyramid_readiness(str(fake_bam), ["chrT"])

    assert rows[0]["present"] is False
    assert rows[0]["sizeBytes"] == 0


def test_missing_broad_tile_never_waits_on_cold_build_lock(monkeypatch, tmp_path):
    from src.services import coverage_pyramid as cp

    missing_path = tmp_path / "missing.npy"
    monkeypatch.setattr(cp, "_base_layer_cache_path", lambda *_args: missing_path)
    monkeypatch.setattr(
        cp,
        "_base_layer_lock",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("foreground tiles must never enter the producer lock")
        ),
    )

    with pytest.raises(
        cp.CoveragePyramidMissingError, match="coverage pyramid missing"
    ):
        cp._coverage_tile_from_cached_base_layer(
            resolved="/reads.bam",
            resolved_index="/reads.bam.bai",
            resolved_reference=None,
            chrom="chrT",
            chrom_len=100_000_000,
            start=0,
            end=100_000_000,
            bins=1024,
        )


def test_cached_base_layer_retains_read_only_mapping_after_first_load(
    monkeypatch, tmp_path
):
    from src.services import coverage_pyramid as cp

    cp._clear_base_layer_memory_cache()
    monkeypatch.delenv("WAYPOINT_COVERAGE_BASE_LAYER_MEMORY_CACHE_BYTES", raising=False)
    path = tmp_path / "base.npy"
    np.save(path, np.arange(cp.BASE_BINS, dtype=np.float32), allow_pickle=False)

    original_load = np.load
    loads = []

    def counted_load(*args, **kwargs):
        loads.append((args[0], kwargs))
        return original_load(*args, **kwargs)

    monkeypatch.setattr(cp.np, "load", counted_load)

    first = cp._load_cached_base_layer(path)
    second = cp._load_cached_base_layer(path)

    assert first is second
    assert len(loads) == 1
    assert loads[0][1]["mmap_mode"] == "r"
    assert isinstance(first.base, np.memmap)
    assert first.flags.writeable is False
    cp._clear_base_layer_memory_cache()


def test_rust_build_to_path_uses_helper_max_depth_without_rereading_layer(
    monkeypatch, tmp_path
):
    from src.services import coverage_pyramid as cp

    fake_bam = tmp_path / "reads.bam"
    fake_bam.write_bytes(b"fake-bam")
    out_path = tmp_path / "base.npy"

    def rust_build(**kwargs):
        np.save(
            kwargs["out_path"],
            np.array([0, 17, 3, 0], dtype=np.float32),
            allow_pickle=False,
        )
        return {
            "chrom": "chrT",
            "chromLength": 4,
            "baseBins": 4,
            "baseBinBp": 1,
            "maxDepth": 17.0,
            "outPath": str(kwargs["out_path"]),
            "provenance": {"method": "rust-htslib-base-layer", "exact": True},
        }

    monkeypatch.setattr(cp, "BASE_BINS", 4)
    monkeypatch.setattr(cp, "use_rust_coverage", lambda: True)
    monkeypatch.setattr(cp, "run_build_base_layer", rust_build)
    monkeypatch.setattr(
        cp,
        "_load_cached_base_layer",
        lambda _path: (_ for _ in ()).throw(
            AssertionError("fresh Rust output must not be reread for maxDepth")
        ),
    )

    provenance, max_depth, aligned_base_count = cp._build_base_layer_to_path(
        str(fake_bam), None, None, "chrT", 4, out_path
    )

    assert provenance == {"method": "rust-htslib-base-layer", "exact": True}
    assert max_depth == 17.0
    assert out_path.is_file()


def test_build_base_layer_prefers_rust_helper(monkeypatch, tmp_path):
    from src.services import coverage_pyramid as cp

    fake_bam = tmp_path / "reads.bam"
    fake_bam.write_bytes(b"fake-bam")
    calls = []

    def rust_build(**kwargs):
        calls.append(kwargs)
        np.save(
            kwargs["out_path"],
            np.full(cp.BASE_BINS, 7, dtype=np.float32),
            allow_pickle=False,
        )
        return {
            "chrom": "chrT",
            "chromLength": 1000,
            "baseBins": cp.BASE_BINS,
            "baseBinBp": 1,
            "maxDepth": 7.0,
            "outPath": str(kwargs["out_path"]),
            "provenance": {"method": "rust-htslib-base-layer", "exact": True},
        }

    def fail_python_alignment(*_args, **_kwargs):
        raise AssertionError("base layer should be built by the Rust helper")

    monkeypatch.setattr(cp, "use_rust_coverage", lambda: True)
    monkeypatch.setattr(cp, "run_build_base_layer", rust_build)
    monkeypatch.setattr(cp, "_open_alignment", fail_python_alignment)

    base, aligned_base_count = cp._build_base_layer(
        str(fake_bam), str(fake_bam) + ".bai", None, "chrT", 1000
    )

    assert base.shape == (cp.BASE_BINS,)
    assert float(base.max()) == 7.0
    assert calls[0]["bam_path"] == fake_bam
    assert calls[0]["chrom"] == "chrT"
    assert calls[0]["base_bins"] == cp.BASE_BINS
    assert calls[0]["window_bp"] == cp.WINDOW_BP
    assert calls[0]["index_path"] == Path(str(fake_bam) + ".bai")
    assert calls[0]["reference_fasta"] is None


def test_coverage_pyramid_precompute_builds_missing_cache_with_rust(
    monkeypatch, tmp_path
):
    from src.services import coverage_pyramid as cp

    cache_dir = tmp_path / "cov-pyramid-cache"
    cache_dir.mkdir()
    fake_bam = tmp_path / "reads.bam"
    fake_bam.write_bytes(b"fake-bam")
    calls = []

    def rust_build(**kwargs):
        calls.append(kwargs)
        np.save(
            kwargs["out_path"],
            np.full(cp.BASE_BINS, 11, dtype=np.float32),
            allow_pickle=False,
        )
        return {
            "chrom": "chrT",
            "chromLength": 100_000_000,
            "baseBins": cp.BASE_BINS,
            "baseBinBp": 382,
            "maxDepth": 11.0,
            "outPath": str(kwargs["out_path"]),
            "provenance": {"method": "rust-htslib-base-layer", "exact": True},
        }

    monkeypatch.setenv("WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR", str(cache_dir))
    monkeypatch.setattr(cp, "_open_alignment", lambda *_args, **_kwargs: _FakeBam())
    monkeypatch.setattr(cp, "_resolve_bam_path", lambda p: str(fake_bam))
    monkeypatch.setattr(cp, "_resolve_index_path", lambda p: None)
    monkeypatch.setattr(cp, "_resolve_reference_path", lambda p: None)
    monkeypatch.setattr(cp, "use_rust_coverage", lambda: True)
    monkeypatch.setattr(cp, "coverage_engine_identity", lambda: "test-rust-engine")
    monkeypatch.setattr(cp, "run_build_base_layer", rust_build)

    built = cp.coverage_pyramid_precompute(str(fake_bam), ["chrT"])

    assert len(calls) == 1
    assert built[0]["present"] is True
    assert built[0]["built"] is True
    assert built[0]["maxDepth"] == 11.0
    assert built[0]["provenance"] == {
        "method": "rust-htslib-base-layer",
        "exact": True,
    }
    assert Path(built[0]["cachePath"]).is_file()
    assert np.load(built[0]["cachePath"], allow_pickle=False).shape == (cp.BASE_BINS,)

    monkeypatch.setattr(
        cp.np,
        "max",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("warm precompute must not rescan the base layer")
        ),
    )
    warm = cp.coverage_pyramid_precompute(str(fake_bam), ["chrT"])

    assert len(calls) == 1
    assert warm[0]["present"] is True
    assert warm[0]["built"] is False
    assert warm[0]["maxDepth"] == 11.0


def test_coverage_pyramid_precompute_preserves_unverified_legacy_artifact_and_rebuilds(
    monkeypatch, tmp_path
):
    from src.services import coverage_pyramid as cp

    cache_dir = tmp_path / "shared-cache"
    legacy_dir = tmp_path / "legacy-cache"
    cache_dir.mkdir()
    legacy_dir.mkdir()
    fake_bam = tmp_path / "reads.bam"
    fake_bam.write_bytes(b"fake-bam")

    monkeypatch.setenv("WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR", str(cache_dir))
    monkeypatch.setenv("WAYPOINT_COVERAGE_PYRAMID_LEGACY_DIRS", str(legacy_dir))
    monkeypatch.setattr(cp, "_open_alignment", lambda *_args, **_kwargs: _FakeBam())
    monkeypatch.setattr(cp, "_resolve_bam_path", lambda p: str(fake_bam))
    monkeypatch.setattr(cp, "_resolve_index_path", lambda p: None)
    monkeypatch.setattr(cp, "_resolve_reference_path", lambda p: None)
    monkeypatch.setattr(cp, "coverage_engine_identity", lambda: "engine-a")

    legacy_path = cp._legacy_base_layer_paths(str(fake_bam), "chrT", None, None)[0]
    np.save(
        legacy_path,
        np.full(cp.BASE_BINS, 3, dtype=np.float32),
        allow_pickle=False,
    )
    legacy_bytes = legacy_path.read_bytes()
    builds = []

    def rebuild(_resolved, _index, _reference, _chrom, _length, out_path):
        builds.append(out_path)
        np.save(
            out_path, np.full(cp.BASE_BINS, 5, dtype=np.float32), allow_pickle=False
        )
        return {"method": "aligned-query-fixture", "exact": True}, 5.0, None

    monkeypatch.setattr(cp, "_build_base_layer_to_path", rebuild)
    result = cp.coverage_pyramid_precompute(str(fake_bam), ["chrT"])
    assert result[0]["present"] is True
    assert result[0]["built"] is True
    current_path = Path(result[0]["cachePath"])
    assert builds == [current_path]
    assert current_path.stat().st_ino != legacy_path.stat().st_ino
    assert legacy_path.read_bytes() == legacy_bytes
    manifest = cp._read_base_layer_manifest(
        current_path, chrom="chrT", chrom_len=100_000_000
    )
    assert manifest is not None
    assert manifest["adoptedFrom"] is None
    assert np.load(current_path, allow_pickle=False)[0] == 5


def test_coverage_pyramid_precompute_parallelizes_rust_builds_in_request_order(
    monkeypatch, tmp_path
):
    from src.services import coverage_pyramid as cp

    class _MultiChromBam:
        references = ("chrA", "chrB", "chrC")

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

        def get_reference_length(self, chrom: str) -> int:
            return {"chrA": 10_000, "chrB": 20_000, "chrC": 30_000}[chrom]

    cache_dir = tmp_path / "cov-pyramid-cache"
    cache_dir.mkdir()
    fake_bam = tmp_path / "reads.bam"
    fake_bam.write_bytes(b"fake-bam")
    calls = []

    def rust_build(**kwargs):
        calls.append(kwargs["chrom"])
        np.save(
            kwargs["out_path"],
            np.full(cp.BASE_BINS, len(kwargs["chrom"]), dtype=np.float32),
            allow_pickle=False,
        )
        return {
            "chrom": kwargs["chrom"],
            "chromLength": 10_000,
            "baseBins": cp.BASE_BINS,
            "baseBinBp": 1,
            "maxDepth": float(len(kwargs["chrom"])),
            "outPath": str(kwargs["out_path"]),
            "provenance": {"method": "rust-htslib-base-layer", "exact": True},
        }

    monkeypatch.setenv("WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR", str(cache_dir))
    monkeypatch.setenv("WAYPOINT_COVERAGE_PRECOMPUTE_WORKERS", "3")
    monkeypatch.setattr(
        cp, "_open_alignment", lambda *_args, **_kwargs: _MultiChromBam()
    )
    monkeypatch.setattr(cp, "_resolve_bam_path", lambda p: str(fake_bam))
    monkeypatch.setattr(cp, "_resolve_index_path", lambda p: None)
    monkeypatch.setattr(cp, "_resolve_reference_path", lambda p: None)
    monkeypatch.setattr(cp, "use_rust_coverage", lambda: True)
    monkeypatch.setattr(cp, "coverage_engine_identity", lambda: "test-rust-engine")
    monkeypatch.setattr(cp, "run_build_base_layer", rust_build)

    built = cp.coverage_pyramid_precompute(str(fake_bam), ["chrC", "chrA", "chrB"])

    assert [row["chrom"] for row in built] == ["chrC", "chrA", "chrB"]
    assert set(calls) == {"chrA", "chrB", "chrC"}
    assert all(row["present"] is True for row in built)
    assert all(row["provenance"]["method"] == "rust-htslib-base-layer" for row in built)


def test_coverage_pyramid_precompute_rebuilds_invalid_cache(monkeypatch, tmp_path):
    from src.services import coverage_pyramid as cp

    cache_dir = tmp_path / "cov-pyramid-cache"
    cache_dir.mkdir()
    fake_bam = tmp_path / "reads.bam"
    fake_bam.write_bytes(b"fake-bam")
    calls = []

    monkeypatch.setenv("WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR", str(cache_dir))
    monkeypatch.setattr(cp, "_open_alignment", lambda *_args, **_kwargs: _FakeBam())
    monkeypatch.setattr(cp, "_resolve_bam_path", lambda p: str(fake_bam))
    monkeypatch.setattr(cp, "_resolve_index_path", lambda p: None)
    monkeypatch.setattr(cp, "_resolve_reference_path", lambda p: None)
    monkeypatch.setattr(cp, "use_rust_coverage", lambda: True)
    monkeypatch.setattr(cp, "coverage_engine_identity", lambda: "test-rust-engine")

    stale_path = cp._base_layer_cache_path(str(fake_bam), "chrT", None, None)
    assert stale_path is not None
    np.save(
        stale_path, np.ones(cp.BASE_BINS // 2, dtype=np.float32), allow_pickle=False
    )

    def rust_build(**kwargs):
        calls.append(kwargs)
        np.save(
            kwargs["out_path"],
            np.full(cp.BASE_BINS, 13, dtype=np.float32),
            allow_pickle=False,
        )
        return {
            "chrom": "chrT",
            "chromLength": 100_000_000,
            "baseBins": cp.BASE_BINS,
            "baseBinBp": 382,
            "maxDepth": 13.0,
            "outPath": str(kwargs["out_path"]),
            "provenance": {"method": "rust-htslib-base-layer", "exact": True},
        }

    monkeypatch.setattr(cp, "run_build_base_layer", rust_build)

    rebuilt = cp.coverage_pyramid_precompute(str(fake_bam), ["chrT"])

    assert len(calls) == 1
    assert rebuilt[0]["present"] is True
    assert rebuilt[0]["built"] is True
    assert "rebuilt invalid cache" in rebuilt[0]["reason"]
    assert np.load(stale_path, allow_pickle=False).shape == (cp.BASE_BINS,)
