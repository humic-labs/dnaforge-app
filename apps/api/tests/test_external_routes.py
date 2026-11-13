""" / L2 — FastAPI TestClient integration for /external/* routes.

Spins up the real FastAPI app in-process with a MockTransport-backed
ExternalResourcesService and verifies the request → service → DAO →
response round-trip. Covers what the unit + service tests cannot:

  - Pydantic request/response validation
  - HTTP status code mapping (404 / 403 / 400 / 502 / 503)
  - JSON serialization of the persisted row
  - Capability denial returning 403 (vs 5xx for other errors)
"""

from __future__ import annotations

import hashlib
import json
import math
import struct
import time
import zlib
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.control_plane.store import ControlPlaneStore
from src.external.alphafold_poster import (
    _extract_backbone_points,
    render_alphafold_cartoon_plddt_png,
)
from src.external.contract import (
    FetchOptions,
    ProviderHttpError,
    ProviderRateLimitError,
)
from src.external.providers import RCSBProvider, UniProtProvider
from src.external.service import CircuitOpen, ExternalResourcesService
from src.routes import external as external_routes
from src.routes.external import router as external_router

from .conftest import anonymous_client


def _p00875_payload() -> dict:
    return {
        "primaryAccession": "P00875",
        "entryType": "UniProtKB reviewed (Swiss-Prot)",
        "organism": {"scientificName": "Synechococcus elongatus", "taxonId": 269084},
        "sequence": {"length": 472},
        "genes": [{"geneName": {"value": "rbcL"}}],
        "proteinDescription": {
            "recommendedName": {
                "fullName": {"value": "Ribulose bisphosphate carboxylase large chain"},
                "ecNumbers": [{"value": "4.1.1.39"}],
            }
        },
        "entryAudit": {"entryVersion": 178},
        "uniProtKBCrossReferences": [
            {"database": "PDB", "id": "1RBL", "properties": []},
        ],
    }


TEST_MCP_TOKEN = "test-mcp-session"
LEGACY_STRUCTURE_BYTE_CAP = 25 * 1024 * 1024
YOEB_RIBOSOME_4V8X_MMCIF_BYTES = 26_216_783


@pytest.fixture(autouse=True)
def _reset_external_service(monkeypatch):
    """Per testing-specialist: tests rely on a module-global singleton; an
    autouse teardown removes the order-dependence that try/finally blocks
    inside each test would otherwise leave open. Also injects the
    DNAFORGE_MCP_SESSION_TOKEN env so route-level check_session() succeeds
    on the standard test path; tests covering the missing/bad-token case
    explicitly delete the env or override the header."""
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_MCP_TOKEN)
    yield
    external_routes.set_service(None)  # type: ignore[arg-type]


def _build_app(
    tmp_path, handler
) -> tuple[TestClient, ExternalResourcesService, ControlPlaneStore]:
    """Build a minimal FastAPI app mounted with just the /external/* router,
    backed by a MockTransport-driven service. Avoids spinning up the full
    apps/api lifespan (annotation downloads, agent tools registry, etc.) so
    the L2 tests stay fast and hermetic.

    The returned TestClient sends `X-DNAForge-Session: TEST_MCP_TOKEN` on
    every request; `_build_app_no_session` returns a client without the
    default header for auth-failure tests.

    Returns (client, service, store) so tests can read directly from the
    store without poking `service._store`.
    """
    store = ControlPlaneStore(tmp_path / "routes.sqlite3")
    store.initialize()
    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport)
    service = ExternalResourcesService(store, client=client)
    service.register(UniProtProvider(client=client))
    service.register(RCSBProvider(client=client))
    external_routes.set_service(service)

    app = FastAPI()
    app.include_router(external_router)

    return (
        TestClient(app, headers={"X-DNAForge-Session": TEST_MCP_TOKEN}),
        service,
        store,
    )


def _build_app_no_session(
    tmp_path, handler
) -> tuple[TestClient, ExternalResourcesService, ControlPlaneStore]:
    """Same as `_build_app` but the TestClient does NOT include a default
    session header. Used by auth-failure tests.

    : `conftest` gives every TestClient a default session header so the
    ~110 route tests keep modelling a normally launched sidecar. A test whose
    whole subject is "no credential presented" has to opt out explicitly, which
    is what `anonymous_client` is for."""
    store = ControlPlaneStore(tmp_path / "routes_noauth.sqlite3")
    store.initialize()
    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport)
    service = ExternalResourcesService(store, client=client)
    service.register(UniProtProvider(client=client))
    service.register(RCSBProvider(client=client))
    external_routes.set_service(service)

    app = FastAPI()
    app.include_router(external_router)
    return anonymous_client(app), service, store


def _ok_handler(request):
    return httpx.Response(status_code=200, json=_p00875_payload())


def _valid_mmcif_body(pdb_id: str, *, byte_count: int | None = None) -> bytes:
    body = f"data_{pdb_id}\n_atom_site.id 1\n".encode()
    if byte_count is None:
        return body
    if byte_count < len(body):
        raise ValueError("byte_count must fit the minimal valid mmCIF fixture")
    return body + (b"#" * (byte_count - len(body)))


def _rcsb_entry_payload() -> dict[str, Any]:
    return {
        "rcsb_id": "1RBL",
        "rcsb_entry_container_identifiers": {
            "entry_id": "1RBL",
            "polymer_entity_ids": ["1"],
            "assembly_ids": ["1"],
        },
        "struct": {"title": "Ribulose bisphosphate carboxylase large chain"},
        "exptl": [{"method": "X-RAY DIFFRACTION"}],
        "rcsb_entry_info": {"resolution_combined": [2.2]},
        "rcsb_accession_info": {
            "revision_date": "2024-06-12",
            "major_revision": 1,
            "minor_revision": 3,
        },
    }


def _rcsb_polymer_entity_payload() -> dict[str, Any]:
    return {
        "rcsb_polymer_entity_container_identifiers": {
            "entry_id": "1RBL",
            "entity_id": "1",
            "asym_ids": ["A", "B"],
            "auth_asym_ids": ["A", "B"],
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


def _rcsb_assembly_payload(
    asym_ids: list[str] | None = None,
    *,
    pdb_id: str = "1RBL",
    assembly_id: str = "1",
) -> dict[str, Any]:
    return {
        "rcsb_assembly_container_identifiers": {
            "entry_id": pdb_id,
            "assembly_id": assembly_id,
        },
        "pdbx_struct_assembly_gen": [
            {"assembly_id": assembly_id, "asym_id_list": asym_ids or ["A", "B"]}
        ],
    }


def _structure_handler(request):
    if request.url.path.startswith("/rest/v1/core/entry/"):
        return httpx.Response(200, json=_rcsb_entry_payload())
    if request.url.path.startswith("/rest/v1/core/polymer_entity/"):
        return httpx.Response(200, json=_rcsb_polymer_entity_payload())
    if request.url.path.startswith("/rest/v1/core/assembly/"):
        return httpx.Response(200, json=_rcsb_assembly_payload())
    if request.url.path == "/download/1RBL.cif":
        return httpx.Response(
            200,
            text="data_1RBL\n_atom_site.id 1\n",
            headers={"Content-Type": "chemical/x-mmcif", "ETag": 'W/"1rbl-cif"'},
        )
    if request.url.path == "/images/structures/1rbl_assembly-1.jpeg":
        return httpx.Response(
            200,
            content=b"\xff\xd8\xffposter",
            headers={"Content-Type": "image/jpeg", "ETag": 'W/"1rbl-poster"'},
        )
    if request.url.path == "/files/AF-A0A0H3JZA8-F1-predicted_aligned_error_v6.png":
        return httpx.Response(
            200,
            content=b"\x89PNG\r\n\x1a\nposter",
            headers={
                "Content-Type": "application/octet-stream",
                "ETag": 'W/"af-poster"',
            },
        )
    if request.url.path == "/api/prediction/A0A0H3JZA8":
        return httpx.Response(
            200,
            json=[
                {
                    "uniprotAccession": "A0A0H3JZA8",
                    "globalMetricValue": 31.47,
                    "latestVersion": 6,
                    "cifUrl": "https://alphafold.ebi.ac.uk/files/AF-A0A0H3JZA8-F1-model_v6.cif",
                }
            ],
        )
    if request.url.path == "/files/AF-A0A0H3JZA8-F1-model_v6.cif":
        return httpx.Response(
            200,
            text="data_AF-A0A0H3JZA8-F1\n_atom_site.id 1\n",
            headers={
                "Content-Type": "chemical/x-mmcif",
                "ETag": 'W/"af-a0a0h3jza8"',
            },
        )
    if request.url.path.startswith("/files/AF-A0A0H3JZA8-F1-model_"):
        return httpx.Response(404, text="wrong alphafold model version")
    return _ok_handler(request)


def test_post_fetch_annotation_only_returns_full_response_without_xrefs(tmp_path):
    client, service, store = _build_app(tmp_path, _ok_handler)
    response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "workspace_id": "ws-1",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "uniprot"
    assert body["external_id"] == "P00875"
    assert body["cache_hit"] is False
    assert body["license"] == "CC-BY-4.0"
    assert "UniProt Consortium" in body["attribution"]
    assert body["xref_count"] == 0
    assert body["binding_id"] is None
    assert all(not k.startswith("_") for k in body["metadata"].keys())
    resource = store.get_external_resource_by_external_id("uniprot", "P00875")
    assert resource is not None
    xrefs = store.list_external_resource_xrefs(from_resource_id=resource["id"])
    assert xrefs == []


def test_post_fetch_with_xref_scope_persists_inline_provider_xrefs(tmp_path):
    client, service, store = _build_app(tmp_path, _ok_handler)
    response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "workspace_id": "ws-1",
            "granted_capabilities": [
                "external-fetch:annotation",
                "external-fetch:xref-resolution",
            ],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["xref_count"] == 1
    resource = store.get_external_resource_by_external_id("uniprot", "P00875")
    assert resource is not None
    xrefs = store.list_external_resource_xrefs(from_resource_id=resource["id"])
    assert len(xrefs) == 1
    target = store.get_external_resource(xrefs[0]["to_resource_id"])
    assert target is not None
    assert target["provider"] == "rcsb"
    assert target["external_id"] == "RCSB:1RBL:ENTRY"


def test_post_fetch_cannot_self_upgrade_xref_scope_past_session_grant(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "external-fetch:annotation")
    client, service, store = _build_app(tmp_path, _ok_handler)
    response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "workspace_id": "ws-1",
            "granted_capabilities": [
                "external-fetch:annotation",
                "external-fetch:xref-resolution",
            ],
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["xref_count"] == 0
    resource = store.get_external_resource_by_external_id("uniprot", "P00875")
    assert resource is not None
    assert store.list_external_resource_xrefs(from_resource_id=resource["id"]) == []


def test_rcsb_validate_returns_metadata_without_persisting_resource(tmp_path):
    client, service, store = _build_app(tmp_path, _structure_handler)

    response = client.post(
        "/external/rcsb/validate",
        json={
            "pdb_id": "1rbl",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is True
    assert body["pdb_id"] == "1RBL"
    assert body["metadata"]["title"].startswith("Ribulose bisphosphate")
    assert body["metadata"]["resolution"] == 2.2
    assert body["metadata"]["chain_ids"] == ["A", "B"]
    assert body["license"] == "CC0-1.0"
    assert store.get_external_resource_by_external_id("rcsb", "1RBL") is None
    logs = store.list_external_fetch_log(provider="rcsb")
    assert len(logs) == 1
    assert logs[0]["endpoint"].endswith("/rest/v1/core/entry/1RBL")


def test_rcsb_sequence_search_route_returns_polymer_entity_hits(tmp_path):
    seen: dict[str, Any] = {}

    def handler(request):
        if request.url.path == "/rcsbsearch/v2/query":
            seen["body"] = json.loads(request.content.decode("utf-8"))
            return httpx.Response(
                200,
                json={
                    "result_set": [
                        {
                            "identifier": "4GXY_1",
                            "score": 81.25,
                            "services": [
                                {
                                    "nodes": [
                                        {
                                            "match_context": [
                                                {
                                                    "sequence_identity": 0.96,
                                                    "evalue": 3.4e-12,
                                                    "bitscore": 120.0,
                                                }
                                            ]
                                        }
                                    ]
                                }
                            ],
                        }
                    ]
                },
            )
        raise AssertionError(f"unexpected RCSB request: {request.url}")

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/rcsb/sequence-search",
        json={
            "sequence": "AUGCUAGCUAGCUAGCUAGCUAGCUAGCUA",
            "sequence_type": "rna",
            "identity_cutoff": 0.95,
            "evalue_cutoff": 0.001,
            "size": 5,
            "granted_capabilities": ["external-fetch:homology-search"],
        },
    )

    assert response.status_code == 200, response.text
    assert seen["body"]["query"]["parameters"]["sequence_type"] == "rna"
    assert seen["body"]["return_type"] == "polymer_entity"
    assert seen["body"]["request_options"]["paginate"] == {"start": 0, "rows": 5}
    assert response.json() == {
        "hits": [
            {
                "identifier": "4GXY_1",
                "pdb_id": "4GXY",
                "entity_id": "1",
                "score": 81.25,
                "sequence_identity": 0.96,
                "evalue": 3.4e-12,
                "bit_score": 120.0,
            }
        ]
    }
    assert store.get_external_resource_by_external_id("rcsb", "4GXY_1") is None


def test_rcsb_sequence_search_route_rejects_annotation_only_grant_before_network(
    tmp_path,
):
    calls: list[str] = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(200, json={"result_set": []})

    client, _service, _store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/rcsb/sequence-search",
        json={
            "sequence": "AUGCUAGCUAGCUAGCUAGCUAGCUAGCUA",
            "sequence_type": "rna",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"] == {
        "error": "capability_denied",
        "required": ["external-fetch:homology-search"],
        "granted": ["external-fetch:annotation"],
    }
    assert calls == []


def test_rcsb_validate_entry_404_returns_valid_false(tmp_path):
    def handler(request):
        if request.url.path.startswith("/rest/v1/core/entry/"):
            return httpx.Response(404, json={"error": "not found"})
        raise AssertionError(
            f"entry miss must stop before subresource fetch: {request.url}"
        )

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/rcsb/validate",
        json={
            "pdb_id": "9zzz",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 200
    assert response.json()["valid"] is False


def test_rcsb_validate_polymer_404_returns_provider_error(tmp_path):
    def handler(request):
        if request.url.path.startswith("/rest/v1/core/entry/"):
            return httpx.Response(200, json=_rcsb_entry_payload())
        if request.url.path.startswith("/rest/v1/core/polymer_entity/"):
            return httpx.Response(404, json={"error": "missing polymer entity"})
        raise AssertionError(f"unexpected RCSB request: {request.url}")

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/rcsb/validate",
        json={
            "pdb_id": "1rbl",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "provider_error"
    assert response.json()["detail"]["failure_kind"] == "provider_contract_error"
    assert response.json()["detail"]["status_code"] == 502


def test_uniprot_summary_returns_metadata_without_persisting_resource(tmp_path):
    client, service, store = _build_app(tmp_path, _ok_handler)

    response = client.post(
        "/external/uniprot/summary",
        json={
            "accession": "P00875",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is True
    assert body["accession"] == "P00875"
    assert body["metadata"]["name"] == "Ribulose bisphosphate carboxylase large chain"
    assert body["metadata"]["organism"] == "Synechococcus elongatus"
    assert body["license"] == "CC-BY-4.0"
    assert store.get_external_resource_by_external_id("uniprot", "P00875") is None
    assert len(store.list_external_fetch_log(provider="uniprot")) == 1


def test_alphafold_summary_returns_versioned_provider_identity(tmp_path):
    client, service, store = _build_app(tmp_path, _structure_handler)

    response = client.post(
        "/external/alphafold/summary",
        json={
            "accession": "A0A0H3JZA8",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is True
    assert body["accession"] == "A0A0H3JZA8"
    assert body["latest_version"] == 6
    assert (
        body["provider_identity_key"]
        == "AF:A0A0H3JZA8:F1:V6:MODEL:AF-A0A0H3JZA8-F1-model_v6"
    )
    assert body["model_id"] == "AF-A0A0H3JZA8-F1-model_v6"
    assert body["cif_url"].endswith("/AF-A0A0H3JZA8-F1-model_v6.cif")


def test_alphafold_summary_infers_version_from_cif_url_when_latest_version_absent(
    tmp_path,
):
    def handler(request):
        if request.url.path == "/api/prediction/A0A0H3JZA8":
            return httpx.Response(
                200,
                json=[
                    {
                        "uniprotAccession": "A0A0H3JZA8",
                        "globalMetricValue": 31.47,
                        "cifUrl": "https://alphafold.ebi.ac.uk/files/AF-A0A0H3JZA8-F1-model_v6.cif",
                    }
                ],
            )
        return httpx.Response(500, text="unexpected")

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/alphafold/summary",
        json={
            "accession": "A0A0H3JZA8",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["latest_version"] == 6
    assert (
        body["provider_identity_key"]
        == "AF:A0A0H3JZA8:F1:V6:MODEL:AF-A0A0H3JZA8-F1-model_v6"
    )


def test_alphafold_summary_rejects_conflicting_latest_version_and_cif_url(tmp_path):
    def handler(request):
        if request.url.path == "/api/prediction/A0A0H3JZA8":
            return httpx.Response(
                200,
                json=[
                    {
                        "uniprotAccession": "A0A0H3JZA8",
                        "globalMetricValue": 31.47,
                        "latestVersion": 7,
                        "cifUrl": "https://alphafold.ebi.ac.uk/files/AF-A0A0H3JZA8-F1-model_v6.cif",
                    }
                ],
            )
        return httpx.Response(500, text="unexpected")

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/alphafold/summary",
        json={
            "accession": "A0A0H3JZA8",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "provider_error"
    assert response.json()["detail"]["failure_kind"] == "provider_contract_error"


def test_structure_bytes_fetches_rcsb_mmcif_with_structure_capability(tmp_path):
    client, service, store = _build_app(tmp_path, _structure_handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:1RBL:ENTRY",
            "pdb_id": "1RBL",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 200
    assert response.text == "data_1RBL\n_atom_site.id 1\n"
    assert response.headers["X-External-Provider"] == "rcsb"
    assert response.headers["X-External-Id"] == "RCSB:1RBL:ENTRY"
    assert response.headers["X-Served-External-Id"] == "RCSB:1RBL:ENTRY"
    assert response.headers["X-Structure-Format"] == "mmcif"
    assert response.headers["X-License"] == "CC0-1.0"
    assert len(store.list_external_fetch_log(provider="rcsb")) == 1


def test_structure_poster_fetches_rcsb_jpeg_with_structure_capability(tmp_path):
    client, service, store = _build_app(tmp_path, _structure_handler)

    response = client.get("/external/structure/poster/rcsb/1RBL/assembly-1")

    assert response.status_code == 200
    assert response.content == b"\xff\xd8\xffposter"
    assert response.headers["Content-Type"] == "image/jpeg"
    assert response.headers["X-External-Provider"] == "rcsb"
    assert response.headers["X-External-Id"] == "RCSB:1RBL:POSTER:assembly-1"
    assert response.headers["X-Source-Url"] == (
        "https://cdn.rcsb.org/images/structures/1rbl_assembly-1.jpeg"
    )


def test_structure_poster_provider_miss_is_optional_no_content(tmp_path):
    def handler(request):
        if request.url.path == "/images/structures/7nbu_assembly-1.jpeg":
            return httpx.Response(404, text="not found")
        raise AssertionError(f"unexpected request: {request.url}")

    client, service, store = _build_app(tmp_path, handler)

    response = client.get("/external/structure/poster/rcsb/7NBU/assembly-1")

    assert response.status_code == 204
    assert response.content == b""


def _alphafold_cartoon_poster_handler(request):
    if request.url.path == "/api/prediction/A0A0H3JZA8":
        return httpx.Response(
            200,
            json=[
                {
                    "uniprotAccession": "A0A0H3JZA8",
                    "globalMetricValue": 31.47,
                    "latestVersion": 6,
                    "cifUrl": "https://alphafold.ebi.ac.uk/files/AF-A0A0H3JZA8-F1-model_v6.cif",
                }
            ],
        )
    if request.url.path == "/files/AF-A0A0H3JZA8-F1-model_v6.cif":
        return httpx.Response(
            200,
            text=_alphafold_cartoon_fixture_mmcif(),
            headers={
                "Content-Type": "chemical/x-mmcif",
                "ETag": 'W/"af-cartoon-cif"',
            },
        )
    if request.url.path == "/files/AF-A0A0H3JZA8-F1-predicted_aligned_error_v6.png":
        raise AssertionError(
            "AlphaFold posters must render from model CIF, not PAE PNG"
        )
    raise AssertionError(f"unexpected request: {request.url}")


def _alphafold_cartoon_fixture_mmcif() -> str:
    return """data_AF-A0A0H3JZA8-F1
#
loop_
_struct_conf.beg_auth_asym_id
_struct_conf.beg_auth_comp_id
_struct_conf.beg_auth_seq_id
_struct_conf.beg_label_asym_id
_struct_conf.beg_label_comp_id
_struct_conf.beg_label_seq_id
_struct_conf.conf_type_id
_struct_conf.end_auth_asym_id
_struct_conf.end_auth_comp_id
_struct_conf.end_auth_seq_id
_struct_conf.end_label_asym_id
_struct_conf.end_label_comp_id
_struct_conf.end_label_seq_id
_struct_conf.id
_struct_conf.pdbx_beg_PDB_ins_code
_struct_conf.pdbx_end_PDB_ins_code
A ALA 5  A ALA 5  HELX_RH_AL_P A ALA 28 A ALA 28 HELX_RH_AL_P1 ? ?
A ALA 36 A ALA 36 STRN         A ALA 55 A ALA 55 STRN1         ? ?
A ALA 66 A ALA 66 HELX_RH_AL_P A ALA 78 A ALA 78 HELX_RH_AL_P2 ? ?
#
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_alt_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_entity_id
_atom_site.label_seq_id
_atom_site.pdbx_PDB_ins_code
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.occupancy
_atom_site.B_iso_or_equiv
_atom_site.pdbx_formal_charge
_atom_site.auth_seq_id
_atom_site.auth_comp_id
_atom_site.auth_asym_id
_atom_site.auth_atom_id
_atom_site.pdbx_PDB_model_num
ATOM 1 C CA . GLY A 1 1 ? 0.0 0.0 0.0 1.00 95.0 ? 1 GLY A CA 1
ATOM 2 C CA . ALA A 1 2 ? 4.0 3.0 0.5 1.00 88.0 ? 2 ALA A CA 1
ATOM 3 C CA . SER A 1 3 ? 8.0 0.5 1.0 1.00 72.0 ? 3 SER A CA 1
ATOM 4 C CA . THR A 1 4 ? 12.0 4.0 1.5 1.00 58.0 ? 4 THR A CA 1
ATOM 5 C CA . LYS A 1 5 ? 16.0 1.0 2.0 1.00 36.0 ? 5 LYS A CA 1
#
"""


def _alphafold_rich_cartoon_fixture_mmcif() -> str:
    rows: list[str] = []
    for index in range(90):
        angle = index * 0.45
        confidence = (
            95.0 if index < 25 else 82.0 if index < 50 else 65.0 if index < 70 else 40.0
        )
        rows.append(
            "ATOM {atom_id} C CA . ALA A 1 {seq_id} ? {x:.3f} {y:.3f} {z:.3f} "
            "1.00 {confidence:.1f} ? {seq_id} ALA A CA 1".format(
                atom_id=index + 1,
                seq_id=index + 1,
                x=math.cos(angle) * 8.0 + index * 0.08,
                y=math.sin(angle) * 8.0,
                z=index * 1.2,
                confidence=confidence,
            )
        )
    return """data_AF-A0A0H3JZA8-F1
#
loop_
_struct_conf.beg_auth_asym_id
_struct_conf.beg_auth_comp_id
_struct_conf.beg_auth_seq_id
_struct_conf.beg_label_asym_id
_struct_conf.beg_label_comp_id
_struct_conf.beg_label_seq_id
_struct_conf.conf_type_id
_struct_conf.end_auth_asym_id
_struct_conf.end_auth_comp_id
_struct_conf.end_auth_seq_id
_struct_conf.end_label_asym_id
_struct_conf.end_label_comp_id
_struct_conf.end_label_seq_id
_struct_conf.id
_struct_conf.pdbx_beg_PDB_ins_code
_struct_conf.pdbx_end_PDB_ins_code
A ALA 5  A ALA 5  HELX_RH_AL_P A ALA 28 A ALA 28 HELX_RH_AL_P1 ? ?
A ALA 36 A ALA 36 STRN         A ALA 55 A ALA 55 STRN1         ? ?
A ALA 66 A ALA 66 HELX_RH_AL_P A ALA 78 A ALA 78 HELX_RH_AL_P2 ? ?
#
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_alt_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_entity_id
_atom_site.label_seq_id
_atom_site.pdbx_PDB_ins_code
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.occupancy
_atom_site.B_iso_or_equiv
_atom_site.pdbx_formal_charge
_atom_site.auth_seq_id
_atom_site.auth_comp_id
_atom_site.auth_asym_id
_atom_site.auth_atom_id
_atom_site.pdbx_PDB_model_num
{rows}
#
""".format(rows="\n".join(rows))


def _png_rgba_pixels(content: bytes) -> set[tuple[int, int, int, int]]:
    assert content.startswith(b"\x89PNG\r\n\x1a\n")
    offset = 8
    width = 0
    height = 0
    idat = bytearray()
    while offset < len(content):
        length = struct.unpack(">I", content[offset : offset + 4])[0]
        chunk_type = content[offset + 4 : offset + 8]
        chunk_data = content[offset + 8 : offset + 8 + length]
        offset += 12 + length
        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, _compression, _filter, interlace = (
                struct.unpack(">IIBBBBB", chunk_data)
            )
            assert bit_depth == 8
            assert color_type == 6
            assert interlace == 0
        elif chunk_type == b"IDAT":
            idat.extend(chunk_data)
        elif chunk_type == b"IEND":
            break
    raw = zlib.decompress(bytes(idat))
    stride = width * 4
    pixels: set[tuple[int, int, int, int]] = set()
    cursor = 0
    previous = bytearray(stride)
    for _row in range(height):
        filter_type = raw[cursor]
        cursor += 1
        row = bytearray(raw[cursor : cursor + stride])
        cursor += stride
        if filter_type == 0:
            pass
        elif filter_type == 1:
            for i in range(stride):
                left = row[i - 4] if i >= 4 else 0
                row[i] = (row[i] + left) & 0xFF
        elif filter_type == 2:
            for i in range(stride):
                row[i] = (row[i] + previous[i]) & 0xFF
        else:
            raise AssertionError(
                f"unsupported PNG filter in test helper: {filter_type}"
            )
        previous = row
        for index in range(0, stride, 4):
            pixel = tuple(row[index : index + 4])
            if pixel[3] > 0:
                pixels.add(pixel)  # type: ignore[arg-type]
    return pixels


def _png_rgba_summary(content: bytes) -> dict[str, int]:
    assert content.startswith(b"\x89PNG\r\n\x1a\n")
    offset = 8
    width = 0
    height = 0
    idat = bytearray()
    while offset < len(content):
        length = struct.unpack(">I", content[offset : offset + 4])[0]
        chunk_type = content[offset + 4 : offset + 8]
        chunk_data = content[offset + 8 : offset + 8 + length]
        offset += 12 + length
        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, _compression, _filter, interlace = (
                struct.unpack(">IIBBBBB", chunk_data)
            )
            assert bit_depth == 8
            assert color_type == 6
            assert interlace == 0
        elif chunk_type == b"IDAT":
            idat.extend(chunk_data)
        elif chunk_type == b"IEND":
            break
    raw = zlib.decompress(bytes(idat))
    stride = width * 4
    cursor = 0
    previous = bytearray(stride)
    unique: set[tuple[int, int, int, int]] = set()
    nontransparent = 0
    partial_alpha = 0
    for _row in range(height):
        filter_type = raw[cursor]
        cursor += 1
        row = bytearray(raw[cursor : cursor + stride])
        cursor += stride
        if filter_type == 0:
            pass
        elif filter_type == 1:
            for i in range(stride):
                left = row[i - 4] if i >= 4 else 0
                row[i] = (row[i] + left) & 0xFF
        elif filter_type == 2:
            for i in range(stride):
                row[i] = (row[i] + previous[i]) & 0xFF
        else:
            raise AssertionError(
                f"unsupported PNG filter in test helper: {filter_type}"
            )
        previous = row
        for index in range(0, stride, 4):
            pixel = tuple(row[index : index + 4])
            alpha = pixel[3]
            if alpha <= 0:
                continue
            nontransparent += 1
            if alpha < 255:
                partial_alpha += 1
            unique.add(pixel)  # type: ignore[arg-type]
    return {
        "width": width,
        "height": height,
        "unique_colors": len(unique),
        "nontransparent_pixels": nontransparent,
        "partial_alpha_pixels": partial_alpha,
    }


def test_alphafold_cartoon_poster_renderer_has_bounded_cpu_work_and_cartoon_geometry(
    record_property,
):
    points = _extract_backbone_points(_alphafold_rich_cartoon_fixture_mmcif())
    assert points[4].secondary == "helix"
    assert points[35].secondary == "sheet"
    assert points[59].secondary == "coil"

    started = time.perf_counter()
    cpu_started = time.process_time()
    content = render_alphafold_cartoon_plddt_png(
        _alphafold_rich_cartoon_fixture_mmcif()
    )
    elapsed_ms = (time.perf_counter() - started) * 1000
    cpu_ms = (time.process_time() - cpu_started) * 1000
    record_property("render_wall_ms", elapsed_ms)
    record_property("render_cpu_ms", cpu_ms)

    summary = _png_rgba_summary(content)
    assert (
        hashlib.sha256(content).hexdigest()
        == "bff6ff84bfea6fb861b871877f9ed4960d6ab7a176707689e6032a5fd927d01f"
    )

    assert (
        cpu_ms < 2500
    ), f"Render CPU work: {cpu_ms:.1f}ms; elapsed: {elapsed_ms:.1f}ms"
    assert summary["width"] == 640
    assert summary["height"] == 420
    assert summary["nontransparent_pixels"] > 9000
    assert summary["partial_alpha_pixels"] > 200
    assert summary["unique_colors"] > 80


def test_structure_poster_renders_alphafold_cartoon_plddt_png_with_structure_capability(
    tmp_path, monkeypatch
):
    monkeypatch.setenv(
        "WAYPOINT_STRUCTURE_POSTER_CACHE_DIR", str(tmp_path / "poster-cache")
    )
    client, service, store = _build_app(tmp_path, _alphafold_cartoon_poster_handler)

    response = client.get("/external/structure/poster/alphafold/A0A0H3JZA8/F1/v6")

    assert response.status_code == 200
    assert response.content.startswith(b"\x89PNG\r\n\x1a\n")
    assert (
        hashlib.sha256(response.content).hexdigest()
        == "2048281e8cced6325e3d97020a3b0cd89afdc409a0de3c8098274f8c827b17b1"
    )
    assert response.headers["Content-Type"] == "image/png"
    assert response.headers["X-External-Provider"] == "alphafold"
    assert (
        response.headers["X-External-Id"] == "AF:A0A0H3JZA8:F1:V6:POSTER:CARTOON_PLDDT"
    )
    assert response.headers["X-Poster-Style"] == "cartoon-plddt"
    assert response.headers["X-Poster-Render-Version"] == "cartoon-plddt-v3"
    assert response.headers["X-Poster-Cache-Hit"] == "false"
    assert response.headers["X-Source-Url"] == (
        "https://alphafold.ebi.ac.uk/files/AF-A0A0H3JZA8-F1-model_v6.cif"
    )
    pixels = _png_rgba_pixels(response.content)
    summary = _png_rgba_summary(response.content)
    assert summary["nontransparent_pixels"] > 400
    assert summary["partial_alpha_pixels"] > 20
    assert summary["unique_colors"] > 40
    assert any(
        red < 40 and green > 40 and blue > 120 for red, green, blue, alpha in pixels
    )
    assert any(
        red > 60 and green > 120 and blue > 140 for red, green, blue, alpha in pixels
    )
    assert any(
        red > 140 and green > 110 and blue < 90 for red, green, blue, alpha in pixels
    )
    assert any(
        red > 140 and 40 < green < 130 and blue < 90
        for red, green, blue, alpha in pixels
    )


def test_structure_poster_caches_alphafold_cartoon_prediction_image(
    tmp_path, monkeypatch
):
    monkeypatch.setenv(
        "WAYPOINT_STRUCTURE_POSTER_CACHE_DIR", str(tmp_path / "poster-cache")
    )
    request_counts = {"cif": 0}

    def handler(request):
        if request.url.path == "/api/prediction/A0A0H3JZA8":
            return _alphafold_cartoon_poster_handler(request)
        if request.url.path == "/files/AF-A0A0H3JZA8-F1-model_v6.cif":
            request_counts["cif"] += 1
            return _alphafold_cartoon_poster_handler(request)
        return _alphafold_cartoon_poster_handler(request)

    client, service, store = _build_app(tmp_path, handler)

    response = client.get("/external/structure/poster/alphafold/A0A0H3JZA8/F1/latest")
    cached_response = client.get(
        "/external/structure/poster/alphafold/A0A0H3JZA8/F1/latest"
    )

    assert response.status_code == 200
    assert cached_response.status_code == 200
    assert response.content == cached_response.content
    assert request_counts["cif"] == 1
    assert response.headers["X-Poster-Cache-Hit"] == "false"
    assert cached_response.headers["X-Poster-Cache-Hit"] == "true"
    assert response.headers["X-Poster-Render-Version"] == "cartoon-plddt-v3"
    assert cached_response.headers["X-Poster-Render-Version"] == "cartoon-plddt-v3"
    assert (
        response.headers["X-External-Id"] == "AF:A0A0H3JZA8:F1:V6:POSTER:CARTOON_PLDDT"
    )
    assert response.headers["X-Source-Url"] == (
        "https://alphafold.ebi.ac.uk/files/AF-A0A0H3JZA8-F1-model_v6.cif"
    )


def test_structure_bytes_cannot_self_upgrade_past_session_grant(tmp_path, monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "external-fetch:annotation")

    def handler(request):
        raise AssertionError(
            f"structure-byte route must reject before upstream: {request.url}"
        )

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:1RBL:ENTRY",
            "pdb_id": "1RBL",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"]["error"] == "capability_denied"
    assert len(store.list_external_fetch_log(provider="rcsb")) == 1


def test_structure_bytes_allows_configured_renderer_structure_grant(
    tmp_path, monkeypatch
):
    monkeypatch.setenv(
        "DNAFORGE_MCP_GRANT_CAPABILITIES",
        "external-fetch:annotation,external-fetch:xref-resolution,external-fetch:structure",
    )
    client, service, store = _build_app(tmp_path, _structure_handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:1RBL:ENTRY",
            "pdb_id": "1RBL",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 200
    assert response.text == "data_1RBL\n_atom_site.id 1\n"
    assert len(store.list_external_fetch_log(provider="rcsb")) == 1


def test_structure_bytes_preserves_scoped_rcsb_identity(tmp_path):
    client, service, store = _build_app(tmp_path, _structure_handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:1RBL:ENTRY:ASSEMBLY:1:ENTITY:1:LABEL_ASYM:A,B",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 200, response.json()
    assert response.text == "data_1RBL\n_atom_site.id 1\n"
    assert (
        response.headers["X-External-Id"]
        == "RCSB:1RBL:ENTRY:ASSEMBLY:1:ENTITY:1:LABEL_ASYM:A,B"
    )
    assert response.headers["X-Served-External-Id"] == "RCSB:1RBL:ENTRY"
    logs = store.list_external_fetch_log(provider="rcsb")
    assert len(logs) == 1
    assert logs[0]["endpoint"].endswith("/download/1RBL.cif")


def test_scoped_rcsb_structure_byte_5xx_opens_breaker_despite_scope_preflight(tmp_path):
    paths: list[str] = []

    def handler(request):
        paths.append(request.url.path)
        if request.url.path.startswith("/rest/v1/core/entry/"):
            return httpx.Response(200, json=_rcsb_entry_payload())
        if request.url.path.startswith("/rest/v1/core/polymer_entity/"):
            return httpx.Response(200, json=_rcsb_polymer_entity_payload())
        if request.url.path == "/download/1RBL.cif":
            return httpx.Response(503, text="upstream unavailable")
        raise AssertionError(f"unexpected request: {request.url}")

    client, service, store = _build_app(tmp_path, handler)
    breaker = service._breaker_for("rcsb")
    breaker.failure_threshold = 2

    for _ in range(breaker.failure_threshold):
        response = client.post(
            "/external/structure/bytes",
            json={
                "provider": "rcsb",
                "external_id": "RCSB:1RBL:ENTRY:ENTITY:1",
                "format": "mmcif",
                "granted_capabilities": ["external-fetch:structure"],
            },
        )
        assert response.status_code == 502
        assert response.json()["detail"]["error"] == "provider_error"

    open_response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:1RBL:ENTRY:ENTITY:1",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )
    assert open_response.status_code == 503
    assert open_response.json()["detail"]["error"] == "circuit_open"
    assert paths.count("/download/1RBL.cif") >= breaker.failure_threshold


def test_rcsb_polymer_entity_404_is_provider_contract_error_and_counts_breaker(
    tmp_path,
):
    def handler(request):
        if request.url.path.startswith("/rest/v1/core/entry/"):
            return httpx.Response(200, json=_rcsb_entry_payload())
        if request.url.path.startswith("/rest/v1/core/polymer_entity/"):
            return httpx.Response(404, json={"error": "not found"})
        raise AssertionError(f"unexpected request: {request.url}")

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:1RBL:ENTRY:ENTITY:1",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "provider_error"
    assert response.json()["detail"]["failure_kind"] == "provider_contract_error"
    assert service._breaker_for("rcsb").consecutive_failures == 1
    logs = store.list_external_fetch_log(provider="rcsb")
    assert logs[-1]["status_code"] == 502
    assert logs[-1]["failure_kind"] == "provider_contract_error"


def test_structure_bytes_rcsb_assembly_404_is_502_contract_not_404_not_found(tmp_path):
    def handler(request):
        if request.url.path.startswith("/rest/v1/core/entry/"):
            return httpx.Response(200, json=_rcsb_entry_payload())
        if request.url.path.startswith("/rest/v1/core/polymer_entity/"):
            return httpx.Response(200, json=_rcsb_polymer_entity_payload())
        if request.url.path.startswith("/rest/v1/core/assembly/"):
            return httpx.Response(404, json={"error": "not found"})
        raise AssertionError(f"unexpected request: {request.url}")

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:1RBL:ENTRY:ASSEMBLY:1",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "provider_error"
    assert response.json()["detail"]["failure_kind"] == "provider_contract_error"


def test_structure_bytes_canonicalizes_rcsb_chain_scope_order(tmp_path):
    client, service, store = _build_app(tmp_path, _structure_handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:1RBL:ENTRY:LABEL_ASYM:B,A",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 200, response.json()
    assert response.headers["X-External-Id"] == "RCSB:1RBL:ENTRY:LABEL_ASYM:A,B"


def test_structure_bytes_accepts_legacy_chain_entity_rcsb_identity(tmp_path):
    client, service, store = _build_app(tmp_path, _structure_handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "1RBL/A#1",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 200, response.json()
    assert response.headers["X-External-Id"] == "RCSB:1RBL:ENTRY:ENTITY:1:AUTH_ASYM:A"


def test_rcsb_scoped_identity_preserves_case_sensitive_auth_asym_ids(tmp_path):
    def handler(request):
        if request.url.path.startswith("/rest/v1/core/entry/"):
            return httpx.Response(200, json=_rcsb_entry_payload())
        if request.url.path.startswith("/rest/v1/core/polymer_entity/"):
            payload = _rcsb_polymer_entity_payload()
            payload["rcsb_polymer_entity_container_identifiers"]["asym_ids"] = [
                "A",
                "B",
            ]
            payload["rcsb_polymer_entity_container_identifiers"]["auth_asym_ids"] = [
                "a",
                "A",
            ]
            return httpx.Response(200, json=payload)
        if request.url.path == "/download/1RBL.cif":
            return httpx.Response(
                200,
                text="data_1RBL\n_atom_site.id 1\n",
                headers={"Content-Type": "chemical/x-mmcif"},
            )
        raise AssertionError(f"unexpected request: {request.url}")

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:1RBL:ENTRY:AUTH_ASYM:a",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 200, response.json()
    assert response.headers["X-External-Id"] == "RCSB:1RBL:ENTRY:AUTH_ASYM:a"


def test_structure_bytes_rejects_duplicate_rcsb_scope_keys(tmp_path):
    client, service, store = _build_app(tmp_path, _structure_handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:1RBL:ENTRY:ENTITY:1:ENTITY:2",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"]["error"] == "invalid_request"


@pytest.mark.parametrize(
    "external_id",
    [
        "1RBL/,",
        "1RBL/A,A",
        "RCSB:1RBL:ENTRY:AUTH_ASYM:A,",
        "RCSB:1RBL:ENTRY:AUTH_ASYM:,A",
        "RCSB:1RBL:ENTRY:AUTH_ASYM:A,,B",
        "RCSB:1RBL:ENTRY:AUTH_ASYM:A,A",
        "RCSB:1RBL:ENTRY:ASSEMBLY:",
    ],
)
def test_structure_bytes_rejects_malformed_rcsb_scope_tokens_before_network(
    tmp_path, external_id
):
    calls: list[str] = []

    def handler(request):
        calls.append(request.url.path)
        return _structure_handler(request)

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": external_id,
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"]["error"] == "invalid_request"
    assert calls == []


def test_structure_bytes_logs_invalid_identity_before_network(tmp_path):
    def handler(request):
        raise AssertionError(f"invalid identity must not call upstream: {request.url}")

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "alphafold",
            "external_id": "AF:A0A0H3JZA8:F1:V0",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 422
    logs = store.list_external_fetch_log(provider="alphafold")
    assert len(logs) == 1
    assert logs[0]["endpoint"] == "alphafold:AF:A0A0H3JZA8:F1:V0"
    assert logs[0]["status_code"] == 422
    assert logs[0]["failure_kind"] == "http_error"


def test_structure_bytes_logs_circuit_open_without_network(tmp_path):
    def handler(request):
        raise AssertionError(f"open circuit must not call upstream: {request.url}")

    client, service, store = _build_app(tmp_path, handler)
    breaker = service._breaker_for("rcsb")
    for _ in range(breaker.failure_threshold):
        permit = breaker.try_acquire()
        assert permit is not None
        breaker.record_failure(permit)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:1RBL:ENTRY",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 503
    logs = store.list_external_fetch_log(provider="rcsb")
    assert len(logs) == 1
    assert logs[0]["failure_kind"] == "circuit_open"


@pytest.mark.parametrize(
    "payload",
    [
        {"external_id": "RCSB:1RBL:ENTRY", "pdb_id": "2ABC"},
        {"external_id": "RCSB:1RBL:ENTRY:ENTITY:1", "pdb_entity_id": "2"},
        {"external_id": "RCSB:1RBL:ENTRY:LABEL_ASYM:A", "label_asym_ids": ["Z"]},
        {"external_id": "RCSB:1RBL:ENTRY:AUTH_ASYM:A", "auth_asym_ids": ["Z"]},
        {"external_id": "RCSB:1RBL:ENTRY:ASSEMBLY:1", "assembly_id": "2"},
        {"external_id": "RCSB:1RBL:ENTRY:ENTITY:999"},
        {"external_id": "RCSB:1RBL:ENTRY:LABEL_ASYM:Z"},
        {"external_id": "RCSB:1RBL:ENTRY:AUTH_ASYM:Z"},
        {"external_id": "RCSB:1RBL:ENTRY:ASSEMBLY:2"},
        {"external_id": "1RBL/Z#999"},
    ],
)
def test_structure_bytes_rejects_rcsb_scope_mismatch_without_byte_fetch(
    tmp_path, payload
):
    calls: list[str] = []

    def handler(request):
        calls.append(request.url.path)
        return _structure_handler(request)

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
            **payload,
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"]["error"] == "invalid_request"
    assert "/download/1RBL.cif" not in calls


def test_structure_bytes_rejects_mismatched_rcsb_label_auth_pair(tmp_path):
    calls: list[str] = []

    def handler(request):
        calls.append(request.url.path)
        if request.url.path.startswith("/rest/v1/core/polymer_entity/"):
            payload = _rcsb_polymer_entity_payload()
            payload["rcsb_polymer_entity_container_identifiers"]["asym_ids"] = [
                "A",
                "B",
            ]
            payload["rcsb_polymer_entity_container_identifiers"]["auth_asym_ids"] = [
                "1",
                "2",
            ]
            return httpx.Response(200, json=payload)
        return _structure_handler(request)

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:1RBL:ENTRY:LABEL_ASYM:A:AUTH_ASYM:2",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"]["error"] == "invalid_request"
    assert "/download/1RBL.cif" not in calls


def test_structure_bytes_rejects_rcsb_chain_absent_from_requested_assembly(tmp_path):
    calls: list[str] = []

    def handler(request):
        calls.append(request.url.path)
        if request.url.path.startswith("/rest/v1/core/assembly/"):
            return httpx.Response(200, json=_rcsb_assembly_payload(["B"]))
        return _structure_handler(request)

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:1RBL:ENTRY:ASSEMBLY:1:LABEL_ASYM:A",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"]["error"] == "invalid_request"
    assert "/rest/v1/core/assembly/1RBL/1" in calls
    assert "/download/1RBL.cif" not in calls


def test_structure_bytes_allows_yoeb_ribosome_scale_rcsb_mmcif_from_content_length(
    tmp_path,
):
    def handler(request):
        if request.url.path == "/download/4V8X.cif":
            content = _valid_mmcif_body(
                "4V8X", byte_count=YOEB_RIBOSOME_4V8X_MMCIF_BYTES
            )
            return httpx.Response(
                200,
                content=content,
                headers={
                    "Content-Type": "chemical/x-mmcif",
                    "Content-Length": str(len(content)),
                },
            )
        return _structure_handler(request)

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:4V8X:ENTRY",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 200, response.text[:500]
    assert len(response.content) == YOEB_RIBOSOME_4V8X_MMCIF_BYTES
    assert response.content.startswith(b"data_4V8X\n_atom_site.id 1\n")
    assert response.headers["X-External-Id"] == "RCSB:4V8X:ENTRY"
    logs = store.list_external_fetch_log(provider="rcsb")
    assert len(logs) == 1
    assert logs[0]["failure_kind"] is None
    assert logs[0]["status_code"] == 200
    assert logs[0]["bytes_received"] == YOEB_RIBOSOME_4V8X_MMCIF_BYTES
    breaker = service._breaker_for("rcsb")
    assert breaker.consecutive_failures == 0
    assert breaker.opened_at_monotonic is None


def test_structure_bytes_allows_legacy_cap_crossing_stream_without_content_length(
    tmp_path,
):
    def handler(request):
        if request.url.path == "/download/4V8X.cif":
            return httpx.Response(
                200,
                stream=httpx.ByteStream(
                    _valid_mmcif_body("4V8X", byte_count=LEGACY_STRUCTURE_BYTE_CAP + 1)
                ),
                headers={"Content-Type": "chemical/x-mmcif"},
            )
        return _structure_handler(request)

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:4V8X:ENTRY",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 200, response.text[:500]
    assert len(response.content) == LEGACY_STRUCTURE_BYTE_CAP + 1
    assert response.content.startswith(b"data_4V8X\n_atom_site.id 1\n")
    logs = store.list_external_fetch_log(provider="rcsb")
    assert logs[0]["failure_kind"] is None
    assert logs[0]["status_code"] == 200
    assert logs[0]["bytes_received"] == LEGACY_STRUCTURE_BYTE_CAP + 1
    breaker = service._breaker_for("rcsb")
    assert breaker.consecutive_failures == 0
    assert breaker.opened_at_monotonic is None


def test_structure_bytes_rejects_empty_200_body_as_provider_contract_error(tmp_path):
    def handler(request):
        if request.url.path == "/download/1RBL.cif":
            return httpx.Response(
                200,
                content=b"",
                headers={"Content-Type": "chemical/x-mmcif"},
            )
        return _structure_handler(request)

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:1RBL:ENTRY",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "provider_error"
    assert response.json()["detail"]["failure_kind"] == "provider_contract_error"
    assert response.json()["detail"]["status_code"] == 200
    logs = store.list_external_fetch_log(provider="rcsb")
    assert logs[0]["failure_kind"] == "provider_contract_error"


def test_structure_bytes_rejects_html_200_body_as_provider_contract_error(tmp_path):
    def handler(request):
        if request.url.path == "/download/1RBL.cif":
            return httpx.Response(
                200,
                text="<!doctype html><html><title>Not a structure</title></html>",
                headers={"Content-Type": "text/html"},
            )
        return _structure_handler(request)

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:1RBL:ENTRY",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "provider_error"
    assert response.json()["detail"]["failure_kind"] == "provider_contract_error"
    assert response.json()["detail"]["status_code"] == 200
    logs = store.list_external_fetch_log(provider="rcsb")
    assert logs[0]["failure_kind"] == "provider_contract_error"


def test_structure_bytes_rejects_rcsb_mmcif_for_wrong_entry_id(tmp_path):
    def handler(request):
        if request.url.path == "/download/1RBL.cif":
            return httpx.Response(
                200,
                text="data_2ABC\n_atom_site.id 1\n",
                headers={"Content-Type": "chemical/x-mmcif"},
            )
        return _structure_handler(request)

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:1RBL:ENTRY",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "provider_error"
    assert response.json()["detail"]["failure_kind"] == "provider_contract_error"
    assert service._breaker_for("rcsb").consecutive_failures == 1
    assert (
        store.list_external_fetch_log(provider="rcsb")[0]["failure_kind"]
        == "provider_contract_error"
    )


def test_structure_bytes_rejects_atom_site_under_wrong_mmcif_data_block(tmp_path):
    def handler(request):
        if request.url.path == "/download/1RBL.cif":
            return httpx.Response(
                200,
                text="data_1RBL\n# empty first block\n\ndata_2ABC\n_atom_site.id 1\n",
                headers={"Content-Type": "chemical/x-mmcif"},
            )
        return _structure_handler(request)

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:1RBL:ENTRY",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "provider_error"
    assert response.json()["detail"]["failure_kind"] == "provider_contract_error"
    assert service._breaker_for("rcsb").consecutive_failures == 1
    assert (
        store.list_external_fetch_log(provider="rcsb")[0]["failure_kind"]
        == "provider_contract_error"
    )


def test_structure_bytes_rejects_atom_site_comment_under_correct_mmcif_data_block(
    tmp_path,
):
    def handler(request):
        if request.url.path == "/download/1RBL.cif":
            return httpx.Response(
                200,
                text=(
                    "data_1RBL\n"
                    "# _atom_site.id mentioned only in a comment\n\n"
                    "data_2ABC\n"
                    "_atom_site.id 1\n"
                ),
                headers={"Content-Type": "chemical/x-mmcif"},
            )
        return _structure_handler(request)

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:1RBL:ENTRY",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "provider_error"
    assert response.json()["detail"]["failure_kind"] == "provider_contract_error"
    assert service._breaker_for("rcsb").consecutive_failures == 1
    assert (
        store.list_external_fetch_log(provider="rcsb")[0]["failure_kind"]
        == "provider_contract_error"
    )


def test_structure_bytes_rejects_alphafold_mmcif_for_wrong_prediction_id(tmp_path):
    def handler(request):
        if request.url.path == "/files/AF-A0A0H3JZA8-F1-model_v6.cif":
            return httpx.Response(
                200,
                text="data_AF-P04637-F1\n_atom_site.id 1\n",
                headers={"Content-Type": "chemical/x-mmcif"},
            )
        return _structure_handler(request)

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "alphafold",
            "external_id": "AF:A0A0H3JZA8:F1:LATEST",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "provider_error"
    assert response.json()["detail"]["failure_kind"] == "provider_contract_error"
    assert service._breaker_for("alphafold").consecutive_failures == 1
    assert (
        store.list_external_fetch_log(provider="alphafold")[-1]["failure_kind"]
        == "provider_contract_error"
    )


def test_structure_bytes_accepts_mmcif_atom_site_after_large_metadata_prefix(tmp_path):
    large_valid_mmcif = "data_1RBL\n" + ("# metadata\n" * 7000) + "_atom_site.id 1\n"

    def handler(request):
        if request.url.path == "/download/1RBL.cif":
            return httpx.Response(
                200,
                text=large_valid_mmcif,
                headers={"Content-Type": "chemical/x-mmcif"},
            )
        return _structure_handler(request)

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:1RBL:ENTRY",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 200
    assert response.text == large_valid_mmcif


def test_structure_bytes_fetches_alphafold_mmcif_for_trembl_accession(tmp_path):
    client, service, store = _build_app(tmp_path, _structure_handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "alphafold",
            "external_id": "AF:A0A0H3JZA8:F1:LATEST",
            "accession": "A0A0H3JZA8",
            "fragment": "F1",
            "version": "LATEST",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 200, response.json()
    assert response.text == "data_AF-A0A0H3JZA8-F1\n_atom_site.id 1\n"
    assert response.headers["X-External-Provider"] == "alphafold"
    assert (
        response.headers["X-External-Id"]
        == "AF:A0A0H3JZA8:F1:V6:MODEL:AF-A0A0H3JZA8-F1-model_v6"
    )
    assert (
        response.headers["X-Served-External-Id"]
        == "AF:A0A0H3JZA8:F1:V6:MODEL:AF-A0A0H3JZA8-F1-model_v6"
    )
    assert response.headers["X-Structure-Format"] == "mmcif"
    assert response.headers["X-Source-Url"].endswith("/AF-A0A0H3JZA8-F1-model_v6.cif")
    assert response.headers["X-License"] == "CC-BY-4.0"
    logs = store.list_external_fetch_log(provider="alphafold")
    assert len(logs) == 1
    assert logs[0]["endpoint"].endswith("/AF-A0A0H3JZA8-F1-model_v6.cif")
    assert logs[0]["bytes_received"] == len(response.content)


@pytest.mark.asyncio
async def test_structure_bytes_alphafold_latest_provider_error_logs_satisfied_capability(
    tmp_path,
):
    def handler(request):
        if request.url.path == "/api/prediction/A0A0H3JZA8":
            return httpx.Response(
                status_code=599,
                json={"error": "external_replay_miss", "url": str(request.url)},
            )
        return httpx.Response(status_code=500, text="unexpected request")

    client, service, store = _build_app(tmp_path, handler)

    with pytest.raises(ProviderHttpError):
        await service.fetch_structure_bytes(
            provider="alphafold",
            external_id="AF:A0A0H3JZA8:F1:LATEST",
            format="mmcif",
            accession="A0A0H3JZA8",
            fragment="F1",
            version="LATEST",
            granted_capabilities=["external-fetch:structure"],
            opts=FetchOptions(max_retries=0, initial_backoff_s=0, max_backoff_s=0),
        )

    logs = store.list_external_fetch_log(provider="alphafold")
    assert len(logs) == 1
    assert logs[0]["endpoint"].endswith("/api/prediction/A0A0H3JZA8")
    assert logs[0]["status_code"] == 599
    assert logs[0]["failure_kind"] == "http_error"
    assert logs[0]["capability_check_json"]["satisfied"] is True


@pytest.mark.asyncio
async def test_structure_bytes_alphafold_not_found_does_not_open_breaker(tmp_path):
    def handler(request):
        if request.url.path == "/api/prediction/P99999":
            return httpx.Response(status_code=404, json=[])
        return httpx.Response(status_code=500, text="unexpected request")

    client, service, store = _build_app(tmp_path, handler)

    with pytest.raises(ProviderHttpError):
        await service.fetch_structure_bytes(
            provider="alphafold",
            external_id="AF:P99999:F1:LATEST",
            format="mmcif",
            granted_capabilities=["external-fetch:structure"],
            opts=FetchOptions(max_retries=0, initial_backoff_s=0, max_backoff_s=0),
        )

    breaker = service._breaker_for("alphafold")
    assert breaker.consecutive_failures == 0
    assert breaker.opened_at_monotonic is None


@pytest.mark.asyncio
async def test_structure_bytes_final_rate_limit_does_not_sleep_retry_after(
    tmp_path, monkeypatch
):
    def handler(request):
        if request.url.path == "/download/1RBL.cif":
            return httpx.Response(
                status_code=429,
                headers={"Retry-After": "600"},
                text="rate limited",
            )
        return _structure_handler(request)

    sleep_calls: list[float] = []

    async def fake_sleep(delay: float):
        sleep_calls.append(delay)

    monkeypatch.setattr("src.external.service.asyncio.sleep", fake_sleep)
    client, service, store = _build_app(tmp_path, handler)

    with pytest.raises(ProviderRateLimitError):
        await service.fetch_structure_bytes(
            provider="rcsb",
            external_id="RCSB:1RBL:ENTRY",
            format="mmcif",
            granted_capabilities=["external-fetch:structure"],
            opts=FetchOptions(max_retries=0, initial_backoff_s=0, max_backoff_s=0),
        )

    assert sleep_calls == []


def test_structure_bytes_preserves_scoped_alphafold_model_identity(tmp_path):
    client, service, store = _build_app(tmp_path, _structure_handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "alphafold",
            "external_id": "AF:A0A0H3JZA8:F1:V6:MODEL:AF-A0A0H3JZA8-F1-model_v6",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 200, response.json()
    assert response.text == "data_AF-A0A0H3JZA8-F1\n_atom_site.id 1\n"
    assert (
        response.headers["X-External-Id"]
        == "AF:A0A0H3JZA8:F1:V6:MODEL:AF-A0A0H3JZA8-F1-model_v6"
    )
    logs = store.list_external_fetch_log(provider="alphafold")
    assert len(logs) == 1
    assert logs[0]["endpoint"].endswith("/AF-A0A0H3JZA8-F1-model_v6.cif")


def test_structure_bytes_canonicalizes_alphafold_model_id_case(tmp_path):
    client, service, store = _build_app(tmp_path, _structure_handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "alphafold",
            "external_id": "AF:A0A0H3JZA8:F1:V6",
            "model_id": "AF-a0a0h3jza8-F1-model_v6",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 200, response.json()
    assert (
        response.headers["X-External-Id"]
        == "AF:A0A0H3JZA8:F1:V6:MODEL:AF-A0A0H3JZA8-F1-model_v6"
    )


def test_structure_bytes_explicit_alphafold_version_uses_model_identity(tmp_path):
    client, service, store = _build_app(tmp_path, _structure_handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "alphafold",
            "external_id": "AF:A0A0H3JZA8:F1:V6",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 200, response.json()
    assert (
        response.headers["X-External-Id"]
        == "AF:A0A0H3JZA8:F1:V6:MODEL:AF-A0A0H3JZA8-F1-model_v6"
    )
    assert (
        response.headers["X-Served-External-Id"]
        == "AF:A0A0H3JZA8:F1:V6:MODEL:AF-A0A0H3JZA8-F1-model_v6"
    )


def test_structure_bytes_rejects_latest_with_mismatched_alphafold_model_id(tmp_path):
    client, service, store = _build_app(tmp_path, _structure_handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "alphafold",
            "external_id": "AF:A0A0H3JZA8:F1:LATEST",
            "model_id": "AF-P04637-F1-model_v4",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"]["error"] == "invalid_request"


@pytest.mark.parametrize(
    "payload",
    [
        {"external_id": "AF:A0A0H3JZA8:F1:V0"},
        {"external_id": "AF:A0A0H3JZA8:F1:LATEST", "version": "V0"},
        {
            "external_id": "AF:A0A0H3JZA8:F1:LATEST",
            "model_id": "AF-A0A0H3JZA8-F1-model_v0",
        },
    ],
)
def test_structure_bytes_rejects_alphafold_zero_version(tmp_path, payload):
    client, service, store = _build_app(tmp_path, _structure_handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "alphafold",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
            **payload,
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"]["error"] == "invalid_request"


def test_structure_bytes_rejects_alphafold_zero_fragment_before_network(tmp_path):
    calls: list[str] = []

    def handler(request):
        calls.append(request.url.path)
        return _structure_handler(request)

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "alphafold",
            "external_id": "AF:A0A0H3JZA8:F0:LATEST",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"]["error"] == "invalid_request"
    assert calls == []
    logs = store.list_external_fetch_log(provider="alphafold")
    assert len(logs) == 1
    assert logs[0]["endpoint"] == "alphafold:AF:A0A0H3JZA8:F0:LATEST"
    assert logs[0]["status_code"] == 422
    assert logs[0]["failure_kind"] == "http_error"


def test_structure_bytes_rejects_alphafold_cif_url_for_wrong_fragment(tmp_path):
    def handler(request):
        if request.url.path == "/api/prediction/A0A0H3JZA8":
            return httpx.Response(
                200,
                json=[
                    {
                        "uniprotAccession": "A0A0H3JZA8",
                        "globalMetricValue": 31.47,
                        "latestVersion": 6,
                        "cifUrl": "https://alphafold.ebi.ac.uk/files/AF-A0A0H3JZA8-F1-model_v6.cif",
                    }
                ],
            )
        return httpx.Response(500, text="unexpected")

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "alphafold",
            "external_id": "AF:A0A0H3JZA8:F2:LATEST",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 404
    assert response.json()["detail"]["error"] == "provider_not_found"


def test_structure_bytes_rejects_alphafold_cif_url_outside_provider_namespace(tmp_path):
    calls: list[str] = []

    def handler(request):
        calls.append(request.url.path)
        if request.url.path == "/api/prediction/A0A0H3JZA8":
            return httpx.Response(
                200,
                json=[
                    {
                        "uniprotAccession": "A0A0H3JZA8",
                        "globalMetricValue": 31.47,
                        "latestVersion": 6,
                        "cifUrl": "https://example.com/AF-A0A0H3JZA8-F1-model_v6.cif",
                    }
                ],
            )
        return httpx.Response(500, text="unexpected")

    client, service, store = _build_app(tmp_path, handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "alphafold",
            "external_id": "AF:A0A0H3JZA8:F1:LATEST",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "provider_error"
    assert calls == ["/api/prediction/A0A0H3JZA8"]


def test_structure_bytes_rejects_scope_mismatch(tmp_path):
    client, service, store = _build_app(tmp_path, _structure_handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "alphafold",
            "external_id": "AF:A0A0H3JZA8:F1:LATEST",
            "accession": "P00875",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:structure"],
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"]["error"] == "invalid_request"


def test_structure_bytes_requires_structure_capability(tmp_path):
    client, service, store = _build_app(tmp_path, _structure_handler)

    response = client.post(
        "/external/structure/bytes",
        json={
            "provider": "rcsb",
            "external_id": "1rbl",
            "format": "mmcif",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"]["error"] == "capability_denied"
    logs = store.list_external_fetch_log(provider="rcsb")
    assert len(logs) == 1
    assert logs[0]["failure_kind"] == "capability_denied"
    assert logs[0]["capability_check_json"]["satisfied"] is False


def test_post_fetch_capability_denied_returns_403(tmp_path):
    client, service, store = _build_app(tmp_path, _ok_handler)
    response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "granted_capabilities": [],
        },
    )
    assert response.status_code == 403
    body = response.json()
    assert body["detail"]["error"] == "capability_denied"
    assert "external-fetch:annotation" in body["detail"]["required"]


def test_post_fetch_xref_only_capability_denied_before_network(tmp_path):
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        return _ok_handler(request)

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "granted_capabilities": ["external-fetch:xref-resolution"],
        },
    )

    assert response.status_code == 403
    assert calls == 0
    body = response.json()
    assert body["detail"]["error"] == "capability_denied"
    assert body["detail"]["required"] == ["external-fetch:annotation"]
    logs = store.list_external_fetch_log(provider="uniprot")
    assert len(logs) == 1
    assert logs[0]["failure_kind"] == "capability_denied"
    assert logs[0]["capability_check_json"] == {
        "required": ["external-fetch:annotation"],
        "granted": ["external-fetch:xref-resolution"],
        "satisfied": False,
    }


def test_canonical_xref_stub_does_not_short_circuit_later_rcsb_fetch(tmp_path):
    calls: list[str] = []

    def handler(request):
        calls.append(request.url.path)
        return _structure_handler(request)

    client, service, store = _build_app(tmp_path, handler)
    uniprot_response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "granted_capabilities": [
                "external-fetch:annotation",
                "external-fetch:xref-resolution",
            ],
        },
    )
    assert uniprot_response.status_code == 200, uniprot_response.json()
    stub = store.get_external_resource_by_external_id("rcsb", "RCSB:1RBL:ENTRY")
    assert stub is not None
    assert stub["metadata_json"] == {"_stub": True}

    rcsb_response = client.post(
        "/external/fetch",
        json={
            "provider": "rcsb",
            "external_id": "RCSB:1RBL:ENTRY",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert rcsb_response.status_code == 200, rcsb_response.json()
    assert rcsb_response.json()["cache_hit"] is False
    assert "/rest/v1/core/entry/1RBL" in calls
    persisted = store.get_external_resource_by_external_id("rcsb", "RCSB:1RBL:ENTRY")
    assert persisted is not None
    assert persisted["metadata_json"].get("_stub") is not True
    assert persisted["metadata_json"]["pdb_id"] == "1RBL"


def test_post_fetch_unknown_provider_returns_400(tmp_path):
    client, service, store = _build_app(tmp_path, _ok_handler)
    response = client.post(
        "/external/fetch",
        json={
            "provider": "ncbi",
            "external_id": "GENBANK-12345",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 400
    assert response.json()["detail"]["error"] == "unknown_provider"


def test_post_fetch_provider_404_returns_502(tmp_path):
    """Upstream 4xx propagates as 502 — we don't pass through provider
    status codes because they don't reflect the client→our-service
    relationship."""

    def handler(request):
        return httpx.Response(status_code=404, json={"error": "not found"})

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P99999",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 502
    body = response.json()
    assert body["detail"]["error"] == "provider_error"
    assert body["detail"]["failure_kind"] == "http_error"
    assert body["detail"]["status_code"] == 404


def test_post_fetch_uniprot_mismatched_2xx_body_is_contract_error(tmp_path):
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        return httpx.Response(
            status_code=200,
            json={
                **_p00875_payload(),
                "primaryAccession": "P99999",
            },
        )

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "granted_capabilities": [
                "external-fetch:annotation",
                "external-fetch:xref-resolution",
            ],
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["failure_kind"] == "provider_contract_error"
    assert calls == 1
    logs = store.list_external_fetch_log(provider="uniprot")
    assert logs[0]["failure_kind"] == "provider_contract_error"


def test_post_fetch_uniprot_non_object_2xx_body_is_contract_error(tmp_path):
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        return httpx.Response(status_code=200, json=[])

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "granted_capabilities": [
                "external-fetch:annotation",
                "external-fetch:xref-resolution",
            ],
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["failure_kind"] == "provider_contract_error"
    assert calls == 1
    logs = store.list_external_fetch_log(provider="uniprot")
    assert logs[0]["failure_kind"] == "provider_contract_error"


def test_post_fetch_with_workspace_binding(tmp_path):
    client, service, store = _build_app(tmp_path, _ok_handler)
    response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "workspace_id": "ws-rubisco",
            "granted_capabilities": ["external-fetch:annotation"],
            "bind_to": {
                "source_kind": "sequence",
                "source_uri": "waypoint://workspace/ws-rubisco/sequence/r.gb",
                "relationship": "derived_from",
                "evidence": "asserted",
            },
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["binding_id"] is not None
    bindings = store.list_external_resource_bindings(workspace_id="ws-rubisco")
    assert len(bindings) == 1
    assert bindings[0]["id"] == body["binding_id"]


def test_post_fetch_pydantic_rejects_missing_provider(tmp_path):
    client, _, _ = _build_app(tmp_path, _ok_handler)
    response = client.post(
        "/external/fetch",
        json={
            "external_id": "P00875",
        },
    )
    assert response.status_code == 422


def test_post_fetch_invalid_source_kind_returns_422(tmp_path):
    """Pydantic Literal validation: invalid source_kind / evidence rejects
    at the route boundary (422) instead of bubbling as 500 from the SQL
    CHECK constraint."""
    client, _, _ = _build_app(tmp_path, _ok_handler)
    response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "workspace_id": "ws-1",
            "granted_capabilities": ["external-fetch:annotation"],
            "bind_to": {
                "source_kind": "organism",
                "source_uri": "waypoint://workspace/ws-1/sequence/x.gb",
                "relationship": "derived_from",
            },
        },
    )
    assert response.status_code == 422


def test_post_fetch_bind_to_without_workspace_id_returns_400(tmp_path):
    """Anonymous bindings would all share workspace='' — service rejects
    bind_to without an explicit workspace_id with a 400 (invalid_request).

    `evidence` is required at the schema layer  alignment with the
    renderer zod schema + manifest) so we supply it here; the test pin is
    on the workspace_id-omission path, not the evidence default.
    """
    client, _, _ = _build_app(tmp_path, _ok_handler)
    response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "granted_capabilities": ["external-fetch:annotation"],
            "bind_to": {
                "source_kind": "sequence",
                "source_uri": "waypoint://anywhere/x.gb",
                "relationship": "derived_from",
                "evidence": "asserted",
            },
        },
    )
    assert response.status_code == 400
    assert response.json()["detail"]["error"] == "invalid_request"


def test_get_by_external_id_returns_404_when_missing(tmp_path):
    client, _, _ = _build_app(tmp_path, _ok_handler)
    response = client.get(
        "/external/resource/by-external-id",
        params={"provider": "uniprot", "external_id": "P99999"},
    )
    assert response.status_code == 404


def test_get_by_external_id_returns_persisted_row_after_fetch(tmp_path):
    client, _, _ = _build_app(tmp_path, _ok_handler)
    client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    response = client.get(
        "/external/resource/by-external-id",
        params={"provider": "uniprot", "external_id": "P00875"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "uniprot"
    assert body["external_id"] == "P00875"
    assert body["license"] == "CC-BY-4.0"
    assert body["metadata"]["primary_accession"] == "P00875"


def test_get_resource_by_id_round_trips_with_post_fetch(tmp_path):
    client, _, _ = _build_app(tmp_path, _ok_handler)
    post_response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    resource_id = post_response.json()["external_resource_id"]
    get_response = client.get(f"/external/resource/{resource_id}")
    assert get_response.status_code == 200
    body = get_response.json()
    assert body["id"] == resource_id
    assert body["provider"] == "uniprot"
    assert body["external_id"] == "P00875"


def test_get_resource_by_id_404_for_unknown(tmp_path):
    client, _, _ = _build_app(tmp_path, _ok_handler)
    response = client.get("/external/resource/00000000-0000-0000-0000-000000000000")
    assert response.status_code == 404


def _uniprot_search_handler(accession: str = "P0AD86", reviewed: bool = True):
    entry_type = (
        "UniProtKB reviewed (Swiss-Prot)"
        if reviewed
        else "UniProtKB unreviewed (TrEMBL)"
    )

    def handler(request):
        assert "query" in request.url.params
        return httpx.Response(
            status_code=200,
            json={
                "results": [
                    {
                        "primaryAccession": accession,
                        "entryType": entry_type,
                    }
                ]
            },
        )

    return handler


def test_uniprot_search_happy_path_returns_hits(tmp_path):
    client, service, store = _build_app(tmp_path, _uniprot_search_handler())
    response = client.post(
        "/external/uniprot/search",
        json={
            "query": "xref:embl-AAC73112.1 AND reviewed:true",
            "size": 1,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["hits"] == [{"accession": "P0AD86", "reviewed": True}]
    logs = store.list_external_fetch_log(provider="uniprot")
    assert any(row["endpoint"].endswith("/search") for row in logs)


def test_uniprot_search_include_sequence_returns_sequence_and_organism(tmp_path):
    def handler(request):
        assert request.url.params["fields"] == (
            "accession,reviewed,sequence,organism_id,organism_name"
        )
        return httpx.Response(
            status_code=200,
            json={
                "results": [
                    {
                        "primaryAccession": "P75718",
                        "entryType": "UniProtKB reviewed (Swiss-Prot)",
                        "organism": {
                            "scientificName": "Escherichia coli (strain K12)",
                            "taxonId": 83333,
                        },
                        "sequence": {
                            "value": "MARAGILVVDGKVWRTVYYRFATREEWEGKVSTNLIFKECRQSAAMKRVLRVYKRTSMGTQ"
                        },
                    }
                ]
            },
        )

    client, _service, _store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/uniprot/search",
        json={
            "query": "gene:renD AND reviewed:true",
            "size": 10,
            "include_sequence": True,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 200
    assert response.json()["hits"] == [
        {
            "accession": "P75718",
            "reviewed": True,
            "sequence": "MARAGILVVDGKVWRTVYYRFATREEWEGKVSTNLIFKECRQSAAMKRVLRVYKRTSMGTQ",
            "taxon_id": 83333,
            "organism": "Escherichia coli (strain K12)",
        }
    ]


def test_uniprot_search_capability_denied_returns_403(tmp_path):
    client, service, store = _build_app(tmp_path, _uniprot_search_handler())
    response = client.post(
        "/external/uniprot/search",
        json={"query": "gene:thrL AND organism_id:83333", "granted_capabilities": []},
    )
    assert response.status_code == 403


def test_uniprot_search_empty_results_returns_empty_hits(tmp_path):
    def handler(request):
        return httpx.Response(status_code=200, json={"results": []})

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/uniprot/search",
        json={
            "query": "xref:refseq-NP_999999999.1",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 200
    assert response.json()["hits"] == []


def test_uniprot_search_rejects_malformed_primary_accession_as_contract_error(tmp_path):
    def handler(request):
        return httpx.Response(
            status_code=200,
            json={
                "results": [
                    {
                        "primaryAccession": "../not-a-uniprot-accession",
                        "entryType": "UniProtKB reviewed (Swiss-Prot)",
                    }
                ]
            },
        )

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/uniprot/search",
        json={
            "query": "gene:thrL",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "provider_error"
    assert response.json()["detail"]["failure_kind"] == "provider_contract_error"
    assert response.json()["detail"]["status_code"] == 200


def test_uniprot_search_rejects_non_string_entry_type_as_contract_error(tmp_path):
    def handler(request):
        return httpx.Response(
            status_code=200,
            json={
                "results": [
                    {"primaryAccession": "P0AD86", "entryType": {"reviewed": True}}
                ]
            },
        )

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/uniprot/search",
        json={
            "query": "gene:thrL",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "provider_error"
    assert response.json()["detail"]["failure_kind"] == "provider_contract_error"
    assert response.json()["detail"]["status_code"] == 200


def test_uniprot_search_4xx_propagates_as_502(tmp_path):
    def handler(request):
        return httpx.Response(status_code=400, json={"error": "bad query"})

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/uniprot/search",
        json={
            "query": "??invalid syntax??",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 502


def test_uniprot_search_404_propagates_as_502(tmp_path):
    def handler(request):
        return httpx.Response(status_code=404, json={"error": "not found"})

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/uniprot/search",
        json={
            "query": "checksum:DEADBEEF",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "provider_error"
    assert response.json()["detail"]["status_code"] == 404


def test_uniprot_search_circuit_open_returns_503(tmp_path):
    client, service, store = _build_app(tmp_path, _uniprot_search_handler())

    async def raise_circuit(*args, **kwargs):
        raise CircuitOpen("uniprot", 12.0)

    service.search_uniprot = raise_circuit  # type: ignore[method-assign]
    response = client.post(
        "/external/uniprot/search",
        json={
            "query": "gene:thrL",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 503
    assert response.json()["detail"]["error"] == "circuit_open"


_MIOC_PROTEIN = (
    "MADITLISGSTLGGAEYVAEHLAEKLEEAGFTTETLHGPLLEDLPASGIWLVISSTHGAGDI"
    "PDNLSPFYEALQEQKPDLSAVRFGAIGIGSREYDTFCGAIDKLEAELKNSGAKQTGETLKIN"
    "ILDHDIPEDPAEEWLGSWVNLLK"
)
_MIOC_MD5 = "4BFC2ED15C60BB6BF4D68FC54F668B53"


def _by_sequence_handler(
    expected_checksum: str,
    hits: list[dict[str, Any]] | None = None,
    *,
    expect_xrefs: bool = False,
):
    """Build a UniProt /search handler that asserts the renderer's query
    arrived as `checksum:<MD5>` and returns canned hits.

    Also pins capability scoping for PDB xrefs: the route must only pass
    `fields=...,xref_pdb` when the caller has the xref-resolution grant."""

    def handler(request):
        query = request.url.params.get("query", "")
        assert (
            query == f"checksum:{expected_checksum}"
        ), f"unexpected upstream query: {query!r} (expected checksum:{expected_checksum})"
        fields = request.url.params.get("fields", "")
        if expect_xrefs:
            assert (
                "xref_pdb" in fields
            ), f"by-sequence must request xref_pdb when xref is granted; got: {fields!r}"
        else:
            assert (
                "xref_pdb" not in fields
            ), f"annotation-only by-sequence must not request xref_pdb; got: {fields!r}"
        results = []
        for h in hits or [
            {
                "primaryAccession": "P03817",
                "entryType": "UniProtKB reviewed (Swiss-Prot)",
            }
        ]:
            results.append(h)
        return httpx.Response(status_code=200, json={"results": results})

    return handler


def test_by_sequence_happy_path_returns_md5_and_hits(tmp_path):
    client, service, store = _build_app(tmp_path, _by_sequence_handler(_MIOC_MD5))
    response = client.post(
        "/external/uniprot/by-sequence",
        json={
            "sequence": _MIOC_PROTEIN,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 200, response.json()
    body = response.json()
    assert body["md5"] == _MIOC_MD5
    assert body["query_identity"] == {
        "kind": "protein_sequence",
        "normalized_length": len(_MIOC_PROTEIN),
        "checksum_md5": _MIOC_MD5,
        "checksum_sha256": "61d26ffec893f8530b612b7958034b575130591b62d6d2eafc4686df0c53e13e",
        "canonical_form": "waypoint-protein-v2",
        "canonical_lookup_sequence": _MIOC_PROTEIN,
        "canonical_form_applied": True,
        "ineligible": False,
        "ineligible_reason": None,
        "evidence": [],
    }
    assert body["hits"] == [
        {
            "accession": "P03817",
            "reviewed": True,
            "match_evidence": {
                "kind": "exact_sequence_checksum",
                "checksum_md5": _MIOC_MD5,
                "sequence_identity": 1.0,
                "taxon_id": None,
                "organism": None,
                "rank": 0,
                "rank_reasons": ["checksum_match", "reviewed"],
            },
            "pdb_ids": [],
            "pdb_xrefs": [],
        }
    ]


def test_by_sequence_strips_trailing_stop_before_hashing(tmp_path):
    """Critical: UniProt stores the protein WITHOUT trailing stop. Our
    cdsToProtein renderer-side helper drops it; this test pins the
    sidecar's defensive strip in case any caller forgets."""
    client, service, store = _build_app(tmp_path, _by_sequence_handler(_MIOC_MD5))
    response = client.post(
        "/external/uniprot/by-sequence",
        json={
            "sequence": _MIOC_PROTEIN + "*",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 200, response.json()
    assert response.json()["md5"] == _MIOC_MD5


def test_by_sequence_normalizes_whitespace_and_case(tmp_path):
    """Tolerate copy-paste-flavored input: line breaks, lowercase. Same
    canonical hash output."""
    client, service, store = _build_app(tmp_path, _by_sequence_handler(_MIOC_MD5))
    munged = (
        _MIOC_PROTEIN[:50].lower()
        + "\n"
        + _MIOC_PROTEIN[50:100]
        + "\t"
        + _MIOC_PROTEIN[100:]
    )
    response = client.post(
        "/external/uniprot/by-sequence",
        json={
            "sequence": munged,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 200, response.json()
    assert response.json()["md5"] == _MIOC_MD5


def test_by_sequence_normalizes_unicode_whitespace_before_hashing(tmp_path):
    client, service, store = _build_app(tmp_path, _by_sequence_handler(_MIOC_MD5))
    munged = (
        _MIOC_PROTEIN[:10].lower()
        + "\u00a0"
        + _MIOC_PROTEIN[10:40]
        + "\u2003"
        + _MIOC_PROTEIN[40:]
        + "*"
    )
    response = client.post(
        "/external/uniprot/by-sequence",
        json={
            "sequence": munged,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 200, response.json()
    body = response.json()
    assert body["md5"] == _MIOC_MD5
    assert body["query_identity"]["canonical_lookup_sequence"] == _MIOC_PROTEIN
    assert body["query_identity"]["evidence"] == []


def test_by_sequence_no_match_returns_empty_hits(tmp_path):
    """Synthetic / engineered protein with no UniProt entry: empty hits,
    md5 still echoed back so caller can audit."""

    def handler(request):
        return httpx.Response(status_code=200, json={"results": []})

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/uniprot/by-sequence",
        json={
            "sequence": "MFAKEPROTEINSEQUENCETHATNOTHINGINUNIPROT",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 200, response.json()
    assert response.json()["hits"] == []
    assert len(response.json()["md5"]) == 32


def test_by_sequence_internal_stop_is_ineligible_without_upstream_call(tmp_path):
    def handler(request):
        raise AssertionError(
            f"internal-stop input must not call upstream: {request.url}"
        )

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/uniprot/by-sequence",
        json={
            "sequence": "MFAKE*PRTEIN",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 200, response.json()
    body = response.json()
    assert body["hits"] == []
    assert body["md5"] == ""
    assert body["query_identity"]["ineligible"] is True
    assert body["query_identity"]["ineligible_reason"] == "internal_stop"
    assert body["query_identity"]["normalized_length"] == len("MFAKE*PRTEIN")
    assert body["query_identity"]["checksum_md5"] == ""
    assert body["query_identity"]["checksum_sha256"] == ""
    assert body["query_identity"]["canonical_lookup_sequence"] == ""
    assert body["query_identity"]["evidence"] == [
        {"kind": "internal_stop", "residue": "*"}
    ]
    assert len(store.list_external_fetch_log(provider="uniprot")) == 0


def test_by_sequence_ineligible_input_still_requires_annotation_capability(tmp_path):
    def handler(request):
        raise AssertionError(
            f"capability-denied by-sequence request must not call upstream: {request.url}"
        )

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/uniprot/by-sequence",
        json={
            "sequence": "MFAKE*PRTEIN",
            "granted_capabilities": [],
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"]["error"] == "capability_denied"
    assert len(store.list_external_fetch_log(provider="uniprot")) == 0


def test_by_sequence_invalid_residue_is_ineligible_without_upstream_call(tmp_path):
    def handler(request):
        raise AssertionError(
            f"invalid residue input must not call upstream: {request.url}"
        )

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/uniprot/by-sequence",
        json={
            "sequence": "MFAKE-PROTEIN",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 200, response.json()
    body = response.json()
    assert body["hits"] == []
    assert body["md5"] == ""
    assert body["query_identity"]["ineligible"] is True
    assert body["query_identity"]["ineligible_reason"] == "protein_invalid_residue"
    assert body["query_identity"]["canonical_lookup_sequence"] == ""
    assert body["query_identity"]["evidence"] == [
        {"kind": "protein_invalid_residue", "residue": "-"}
    ]
    assert len(store.list_external_fetch_log(provider="uniprot")) == 0


def test_by_sequence_collects_internal_stop_and_invalid_residue_evidence(tmp_path):
    def handler(request):
        raise AssertionError(f"ineligible input must not call upstream: {request.url}")

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/uniprot/by-sequence",
        json={
            "sequence": "MFAKE-PROT*EIN",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 200, response.json()
    body = response.json()
    assert body["hits"] == []
    assert body["query_identity"]["ineligible"] is True
    assert body["query_identity"]["ineligible_reason"] == "internal_stop"
    assert body["query_identity"]["canonical_lookup_sequence"] == ""
    assert body["query_identity"]["evidence"] == [
        {"kind": "protein_invalid_residue", "residue": "-"},
        {"kind": "internal_stop", "residue": "*"},
    ]
    assert len(store.list_external_fetch_log(provider="uniprot")) == 0


def test_by_sequence_sorts_reviewed_first(tmp_path):
    """When UniProt returns multiple identical-sequence hits across
    strains (common for highly-conserved proteins), the route must surface
    the Swiss-Prot reviewed entry first regardless of UniProt's REST
    ordering. Renderer takes hits[0]."""

    def handler(request):
        return httpx.Response(
            status_code=200,
            json={
                "results": [
                    {
                        "primaryAccession": "W8T383",
                        "entryType": "UniProtKB unreviewed (TrEMBL)",
                    },
                    {
                        "primaryAccession": "P03817",
                        "entryType": "UniProtKB reviewed (Swiss-Prot)",
                    },
                    {
                        "primaryAccession": "A0AAN3ZHY6",
                        "entryType": "UniProtKB unreviewed (TrEMBL)",
                    },
                ]
            },
        )

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/uniprot/by-sequence",
        json={
            "sequence": _MIOC_PROTEIN,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 200, response.json()
    accessions = [h["accession"] for h in response.json()["hits"]]
    assert (
        accessions[0] == "P03817"
    ), f"reviewed entry must surface first; got order: {accessions}"


def test_by_sequence_returns_401_when_session_missing(tmp_path):
    client, _service, _store = _build_app_no_session(tmp_path, _ok_handler)
    response = client.post(
        "/external/uniprot/by-sequence",
        json={"sequence": _MIOC_PROTEIN},
    )
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "BAD_SESSION"


def test_by_sequence_capability_denied_returns_403(tmp_path):
    client, service, store = _build_app(tmp_path, _by_sequence_handler(_MIOC_MD5))
    response = client.post(
        "/external/uniprot/by-sequence",
        json={"sequence": _MIOC_PROTEIN, "granted_capabilities": []},
    )
    assert response.status_code == 403


def test_by_sequence_propagates_provider_4xx_as_502(tmp_path):
    def handler(request):
        return httpx.Response(status_code=400, json={"error": "bad query"})

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/uniprot/by-sequence",
        json={
            "sequence": _MIOC_PROTEIN,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 502


def test_by_sequence_propagates_uniprot_search_404_as_502(tmp_path):
    def handler(request):
        return httpx.Response(status_code=404, json={"error": "not found"})

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/uniprot/by-sequence",
        json={
            "sequence": _MIOC_PROTEIN,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "provider_error"
    assert response.json()["detail"]["status_code"] == 404


@pytest.mark.parametrize(
    "upstream_response",
    [
        httpx.Response(status_code=200, content=b"<html>not json</html>"),
        httpx.Response(status_code=200, json={}),
        httpx.Response(status_code=200, json={"results": {}}),
        httpx.Response(status_code=200, json={"results": [None]}),
        httpx.Response(
            status_code=200,
            json={"results": [{"entryType": "UniProtKB reviewed (Swiss-Prot)"}]},
        ),
    ],
)
def test_by_sequence_malformed_upstream_200_returns_provider_error(
    tmp_path, upstream_response
):
    def handler(request):
        return upstream_response

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/uniprot/by-sequence",
        json={
            "sequence": _MIOC_PROTEIN,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "provider_error"
    assert response.json()["detail"]["failure_kind"] == "provider_contract_error"


def test_by_sequence_circuit_open_returns_503(tmp_path):
    client, service, store = _build_app(tmp_path, _by_sequence_handler(_MIOC_MD5))

    async def raise_circuit(*args, **kwargs):
        raise CircuitOpen("uniprot", 12.0)

    service.search_uniprot_by_sequence = raise_circuit  # type: ignore[method-assign]
    response = client.post(
        "/external/uniprot/by-sequence",
        json={
            "sequence": _MIOC_PROTEIN,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 503
    assert response.json()["detail"]["error"] == "circuit_open"


def test_by_sequence_surfaces_pdb_xrefs_per_hit(tmp_path):
    """When a UniProt entry has solved structures, the by-sequence response
    must carry their PDB ids (DNA-XXX quick-win) in REST order so the
    renderer can prefer experimental over predicted. Order preservation
    is part of the contract — the renderer takes pdb_ids[0] today; the
    follow-up source-management ticket will replace that with
    best-resolution selection."""
    client, service, store = _build_app(
        tmp_path,
        _by_sequence_handler(
            _MIOC_MD5,
            hits=[
                {
                    "primaryAccession": "P03817",
                    "entryType": "UniProtKB reviewed (Swiss-Prot)",
                    "uniProtKBCrossReferences": [
                        {
                            "database": "PDB",
                            "id": "1XYZ",
                            "properties": [
                                {"key": "Method", "value": "X-ray"},
                                {"key": "Resolution", "value": "2.10 A"},
                                {"key": "Chains", "value": "A=1-150, B=4-153"},
                            ],
                        },
                        {"database": "EMBL", "id": "X12345"},
                        {
                            "database": "PDB",
                            "id": "2ABC",
                            "properties": [
                                {"key": "Method", "value": "NMR"},
                                {"key": "Chains", "value": "A/B=1-95"},
                            ],
                        },
                    ],
                }
            ],
            expect_xrefs=True,
        ),
    )
    response = client.post(
        "/external/uniprot/by-sequence",
        json={
            "sequence": _MIOC_PROTEIN,
            "granted_capabilities": [
                "external-fetch:annotation",
                "external-fetch:xref-resolution",
            ],
        },
    )
    assert response.status_code == 200, response.json()
    body = response.json()
    assert body["hits"][0]["pdb_ids"] == [
        "1XYZ",
        "2ABC",
    ], "PDB ids must be filtered to PDB-only and preserve REST order; EMBL xref must be dropped"
    assert body["hits"][0]["pdb_xrefs"] == [
        {
            "pdb_id": "1XYZ",
            "method": "X-ray",
            "resolution": 2.1,
            "chains": ["A", "B"],
            "raw_properties": {
                "Method": "X-ray",
                "Resolution": "2.10 A",
                "Chains": "A=1-150, B=4-153",
            },
        },
        {
            "pdb_id": "2ABC",
            "method": "NMR",
            "resolution": None,
            "chains": ["A", "B"],
            "raw_properties": {
                "Method": "NMR",
                "Chains": "A/B=1-95",
            },
        },
    ]


def test_by_sequence_does_not_surface_pdb_xrefs_without_xref_capability(tmp_path):
    client, service, store = _build_app(
        tmp_path,
        _by_sequence_handler(
            _MIOC_MD5,
            hits=[
                {
                    "primaryAccession": "P03817",
                    "entryType": "UniProtKB reviewed (Swiss-Prot)",
                    "uniProtKBCrossReferences": [
                        {
                            "database": "PDB",
                            "id": "1XYZ",
                            "properties": [{"key": "Chains", "value": "A=1-150"}],
                        }
                    ],
                }
            ],
        ),
    )
    response = client.post(
        "/external/uniprot/by-sequence",
        json={
            "sequence": _MIOC_PROTEIN,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 200, response.json()
    hit = response.json()["hits"][0]
    assert hit["pdb_ids"] == []
    assert hit["pdb_xrefs"] == []


def test_by_sequence_cannot_self_upgrade_xref_scope_past_session_grant(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "external-fetch:annotation")
    client, service, store = _build_app(
        tmp_path,
        _by_sequence_handler(
            _MIOC_MD5,
            hits=[
                {
                    "primaryAccession": "P03817",
                    "entryType": "UniProtKB reviewed (Swiss-Prot)",
                    "uniProtKBCrossReferences": [
                        {
                            "database": "PDB",
                            "id": "1XYZ",
                            "properties": [{"key": "Chains", "value": "A=1-150"}],
                        }
                    ],
                }
            ],
            expect_xrefs=False,
        ),
    )
    response = client.post(
        "/external/uniprot/by-sequence",
        json={
            "sequence": _MIOC_PROTEIN,
            "granted_capabilities": [
                "external-fetch:annotation",
                "external-fetch:xref-resolution",
            ],
        },
    )

    assert response.status_code == 200, response.json()
    hit = response.json()["hits"][0]
    assert hit["pdb_ids"] == []
    assert hit["pdb_xrefs"] == []


def test_by_sequence_omits_pdb_ids_when_no_solved_structure(tmp_path):
    """Most bacterial proteins / synthetic sequences have no solved
    structure — pdb_ids must be an empty list (not null, not missing) so
    the renderer's `pdbIds.length > 0` check is unambiguous."""
    client, service, store = _build_app(
        tmp_path,
        _by_sequence_handler(
            _MIOC_MD5,
            hits=[
                {
                    "primaryAccession": "P03817",
                    "entryType": "UniProtKB reviewed (Swiss-Prot)",
                }
            ],
        ),
    )
    response = client.post(
        "/external/uniprot/by-sequence",
        json={
            "sequence": _MIOC_PROTEIN,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 200, response.json()
    hit = response.json()["hits"][0]
    assert hit["pdb_ids"] == []
    assert hit["pdb_xrefs"] == []


def test_afdb_validate_hit_returns_plddt(tmp_path):
    def handler(request):
        assert request.url.path.endswith("/P0AD86")
        return httpx.Response(
            status_code=200,
            json=[
                {
                    "uniprotAccession": "P0AD86",
                    "confidenceAvgGlobal": 88.2,
                    "cifUrl": "https://alphafold.ebi.ac.uk/files/AF-P0AD86-F1-model_v1.cif",
                }
            ],
        )

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/alphafold/validate",
        json={
            "accession": "P0AD86",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body == {
        "accession": "P0AD86",
        "mean_plddt": 88.2,
        "latest_version": 1,
        "cif_url": "https://alphafold.ebi.ac.uk/files/AF-P0AD86-F1-model_v1.cif",
        "provider_identity_key": "AF:P0AD86:F1:V1:MODEL:AF-P0AD86-F1-model_v1",
        "fragment": "F1",
        "model_id": "AF-P0AD86-F1-model_v1",
        "exists": True,
    }


def test_afdb_validate_accepts_current_global_metric_field(tmp_path):
    def handler(request):
        assert request.url.path.endswith("/A0A0H3JZA8")
        return httpx.Response(
            status_code=200,
            json=[
                {
                    "uniprotAccession": "A0A0H3JZA8",
                    "globalMetricValue": 31.47,
                    "latestVersion": 6,
                    "cifUrl": "https://alphafold.ebi.ac.uk/files/AF-A0A0H3JZA8-F1-model_v6.cif",
                }
            ],
        )

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/alphafold/validate",
        json={
            "accession": "A0A0H3JZA8",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body == {
        "accession": "A0A0H3JZA8",
        "mean_plddt": 31.47,
        "latest_version": 6,
        "cif_url": "https://alphafold.ebi.ac.uk/files/AF-A0A0H3JZA8-F1-model_v6.cif",
        "provider_identity_key": "AF:A0A0H3JZA8:F1:V6:MODEL:AF-A0A0H3JZA8-F1-model_v6",
        "fragment": "F1",
        "model_id": "AF-A0A0H3JZA8-F1-model_v6",
        "exists": True,
    }


def test_afdb_validate_respects_requested_fragment(tmp_path):
    def handler(request):
        assert request.url.path.endswith("/P12345")
        return httpx.Response(
            status_code=200,
            json=[
                {
                    "uniprotAccession": "P12345",
                    "globalMetricValue": 70.0,
                    "latestVersion": 4,
                    "cifUrl": "https://alphafold.ebi.ac.uk/files/AF-P12345-F1-model_v4.cif",
                },
                {
                    "uniprotAccession": "P12345",
                    "globalMetricValue": 80.0,
                    "latestVersion": 4,
                    "cifUrl": "https://alphafold.ebi.ac.uk/files/AF-P12345-F2-model_v4.cif",
                },
            ],
        )

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/alphafold/validate",
        json={
            "accession": "P12345",
            "fragment": "F2",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["exists"] is True
    assert body["fragment"] == "F2"
    assert (
        body["provider_identity_key"] == "AF:P12345:F2:V4:MODEL:AF-P12345-F2-model_v4"
    )


def test_afdb_validate_rejects_invalid_fragment_before_upstream(tmp_path):
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        return httpx.Response(status_code=200, json=[])

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/alphafold/validate",
        json={
            "accession": "P12345",
            "fragment": "BAD",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 422
    assert calls == 0
    assert store.list_external_fetch_log(provider="alphafold") == []


def test_afdb_validate_mismatched_2xx_body_is_contract_error(tmp_path):
    def handler(request):
        return httpx.Response(
            status_code=200,
            json=[
                {
                    "uniprotAccession": "Q99999",
                    "globalMetricValue": 80.0,
                    "latestVersion": 4,
                    "cifUrl": "https://alphafold.ebi.ac.uk/files/AF-Q99999-F1-model_v4.cif",
                }
            ],
        )

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/alphafold/validate",
        json={
            "accession": "P12345",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["failure_kind"] == "provider_contract_error"
    logs = store.list_external_fetch_log(provider="alphafold")
    assert logs[0]["failure_kind"] == "provider_contract_error"


def test_afdb_validate_rejects_bool_latest_version(tmp_path):
    def handler(request):
        return httpx.Response(
            status_code=200,
            json=[{"uniprotAccession": "P0AD86", "latestVersion": True}],
        )

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/alphafold/validate",
        json={
            "accession": "P0AD86",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "provider_error"


def test_afdb_validate_rejects_multi_fragment_payload_without_parseable_fragment(
    tmp_path,
):
    def handler(request):
        return httpx.Response(
            status_code=200,
            json=[
                {"uniprotAccession": "P0AD86", "globalMetricValue": 88.2},
                {"uniprotAccession": "P0AD86", "globalMetricValue": 77.1},
            ],
        )

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/alphafold/validate",
        json={
            "accession": "P0AD86",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "provider_error"


def test_afdb_validate_404_returns_exists_false(tmp_path):
    def handler(request):
        return httpx.Response(status_code=404, text="not found")

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/alphafold/validate",
        json={
            "accession": "Q99999",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body == {
        "accession": None,
        "mean_plddt": None,
        "latest_version": None,
        "cif_url": None,
        "provider_identity_key": None,
        "fragment": None,
        "model_id": None,
        "exists": False,
    }


def test_afdb_validate_empty_list_returns_exists_false(tmp_path):
    def handler(request):
        return httpx.Response(status_code=200, json=[])

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/alphafold/validate",
        json={
            "accession": "Q99999",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body == {
        "accession": None,
        "mean_plddt": None,
        "latest_version": None,
        "cif_url": None,
        "provider_identity_key": None,
        "fragment": None,
        "model_id": None,
        "exists": False,
    }


def test_afdb_validate_replay_miss_fails_closed(tmp_path):
    def handler(request):
        return httpx.Response(
            status_code=599,
            json={"error": "external_replay_miss", "url": str(request.url)},
        )

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/alphafold/validate",
        json={
            "accession": "Q99999",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "provider_error"


def test_afdb_validate_missing_plddt_omits_field(tmp_path):
    def handler(request):
        return httpx.Response(
            status_code=200,
            json=[
                {
                    "uniprotAccession": "P00875",
                    "cifUrl": "https://alphafold.ebi.ac.uk/files/AF-P00875-F1-model_v1.cif",
                }
            ],
        )

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/alphafold/validate",
        json={
            "accession": "P00875",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["exists"] is True
    assert body["accession"] == "P00875"
    assert body["mean_plddt"] is None


def test_afdb_validate_capability_denied_returns_403(tmp_path):
    client, service, store = _build_app(tmp_path, _ok_handler)
    response = client.post(
        "/external/alphafold/validate",
        json={"accession": "P0AD86", "granted_capabilities": []},
    )
    assert response.status_code == 403


def test_afdb_validate_xref_only_capability_denied_returns_403(tmp_path):
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        return _ok_handler(request)

    client, service, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/alphafold/validate",
        json={
            "accession": "P0AD86",
            "granted_capabilities": ["external-fetch:xref-resolution"],
        },
    )

    assert response.status_code == 403
    assert calls == 0
    logs = store.list_external_fetch_log(provider="alphafold")
    assert len(logs) == 0


def test_afdb_validate_circuit_open_returns_503(tmp_path):
    client, service, store = _build_app(tmp_path, _ok_handler)

    async def raise_circuit(*args, **kwargs):
        raise CircuitOpen("alphafold", 12.0)

    service.validate_afdb_exists = raise_circuit  # type: ignore[method-assign]
    response = client.post(
        "/external/alphafold/validate",
        json={
            "accession": "P0AD86",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 503
    assert response.json()["detail"]["error"] == "circuit_open"


def test_routes_return_503_when_service_not_initialized():
    """If the lifespan startup hasn't wired the service yet, every route
    fails-fast with 503 Service Unavailable — better than a confusing
    AttributeError. Note: the test sends a valid session token so it
    isolates the service-uninit 503 path from the  auth 401 path."""
    external_routes.set_service(None)  # type: ignore[arg-type]
    app = FastAPI()
    app.include_router(external_router)
    client = TestClient(app, headers={"X-DNAForge-Session": TEST_MCP_TOKEN})
    response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 503


def test_lifespan_wires_external_service_and_fetch_works_end_to_end(
    tmp_path, monkeypatch
):
    """Boot the real main.py lifespan + execute /external/fetch + verify
    the row landed in the DB. Catches the class of bugs where main.py's
    lifespan rip leaves the service unregistered (the 16 other tests that
    do `from src.main import app` use TestClient as a non-context-manager
    and thus never trigger lifespan)."""
    monkeypatch.setenv("DNAFORGE_SIDECAR_DB_PATH", str(tmp_path / "lifespan.sqlite3"))
    monkeypatch.setenv("WAYPOINT_DATA_DIR", str(tmp_path / "application-data"))
    monkeypatch.setenv("DNAFORGE_OFFLINE_ANNOTATION", "1")

    external_routes.set_service(None)  # type: ignore[arg-type]

    import httpx as httpx_mod

    from src.external.providers import uniprot as uniprot_module

    captured_client: dict = {}

    real_init = uniprot_module.UniProtProvider.__init__

    def patched_init(self, client=None, *, base_url=None):
        if client is None:
            transport = httpx_mod.MockTransport(
                lambda r: httpx_mod.Response(
                    200,
                    json={
                        "primaryAccession": "P00875",
                        "entryType": "UniProtKB reviewed (Swiss-Prot)",
                        "organism": {
                            "scientificName": "Synechococcus elongatus",
                            "taxonId": 269084,
                        },
                        "sequence": {"length": 472},
                        "genes": [{"geneName": {"value": "rbcL"}}],
                        "proteinDescription": {
                            "recommendedName": {
                                "fullName": {
                                    "value": "Ribulose bisphosphate carboxylase large chain"
                                }
                            }
                        },
                        "uniProtKBCrossReferences": [],
                    },
                )
            )
            client = httpx_mod.AsyncClient(transport=transport)
            captured_client["client"] = client
        real_init(self, client=client, base_url=base_url)

    monkeypatch.setattr(uniprot_module.UniProtProvider, "__init__", patched_init)

    from src.main import app

    with TestClient(app, headers={"X-DNAForge-Session": TEST_MCP_TOKEN}) as client:
        response = client.post(
            "/external/fetch",
            json={
                "provider": "uniprot",
                "external_id": "P00875",
                "granted_capabilities": ["external-fetch:annotation"],
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["provider"] == "uniprot"
        assert body["external_id"] == "P00875"
        assert body["cache_hit"] is False

        response2 = client.post(
            "/external/fetch",
            json={
                "provider": "uniprot",
                "external_id": "P00875",
                "granted_capabilities": ["external-fetch:annotation"],
            },
        )
        assert response2.status_code == 200
        assert response2.json()["cache_hit"] is True


def test_get_xrefs_returns_404_when_not_cached(tmp_path):
    """ review fix: /external/xrefs matches sibling routes' 404 contract
    (vs the prior 200 + found:false). Renderer translates 404 → not_cached."""
    client, _service, _store = _build_app(tmp_path, _ok_handler)
    response = client.get(
        "/external/xrefs",
        params={"provider": "uniprot", "external_id": "NEVER_FETCHED"},
    )
    assert response.status_code == 404


def test_get_xrefs_returns_persisted_xrefs(tmp_path):
    client, _service, _store = _build_app(tmp_path, _ok_handler)
    client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "granted_capabilities": [
                "external-fetch:annotation",
                "external-fetch:xref-resolution",
            ],
        },
    )
    response = client.get(
        "/external/xrefs",
        params={"provider": "uniprot", "external_id": "P00875"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["resource_id"] is not None
    assert body["total"] >= 1
    assert all("xref_type" in row for row in body["xrefs"])


def test_get_xrefs_filters_by_target_provider(tmp_path):
    client, _service, store = _build_app(tmp_path, _ok_handler)
    client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "granted_capabilities": [
                "external-fetch:annotation",
                "external-fetch:xref-resolution",
            ],
        },
    )
    response = client.get(
        "/external/xrefs",
        params={
            "provider": "uniprot",
            "external_id": "P00875",
            "target_provider": "pdb",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["target_provider"] == "pdb"
    assert body["total"] >= 1
    for row in body["xrefs"]:
        target = store.get_external_resource(row["to_resource_id"])
        assert target is not None
        assert target["provider"] == "rcsb"


def test_get_xrefs_rejects_session_grant_without_xref_scope(tmp_path, monkeypatch):
    client, _service, _store = _build_app(tmp_path, _ok_handler)
    client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "granted_capabilities": [
                "external-fetch:annotation",
                "external-fetch:xref-resolution",
            ],
        },
    )

    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "external-fetch:annotation")
    response = client.get(
        "/external/xrefs",
        params={"provider": "uniprot", "external_id": "P00875"},
    )

    assert response.status_code == 403
    body = response.json()["detail"]
    assert body["error"] == "capability_denied"
    assert body["required"] == ["external-fetch:xref-resolution"]
    assert body["granted"] == ["external-fetch:annotation"]


def test_get_xrefs_allows_session_grant_with_xref_scope(tmp_path, monkeypatch):
    client, _service, _store = _build_app(tmp_path, _ok_handler)
    client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "granted_capabilities": [
                "external-fetch:annotation",
                "external-fetch:xref-resolution",
            ],
        },
    )

    monkeypatch.setenv(
        "DNAFORGE_MCP_GRANT_CAPABILITIES",
        "external-fetch:annotation,external-fetch:xref-resolution",
    )
    response = client.get(
        "/external/xrefs",
        params={"provider": "uniprot", "external_id": "P00875"},
    )

    assert response.status_code == 200
    assert response.json()["total"] >= 1


def test_post_fetch_forwards_action_id_header_to_service(tmp_path):
    """When /mcp/call dispatches external.fetch, the renderer-bridge passes
    the originating agent_action.id as X-DNAForge-Action-Id. The route MUST
    read it and feed it into FetchRequest.agent_action_id so the service can
    write the agent_artifact row inside the same transaction."""
    client, _service, store = _build_app(tmp_path, _ok_handler)
    store.ensure_agent_identity("agent-1", scope=["external-fetch:annotation"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="external.fetch",
        parameters={"provider": "uniprot", "external_id": "P00875"},
    )

    response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "granted_capabilities": ["external-fetch:annotation"],
        },
        headers={"X-DNAForge-Action-Id": action_id},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["external_resource_id"]


def test_post_fetch_without_action_id_header_still_succeeds(tmp_path):
    """Action-id header is optional. Direct sidecar fetches and harness
    contract tests omit it; the route must not require it."""
    client, _service, _store = _build_app(tmp_path, _ok_handler)
    response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 200


def test_post_fetch_returns_401_when_session_header_missing(tmp_path):
    client, _service, _store = _build_app_no_session(tmp_path, _ok_handler)
    response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "BAD_SESSION"


def test_post_fetch_returns_401_when_session_token_invalid(tmp_path):
    client, _service, _store = _build_app_no_session(tmp_path, _ok_handler)
    response = client.post(
        "/external/fetch",
        headers={"X-DNAForge-Session": "wrong-token"},
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "BAD_SESSION"


def test_post_fetch_returns_500_when_session_token_not_configured(
    tmp_path, monkeypatch
):
    """Operator misconfiguration (env unset) surfaces as a 500
    MCP_SESSION_NOT_CONFIGURED — same shape /mcp/call uses."""
    monkeypatch.delenv("DNAFORGE_MCP_SESSION_TOKEN", raising=False)
    client, _service, _store = _build_app_no_session(tmp_path, _ok_handler)
    response = client.post(
        "/external/fetch",
        headers={"X-DNAForge-Session": "anything"},
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 500
    assert response.json()["detail"]["code"] == "MCP_SESSION_NOT_CONFIGURED"


def test_get_xrefs_returns_401_when_session_missing(tmp_path):
    client, _service, _store = _build_app_no_session(tmp_path, _ok_handler)
    response = client.get(
        "/external/xrefs",
        params={"provider": "uniprot", "external_id": "P00875"},
    )
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "BAD_SESSION"


def test_get_resource_routes_return_401_when_session_missing(tmp_path):
    """Both /external/resource/{id} and /external/resource/by-external-id
    enforce the session gate."""
    client, _service, _store = _build_app_no_session(tmp_path, _ok_handler)
    r1 = client.get("/external/resource/by-external-id?provider=x&external_id=y")
    r2 = client.get("/external/resource/some-id")
    assert r1.status_code == 401
    assert r2.status_code == 401


def test_post_uniprot_search_returns_401_when_session_missing(tmp_path):
    """'s UniProt search wrapper must enforce the same session gate
    as the rest of /external/* — without it, any local process could
    forge resolver-chain queries + poison external_fetch_log."""
    client, _service, _store = _build_app_no_session(tmp_path, _ok_handler)
    response = client.post(
        "/external/uniprot/search",
        json={"query": "gene:groEL AND organism_id:83333"},
    )
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "BAD_SESSION"


def test_post_afdb_validate_returns_401_when_session_missing(tmp_path):
    """'s AFDB existence check must enforce the same session gate
    as the rest of /external/*."""
    client, _service, _store = _build_app_no_session(tmp_path, _ok_handler)
    response = client.post(
        "/external/alphafold/validate",
        json={"accession": "P0A6F5"},
    )
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "BAD_SESSION"


def test_post_uniprot_search_returns_500_when_session_token_not_configured(
    tmp_path, monkeypatch
):
    """Operator misconfiguration (env unset) on 's UniProt search
    surfaces as a 500 — same shape as /fetch's analogous test, so a future
    per-route refactor of _enforce_session can't drift one route's contract
    out of sync with the others."""
    monkeypatch.delenv("DNAFORGE_MCP_SESSION_TOKEN", raising=False)
    client, _service, _store = _build_app_no_session(tmp_path, _ok_handler)
    response = client.post(
        "/external/uniprot/search",
        headers={"X-DNAForge-Session": "anything"},
        json={"query": "gene:groEL AND organism_id:83333"},
    )
    assert response.status_code == 500
    assert response.json()["detail"]["code"] == "MCP_SESSION_NOT_CONFIGURED"


def test_post_afdb_validate_returns_500_when_session_token_not_configured(
    tmp_path, monkeypatch
):
    """Operator misconfiguration on 's AFDB validate route. Mirrors
    the /fetch + /uniprot/search shape so all three /external/* POST routes
    have lockstep coverage."""
    monkeypatch.delenv("DNAFORGE_MCP_SESSION_TOKEN", raising=False)
    client, _service, _store = _build_app_no_session(tmp_path, _ok_handler)
    response = client.post(
        "/external/alphafold/validate",
        headers={"X-DNAForge-Session": "anything"},
        json={"accession": "P0A6F5"},
    )
    assert response.status_code == 500
    assert response.json()["detail"]["code"] == "MCP_SESSION_NOT_CONFIGURED"


def test_post_fetch_with_empty_action_id_header_succeeds(tmp_path):
    """Empty string header → service treats as unknown action → fail-soft.
    No agent_artifact row written, but the fetch still succeeds and the
    response shape is intact."""
    client, _service, _store = _build_app(tmp_path, _ok_handler)
    response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "granted_capabilities": ["external-fetch:annotation"],
        },
        headers={"X-DNAForge-Action-Id": ""},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["agent_artifact_id"] is None


def test_post_fetch_with_garbage_action_id_header_succeeds(tmp_path):
    """Garbage action_id (non-existent in agent_action table) → service
    fails soft, fetch succeeds, no audit forgery. A future refactor that
    starts raising on unknown action_ids would break this test."""
    client, _service, _store = _build_app(tmp_path, _ok_handler)
    response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "granted_capabilities": ["external-fetch:annotation"],
        },
        headers={"X-DNAForge-Action-Id": "ghost-action-not-in-table"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["agent_artifact_id"] is None


def test_post_fetch_rejects_oversized_provider(tmp_path):
    client, _service, _store = _build_app(tmp_path, _ok_handler)
    response = client.post(
        "/external/fetch",
        json={
            "provider": "p" * 65,
            "external_id": "P00875",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 422


def test_post_fetch_rejects_oversized_external_id(tmp_path):
    """Direct-sidecar caller sends a 50KB external_id — pydantic rejects
    at the schema layer before the DAO ever sees it. Without this bound
    the parameterized SQLite query would still execute (no SQL injection
    risk because the param is positional), but the 50KB blob would be
    written to external_resource.external_id and persisted indefinitely."""
    client, _service, _store = _build_app(tmp_path, _ok_handler)
    response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "x" * 201,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 422


def test_post_fetch_rejects_oversized_workspace_id(tmp_path):
    client, _service, _store = _build_app(tmp_path, _ok_handler)
    response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "workspace_id": "w" * 201,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 422


def test_post_fetch_rejects_oversized_bind_to_relationship(tmp_path):
    client, _service, _store = _build_app(tmp_path, _ok_handler)
    response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "workspace_id": "ws-1",
            "granted_capabilities": ["external-fetch:annotation"],
            "bind_to": {
                "source_kind": "sequence",
                "source_uri": "waypoint://sequence/foo.gb",
                "relationship": "r" * 101,
                "evidence": "asserted",
            },
        },
    )
    assert response.status_code == 422


def test_post_fetch_accepts_valid_lengths(tmp_path):
    """Positive case: lengths exactly at the bounds pass. Asserts the
    bounds are inclusive (<=64 / <=200 / <=100), not strict (<)."""
    client, _service, _store = _build_app(tmp_path, _ok_handler)
    response = client.post(
        "/external/fetch",
        json={
            "provider": "uniprot",
            "external_id": "P00875",
            "workspace_id": "w" * 200,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 200
