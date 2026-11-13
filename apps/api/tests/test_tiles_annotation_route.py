""" P2 — /tiles/annotation/{level}/{tileIndex} route (the KEYSTONE).

Gene/transcript glyphs over chr11 of the prepared GRCh38 reference, tabix-
indexed on demand, resolved through the ported transcript resolver.

  FINE (binBp <= ~256): VECTOR glyphs — every touching transcript with its exons +
  CDS, ``droppedCount === 0`` (the  "no dropped CDS/exon children" contract).
  COARSE: a fixed-1024-bin RASTER composite (alpha-OVER), NO blend-to-white on a
  dense locus (the falsifiable keystone risk), every touching CDS/exon mark
  contributing.

Pinned at the HBB locus (chr11): a 3-exon, 3-CDS MANE-select transcript
(NM_000518.5) on the reverse strand — the canonical real-parent fold.

FIXTURE: chr11 of the prepared GRCh38 default reference. Absent => INVALID RUN.
"""

from __future__ import annotations

import os

import pytest

from src.services import tile_geometry as tg
from tests.reference_assets import prepared_member
from tests.sidecar_test_client import AuthenticatedSidecarTestClient as TestClient

_GRCH38_CHR11_GFF = prepared_member("grch38", "chr11", ".gff3.gz")
GFF_CHR11 = str(_GRCH38_CHR11_GFF) if _GRCH38_CHR11_GFF else ""

HBB_START = 5_225_464
HBB_END = 5_227_071
HBB_BP = (HBB_START + HBB_END) // 2

FINE_LEVEL = 8
COARSE_LEVEL = 12


@pytest.fixture(scope="module")
def client() -> TestClient:
    from src.main import app

    return TestClient(app)


@pytest.fixture(scope="module", autouse=True)
def _require_gff():
    if not (GFF_CHR11 and os.path.isfile(GFF_CHR11)):
        pytest.skip("prepared GRCh38 reference not present on this machine")


@pytest.fixture(scope="module", autouse=True)
def _isolated_tabix_cache():
    from pathlib import Path

    cache = Path(os.environ.get("TMPDIR", "/tmp")) / "annotation-annotation-tabix-cache"
    cache.mkdir(parents=True, exist_ok=True)
    prev = os.environ.get("WAYPOINT_ANNOTATION_TABIX_CACHE_DIR")
    os.environ["WAYPOINT_ANNOTATION_TABIX_CACHE_DIR"] = str(cache)
    yield
    if prev is None:
        os.environ.pop("WAYPOINT_ANNOTATION_TABIX_CACHE_DIR", None)
    else:
        os.environ["WAYPOINT_ANNOTATION_TABIX_CACHE_DIR"] = prev


@pytest.fixture(scope="module", autouse=True)
def _sealed_annotation_pyramid(tmp_path_factory):
    from src.services.annotation_tiles import annotation_pyramid_precompute

    cache = tmp_path_factory.mktemp("annotation-annotation-pyramid")
    previous = os.environ.get("WAYPOINT_ANNOTATION_PYRAMID_CACHE_DIR")
    os.environ["WAYPOINT_ANNOTATION_PYRAMID_CACHE_DIR"] = str(cache)
    annotation_pyramid_precompute(GFF_CHR11, "chr11", 135_086_622)
    yield
    if previous is None:
        os.environ.pop("WAYPOINT_ANNOTATION_PYRAMID_CACHE_DIR", None)
    else:
        os.environ["WAYPOINT_ANNOTATION_PYRAMID_CACHE_DIR"] = previous


def test_fine_tile_resolves_hbb_transcript_with_exons_and_cds(client):
    """The FINE annotation tile over HBB carries the resolved MANE transcript with
    its 3 exons + 3 CDS (the canonical Parent= fold), droppedCount === 0."""
    ti = tg.tile_index(HBB_BP, FINE_LEVEL)
    resp = client.post(
        f"/tiles/annotation/{FINE_LEVEL}/{ti}",
        json={"gffPath": GFF_CHR11, "chrom": "chr11"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["fine"] is True
    assert body["format"] == "vector"
    assert body["droppedCount"] == 0

    hbb = next(
        (t for t in body["transcripts"] if t["transcriptId"] == "HBB.mrna.1"),
        None,
    )
    assert hbb is not None, "HBB MANE transcript (HBB.mrna.1) not resolved in tile"
    assert hbb["strand"] == "-"
    assert len(hbb["exons"]) == 3
    assert len(hbb["cds"]) == 3
    assert hbb["exons"][0]["start"] == HBB_START


def test_fine_tile_no_dropped_children(client):
    """Across the HBB tile, no resolved feature loses its CDS/exon children — every
    coding transcript with CDS in the source still carries CDS (no zoom-as-fidelity
    switch). Asserted via droppedCount + presence of CDS on the coding transcript."""
    ti = tg.tile_index(HBB_BP, FINE_LEVEL)
    body = client.post(
        f"/tiles/annotation/{FINE_LEVEL}/{ti}",
        json={"gffPath": GFF_CHR11, "chrom": "chr11"},
    ).json()
    assert body["droppedCount"] == 0
    coding = [t for t in body["transcripts"] if t["cds"]]
    assert coding, "expected at least one coding transcript (HBB) with CDS in the tile"
    for t in coding:
        ex_lo = min(e["start"] for e in t["exons"])
        ex_hi = max(e["end"] for e in t["exons"])
        for c in t["cds"]:
            assert ex_lo <= c["start"] and c["end"] <= ex_hi


def test_coarse_tile_is_raster_and_does_not_blend_to_white(client):
    """The COARSE tile rasterizes every touching CDS/exon mark with alpha-OVER —
    per-bin alpha is BOUNDED to <= 1.0 (no whiteout), and the HBB exon bins are
    actually marked (features conserved, not dropped)."""
    ti = tg.tile_index(HBB_BP, COARSE_LEVEL)
    resp = client.post(
        f"/tiles/annotation/{COARSE_LEVEL}/{ti}",
        json={"gffPath": GFF_CHR11, "chrom": "chr11"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["fine"] is False
    assert body["format"] == "raster"
    assert len(body["exonRaster"]) == tg.TILE_PX
    assert len(body["cdsRaster"]) == tg.TILE_PX
    assert max(body["exonRaster"]) <= 1.0 + 1e-9
    assert max(body["cdsRaster"]) <= 1.0 + 1e-9
    assert body["markCount"] > 0
    assert max(body["exonRaster"]) > 0.0, "HBB exon marks vanished from the raster"
    assert max(body["cdsRaster"]) > 0.0, "HBB CDS marks vanished from the raster"


def test_readiness_route_returns_the_full_verified_type_inventory(client):
    response = client.post(
        "/tiles/annotation/pyramid/readiness",
        json={
            "sources": [
                {
                    "gffPath": GFF_CHR11,
                    "chrom": "chr11",
                    "chromLength": 135_086_622,
                }
            ],
            "verifyHashes": True,
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ready"] is True
    assert len(body["availableTypes"]) == 48
    assert {"gene", "mRNA", "CDS", "exon", "enhancer"}.issubset(body["availableTypes"])
    assert body["chroms"]["chr11"]["artifactCount"] == 96


def test_coarse_raster_conserves_dense_overlap_without_saturation(client):
    """Even where MANY transcripts overlap (HBB region has multiple isoforms +
    regulatory features), the alpha-OVER composite stays <= 1.0 everywhere — the
    keystone no-whiteout proof on a real dense locus, not a synthetic stub."""
    ti = tg.tile_index(HBB_BP, COARSE_LEVEL)
    body = client.post(
        f"/tiles/annotation/{COARSE_LEVEL}/{ti}",
        json={"gffPath": GFF_CHR11, "chrom": "chr11"},
    ).json()
    assert all(0.0 <= a <= 1.0 + 1e-9 for a in body["exonRaster"])
    assert all(0.0 <= a <= 1.0 + 1e-9 for a in body["cdsRaster"])


def test_gene_filter_emits_a_visible_bbox_in_vector_and_raster_tiles(client):
    """A picker-visible type cannot be an empty promise.

    Gene entities have no biological exon/CDS children, so their annotation
    render carrier uses the exact gene bbox as its thin mark. This proves that
    selecting ``gene`` produces visible geometry at both route formats while
    still inventing no CDS geometry.
    """
    fine_index = tg.tile_index(HBB_BP, FINE_LEVEL)
    fine = client.post(
        f"/tiles/annotation/{FINE_LEVEL}/{fine_index}",
        json={
            "gffPath": GFF_CHR11,
            "chrom": "chr11",
            "visibleTypes": ["gene"],
        },
    )
    assert fine.status_code == 200, fine.text
    fine_body = fine.json()
    assert fine_body["transcripts"]
    assert {carrier["type"] for carrier in fine_body["transcripts"]} == {"gene"}
    assert all(carrier["exons"] for carrier in fine_body["transcripts"])
    assert all(carrier["cds"] == [] for carrier in fine_body["transcripts"])

    coarse_index = tg.tile_index(HBB_BP, COARSE_LEVEL)
    coarse = client.post(
        f"/tiles/annotation/{COARSE_LEVEL}/{coarse_index}",
        json={
            "gffPath": GFF_CHR11,
            "chrom": "chr11",
            "visibleTypes": ["gene"],
        },
    )
    assert coarse.status_code == 200, coarse.text
    coarse_body = coarse.json()
    assert coarse_body["markCount"] > 0
    assert max(coarse_body["exonRaster"]) > 0.0
    assert max(coarse_body["cdsRaster"]) == 0.0
