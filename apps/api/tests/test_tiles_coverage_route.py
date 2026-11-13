""" P2 — /tiles/coverage/{level}/{tileIndex} route (async, ManagedPool).

The coverage band's tile source. Serves a (level, tileIndex) coverage tile from the
already-de-risked persisted ``coverage_pyramid``, behind the ``TILE_IO``
ManagedPool, with pysam run via ``asyncio.to_thread`` so the event loop never blocks.

STRICT TDD — RED FIRST: the route does not exist yet (404 from FastAPI / import
error), so these fail for the right reason before the route is built.

Contracts pinned here:
  - A tile returns exactly TILE_PX (1024) bins (the tile path has NO bin clamp).
  - Broad levels mean-pool the fixed-base peak samples over each exact bp span,
    keeping the vertical scale stable across LOD changes.
  - The handler is bounded (the pyramid never allocates a full-span array).
  - The tile bp span equals the shared tile-geometry math (TS<->Python no drift).

FIXTURE: real HG002 Element 80x GRCh38 BAM. Absent/unreadable => INVALID RUN
(distinct from a contract RED), so a fixture regression can't masquerade as green.
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pysam
import pytest

from src.services import tile_geometry as tg
from tests.sidecar_test_client import AuthenticatedSidecarTestClient as TestClient

FIXTURE_BAM = os.path.expanduser(
    "~/projects/wp-assets/bam-cache/HG002_Element_80x_GRCh38.bam"
)
FIXTURE_BAI = os.path.expanduser(
    "~/projects/wp-assets/bam-cache/HG002_Element_80x.bam.bai"
)


@pytest.fixture(scope="module", autouse=True)
def _isolated_pyramid_cache(tmp_path_factory):
    cache = tmp_path_factory.mktemp("annotation-cov-tile-route-cache")
    prev = os.environ.get("WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR")
    os.environ["WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR"] = str(cache)
    yield
    if prev is None:
        os.environ.pop("WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR", None)
    else:
        os.environ["WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR"] = prev


@pytest.fixture(scope="module")
def client() -> TestClient:
    from src.main import app

    return TestClient(app)


def _repo_root() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "Cargo.toml").is_file():
            return parent
    raise RuntimeError("cannot find worktree root")


def _dna_coverage_binary() -> Path | None:
    binary = _repo_root() / "target" / "release" / "dna-coverage"
    if binary.is_file() and os.access(binary, os.X_OK):
        return binary
    return None


def _make_tiny_bam(tmp_path: Path) -> Path:
    header = {
        "HD": {"VN": "1.6", "SO": "coordinate"},
        "SQ": [{"SN": "chr11", "LN": 1000}],
    }
    path = tmp_path / "route-tiny.bam"
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


@pytest.fixture(scope="module")
def chr1_len() -> int:
    import pysam

    from src.services import coverage_pyramid as cp

    if not os.path.isfile(FIXTURE_BAM):
        pytest.skip(f"wp-assets fixture not present: {FIXTURE_BAM}")
    try:
        bam = pysam.AlignmentFile(FIXTURE_BAM)
    except Exception as exc:  # noqa: BLE001
        pytest.fail(f"INVALID RUN: fixture missing -- cannot open {FIXTURE_BAM}: {exc}")
    if "chr1" not in set(bam.references):
        pytest.fail("INVALID RUN: fixture missing -- chr1 not in BAM references")
    length = int(bam.get_reference_length("chr1"))
    bam.close()

    cache_path = cp._base_layer_cache_path(FIXTURE_BAM, "chr1", FIXTURE_BAI, None)
    if cache_path is None:
        pytest.fail("INVALID RUN: could not derive route-test coverage cache path")
    base = np.arange(cp.BASE_BINS, dtype=np.float32)
    base /= np.float32(cp.BASE_BINS)
    np.save(cache_path, base, allow_pickle=False)
    return length


def _coarsest_level(length: int) -> int:
    """Smallest level whose tile 0 spans the whole chromosome."""
    level = 0
    while tg.tile_span_bp(level) < length:
        level += 1
    return level


def _expected_normalized_ramp_means(
    *, chrom_len: int, start: int, end: int, bins: int
) -> np.ndarray:
    """Closed-form means for the normalized ramp seeded in ``chr1_len``."""
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


def test_coverage_tile_returns_1024_bins(client, chr1_len):
    level = _coarsest_level(chr1_len)
    resp = client.post(
        f"/tiles/coverage/{level}/0",
        json={"bamPath": FIXTURE_BAM, "chrom": "chr1", "indexPath": FIXTURE_BAI},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["bins"]) == tg.TILE_PX
    assert body["level"] == level
    assert body["tileIndex"] == 0


def test_coverage_tile_route_uses_rust_helper_for_local_exact_tile(
    client, tmp_path, monkeypatch
):
    binary = _dna_coverage_binary()
    if binary is None:
        pytest.skip("dna-coverage binary not built")
    bam = _make_tiny_bam(tmp_path)
    monkeypatch.setenv("DNA_COVERAGE_PATH", str(binary))

    resp = client.post(
        "/tiles/coverage/0/0",
        json={
            "bamPath": str(bam),
            "chrom": "chr11",
            "indexPath": str(bam) + ".bai",
        },
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["provenance"] == {
        "method": "rust-htslib-window-peak",
        "exact": True,
    }
    assert body["start"] == 0
    assert body["end"] == 1000
    assert body["binSize"] == 1
    assert len(body["bins"]) == body["end"] - body["start"]
    assert body["maxDepth"] == 2.0
    assert body["bins"][100] == 1.0
    assert body["bins"][120] == 2.0
    assert body["bins"][300] == 1.0
    assert body["bins"][999] == 0.0


def test_coverage_tile_span_matches_shared_geometry(client, chr1_len):
    """The tile's bp [start,end) is clamped to chrom but the level/tileIndex it
    reports must round-trip the shared tile-geometry math (no TS<->Python drift)."""
    level = _coarsest_level(chr1_len)
    resp = client.post(
        f"/tiles/coverage/{level}/0",
        json={"bamPath": FIXTURE_BAM, "chrom": "chr1", "indexPath": FIXTURE_BAI},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["start"] == tg.tile_global_start(0, level)
    assert body["end"] == min(tg.tile_global_end(0, level), chr1_len)


def test_coverage_tile_mean_pools_fixed_base_peaks_across_levels(client, chr1_len):
    """Adjacent route levels use the same fixed-base mean statistic.

    The coarsest tile is chromosome-clamped while its child owns a power-of-two
    span, so their bin edges do not align 2:1. Each response is therefore checked
    against the exact source interval its own bins cover, not compared by index.
    """
    coarse_level = _coarsest_level(chr1_len)
    finer_level = coarse_level - 1
    coarse = client.post(
        f"/tiles/coverage/{coarse_level}/0",
        json={"bamPath": FIXTURE_BAM, "chrom": "chr1", "indexPath": FIXTURE_BAI},
    ).json()
    finer = client.post(
        f"/tiles/coverage/{finer_level}/0",
        json={"bamPath": FIXTURE_BAM, "chrom": "chr1", "indexPath": FIXTURE_BAI},
    ).json()
    for level_name, tile in (("coarse", coarse), ("finer", finer)):
        expected = _expected_normalized_ramp_means(
            chrom_len=chr1_len,
            start=tile["start"],
            end=tile["end"],
            bins=tg.TILE_PX,
        )
        np.testing.assert_allclose(
            tile["bins"],
            expected,
            rtol=0,
            atol=2e-7,
            err_msg=f"{level_name} route tile did not mean-pool its fixed-base samples",
        )


def test_coverage_tile_missing_index_is_404(client):
    """A request whose explicit local index does not exist must 404 (loud), not
    silently fall back and not 500. (Bug #3 family: missing index file.)"""
    resp = client.post(
        "/tiles/coverage/10/0",
        json={
            "bamPath": FIXTURE_BAM,
            "chrom": "chr1",
            "indexPath": "/nonexistent/path/does-not-exist.bai",
        },
    )
    assert resp.status_code == 404, resp.text


def test_coverage_tile_rejects_unimplemented_bigwig_path(client):
    """BigWig is not implemented by /tiles/coverage yet. The route must reject a
    stale desktop bigwigPath loudly instead of ignoring it and computing BAM
    coverage while the harness thinks BigWig was exercised."""
    resp = client.post(
        "/tiles/coverage/10/0",
        json={
            "bamPath": FIXTURE_BAM,
            "chrom": "chr1",
            "indexPath": FIXTURE_BAI,
            "bigwigPath": "/fixtures/HG002.coverage.bw",
        },
    )
    assert resp.status_code == 422, resp.text
