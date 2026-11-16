""" — /tiles/coverage/readiness exposes cache truth over HTTP."""

from __future__ import annotations

from collections.abc import Callable

from tests.sidecar_test_client import AuthenticatedSidecarTestClient as TestClient


def test_coverage_readiness_route_returns_cache_status(monkeypatch):
    from src.main import app
    from src.services import coverage_pyramid

    def fake_readiness(
        bam_path: str,
        chroms: list[str],
        *,
        index_path: str | None,
        reference_fasta: str | None,
    ):
        assert bam_path == "/fixtures/HG002.bam"
        assert chroms == ["chr1", "chr11"]
        assert index_path == "/fixtures/HG002.bam.bai"
        assert reference_fasta is None
        return [
            {
                "chrom": "chr1",
                "present": True,
                "chromLength": 248_956_422,
                "baseBinBp": 3799,
                "cachePath": "/cache/chr1.npy",
                "sizeBytes": 262_272,
            },
            {
                "chrom": "chr11",
                "present": False,
                "chromLength": 135_086_622,
                "baseBinBp": 2062,
                "cachePath": "/cache/chr11.npy",
                "sizeBytes": 0,
            },
        ]

    monkeypatch.setattr(coverage_pyramid, "coverage_pyramid_readiness", fake_readiness)

    client = TestClient(app)
    resp = client.post(
        "/tiles/coverage/readiness",
        json={
            "bamPath": "/fixtures/HG002.bam",
            "indexPath": "/fixtures/HG002.bam.bai",
            "chroms": ["chr1", "chr11"],
        },
    )

    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "chroms": [
            {
                "chrom": "chr1",
                "present": True,
                "chromLength": 248_956_422,
                "baseBinBp": 3799,
                "cachePath": "/cache/chr1.npy",
                "sizeBytes": 262_272,
            },
            {
                "chrom": "chr11",
                "present": False,
                "chromLength": 135_086_622,
                "baseBinBp": 2062,
                "cachePath": "/cache/chr11.npy",
                "sizeBytes": 0,
            },
        ]
    }


def test_coverage_precompute_route_builds_resident_cache(monkeypatch, tmp_path):
    from src.main import app
    from src.services import coverage_pyramid

    bam_path = tmp_path / "HG002.bam"
    index_path = tmp_path / "HG002.bam.bai"
    bam_path.write_bytes(b"bam-placeholder")
    index_path.write_bytes(b"index-placeholder")

    def fake_precompute(
        bam_path: str,
        chroms: list[str],
        *,
        index_path: str | None,
        reference_fasta: str | None,
        force: bool,
    ):
        assert bam_path == str(tmp_path / "HG002.bam")
        assert chroms == ["chr1", "chr11"]
        assert index_path == str(tmp_path / "HG002.bam.bai")
        assert reference_fasta is None
        assert force is False
        return [
            {
                "chrom": "chr1",
                "present": True,
                "built": True,
                "chromLength": 248_956_422,
                "baseBinBp": 1900,
                "cachePath": "/cache/chr1.npy",
                "sizeBytes": 524_416,
                "maxDepth": 177.0,
                "durationMs": 1234.5,
                "provenance": {"method": "rust-htslib-base-layer", "exact": True},
            },
            {
                "chrom": "chr11",
                "present": True,
                "built": False,
                "chromLength": 135_086_622,
                "baseBinBp": 1031,
                "cachePath": "/cache/chr11.npy",
                "sizeBytes": 524_416,
                "maxDepth": 160.0,
            },
        ]

    monkeypatch.setattr(
        coverage_pyramid, "coverage_pyramid_precompute", fake_precompute
    )
    monkeypatch.setattr(
        coverage_pyramid,
        "coverage_pyramid_readiness",
        lambda _bam, chroms, **_kwargs: [
            {"chrom": chrom, "present": True} for chrom in chroms
        ],
    )

    with TestClient(app) as client:
        resp = client.post(
            "/tiles/coverage/precompute",
            json={
                "bamPath": str(bam_path),
                "indexPath": str(index_path),
                "chroms": ["chr1", "chr11"],
            },
        )

    assert resp.status_code == 200, resp.text
    assert resp.headers["X-DNAForge-Operation-Id"]
    assert resp.json() == {
        "chroms": [
            {
                "chrom": "chr1",
                "present": True,
                "built": True,
                "chromLength": 248_956_422,
                "baseBinBp": 1900,
                "sizeBytes": 524_416,
                "maxDepth": 177.0,
                "durationMs": 1234.5,
            },
            {
                "chrom": "chr11",
                "present": True,
                "built": False,
                "chromLength": 135_086_622,
                "baseBinBp": 1031,
                "sizeBytes": 524_416,
                "maxDepth": 160.0,
            },
        ]
    }


def test_coverage_assembly_tile_route_batches_all_segments(monkeypatch):
    from src.main import app
    from src.services import coverage_pyramid

    def fake_assembly_tile(
        bam_path: str,
        segments: list[dict],
        *,
        bins: int,
        bin_size_bp: int,
        index_path: str | None,
        reference_fasta: str | None,
        check_cancelled: Callable[[], None],
    ):
        assert callable(check_cancelled)
        check_cancelled()
        assert bam_path == "/fixtures/HG002.bam"
        assert index_path == "/fixtures/HG002.bam.bai"
        assert reference_fasta is None
        assert bins == 1024
        assert bin_size_bp == 2**21
        assert segments == [
            {"chrom": "chr1", "start": 0, "end": 248_956_422, "globalStart": 0},
            {
                "chrom": "chr2",
                "start": 0,
                "end": 242_193_529,
                "globalStart": 248_956_422,
            },
        ]
        return {
            "segments": [
                {
                    "chrom": "chr1",
                    "start": 0,
                    "end": 248_956_422,
                    "globalStart": 0,
                    "globalEnd": 248_956_422,
                    "bins": [1.0, 2.0],
                    "binSize": 243_122,
                    "maxDepth": 2.0,
                    "provenance": {"method": "pyramid-maxpool", "exact": True},
                },
                {
                    "chrom": "chr2",
                    "start": 0,
                    "end": 242_193_529,
                    "globalStart": 248_956_422,
                    "globalEnd": 491_149_951,
                    "bins": [3.0, 0.0],
                    "binSize": 236_518,
                    "maxDepth": 3.0,
                    "provenance": {"method": "pyramid-maxpool", "exact": True},
                },
            ],
            "maxDepth": 3.0,
            "provenance": {"method": "pyramid-maxpool", "exact": True},
        }

    monkeypatch.setattr(coverage_pyramid, "coverage_assembly_tile", fake_assembly_tile)

    client = TestClient(app)
    resp = client.post(
        "/tiles/coverage-assembly/21/0",
        json={
            "bamPath": "/fixtures/HG002.bam",
            "indexPath": "/fixtures/HG002.bam.bai",
            "segments": [
                {
                    "chrom": "chr1",
                    "start": 0,
                    "end": 248_956_422,
                    "chromGlobalStart": 0,
                },
                {
                    "chrom": "chr2",
                    "start": 0,
                    "end": 242_193_529,
                    "chromGlobalStart": 248_956_422,
                },
            ],
        },
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["level"] == 21
    assert resp.json()["tileIndex"] == 0
    assert len(resp.json()["segments"]) == 2
