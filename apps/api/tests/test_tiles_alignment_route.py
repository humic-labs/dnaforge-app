""" P2 — /tiles/alignment/{level}/{tileIndex} route.

FINE LEVELS ONLY: at a fine level (binBp <= ~256) the route fetches the reads
overlapping the tile span; at a coarse level it returns EMPTY (the coverage band
carries zoomed-out depth — alignment rows are never streamed over a whole chrom).
The route returns alignment records only. Row assignment is renderer-owned; the
sidecar must not publish lane/overflow fields.

Contracts pinned here:
  - reads PRESENT for a fine tile at a known dense locus (HBB on chr11),
  - a coarse-level tile is empty + ``fine=false`` (no htslib fetch),
  - fine tile reads contain alignment identity and coordinates, not renderer row
    ownership.

FIXTURE: the real HG002 Element 80x GRCh38 BAM. Absent => INVALID RUN.
"""

from __future__ import annotations

import os

import pytest

from src.services import tile_geometry as tg
from tests.sidecar_test_client import AuthenticatedSidecarTestClient as TestClient

BAM = os.path.expanduser("~/projects/wp-assets/bam-cache/HG002_Element_80x_GRCh38.bam")
BAI = os.path.expanduser("~/projects/wp-assets/bam-cache/HG002_Element_80x.bam.bai")

HBB_BP = 5_226_000


@pytest.fixture(scope="module")
def client() -> TestClient:
    from src.main import app

    return TestClient(app)


@pytest.fixture(scope="module", autouse=True)
def _require_bam():
    if not os.path.isfile(BAM):
        pytest.skip(f"wp-assets fixture not present: {BAM}")
    import pysam

    try:
        bam = pysam.AlignmentFile(BAM)
    except Exception as exc:  # noqa: BLE001
        pytest.fail(f"INVALID RUN: fixture missing -- cannot open {BAM}: {exc}")
    if "chr11" not in set(bam.references):
        pytest.fail("INVALID RUN: fixture missing -- chr11 not in BAM references")
    bam.close()


def _fine_tile_index_for_bp(bp: int, level: int = 0) -> int:
    return tg.tile_index(bp, level)


def test_fine_tile_at_hbb_has_reads(client):
    """A FINE tile over the HBB locus returns aligned reads (80x WGS — non-empty)."""
    level = 0
    ti = _fine_tile_index_for_bp(HBB_BP, level)
    resp = client.post(
        f"/tiles/alignment/{level}/{ti}",
        json={"bamPath": BAM, "chrom": "chr11", "indexPath": BAI},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["fine"] is True
    assert body["count"] > 0, "expected reads at the HBB locus (80x WGS)"
    assert len(body["reads"]) == body["count"]
    assert "laneCount" not in body
    assert "overflowCount" not in body
    for r in body["reads"]:
        assert "lane" not in r
        assert "overflow" not in r
        assert isinstance(r["readId"], str)
        assert isinstance(r["start"], int)
        assert isinstance(r["end"], int)


def test_coarse_tile_is_empty_and_not_fine(client):
    """A COARSE level (binBp > ~256) returns empty + fine=false — no htslib fetch.
    The coverage band carries depth there; alignment rows are fine-only."""
    level = 9
    assert not tg.is_fine_level(level)
    ti = tg.tile_index(HBB_BP, level)
    resp = client.post(
        f"/tiles/alignment/{level}/{ti}",
        json={"bamPath": BAM, "chrom": "chr11", "indexPath": BAI},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["fine"] is False
    assert body["count"] == 0
    assert body["reads"] == []


def test_same_read_identity_survives_across_adjacent_fine_tiles_without_lane(client):
    """A read overlapping a seam appears in both adjacent FINE tiles by identity.
    The sidecar does not assign rows; the renderer dedupes/places records."""
    level = 0
    ti = _fine_tile_index_for_bp(HBB_BP, level)
    left = client.post(
        f"/tiles/alignment/{level}/{ti}",
        json={"bamPath": BAM, "chrom": "chr11", "indexPath": BAI},
    ).json()
    right = client.post(
        f"/tiles/alignment/{level}/{ti + 1}",
        json={"bamPath": BAM, "chrom": "chr11", "indexPath": BAI},
    ).json()
    left_ids = {(r["readId"], r["start"]) for r in left["reads"]}
    shared = 0
    for r in right["reads"]:
        key = (r["readId"], r["start"])
        if key in left_ids:
            shared += 1
            assert "lane" not in r
            assert "overflow" not in r
    assert shared > 0, "no read spanned the tile seam — cannot prove seam identity"
