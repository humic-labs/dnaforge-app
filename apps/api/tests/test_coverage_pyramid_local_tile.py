""" — coverage tiles use local bounded work on interactive spans."""

from __future__ import annotations

from dataclasses import dataclass
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
        assert chrom == "chrT"
        reads = [_Read(120, 180)]
        return [r for r in reads if r.reference_start < end and r.reference_end > start]

    def get_reference_length(self, chrom: str) -> int:
        assert chrom == "chrT"
        return 100_000_000

    def get_index_statistics(self):
        return [SimpleNamespace(contig="chrT", mapped=50_000_000)]


class _FakeAssemblyBam:
    references = ("chrA", "chrB")

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def get_reference_length(self, chrom: str) -> int:
        if chrom == "chrA":
            return 10_000_000
        if chrom == "chrB":
            return 100_000_000
        raise KeyError(chrom)


def test_interactive_tile_uses_local_histogram_not_whole_chrom_pyramid(
    monkeypatch, tmp_path
):
    from src.services import coverage_pyramid as cp

    fake_bam = tmp_path / "reads.bam"
    fake_bam.write_bytes(b"fake-bam")

    def fail_whole_chrom_build(*_args, **_kwargs):
        raise AssertionError(
            "interactive tile should not build/load the whole-chrom pyramid"
        )

    monkeypatch.setattr(cp, "_load_or_build_base_layer", fail_whole_chrom_build)
    monkeypatch.setattr(cp, "_open_alignment", lambda *_args, **_kwargs: _FakeBam())
    monkeypatch.setattr(cp, "_resolve_bam_path", lambda p: str(fake_bam))
    monkeypatch.setattr(cp, "_resolve_index_path", lambda p: None)
    monkeypatch.setattr(cp, "_resolve_reference_path", lambda p: None)
    monkeypatch.setenv("DNA_COVERAGE_USE_RUST", "0")

    tile = cp.coverage_tile(str(fake_bam), "chrT", 100, 228, bins=4)

    assert tile["start"] == 100
    assert tile["end"] == 228
    assert tile["binSize"] == 32
    assert tile["bins"] == [1.0, 1.0, 1.0, 0.0]
    assert tile["maxDepth"] == 1.0
    assert tile["provenance"] == {"method": "local-window-peak", "exact": True}


def test_interactive_tile_prefers_rust_coverage_helper(monkeypatch, tmp_path):
    from src.services import coverage_pyramid as cp

    fake_bam = tmp_path / "reads.bam"
    fake_bam.write_bytes(b"fake-bam")
    calls = []

    def rust_tile(**kwargs):
        calls.append(kwargs)
        return {
            "chrom": "chrT",
            "start": 100,
            "end": 228,
            "bins": [2.0, 1.0, 0.0, 0.0],
            "binSize": 32,
            "maxDepth": 2.0,
            "provenance": {"method": "rust-htslib-window-peak", "exact": True},
        }

    def fail_python_alignment(*_args, **_kwargs):
        raise AssertionError("interactive coverage should use the Rust helper")

    monkeypatch.setattr(cp, "_coverage_tile_from_rust", rust_tile)
    monkeypatch.setattr(cp, "_open_alignment", fail_python_alignment)
    monkeypatch.setattr(cp, "_resolve_bam_path", lambda p: str(fake_bam))
    monkeypatch.setattr(cp, "_resolve_index_path", lambda p: str(fake_bam) + ".bai")
    monkeypatch.setattr(cp, "_resolve_reference_path", lambda p: None)

    tile = cp.coverage_tile(
        str(fake_bam),
        "chrT",
        100,
        228,
        bins=4,
        index_path=str(fake_bam) + ".bai",
    )

    assert tile["provenance"] == {"method": "rust-htslib-window-peak", "exact": True}
    assert calls == [
        {
            "bam_path": str(fake_bam),
            "chrom": "chrT",
            "start": 100,
            "end": 228,
            "bins": 4,
            "bin_size_bp": None,
            "index_path": str(fake_bam) + ".bai",
            "reference_fasta": None,
        }
    ]


def test_assembly_tile_batches_segments_without_whole_genome_python_parse(
    monkeypatch, tmp_path
):
    from src.services import coverage_pyramid as cp

    fake_bam = tmp_path / "reads.bam"
    fake_bam.write_bytes(b"fake-bam")
    local_calls = []
    cached_calls = []

    monkeypatch.setattr(
        cp, "_open_alignment", lambda *_args, **_kwargs: _FakeAssemblyBam()
    )
    monkeypatch.setattr(cp, "_resolve_bam_path", lambda p: str(fake_bam))
    monkeypatch.setattr(cp, "_resolve_index_path", lambda p: None)
    monkeypatch.setattr(cp, "_resolve_reference_path", lambda p: None)

    def local_tile(
        bam_path: str,
        chrom: str,
        start: int,
        end: int,
        *,
        bins: int,
        bin_size_bp: int | None = None,
        index_path: str | None,
        reference_fasta: str | None,
    ):
        local_calls.append(
            (
                bam_path,
                chrom,
                start,
                end,
                bins,
                bin_size_bp,
                index_path,
                reference_fasta,
            )
        )
        return {
            "chrom": chrom,
            "start": start,
            "end": end,
            "bins": [2.0, 0.0, 1.0, 0.0],
            "binSize": 25,
            "maxDepth": 2.0,
            "provenance": {"method": "rust-htslib-window-peak", "exact": True},
        }

    def cached_tile(**kwargs):
        cached_calls.append(kwargs)
        return {
            "chrom": kwargs["chrom"],
            "start": kwargs["start"],
            "end": kwargs["end"],
            "bins": [0.0, 3.0, 0.0, 1.0],
            "binSize": 100_000,
            "maxDepth": 3.0,
            "provenance": {"method": "pyramid-maxpool", "exact": True},
        }

    monkeypatch.setattr(cp, "_local_coverage_tile", local_tile)
    monkeypatch.setattr(cp, "_coverage_tile_from_cached_base_layer", cached_tile)

    tile = cp.coverage_assembly_tile(
        str(fake_bam),
        [
            {"chrom": "chrA", "start": 100, "end": 200, "globalStart": 1_000},
            {
                "chrom": "chrB",
                "start": 0,
                "end": cp.LOCAL_TILE_COVERAGE_MAX_BP + 1,
                "globalStart": 10_000_000,
            },
        ],
        bins=4,
    )

    assert len(local_calls) == 0
    assert len(cached_calls) == 2
    assert cached_calls[0]["chrom"] == "chrA"
    assert cached_calls[1]["chrom"] == "chrB"
    assert tile["maxDepth"] == 3.0
    assert tile["segments"][0]["globalStart"] == 1_100
    assert tile["segments"][0]["globalEnd"] == 1_200
    assert tile["segments"][0]["provenance"]["method"] == "pyramid-maxpool"
    assert tile["segments"][1]["globalStart"] == 10_000_000
    assert tile["segments"][1]["globalEnd"] == 11_100_001
    assert tile["segments"][1]["provenance"]["method"] == "pyramid-maxpool"


def test_assembly_tile_preserves_lod_bin_size_for_clipped_segments(
    monkeypatch, tmp_path
):
    from src.services import coverage_pyramid as cp

    fake_bam = tmp_path / "reads.bam"
    fake_bam.write_bytes(b"fake-bam")
    cached_calls = []

    monkeypatch.setattr(
        cp, "_open_alignment", lambda *_args, **_kwargs: _FakeAssemblyBam()
    )
    monkeypatch.setattr(cp, "_resolve_bam_path", lambda p: str(fake_bam))
    monkeypatch.setattr(cp, "_resolve_index_path", lambda p: None)
    monkeypatch.setattr(cp, "_resolve_reference_path", lambda p: None)

    def cached_tile(**kwargs):
        cached_calls.append(kwargs)
        bin_size = kwargs["bin_size_bp"]
        span = kwargs["end"] - kwargs["start"]
        out_bins = max(1, -(-span // bin_size))
        return {
            "chrom": kwargs["chrom"],
            "start": kwargs["start"],
            "end": kwargs["end"],
            "bins": [1.0] * out_bins,
            "binSize": bin_size,
            "maxDepth": 1.0,
            "provenance": {"method": "pyramid-maxpool", "exact": True},
        }

    monkeypatch.setattr(cp, "_coverage_tile_from_cached_base_layer", cached_tile)

    tile = cp.coverage_assembly_tile(
        str(fake_bam),
        [{"chrom": "chrA", "start": 100, "end": 145, "globalStart": 1_000}],
        bins=1024,
        bin_size_bp=16,
    )

    assert cached_calls[0]["bins"] == 3
    assert cached_calls[0]["bin_size_bp"] == 16
    assert tile["segments"][0]["binSize"] == 16
    assert len(tile["segments"][0]["bins"]) == 3
    assert tile["segments"][0]["globalStart"] == 1_100
    assert tile["segments"][0]["globalEnd"] == 1_145


def test_assembly_tile_falls_back_to_local_for_local_span_when_resident_cache_is_missing(
    monkeypatch, tmp_path
):
    from src.services import coverage_pyramid as cp

    fake_bam = tmp_path / "reads.bam"
    fake_bam.write_bytes(b"fake-bam")
    local_calls = []

    monkeypatch.setattr(
        cp, "_open_alignment", lambda *_args, **_kwargs: _FakeAssemblyBam()
    )
    monkeypatch.setattr(cp, "_resolve_bam_path", lambda p: str(fake_bam))
    monkeypatch.setattr(cp, "_resolve_index_path", lambda p: None)
    monkeypatch.setattr(cp, "_resolve_reference_path", lambda p: None)

    def local_tile(
        bam_path: str,
        chrom: str,
        start: int,
        end: int,
        *,
        bins: int,
        bin_size_bp: int | None = None,
        index_path: str | None,
        reference_fasta: str | None,
    ):
        local_calls.append(
            (
                bam_path,
                chrom,
                start,
                end,
                bins,
                bin_size_bp,
                index_path,
                reference_fasta,
            )
        )
        return {
            "chrom": chrom,
            "start": start,
            "end": end,
            "bins": [2.0, 0.0, 1.0, 0.0],
            "binSize": 25,
            "maxDepth": 2.0,
            "provenance": {"method": "rust-htslib-window-peak", "exact": True},
        }

    def missing_cached_tile(**_kwargs):
        raise cp.CoveragePyramidMissingError("missing resident cache")

    monkeypatch.setattr(cp, "_local_coverage_tile", local_tile)
    monkeypatch.setattr(
        cp, "_coverage_tile_from_cached_base_layer", missing_cached_tile
    )

    tile = cp.coverage_assembly_tile(
        str(fake_bam),
        [{"chrom": "chrA", "start": 100, "end": 200, "globalStart": 1_000}],
        bins=4,
    )

    assert len(local_calls) == 1
    assert tile["segments"][0]["provenance"]["method"] == "rust-htslib-window-peak"


def test_cold_coarse_tile_without_cached_pyramid_is_not_ready(monkeypatch, tmp_path):
    from src.services import coverage_pyramid as cp

    cache_dir = tmp_path / "cov-pyramid-cache"
    cache_dir.mkdir()
    fake_bam = tmp_path / "reads.bam"
    fake_bam.write_bytes(b"fake-bam")

    def fail_whole_chrom_build(*_args, **_kwargs):
        raise AssertionError("cold coarse tile should not foreground-build the pyramid")

    monkeypatch.setenv("WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR", str(cache_dir))
    monkeypatch.setattr(cp, "_load_or_build_base_layer", fail_whole_chrom_build)
    monkeypatch.setattr(cp, "_open_alignment", lambda *_args, **_kwargs: _FakeBam())
    monkeypatch.setattr(cp, "_resolve_bam_path", lambda p: str(fake_bam))
    monkeypatch.setattr(cp, "_resolve_index_path", lambda p: None)
    monkeypatch.setattr(cp, "_resolve_reference_path", lambda p: None)

    with pytest.raises(
        cp.CoveragePyramidMissingError, match="cannot return estimated bins"
    ):
        cp.coverage_tile(
            str(fake_bam),
            "chrT",
            0,
            cp.LOCAL_TILE_COVERAGE_MAX_BP + 1,
            bins=8,
        )


def test_pyramid_tile_fails_closed_when_requested_bins_are_finer_than_base_layer(
    monkeypatch,
):
    from src.services import coverage_pyramid as cp

    def fake_load_or_build_base_layer(*_args, **_kwargs):

        return np.ones(64, dtype=np.float32), 1_000_000_000

    monkeypatch.setattr(cp, "_load_or_build_base_layer", fake_load_or_build_base_layer)

    with pytest.raises(cp.CoveragePyramidMissingError, match="resolution too coarse"):
        cp.coverage_tile(
            "unused.bam",
            "chr1",
            0,
            1024 * 1500,
            bins=1024,
            no_cache=True,
        )
