from __future__ import annotations

import json

import pytest

from src.services import annotation_tiles as at
from src.services.spliced_resolver import GenomeFeature
from src.services.tile_geometry import tile_global_end, tile_global_start


def feature(
    type_: str,
    start: int,
    end: int,
    *,
    id_: str,
    parent: str | None = None,
) -> GenomeFeature:
    attributes = {"ID": [id_]}
    if parent is not None:
        attributes["Parent"] = [parent]
    return GenomeFeature(
        type=type_,
        start=start,
        end=end,
        chrom="fixture",
        attributes=attributes,
    )


@pytest.fixture()
def source(tmp_path, monkeypatch):
    gff = tmp_path / "fixture.gff3.gz"
    gff.write_bytes(b"stable source identity")
    cache = tmp_path / "pyramid"
    monkeypatch.setenv("WAYPOINT_ANNOTATION_PYRAMID_CACHE_DIR", str(cache))
    rows = [
        feature("gene", 99, 900, id_="gene-1"),
        feature("mRNA", 99, 900, id_="rna-1", parent="gene-1"),
        feature("exon", 99, 299, id_="exon-1", parent="rna-1"),
        feature("CDS", 149, 249, id_="cds-1", parent="rna-1"),
        feature("enhancer", 1_999, 2_199, id_="enhancer-1"),
        feature("repeat_region", 2_999, 3_499, id_="repeat-1"),
    ]
    monkeypatch.setattr(at, "fetch_features", lambda *_args, **_kwargs: rows)
    at.clear_annotation_tile_cache()
    return str(gff)


def test_precompute_seals_every_present_type_for_both_banks(source):
    result = at.annotation_pyramid_precompute(source, "fixture", 8_192)

    assert result["ready"] is True
    assert result["availableTypes"] == [
        "CDS",
        "enhancer",
        "exon",
        "gene",
        "mRNA",
        "repeat_region",
    ]
    assert result["artifactCount"] == len(result["availableTypes"]) * 2
    assert result["missingArtifacts"] == []
    assert result["corruptArtifacts"] == []


def test_coarse_tile_uses_verified_artifact_without_fetching_gff(source, monkeypatch):
    at.annotation_pyramid_precompute(source, "fixture", 8_192)
    monkeypatch.setattr(
        at,
        "fetch_features",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("coarse tile must not parse GFF")
        ),
    )
    level = at.BASE_LEVEL
    tile = at.annotation_tile(
        source,
        "fixture",
        tile_global_start(0, level),
        tile_global_end(0, level),
        level=level,
        tile_index=0,
        visible_types=["enhancer"],
    )

    assert tile["format"] == "raster"
    assert tile["availableTypes"] == [
        "CDS",
        "enhancer",
        "exon",
        "gene",
        "mRNA",
        "repeat_region",
    ]
    assert tile["laneCount"] == 1
    assert max(tile["exonRaster"]) > 0


def test_coarse_tile_resamples_a_shifted_assembly_window_without_parsing_gff(
    source, monkeypatch
):
    at.annotation_pyramid_precompute(source, "fixture", 8_192)
    monkeypatch.setattr(
        at,
        "fetch_features",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("shifted coarse tile must not parse GFF")
        ),
    )
    level = at.BASE_LEVEL
    shifted_start = -123
    tile = at.annotation_tile(
        source,
        "fixture",
        shifted_start,
        shifted_start + at.TILE_PX * at.bin_bp(level),
        level=level,
        tile_index=17,
        visible_types=["enhancer"],
        bank="expanded",
    )

    assert tile["format"] == "raster"
    assert len(tile["exonRaster"]) == at.TILE_PX
    assert tile["exonRaster"][0] == 0.0
    assert max(tile["exonRaster"]) > 0.0
    assert tile["markCount"] > 0


def test_readiness_reports_missing_and_corrupt_artifacts(source):
    ready = at.annotation_pyramid_precompute(source, "fixture", 8_192)
    manifest_path = at.annotation_manifest_path(source, "fixture")
    manifest = json.loads(manifest_path.read_text())
    first = manifest_path.parent / manifest["artifacts"][0]["file"]
    second = manifest_path.parent / manifest["artifacts"][1]["file"]

    first.unlink()
    second.write_bytes(b"corrupt")
    status = at.annotation_pyramid_readiness(
        source, "fixture", chrom_length=8_192, verify_hashes=True
    )

    assert ready["ready"] is True
    assert status["ready"] is False
    assert status["status"] == "corrupt"
    assert status["missingArtifacts"]
    assert status["corruptArtifacts"]


def test_partial_directory_without_commit_manifest_is_not_ready(source):
    product_dir = at.annotation_product_dir(source, "fixture")
    product_dir.mkdir(parents=True, exist_ok=True)
    (product_dir / "orphan.npz").write_bytes(b"partial")

    status = at.annotation_pyramid_readiness(source, "fixture")

    assert status["ready"] is False
    assert status["status"] == "missing"
    assert status["missingArtifacts"] == ["manifest"]
