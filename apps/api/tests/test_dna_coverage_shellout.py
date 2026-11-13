"""Tests for the Rust `dna-coverage` shell-out wrapper."""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

import numpy as np
import pysam
import pytest

_MODULE_PATH = (
    Path(__file__).resolve().parent.parent
    / "src"
    / "services"
    / "dna_coverage_shellout.py"
)
_spec = importlib.util.spec_from_file_location("dna_coverage_shellout", _MODULE_PATH)
_mod = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
sys.modules["dna_coverage_shellout"] = _mod
_spec.loader.exec_module(_mod)  # type: ignore[union-attr]

DnaCoverageNotFoundError = _mod.DnaCoverageNotFoundError
DnaCoverageError = _mod.DnaCoverageError
check_binary_compatibility = _mod.check_binary_compatibility
find_dna_coverage_binary = _mod.find_dna_coverage_binary
run_coverage_tile = _mod.run_coverage_tile
run_build_base_layer = _mod.run_build_base_layer
use_rust_coverage = _mod.use_rust_coverage


def _repo_root() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "Cargo.toml").is_file():
            return parent
    raise RuntimeError("cannot find worktree root")


def _binary() -> Path | None:
    fresh = _repo_root() / "target" / "release" / "dna-coverage"
    if fresh.is_file() and os.access(fresh, os.X_OK):
        return fresh
    try:
        return find_dna_coverage_binary()
    except DnaCoverageNotFoundError:
        return None


def _make_bam(tmp_path: Path) -> Path:
    header = {
        "HD": {"VN": "1.6", "SO": "coordinate"},
        "SQ": [{"SN": "chr11", "LN": 1000}],
    }
    path = tmp_path / "t.bam"
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for i, start in enumerate([100, 120, 300]):
            read = pysam.AlignedSegment()
            read.query_name = f"r{i}"
            read.reference_id = 0
            read.reference_start = start
            read.query_sequence = "A" * 50
            read.cigartuples = [(0, 50)]
            read.mapping_quality = 60
            read.flag = 16 if i == 1 else 0
            out.write(read)
    pysam.index(str(path))
    return path


def test_use_rust_coverage_defaults_on(monkeypatch):
    monkeypatch.delenv("DNA_COVERAGE_USE_RUST", raising=False)
    assert use_rust_coverage() is True


@pytest.mark.parametrize("value", ["0", "false", "FALSE", "no"])
def test_use_rust_coverage_can_be_disabled_for_diagnostics(monkeypatch, value):
    monkeypatch.setenv("DNA_COVERAGE_USE_RUST", value)
    assert use_rust_coverage() is False


def test_check_binary_compatibility_reports_schema_2():
    binary = _binary()
    if binary is None:
        pytest.skip("dna-coverage binary not built")

    assert check_binary_compatibility(binary) == 2


def test_check_binary_compatibility_rejects_schema_2_without_threads(monkeypatch):
    responses = iter(
        [
            _mod.subprocess.CompletedProcess(
                [], 0, "dna-coverage 0.1.0 schema 2\n", ""
            ),
            _mod.subprocess.CompletedProcess([], 0, "--bin-size <BIN_SIZE>\n", ""),
            _mod.subprocess.CompletedProcess([], 0, "--base-bins <BASE_BINS>\n", ""),
        ]
    )
    monkeypatch.setattr(_mod.subprocess, "run", lambda *args, **kwargs: next(responses))

    with pytest.raises(DnaCoverageError, match=r"VERSION_MISMATCH:.*--threads"):
        check_binary_compatibility(Path("/stale/dna-coverage"))


def test_run_coverage_tile_reads_real_indexed_bam(tmp_path: Path):
    binary = _binary()
    if binary is None:
        pytest.skip("dna-coverage binary not built")
    bam = _make_bam(tmp_path)

    tile = run_coverage_tile(
        bam_path=bam,
        index_path=Path(str(bam) + ".bai"),
        chrom="chr11",
        start=100,
        end=350,
        bins=5,
        binary=binary,
    )

    assert tile["chrom"] == "chr11"
    assert tile["start"] == 100
    assert tile["end"] == 350
    assert tile["binSize"] == 50
    assert tile["bins"] == [2.0, 1.0, 0.0, 0.0, 1.0]
    assert tile["maxDepth"] == 2.0
    assert tile["provenance"] == {
        "method": "rust-htslib-window-peak",
        "exact": True,
    }


def test_run_build_base_layer_writes_numpy_base_layer(tmp_path: Path):
    binary = _binary()
    if binary is None:
        pytest.skip("dna-coverage binary not built")
    bam = _make_bam(tmp_path)
    out = tmp_path / "base.npy"

    summary = run_build_base_layer(
        bam_path=bam,
        index_path=Path(str(bam) + ".bai"),
        chrom="chr11",
        out_path=out,
        base_bins=10,
        window_bp=200,
        binary=binary,
    )

    arr = np.load(out, allow_pickle=False)
    assert summary["chrom"] == "chr11"
    assert summary["chromLength"] == 1000
    assert summary["baseBins"] == 10
    assert summary["baseBinBp"] == 100
    assert summary["maxDepth"] == 2.0
    assert summary["provenance"] == {
        "method": "rust-htslib-base-layer",
        "exact": True,
    }
    assert arr.shape == (10,)
    assert arr.dtype == np.float32
    assert arr.tolist() == [0.0, 2.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
