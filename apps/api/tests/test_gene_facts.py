"""Exact database identity, normalization and outbound request boundary tests."""

import asyncio
from unittest.mock import AsyncMock

import httpx
import pytest

from src.external.gene_facts import GeneFactsNotFound, fetch_gene_facts, normalize_facts


def test_ncbi_facts_keep_source_and_organism():
    result = normalize_facts(
        "ncbi",
        "672",
        {
            "result": {
                "672": {
                    "uid": "672",
                    "name": "BRCA1",
                    "summary": "DNA repair",
                    "organism": {"scientificname": "Homo sapiens"},
                }
            }
        },
    )
    assert result.url == "https://www.ncbi.nlm.nih.gov/gene/672"
    assert [(f.label, f.value) for f in result.facts] == [
        ("Gene", "BRCA1"),
        ("Summary", "DNA repair"),
        ("Organism", "Homo sapiens"),
    ]


def test_ensembl_facts_and_missing_fields():
    result = normalize_facts(
        "ensembl",
        "ENSG00000139618",
        {
            "id": "ENSG00000139618",
            "object_type": "Gene",
            "biotype": "protein_coding",
            "assembly_name": "GRCh38",
        },
    )
    assert result.url == "https://www.ensembl.org/id/ENSG00000139618"
    assert len(result.facts) == 2


def test_uniprot_function_and_source():
    result = normalize_facts(
        "uniprot",
        "P38398",
        {
            "primaryAccession": "P38398",
            "comments": [
                {"commentType": "FUNCTION", "texts": [{"value": "DNA repair"}]}
            ],
        },
    )
    assert result.url == "https://www.uniprot.org/uniprotkb/P38398/entry"
    assert result.facts[0].value == "DNA repair"


@pytest.mark.parametrize(
    "database,identifier,data",
    [
        ("ncbi", "672", {"result": {"672": {"uid": "675"}}}),
        (
            "ensembl",
            "ENSG00000139618",
            {"id": "ENSG00000139618", "object_type": "Transcript"},
        ),
        ("uniprot", "P38398", {"primaryAccession": "P04637"}),
    ],
)
def test_refuses_mismatched_records(database, identifier, data):
    with pytest.raises(GeneFactsNotFound):
        normalize_facts(database, identifier, data)


@pytest.mark.parametrize(
    "database,identifier",
    [
        ("ncbi", "BRCA1"),
        ("ncbi", "1&id=2"),
        ("ensembl", "https://localhost"),
        ("uniprot", "P38398/../"),
    ],
)
def test_invalid_identifiers_never_fetch(monkeypatch, database, identifier):
    request = AsyncMock()
    monkeypatch.setattr("src.external.gene_facts.PublicHttpBoundary.open_get", request)
    with pytest.raises(ValueError):
        asyncio.run(fetch_gene_facts(database, identifier))
    request.assert_not_called()


def test_fetch_uses_public_boundary_and_closes_response(monkeypatch):
    response = httpx.Response(
        200,
        json={"primaryAccession": "P38398"},
        request=httpx.Request("GET", "https://rest.uniprot.org"),
    )
    request = AsyncMock(return_value=(response, "https://rest.uniprot.org"))
    monkeypatch.setattr("src.external.gene_facts.PublicHttpBoundary.open_get", request)
    result = asyncio.run(fetch_gene_facts("uniprot", "P38398"))
    assert result.identifier == "P38398"
    assert request.call_args.args[0] == "https://rest.uniprot.org/uniprotkb/P38398.json"
    assert response.is_closed


def test_missing_record(monkeypatch):
    response = httpx.Response(
        404, request=httpx.Request("GET", "https://rest.uniprot.org")
    )
    monkeypatch.setattr(
        "src.external.gene_facts.PublicHttpBoundary.open_get",
        AsyncMock(return_value=(response, "https://rest.uniprot.org")),
    )
    with pytest.raises(GeneFactsNotFound):
        asyncio.run(fetch_gene_facts("uniprot", "P38398"))
    assert response.is_closed
