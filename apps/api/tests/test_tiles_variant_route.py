from __future__ import annotations

from pathlib import Path

import pytest

from tests.sidecar_test_client import AuthenticatedSidecarTestClient as TestClient

VCF_TEXT = """##fileformat=VCFv4.2
##contig=<ID=chr1,length=248956422>
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO
chr1\t104312461\treal-shape\tT\tA\t60\tPASS\t.
"""


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> TestClient:
    monkeypatch.setenv("DNAFORGE_HUMAN_OPERATION_TOKEN", "human-operation-secret")
    monkeypatch.setenv("DNAFORGE_OPERATION_SCOPE", f"variant-route-{tmp_path.name}")
    from src.main import app

    with TestClient(
        app,
        headers={"X-DNAForge-Operation-Authority": "human-operation-secret"},
    ) as managed_client:
        yield managed_client


def test_prepare_then_page_crosses_the_real_route_and_filesystem(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "HG002.GRCh38.vcf"
    source.write_text(VCF_TEXT, encoding="utf-8")
    monkeypatch.setenv("DNAFORGE_VARIANT_INDEX_CACHE_DIR", str(tmp_path / "cache"))

    prepared = client.post(
        "/tiles/variants/prepare",
        json={
            "variantPath": str(source),
            "references": [{"name": "chr1", "length": 248_956_422}],
        },
    )
    assert prepared.status_code == 200, prepared.text
    operation_id = prepared.headers["X-DNAForge-Operation-Id"]
    assert operation_id

    jobs = client.get("/operations")
    assert jobs.status_code == 200, jobs.text
    assert operation_id in {operation["id"] for operation in jobs.json()["operations"]}

    page = client.post(
        "/tiles/variants/page",
        json={
            "queryPath": prepared.json()["queryPath"],
            "indexPath": prepared.json()["indexPath"],
            "references": ["chr1"],
            "sourceGeneration": prepared.json()["sourceGeneration"],
            "queryGeneration": prepared.json()["queryGeneration"],
            "indexGeneration": prepared.json()["indexGeneration"],
            "assemblyRevision": prepared.json()["assemblyRevision"],
            "limit": 100,
        },
    )
    assert page.status_code == 200, page.text
    assert page.json()["variants"] == [
        {
            "id": page.json()["variants"][0]["id"],
            "recordId": "real-shape",
            "chrom": "chr1",
            "start": 104_312_460,
            "end": 104_312_461,
            "position": 104_312_461,
            "ref": "T",
            "alts": ["A"],
            "quality": 60.0,
            "filters": ["PASS"],
            "variantClass": "substitution",
            "genotypes": {},
        }
    ]
    assert page.json()["nextCursor"] is None

    region = client.post(
        "/tiles/variants/region",
        json={
            "queryPath": prepared.json()["queryPath"],
            "indexPath": prepared.json()["indexPath"],
            "sourceGeneration": prepared.json()["sourceGeneration"],
            "queryGeneration": prepared.json()["queryGeneration"],
            "indexGeneration": prepared.json()["indexGeneration"],
            "assemblyRevision": prepared.json()["assemblyRevision"],
            "chrom": "chr1",
            "start": 104_312_400,
            "end": 104_312_500,
            "limit": 10_000,
        },
    )
    assert region.status_code == 200, region.text
    assert [row["recordId"] for row in region.json()["variants"]] == ["real-shape"]
    assert region.json()["truncated"] is False


def test_prepare_surfaces_reference_mismatch_as_conflict(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "HG002.GRCh38.vcf"
    source.write_text(VCF_TEXT, encoding="utf-8")
    monkeypatch.setenv("DNAFORGE_VARIANT_INDEX_CACHE_DIR", str(tmp_path / "cache"))

    response = client.post(
        "/tiles/variants/prepare",
        json={
            "variantPath": str(source),
            "references": [{"name": "1", "length": 248_956_422}],
        },
    )
    assert response.status_code == 409
    assert response.headers["X-DNAForge-Operation-Id"]
    assert response.json()["detail"]["code"] == "VARIANT_SOURCE_ASSEMBLY_MISMATCH"
    assert "exact chromosome" in response.json()["detail"]["message"]
