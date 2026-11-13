""" SPIKE 1 — coverage peak-base pyramid is bounded-memory.

KEYSTONE RISK #1 (from docs/plans/2026-06-24-genome-engine-VALIDATED-BUILD-PLAN.md
§3.1): a COARSE coverage tile spanning all of chr1 must be computable WITHOUT the
``np.zeros(span+1)`` per-base OOM that ``coverage_region`` (pileup.py:403) commits
today. For chr1 (248,956,422 bp) the difference array is ~1 GB int32 and the
``np.cumsum`` of it is ~2 GB int64 -> measured ~3.3 GB peak RSS for a single coarse
request. That is the 3.3 GB OOM the engine was hired to kill.

This module is STRICT TDD:
  - It is RED on HEAD: ``coverage_tile`` does not exist yet (ModuleNotFoundError),
    and when wired to the existing per-base path it blows the 50 MB RSS ceiling.
  - GREEN comes from a persisted peak-base layer: compute a base per-bin PEAK
    layer ONCE per (source, chrom), persist it, and derive any coarser tile by
    mean-pooling the stored finer level. The result is bounded by the requested
    bin count, never the chromosome span, and does not acquire a level-wide
    upward bias as bins get coarser.

FIXTURE: the real HG002 Element 80x GRCh38 BAM. If it does NOT open, the test
FAILS LOUD as ``INVALID RUN: fixture missing`` -- a DISTINCT signal from the OOM RED,
so a fixture regression can never masquerade as a passing or RED gate.
"""

from __future__ import annotations

import os
import resource
import tracemalloc

import numpy as np
import pytest

TILE_BINS = 1024
RSS_CEILING_MB = 50.0

FIXTURE_BAM = os.path.expanduser(
    "~/projects/wp-assets/bam-cache/HG002_Element_80x_GRCh38.bam"
)


def _maxrss_mb() -> float:
    """Peak resident set size of THIS process, in MB.

    On macOS ``ru_maxrss`` is in bytes; on Linux it is in kibibytes. Normalize so
    the 50 MB ceiling is meaningful on either platform.
    """
    raw = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if os.uname().sysname == "Darwin":
        return raw / (1024 * 1024)
    return raw / 1024


@pytest.fixture(scope="module", autouse=True)
def _isolated_pyramid_cache(tmp_path_factory):
    """Persist the base layer to a per-run temp dir so the expensive chr1 stream
    happens ONCE across this module's tests, without touching ~/.dnaforge."""
    cache = tmp_path_factory.mktemp("cov-pyramid-cache")
    prev = os.environ.get("WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR")
    os.environ["WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR"] = str(cache)
    yield
    if prev is None:
        os.environ.pop("WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR", None)
    else:
        os.environ["WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR"] = prev


@pytest.fixture(scope="module")
def chr1_span() -> tuple[str, int]:
    """Open the real fixture BAM and return (chrom, length) for chr1.

    SKIPS when the payload is simply not on this machine (wp-assets is absent on
    every CI runner). Still FAILS LOUD as INVALID RUN when the payload IS present
    but unreadable/unindexed -- distinct from the OOM RED, so a fixture regression
    is never confused with the bug.
    """
    import pysam

    if not os.path.isfile(FIXTURE_BAM):
        pytest.skip(f"wp-assets fixture not present: {FIXTURE_BAM}")
    try:
        bam = pysam.AlignmentFile(FIXTURE_BAM)
    except Exception as exc:  # noqa: BLE001 -- surface ANY open failure as INVALID RUN
        pytest.fail(
            f"INVALID RUN: fixture missing -- could not open {FIXTURE_BAM}: {exc}"
        )
    if not bam.has_index():
        pytest.fail(f"INVALID RUN: fixture missing -- no index alongside {FIXTURE_BAM}")
    if "chr1" not in set(bam.references):
        pytest.fail(
            f"INVALID RUN: fixture missing -- chr1 not in {FIXTURE_BAM} references"
        )
    length = bam.get_reference_length("chr1")
    bam.close()
    return "chr1", int(length)


def _seed_resident_chr1_cache(chrom: str):
    from src.services import coverage_pyramid as cp

    cache_path = cp._base_layer_cache_path(FIXTURE_BAM, chrom, None, None)
    if cache_path is None:
        pytest.fail("INVALID RUN: could not derive coverage pyramid cache path")
    base = np.arange(cp.BASE_BINS, dtype=np.float32)
    base /= np.float32(cp.BASE_BINS)
    np.save(cache_path, base, allow_pickle=False)


def _expected_normalized_ramp_means(
    *, chrom_len: int, start: int, end: int, bins: int
) -> np.ndarray:
    """Closed-form means for the normalized ramp seeded above.

    This is deliberately independent of the production reducer. A max reducer
    returns the upper endpoint of each source interval and fails this oracle.
    """
    from src.services import coverage_pyramid as cp

    base_bin_bp = max(1, -(-chrom_len // cp.BASE_BINS))
    output_bin_bp = max(1, -(-(end - start) // bins))
    expected: list[float] = []
    for output_start in range(start, end, output_bin_bp):
        output_end = min(output_start + output_bin_bp, end)
        base_lo = max(0, min(cp.BASE_BINS - 1, output_start // base_bin_bp))
        base_hi = max(0, min(cp.BASE_BINS - 1, (output_end - 1) // base_bin_bp))
        expected.append((base_lo + base_hi) / (2 * cp.BASE_BINS))
    return np.asarray(expected, dtype=np.float64)


def test_coarse_chr1_tile_has_1024_bins(chr1_span):
    """(a) A coarse tile spanning ALL of chr1 returns exactly TILE_BINS bins --
    bounded by the bin count, never the span."""
    from src.services.coverage_pyramid import coverage_tile

    chrom, length = chr1_span
    _seed_resident_chr1_cache(chrom)
    tile = coverage_tile(FIXTURE_BAM, chrom, 0, length, bins=TILE_BINS)
    assert len(tile["bins"]) == TILE_BINS


def test_coarse_chr1_tile_mean_pools_fixed_base_peaks_at_each_resolution(chr1_span):
    """(b) Every broad output bin is the mean of its fixed-base peak samples.

    This pins the  scale-invariant statistic at both adjacent
    resolutions. It fails if the old max reducer returns and reintroduces the
    systematic vertical step at LOD boundaries.
    """
    from src.services.coverage_pyramid import coverage_tile

    chrom, length = chr1_span
    _seed_resident_chr1_cache(chrom)
    for bins in (TILE_BINS, TILE_BINS * 2):
        tile = coverage_tile(FIXTURE_BAM, chrom, 0, length, bins=bins)
        expected = _expected_normalized_ramp_means(
            chrom_len=length,
            start=0,
            end=length,
            bins=bins,
        )
        np.testing.assert_allclose(
            tile["bins"],
            expected,
            rtol=0,
            atol=2e-7,
            err_msg=f"{bins}-bin tile did not mean-pool its fixed-base samples",
        )


def test_coarse_chr1_tile_stays_under_rss_ceiling(chr1_span):
    """(c) The handler's PEAK allocation stays under RSS_CEILING_MB while computing
    a coarse whole-chr1 tile.

    THIS is the keystone gate. ``coverage_region``'s ``np.zeros(span+1)`` +
    ``np.cumsum`` materialize ~3.7 GB for chr1, blowing this ceiling by ~74x.
    GREEN requires the persisted pyramid path that never allocates a full-span
    array.

    Meter: ``tracemalloc`` peak -- it measures PYTHON/numpy allocation with ZERO
    import/first-touch contamination. This test covers the interactive resident
    path; cold precompute is intentionally not hidden in a tile request.
    """
    from src.services.coverage_pyramid import coverage_tile

    chrom, length = chr1_span
    _seed_resident_chr1_cache(chrom)

    tracemalloc.start()
    tile = coverage_tile(FIXTURE_BAM, chrom, 0, length, bins=TILE_BINS)
    _cur, traced_peak_bytes = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    traced_peak_mb = traced_peak_bytes / (1024 * 1024)

    assert len(tile["bins"]) == TILE_BINS
    assert traced_peak_mb < RSS_CEILING_MB, (
        f"coarse whole-chr1 coverage tile traced {traced_peak_mb:.1f} MB peak "
        f"python alloc (ceiling {RSS_CEILING_MB} MB) -- the np.zeros(span+1) OOM "
        f"is not killed"
    )
