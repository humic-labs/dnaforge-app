import os
from pathlib import Path

import numpy as np
import pysam
import pytest

from src.services import coverage_pyramid as pyramid
from src.services import dna_coverage_shellout as native
from src.services.pileup import coverage_region

EXPECTED = [
    1,
    2,
    2,
    1,
    1,
    2,
    2,
    2,
    1,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    1,
    1,
    1,
    1,
    1,
    0,
    1,
    1,
    1,
    0,
    0,
    1,
    1,
    1,
    0,
    0,
]


@pytest.fixture
def spliced_bam(tmp_path):
    path = tmp_path / "reads.bam"
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chrT", "LN": 32}]}
    rows = [
        (0, [(0, 3), (3, 10), (0, 3)], "rna"),
        (1, [(0, 20)], "dna"),
        (5, [(0, 3)], "nested"),
        (22, [(0, 3), (2, 2), (0, 3)], "deletion"),
    ]
    with pysam.AlignmentFile(str(path), "wb", header=header) as writer:
        for start, cigar, name in rows:
            length = sum(
                length for operation, length in cigar if operation in (0, 1, 4, 7, 8)
            )
            read = pysam.AlignedSegment()
            read.query_name = name
            read.reference_id = 0
            read.reference_start = start
            read.query_sequence = "A" * length
            read.query_qualities = [30] * length
            read.cigartuples = cigar
            read.mapping_quality = 60
            read.flag = 0
            writer.write(read)
    pysam.index(str(path))
    return path


def test_python_region_preserves_rna_skips_and_deletion_gaps(spliced_bam):
    result = coverage_region(str(spliced_bam), "chrT", 0, 32, bin_size=1)
    assert result["bins"] == EXPECTED


def test_python_window_and_base_match_aligned_query_depth(spliced_bam, monkeypatch):
    monkeypatch.setenv("DNA_COVERAGE_USE_RUST", "0")
    monkeypatch.setattr(pyramid, "BASE_BINS", 32)
    monkeypatch.setattr(pyramid, "WINDOW_BP", 8)
    tile = pyramid._local_coverage_tile(
        str(spliced_bam),
        "chrT",
        3,
        13,
        bins=10,
        bin_size_bp=1,
        index_path=None,
        reference_fasta=None,
    )
    assert tile["bins"] == EXPECTED[3:13]
    base, aligned_base_count = pyramid._build_base_layer(
        str(spliced_bam), None, None, "chrT", 32
    )
    assert base.tolist() == EXPECTED
    assert aligned_base_count == sum(EXPECTED)


def test_native_window_and_streaming_base_match_the_same_rna_dna_oracle(
    spliced_bam, tmp_path
):
    try:
        binary = native.find_dna_coverage_binary()
    except native.DnaCoverageNotFoundError:
        if "DNA_COVERAGE_PATH" in os.environ:
            raise
        pytest.skip("native coverage helper is unavailable")
    tile = native.run_coverage_tile(
        bam_path=spliced_bam, chrom="chrT", start=0, end=32, bins=32, binary=binary
    )
    assert tile["bins"] == EXPECTED
    output = tmp_path / "base.npy"
    summary = native.run_build_base_layer(
        bam_path=spliced_bam,
        chrom="chrT",
        out_path=output,
        base_bins=32,
        window_bp=8,
        binary=binary,
    )
    assert np.load(output, allow_pickle=False).tolist() == EXPECTED
    assert summary["alignedBaseCount"] == sum(EXPECTED)
    assert summary["meanDepth"] == sum(EXPECTED) / 32


def test_old_span_counting_helper_is_refused_before_scanning(monkeypatch):
    calls = []

    def old_helper(command, **kwargs):
        calls.append(command)
        return native.subprocess.CompletedProcess(
            command, 0, "dna-coverage 0.1.0 schema 1\n", ""
        )

    monkeypatch.setattr(native.subprocess, "run", old_helper)
    with pytest.raises(native.DnaCoverageError, match="VERSION_MISMATCH"):
        native.check_binary_compatibility(Path("/old/dna-coverage"))
    assert calls == [["/old/dna-coverage", "schema-version"]]


@pytest.mark.parametrize("use_native", [False, True])
def test_exact_contig_mean_is_persisted_and_observed_without_rebuilding(
    spliced_bam, tmp_path, monkeypatch, use_native
):
    if use_native:
        try:
            native.find_dna_coverage_binary()
        except native.DnaCoverageNotFoundError:
            if "DNA_COVERAGE_PATH" in os.environ:
                raise
            pytest.skip("native coverage helper is unavailable")
    monkeypatch.setenv("DNA_COVERAGE_USE_RUST", "1" if use_native else "0")
    monkeypatch.setenv("WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(pyramid, "BASE_BINS", 4)
    monkeypatch.setattr(pyramid, "WINDOW_BP", 8)
    built = pyramid.coverage_pyramid_precompute(str(spliced_bam), ["chrT"])[0]
    assert built["built"] is True
    assert built["alignedBaseCount"] == sum(EXPECTED)
    assert built["meanDepth"] == sum(EXPECTED) / 32

    def forbid_build(*args, **kwargs):
        raise AssertionError("observing a persisted summary must not rebuild coverage")

    monkeypatch.setattr(pyramid, "_build_base_layer_to_path", forbid_build)
    ready = pyramid.coverage_pyramid_readiness(str(spliced_bam), ["chrT"])[0]
    assert ready["present"] is True
    assert ready["alignedBaseCount"] == built["alignedBaseCount"]
    assert ready["meanDepth"] == built["meanDepth"]
    reused = pyramid.coverage_pyramid_precompute(str(spliced_bam), ["chrT"])[0]
    assert reused["built"] is False
    assert reused["meanDepth"] == built["meanDepth"]


@pytest.mark.parametrize("native_case", ["window", "persisted_mean"])
@pytest.mark.parametrize("helper_failure", ["missing", "invalid"])
def test_explicitly_bound_native_helper_cannot_skip(
    spliced_bam, tmp_path, monkeypatch, native_case, helper_failure
):
    monkeypatch.setenv("DNA_COVERAGE_PATH", str(tmp_path / "missing-helper"))
    error = native.DnaCoverageNotFoundError
    if helper_failure == "invalid":
        error = native.DnaCoverageError

        def invalid_helper():
            raise native.DnaCoverageError("VERSION_MISMATCH", "Invalid bound helper")

        monkeypatch.setattr(native, "find_dna_coverage_binary", invalid_helper)
    with pytest.raises(error):
        try:
            if native_case == "window":
                test_native_window_and_streaming_base_match_the_same_rna_dna_oracle(
                    spliced_bam, tmp_path
                )
            else:
                test_exact_contig_mean_is_persisted_and_observed_without_rebuilding(
                    spliced_bam, tmp_path, monkeypatch, True
                )
        except pytest.skip.Exception:
            pytest.fail("An explicitly bound missing or invalid helper must fail")
