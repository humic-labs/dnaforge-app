"""Exact/vector annotation_tile() result cache.

Coarse requests are served only from the sealed raster pyramid and never fetch
GFF rows. This cache now protects repeated fine/exact requests.
"""

from __future__ import annotations

import os

import pytest

from src.services import annotation_tiles as at
from tests.reference_assets import prepared_member

_GRCH38_CHR11_GFF = prepared_member("grch38", "chr11", ".gff3.gz")
GFF_CHR11 = str(_GRCH38_CHR11_GFF) if _GRCH38_CHR11_GFF else ""

HBB_START = 5_225_464
HBB_END = 5_227_071
EXACT_LEVEL = 8


@pytest.fixture(scope="module", autouse=True)
def _require_gff():
    if not (GFF_CHR11 and os.path.isfile(GFF_CHR11)):
        pytest.skip("prepared GRCh38 reference not present on this machine")


@pytest.fixture(autouse=True)
def _clear_cache():
    at.clear_annotation_tile_cache()
    yield
    at.clear_annotation_tile_cache()


def test_second_call_with_identical_inputs_does_not_refetch(monkeypatch):
    calls = {"n": 0}
    real_fetch_features = at.fetch_features

    def counting_fetch_features(*args, **kwargs):
        calls["n"] += 1
        return real_fetch_features(*args, **kwargs)

    monkeypatch.setattr(at, "fetch_features", counting_fetch_features)

    first = at.annotation_tile(
        GFF_CHR11,
        "chr11",
        HBB_START - 10_000,
        HBB_END + 10_000,
        level=EXACT_LEVEL,
        tile_index=0,
    )
    second = at.annotation_tile(
        GFF_CHR11,
        "chr11",
        HBB_START - 10_000,
        HBB_END + 10_000,
        level=EXACT_LEVEL,
        tile_index=0,
    )

    assert calls["n"] == 1
    assert second == first


def test_different_visible_types_are_cached_independently(monkeypatch):
    calls = {"n": 0}
    real_fetch_features = at.fetch_features

    def counting_fetch_features(*args, **kwargs):
        calls["n"] += 1
        return real_fetch_features(*args, **kwargs)

    monkeypatch.setattr(at, "fetch_features", counting_fetch_features)

    at.annotation_tile(
        GFF_CHR11,
        "chr11",
        HBB_START - 10_000,
        HBB_END + 10_000,
        level=EXACT_LEVEL,
        tile_index=0,
        visible_types=["mRNA"],
    )
    at.annotation_tile(
        GFF_CHR11,
        "chr11",
        HBB_START - 10_000,
        HBB_END + 10_000,
        level=EXACT_LEVEL,
        tile_index=0,
        visible_types=["gene"],
    )

    assert calls["n"] == 2


def test_visible_types_order_does_not_bust_the_cache(monkeypatch):
    calls = {"n": 0}
    real_fetch_features = at.fetch_features

    def counting_fetch_features(*args, **kwargs):
        calls["n"] += 1
        return real_fetch_features(*args, **kwargs)

    monkeypatch.setattr(at, "fetch_features", counting_fetch_features)

    at.annotation_tile(
        GFF_CHR11,
        "chr11",
        HBB_START - 10_000,
        HBB_END + 10_000,
        level=EXACT_LEVEL,
        tile_index=0,
        visible_types=["mRNA", "gene"],
    )
    at.annotation_tile(
        GFF_CHR11,
        "chr11",
        HBB_START - 10_000,
        HBB_END + 10_000,
        level=EXACT_LEVEL,
        tile_index=0,
        visible_types=["gene", "mRNA"],
    )

    assert calls["n"] == 1


def test_clear_annotation_tile_cache_forces_a_refetch(monkeypatch):
    calls = {"n": 0}
    real_fetch_features = at.fetch_features

    def counting_fetch_features(*args, **kwargs):
        calls["n"] += 1
        return real_fetch_features(*args, **kwargs)

    monkeypatch.setattr(at, "fetch_features", counting_fetch_features)

    at.annotation_tile(
        GFF_CHR11,
        "chr11",
        HBB_START - 10_000,
        HBB_END + 10_000,
        level=EXACT_LEVEL,
        tile_index=0,
    )
    at.clear_annotation_tile_cache()
    at.annotation_tile(
        GFF_CHR11,
        "chr11",
        HBB_START - 10_000,
        HBB_END + 10_000,
        level=EXACT_LEVEL,
        tile_index=0,
    )

    assert calls["n"] == 2


def test_missing_gff_source_raises_the_documented_not_found_error_not_a_raw_os_error():
    """Regression: the cache key is computed (via os.stat on gffPath)
    BEFORE fetch_features ever runs, so a missing source used to raise a
    raw FileNotFoundError instead of AnnotationSourceNotFoundError -- the
    route only catches the latter (see tiles.py), so the miss surfaced as
    an unhandled 500 instead of the documented 404 contract
    (test_tiles_error_contract.py::test_missing_gff_tabix_source_is_404)."""
    with pytest.raises(at.AnnotationSourceNotFoundError):
        at.annotation_tile(
            "/nonexistent/chr11.gff3.gz",
            "chr11",
            HBB_START,
            HBB_END,
            level=EXACT_LEVEL,
            tile_index=0,
        )
