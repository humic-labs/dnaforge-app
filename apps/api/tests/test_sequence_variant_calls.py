from pathlib import Path

import pytest

from src.services.variant_queries import prepare_variant_source

VCF = """##fileformat=VCFv4.2
##contig=<ID=plasmid,length=12>
##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
##FORMAT=<ID=AD,Number=R,Type=Integer,Description="Allele depths">
##FORMAT=<ID=DP,Number=1,Type=Integer,Description="Depth">
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tbefore\tafter
plasmid\t4\tmulti\tT\tC,G\t60\tPASS\t.\tGT:AD:DP\t1/2:10,2,8:20\t1/2:5,15,0:20
plasmid\t7\tmissing\tG\tA\t.\t.\t.\tGT:AD:DP\t./.:.:.\t./.:.:.
"""


def request(tmp_path: Path, monkeypatch, **changes):
    from src.sequence_variant_contract import SequenceVariantCallsRequest

    monkeypatch.setenv("DNAFORGE_VARIANT_INDEX_CACHE_DIR", str(tmp_path / "cache"))
    path = tmp_path / "calls.vcf"
    path.write_text(VCF)
    prepared = prepare_variant_source(str(path), [{"name": "plasmid", "length": 12}])
    return SequenceVariantCallsRequest.model_validate(
        {
            "source": prepared,
            "chrom": "plasmid",
            "sequence": "ACGTACGTACGT",
            "sample": "after",
            **changes,
        }
    )


def test_preserves_multiallelic_sample_depths_and_missing_counts(tmp_path, monkeypatch):
    from src.services.sequence_variant_calls import query_sequence_variant_calls

    result = query_sequence_variant_calls(request(tmp_path, monkeypatch))
    assert [
        (call.position, call.reference, call.alternate) for call in result.calls
    ] == [
        (4, "T", "C"),
        (4, "T", "G"),
        (7, "G", "A"),
    ]
    assert [
        (call.reference_count, call.alternate_count, call.total_allele_count)
        for call in result.calls
    ] == [(5, 15, 20), (5, 0, 20), (None, None, None)]
    assert result.calls[0].allele_fraction == 0.75
    assert result.calls[1].allele_fraction == 0
    assert result.calls[2].allele_fraction is None
    assert result.sample == "after"
    assert result.calls[0].filters == ["PASS"]
    assert result.calls[2].filters == []
    assert result.reference_sha256


def test_refuses_reference_mismatch_instead_of_coloring_wrong_protein(
    tmp_path, monkeypatch
):
    from src.services.sequence_variant_calls import query_sequence_variant_calls

    with pytest.raises(ValueError, match="reference.*position 4"):
        query_sequence_variant_calls(
            request(tmp_path, monkeypatch, sequence="ACGAACGTACGT")
        )


def test_refuses_unknown_sample_and_truncation(tmp_path, monkeypatch):
    from src.services.sequence_variant_calls import query_sequence_variant_calls

    with pytest.raises(ValueError, match="sample"):
        query_sequence_variant_calls(request(tmp_path, monkeypatch, sample="absent"))
    with pytest.raises(ValueError, match="limit"):
        query_sequence_variant_calls(request(tmp_path, monkeypatch, limit=1))


def test_typed_route_returns_the_same_counts_and_rejects_bad_reference(
    tmp_path, monkeypatch
):
    from fastapi.testclient import TestClient

    from src.main import app

    body = request(tmp_path, monkeypatch)
    client = TestClient(app, raise_server_exceptions=True)
    response = client.post(
        "/tiles/variants/sequence-calls",
        json=body.model_dump(mode="json", by_alias=True),
    )
    assert response.status_code == 200, response.text
    assert response.json()["calls"][0]["alternate_count"] == 15
    invalid = body.model_dump(mode="json", by_alias=True)
    invalid["sequence"] = "ACGAACGTACGT"
    response = client.post("/tiles/variants/sequence-calls", json=invalid)
    assert response.status_code == 422
    assert "position 4" in response.json()["detail"]
