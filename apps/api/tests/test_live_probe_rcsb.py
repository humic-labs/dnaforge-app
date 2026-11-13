"""Tests for the  RCSB live probe helper."""

from __future__ import annotations

import httpx
import pytest

from scripts.live_probe_rcsb import run_probe


def _entry_payload() -> dict:
    return {
        "rcsb_id": "1RBL",
        "rcsb_entry_container_identifiers": {
            "entry_id": "1RBL",
            "polymer_entity_ids": ["1"],
        },
        "struct": {"title": "Ribulose bisphosphate carboxylase"},
        "exptl": [{"method": "X-RAY DIFFRACTION"}],
        "rcsb_entry_info": {"resolution_combined": [2.2]},
        "rcsb_accession_info": {
            "deposit_date": "1991-01-15",
            "initial_release_date": "1991-04-15",
            "revision_date": "2024-06-12",
            "major_revision": 1,
            "minor_revision": 3,
        },
    }


def _polymer_entity_payload() -> dict:
    return {
        "rcsb_polymer_entity_container_identifiers": {
            "entry_id": "1RBL",
            "entity_id": "1",
            "asym_ids": ["A", "B"],
            "auth_asym_ids": ["A", "B"],
            "uniprot_ids": ["P00880"],
            "reference_sequence_identifiers": [
                {"database_name": "UniProt", "database_accession": "P00880"}
            ],
        },
        "rcsb_polymer_entity": {
            "pdbx_description": "Ribulose bisphosphate carboxylase large chain"
        },
        "entity_poly": {
            "type": "polypeptide(L)",
            "pdbx_seq_one_letter_code_can": "MKTAYIAKQRQISFVKSHFSRQ",
        },
        "rcsb_entity_source_organism": [
            {"ncbi_scientific_name": "Synechococcus elongatus"}
        ],
    }


@pytest.mark.asyncio
async def test_rcsb_live_probe_uses_fetch_response_contract(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/rest/v1/core/entry/1RBL":
            return httpx.Response(200, json=_entry_payload())
        if request.url.path == "/rest/v1/core/polymer_entity/1RBL/1":
            return httpx.Response(200, json=_polymer_entity_payload())
        return httpx.Response(404, json={"error": "unexpected URL"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

    try:
        summary = await run_probe(
            tmp_path / "rcsb-live-probe.sqlite3",
            client=client,
            raw_id="1rbl",
        )
    finally:
        await client.aclose()

    assert summary["ok"] is True
    assert summary["provider"] == "rcsb"
    assert summary["requested_id"] == "1rbl"
    assert summary["canonical_pdb_id"] == "1RBL"
    assert summary["data_file_count"] == 0
    assert summary["data_file_id"] is None
    assert summary["chain_ids"] == ["A", "B"]
    assert summary["polymer_entity_ids"] == ["1"]
    assert summary["resource_exists"] is True
    assert summary["fetch_log_count"] == 1
