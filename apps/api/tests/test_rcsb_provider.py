""" - RCSB provider foundation tests.

Hermetic tests for the sidecar RCSB metadata provider. No real RCSB traffic:
httpx.MockTransport supplies trimmed real-shape payloads.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.control_plane.store import ControlPlaneStore
from src.external.contract import (
    Capability,
    ExternalProvider,
    FetchOptions,
    ProviderHttpError,
    ProviderTimeoutError,
)
from src.external.providers import RCSBProvider
from src.external.providers.rcsb import _extract_entry_metadata
from src.external.service import (
    CapabilityDenied,
    ExternalResourcesService,
    FetchRequest,
)
from src.routes import external as external_routes
from src.routes.external import router as external_router

TEST_MCP_TOKEN = "test-mcp-session"


@pytest.fixture(autouse=True)
def _reset_external_service(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_MCP_TOKEN)
    yield
    external_routes.set_service(None)  # type: ignore[arg-type]


def _rcsb_entry_payload(
    pdb_id: str = "1RBL",
    *,
    polymer_entity_ids: list[str] | None = None,
) -> dict[str, Any]:
    if polymer_entity_ids is None:
        polymer_entity_ids = ["1"]
    return {
        "rcsb_id": pdb_id,
        "rcsb_entry_container_identifiers": {
            "entry_id": pdb_id,
            "polymer_entity_ids": polymer_entity_ids,
            "assembly_ids": ["1"],
        },
        "struct": {
            "title": "Ribulose bisphosphate carboxylase large chain crystal structure"
        },
        "exptl": [{"method": "X-RAY DIFFRACTION"}],
        "rcsb_entry_info": {"resolution_combined": [2.2]},
        "rcsb_accession_info": {
            "deposit_date": "1991-01-15",
            "initial_release_date": "1991-04-15",
            "revision_date": "2024-06-12",
            "major_revision": 1,
            "minor_revision": 3,
        },
        "audit_author": [{"name": "Schneider, G."}, {"name": "Lindqvist, Y."}],
        "rcsb_primary_citation": {
            "title": "Crystal structure of ribulose bisphosphate carboxylase",
            "pdbx_database_id_doi": "10.2210/pdb1rbl/pdb",
            "pdbx_database_id_pub_med": 123456,
            "year": 1991,
        },
    }


def _rcsb_polymer_entity_payload(
    *,
    entity_id: str = "1",
    asym_ids: list[str] | None = None,
    auth_asym_ids: list[str] | None = None,
    sequence: str | None = "MKTAYIAKQRQISFVKSHFSRQ",
    sample_sequence_length: int | None = None,
) -> dict[str, Any]:
    if asym_ids is None:
        asym_ids = ["A", "B"]
    if auth_asym_ids is None:
        auth_asym_ids = ["A", "B"]

    entity_poly: dict[str, Any] = {"type": "polypeptide(L)"}
    if sequence is not None:
        entity_poly["pdbx_seq_one_letter_code_can"] = sequence
    if sample_sequence_length is not None:
        entity_poly["rcsb_sample_sequence_length"] = sample_sequence_length

    return {
        "rcsb_polymer_entity_container_identifiers": {
            "entry_id": "1RBL",
            "entity_id": entity_id,
            "asym_ids": asym_ids,
            "auth_asym_ids": auth_asym_ids,
            "uniprot_ids": ["P00880"],
            "reference_sequence_identifiers": [
                {"database_name": "UniProt", "database_accession": "P00880"}
            ],
        },
        "rcsb_polymer_entity": {
            "pdbx_description": "Ribulose bisphosphate carboxylase large chain"
        },
        "entity_poly": entity_poly,
        "rcsb_entity_source_organism": [
            {"ncbi_scientific_name": "Synechococcus elongatus"}
        ],
    }


def _rcsb_handler(
    *,
    entry: dict[str, Any] | None = None,
    entities: dict[str, dict[str, Any]] | None = None,
    entry_headers: dict[str, str] | None = None,
    calls: list[str] | None = None,
):
    if entry is None:
        entry = _rcsb_entry_payload()
    if entities is None:
        entities = {"1": _rcsb_polymer_entity_payload()}

    def handler(request):
        if calls is not None:
            calls.append(request.url.path)

        if request.url.path.startswith("/rest/v1/core/entry/"):
            return httpx.Response(200, json=entry, headers=entry_headers)

        if request.url.path.startswith("/rest/v1/core/polymer_entity/"):
            entity_id = request.url.path.rsplit("/", 1)[-1]
            entity = entities.get(entity_id)
            if entity is None:
                return httpx.Response(404, json={"error": "unexpected entity"})
            return httpx.Response(200, json=entity)

        return httpx.Response(404, json={"error": "unexpected URL"})

    return handler


def _service_with_handler(
    tmp_path,
    handler,
    *,
    rate_limit_per_s: float = 100.0,
    rate_limit_burst: float = 100.0,
) -> tuple[ExternalResourcesService, ControlPlaneStore]:
    store = ControlPlaneStore(tmp_path / "rcsb.sqlite3")
    store.initialize()
    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport)
    service = ExternalResourcesService(
        store,
        client=client,
        rate_limit_per_s=rate_limit_per_s,
        rate_limit_burst=rate_limit_burst,
    )
    service.register(RCSBProvider(client=client))
    return service, store


def _granted_annotation() -> list[str]:
    return [Capability.EXTERNAL_FETCH_ANNOTATION.value]


def _granted_homology() -> list[str]:
    return [Capability.EXTERNAL_FETCH_HOMOLOGY.value]


def test_rcsb_provider_detects_pdb_ids_and_optional_chain():
    provider = RCSBProvider()

    canonical = provider.detect_id(" 1rbl ")
    assert canonical is not None
    assert canonical.canonical_id == "1RBL"
    assert canonical.provider == "rcsb"
    assert canonical.chain is None
    assert canonical.cache_key() == "RCSB:1RBL:ENTRY"

    chain = provider.detect_id("1rbl/a")
    assert chain is not None
    assert chain.canonical_id == "1RBL"
    assert chain.chain == "a"
    assert chain.cache_key() == "RCSB:1RBL:ENTRY:AUTH_ASYM:a"

    chain_entity = provider.detect_id("1rbl/a#1")
    assert chain_entity is not None
    assert chain_entity.canonical_id == "1RBL"
    assert chain_entity.chain == "a"
    assert chain_entity.entity == "1"
    assert chain_entity.cache_key() == "RCSB:1RBL:ENTRY:ENTITY:1:AUTH_ASYM:a"

    scoped = provider.detect_id("RCSB:1rbl:ENTRY:ENTITY:1:LABEL_ASYM:A,B")
    assert scoped is not None
    assert scoped.canonical_id == "1RBL"
    assert scoped.chain is None
    assert scoped.entity == "1"
    assert scoped.cache_key() == "RCSB:1RBL:ENTRY:ENTITY:1:LABEL_ASYM:A,B"


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "P00875",
        "RBL1",
        "12",
        "1RBL/",
        "1RBL//",
        "1RBL/,",
        "1RBL/,,",
        "1RBL/#",
        "1RBL/A#",
        "1RBL/A#,1",
        "1RBL/A,A",
        "1RBL/A/B",
        "RCSB:1RBL",
        "RCSB:1RBL:ENTRY:UNKNOWN:foo",
        "RCSB:1RBL:ENTRY:ASSEMBLY:",
        "RCSB:1RBL:ENTRY:AUTH_ASYM:A,",
        "RCSB:1RBL:ENTRY:AUTH_ASYM:,A",
        "RCSB:1RBL:ENTRY:AUTH_ASYM:A,,B",
        "RCSB:1RBL:ENTRY:AUTH_ASYM:A,A",
        "RCSB:1RBL:ENTRY:ENTITY:1:ENTITY:2",
    ],
)
def test_rcsb_provider_rejects_non_pdb_ids(raw):
    assert RCSBProvider().detect_id(raw) is None


def test_rcsb_metadata_parser_normalizes_candidate_shape():
    metadata = _extract_entry_metadata(
        _rcsb_entry_payload(),
        [_rcsb_polymer_entity_payload()],
    )

    assert metadata["pdb_id"] == "1RBL"
    assert metadata["title"].startswith("Ribulose bisphosphate")
    assert metadata["experimental_method"] == "X-RAY DIFFRACTION"
    assert metadata["resolution"] == 2.2
    assert metadata["revision_version"] == "1.3"
    assert metadata["organism"] == "Synechococcus elongatus"
    assert metadata["chain_ids"] == ["A", "B"]
    assert metadata["polymer_entity_ids"] == ["1"]
    assert metadata["chains"] == [
        {
            "entity_id": "1",
            "description": "Ribulose bisphosphate carboxylase large chain",
            "polymer_type": "polypeptide(L)",
            "asym_ids": ["A", "B"],
            "auth_asym_ids": ["A", "B"],
            "chain_id_pairs": [
                {"label_asym_id": "A", "auth_asym_id": "A"},
                {"label_asym_id": "B", "auth_asym_id": "B"},
            ],
            "organism": "Synechococcus elongatus",
            "source_organisms": ["Synechococcus elongatus"],
            "sequence_length": 22,
            "uniprot_ids": ["P00880"],
            "reference_sequence_identifiers": [
                {"database_name": "UniProt", "database_accession": "P00880"}
            ],
        }
    ]
    assert metadata["primary_citation"]["doi"] == "10.2210/pdb1rbl/pdb"


def test_rcsb_chain_metadata_uses_sample_length_when_sequence_is_absent():
    metadata = _extract_entry_metadata(
        _rcsb_entry_payload(),
        [
            _rcsb_polymer_entity_payload(
                sequence=None,
                sample_sequence_length=467,
            )
        ],
    )

    assert metadata["chains"][0]["sequence_length"] == 467


def test_rcsb_provider_conforms_to_external_provider_protocol():
    assert isinstance(RCSBProvider(), ExternalProvider)


def test_rcsb_provider_declares_metadata_and_homology_capabilities():
    caps = RCSBProvider().declared_capabilities()
    assert caps == [
        Capability.EXTERNAL_FETCH_ANNOTATION,
        Capability.EXTERNAL_FETCH_HOMOLOGY,
    ]
    assert Capability.EXTERNAL_FETCH_STRUCTURE not in caps


def test_rcsb_provider_license_and_attribution_are_explicit():
    assert RCSBProvider.LICENSE == "CC0-1.0"
    assert "RCSB Protein Data Bank" in RCSBProvider.ATTRIBUTION
    assert RCSBProvider.POLICY_URL.startswith("https://www.rcsb.org/")


@pytest.mark.asyncio
async def test_rcsb_sequence_search_posts_polymer_sequence_query_and_parses_hits(
    tmp_path,
):
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
                            "score": 91.5,
                            "services": [
                                {
                                    "nodes": [
                                        {
                                            "match_context": [
                                                {
                                                    "sequence_identity": 0.97,
                                                    "evalue": 1.2e-20,
                                                    "bitscore": 150.0,
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

    service, store = _service_with_handler(tmp_path, handler)

    hits = await service.search_rcsb_by_sequence(
        "AUGCUAGCUAGCUAGCUAGCUAGCUAGCUA",
        sequence_type="rna",
        granted_capabilities=_granted_homology(),
        identity_cutoff=0.95,
        evalue_cutoff=0.001,
        size=7,
    )

    assert seen["body"]["query"]["service"] == "sequence"
    assert seen["body"]["query"]["parameters"] == {
        "value": "AUGCUAGCUAGCUAGCUAGCUAGCUAGCUA",
        "sequence_type": "rna",
        "identity_cutoff": 0.95,
        "evalue_cutoff": 0.001,
    }
    assert seen["body"]["return_type"] == "polymer_entity"
    assert seen["body"]["request_options"]["paginate"] == {"start": 0, "rows": 7}
    assert len(hits) == 1
    hit = hits[0]
    assert hit.identifier == "4GXY_1"
    assert hit.pdb_id == "4GXY"
    assert hit.entity_id == "1"
    assert hit.score == 91.5
    assert hit.sequence_identity == 0.97
    assert hit.evalue == 1.2e-20
    assert hit.bit_score == 150.0
    logs = store.list_external_fetch_log(provider="rcsb")
    assert len(logs) == 1
    assert logs[0]["endpoint"] == "https://search.rcsb.org/rcsbsearch/v2/query"
    assert logs[0]["capability_check_json"] == {
        "required": ["external-fetch:homology-search"],
        "granted": ["external-fetch:homology-search"],
        "satisfied": True,
    }


@pytest.mark.asyncio
async def test_rcsb_sequence_search_rejects_annotation_only_grant_before_network(
    tmp_path,
):
    network_calls = 0

    def handler(request):
        nonlocal network_calls
        network_calls += 1
        return httpx.Response(200, json={"result_set": []})

    service, _store = _service_with_handler(tmp_path, handler)

    with pytest.raises(CapabilityDenied) as exc_info:
        await service.search_rcsb_by_sequence(
            "AUGCUAGCUAGCUAGCUAGCUAGCUAGCUA",
            sequence_type="rna",
            granted_capabilities=_granted_annotation(),
        )

    assert exc_info.value.required == ["external-fetch:homology-search"]
    assert exc_info.value.granted == ["external-fetch:annotation"]
    assert network_calls == 0
    await service.aclose()


@pytest.mark.asyncio
async def test_rcsb_fetch_persists_metadata_license_attribution_and_fetch_log(tmp_path):
    calls: list[str] = []
    service, store = _service_with_handler(
        tmp_path,
        _rcsb_handler(
            entry_headers={"ETag": '"rcsb-entry-1rbl"'},
            calls=calls,
        ),
    )

    response = await service.fetch(
        FetchRequest(
            provider="rcsb",
            raw_id="1rbl",
            workspace_id="ws-structure",
            granted_capabilities=_granted_annotation(),
        )
    )

    assert response.cache_hit is False
    assert response.license == "CC0-1.0"
    assert "RCSB Protein Data Bank" in (response.attribution or "")
    assert response.xref_count == 0
    assert response.metadata["pdb_id"] == "1RBL"
    assert response.metadata["provider_url"] == "https://www.rcsb.org/structure/1RBL"
    assert response.metadata["structure_file_urls"]["mmcif"].endswith("/1RBL.cif")
    assert response.metadata["usage_terms"]["license"] == "CC0-1.0"
    assert response.metadata["source"]["polymer_entity_urls"] == [
        "https://data.rcsb.org/rest/v1/core/polymer_entity/1RBL/1"
    ]

    row = store.get_external_resource_by_external_id("rcsb", "RCSB:1RBL:ENTRY")
    assert row is not None
    assert row["license"] == "CC0-1.0"
    assert "RCSB Protein Data Bank" in (row["attribution"] or "")
    assert row["version_identifier"] == "1.3"
    assert row["etag"] == '"rcsb-entry-1rbl"'
    assert row["metadata_json"]["chains"][0]["auth_asym_ids"] == ["A", "B"]
    assert calls == [
        "/rest/v1/core/entry/1RBL",
        "/rest/v1/core/polymer_entity/1RBL/1",
    ]

    logs = store.list_external_fetch_log(provider="rcsb")
    assert len(logs) == 1
    assert logs[0]["workspace_id"] == "ws-structure"
    assert logs[0]["failure_kind"] is None
    assert logs[0]["cache_hit"] == 0
    assert logs[0]["bytes_received"] is not None

    await service.aclose()


@pytest.mark.asyncio
async def test_rcsb_fetch_chain_selector_uses_chain_scoped_cache_key(tmp_path):
    service, store = _service_with_handler(tmp_path, _rcsb_handler())

    response = await service.fetch(
        FetchRequest(
            provider="rcsb",
            raw_id="1rbl/A",
            granted_capabilities=_granted_annotation(),
        )
    )

    assert response.metadata["pdb_id"] == "1RBL"
    assert response.metadata["requested_chain"] == "A"
    assert (
        store.get_external_resource_by_external_id(
            "rcsb", "RCSB:1RBL:ENTRY:AUTH_ASYM:A"
        )
        is not None
    )
    await service.aclose()


@pytest.mark.asyncio
async def test_rcsb_404_propagates_and_logs_without_persisting_resource(tmp_path):
    service, store = _service_with_handler(
        tmp_path, lambda request: httpx.Response(404, json={"error": "not found"})
    )

    with pytest.raises(ProviderHttpError) as exc:
        await service.fetch(
            FetchRequest(
                provider="rcsb",
                raw_id="9XYZ",
                granted_capabilities=_granted_annotation(),
            ),
            opts=FetchOptions(max_retries=0),
        )

    assert exc.value.status_code == 404
    assert store.get_external_resource_by_external_id("rcsb", "9XYZ") is None
    logs = store.list_external_fetch_log(provider="rcsb")
    assert len(logs) == 1
    assert logs[0]["failure_kind"] == "http_error"
    assert logs[0]["status_code"] == 404
    await service.aclose()


@pytest.mark.asyncio
async def test_rcsb_polymer_entity_failure_logs_without_persisting_resource(tmp_path):
    def handler(request):
        if request.url.path.startswith("/rest/v1/core/entry/"):
            return httpx.Response(200, json=_rcsb_entry_payload())
        return httpx.Response(502, json={"error": "bad gateway"})

    service, store = _service_with_handler(tmp_path, handler)

    with pytest.raises(ProviderHttpError, match="polymer entity 1"):
        await service.fetch(
            FetchRequest(
                provider="rcsb",
                raw_id="1RBL",
                granted_capabilities=_granted_annotation(),
            ),
            opts=FetchOptions(max_retries=0),
        )

    assert store.get_external_resource_by_external_id("rcsb", "1RBL") is None
    logs = store.list_external_fetch_log(provider="rcsb")
    assert len(logs) == 1
    assert logs[0]["failure_kind"] == "http_error"
    assert logs[0]["status_code"] == 502
    await service.aclose()


@pytest.mark.asyncio
async def test_rcsb_rejects_mismatched_polymer_entity_identity(tmp_path):
    service, store = _service_with_handler(
        tmp_path,
        _rcsb_handler(
            entities={
                "1": _rcsb_polymer_entity_payload(
                    entity_id="2",
                )
            }
        ),
    )

    with pytest.raises(ProviderHttpError, match="polymer entity '2'"):
        await service.fetch(
            FetchRequest(
                provider="rcsb",
                raw_id="1RBL",
                granted_capabilities=_granted_annotation(),
            ),
            opts=FetchOptions(max_retries=0),
        )

    assert store.get_external_resource_by_external_id("rcsb", "1RBL") is None
    await service.aclose()


@pytest.mark.asyncio
async def test_rcsb_rejects_missing_polymer_entity_identity(tmp_path):
    entity = _rcsb_polymer_entity_payload()
    entity["rcsb_polymer_entity_container_identifiers"].pop("entry_id")
    service, store = _service_with_handler(
        tmp_path,
        _rcsb_handler(entities={"1": entity}),
    )

    with pytest.raises(ProviderHttpError, match="omitted entry_id"):
        await service.fetch(
            FetchRequest(
                provider="rcsb",
                raw_id="1RBL",
                granted_capabilities=_granted_annotation(),
            ),
            opts=FetchOptions(max_retries=0),
        )

    assert store.get_external_resource_by_external_id("rcsb", "1RBL") is None
    await service.aclose()


@pytest.mark.asyncio
async def test_rcsb_rejects_missing_entity_scope_before_polymer_fanout(tmp_path):
    calls: list[str] = []
    service, store = _service_with_handler(
        tmp_path,
        _rcsb_handler(calls=calls),
    )

    with pytest.raises(ProviderHttpError, match="entity '999'"):
        await service.fetch(
            FetchRequest(
                provider="rcsb",
                raw_id="RCSB:1RBL:ENTRY:ENTITY:999",
                granted_capabilities=_granted_annotation(),
            ),
            opts=FetchOptions(max_retries=0),
        )

    assert calls == ["/rest/v1/core/entry/1RBL"]
    assert (
        store.get_external_resource_by_external_id("rcsb", "RCSB:1RBL:ENTRY:ENTITY:999")
        is None
    )
    await service.aclose()


@pytest.mark.asyncio
async def test_rcsb_429_retry_after_is_honored_then_success(tmp_path):
    attempts = {"entry": 0}
    success_handler = _rcsb_handler()

    def handler(request):
        if request.url.path.startswith("/rest/v1/core/entry/"):
            attempts["entry"] += 1
        if attempts["entry"] == 1:
            return httpx.Response(
                429,
                json={"error": "rate limited"},
                headers={"Retry-After": "0.001"},
            )
        return success_handler(request)

    service, _ = _service_with_handler(tmp_path, handler)
    response = await service.fetch(
        FetchRequest(
            provider="rcsb",
            raw_id="1RBL",
            granted_capabilities=_granted_annotation(),
        ),
        opts=FetchOptions(initial_backoff_s=10.0, max_retries=1),
    )

    assert attempts["entry"] == 2
    assert response.metadata["pdb_id"] == "1RBL"
    await service.aclose()


@pytest.mark.asyncio
async def test_rcsb_timeout_logs_failure_kind(tmp_path):
    def handler(request):
        raise httpx.TimeoutException("simulated timeout")

    service, store = _service_with_handler(tmp_path, handler)

    with pytest.raises(ProviderTimeoutError):
        await service.fetch(
            FetchRequest(
                provider="rcsb",
                raw_id="1RBL",
                granted_capabilities=_granted_annotation(),
            ),
            opts=FetchOptions(max_retries=0),
        )

    logs = store.list_external_fetch_log(provider="rcsb")
    assert len(logs) == 1
    assert logs[0]["failure_kind"] == "timeout"
    await service.aclose()


@pytest.mark.asyncio
async def test_rcsb_malformed_payload_raises_provider_http_error(tmp_path):
    service, _ = _service_with_handler(
        tmp_path, lambda request: httpx.Response(200, content=b"<html>not json</html>")
    )

    with pytest.raises(ProviderHttpError, match="malformed JSON"):
        await service.fetch(
            FetchRequest(
                provider="rcsb",
                raw_id="1RBL",
                granted_capabilities=_granted_annotation(),
            ),
            opts=FetchOptions(max_retries=0),
        )
    await service.aclose()


@pytest.mark.asyncio
async def test_rcsb_response_identity_mismatch_is_rejected(tmp_path):
    service, store = _service_with_handler(
        tmp_path,
        _rcsb_handler(entry=_rcsb_entry_payload("2ABC")),
    )

    with pytest.raises(ProviderHttpError, match="returned data for"):
        await service.fetch(
            FetchRequest(
                provider="rcsb",
                raw_id="1RBL",
                granted_capabilities=_granted_annotation(),
            ),
            opts=FetchOptions(max_retries=0),
        )

    assert store.get_external_resource_by_external_id("rcsb", "1RBL") is None
    await service.aclose()


@pytest.mark.asyncio
async def test_rcsb_capability_denied_fails_before_network(tmp_path):
    network_calls = {"n": 0}

    def handler(request):
        network_calls["n"] += 1
        return httpx.Response(200, json=_rcsb_entry_payload())

    service, store = _service_with_handler(tmp_path, handler)
    with pytest.raises(CapabilityDenied):
        await service.fetch(
            FetchRequest(
                provider="rcsb",
                raw_id="1RBL",
                granted_capabilities=[],
            )
        )

    assert network_calls["n"] == 0
    logs = store.list_external_fetch_log(provider="rcsb")
    assert logs[0]["failure_kind"] == "capability_denied"
    await service.aclose()


def test_external_fetch_route_supports_rcsb_metadata_lookup(tmp_path):
    store = ControlPlaneStore(tmp_path / "routes.sqlite3")
    store.initialize()
    transport = httpx.MockTransport(
        _rcsb_handler(entry_headers={"ETag": '"route-etag"'})
    )
    client = httpx.AsyncClient(transport=transport)
    service = ExternalResourcesService(store, client=client)
    service.register(RCSBProvider(client=client))
    external_routes.set_service(service)

    app = FastAPI()
    app.include_router(external_router)
    test_client = TestClient(app, headers={"X-DNAForge-Session": TEST_MCP_TOKEN})

    response = test_client.post(
        "/external/fetch",
        json={
            "provider": "rcsb",
            "external_id": "1rbl",
            "workspace_id": "ws-route",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["provider"] == "rcsb"
    assert body["external_id"] == "RCSB:1RBL:ENTRY"
    assert body["license"] == "CC0-1.0"
    assert body["metadata"]["pdb_id"] == "1RBL"
    assert body["metadata"]["experimental_method"] == "X-RAY DIFFRACTION"
    assert body["metadata"]["resolution"] == 2.2
    assert body["metadata"]["chain_ids"] == ["A", "B"]
    assert body["xref_count"] == 0

    persisted = store.get_external_resource_by_external_id("rcsb", "RCSB:1RBL:ENTRY")
    assert persisted is not None
    assert persisted["etag"] == '"route-etag"'


@pytest.mark.asyncio
async def test_rcsb_fetch_does_not_create_data_file_or_structure_bytes(tmp_path):
    service, store = _service_with_handler(tmp_path, _rcsb_handler())

    response = await service.fetch(
        FetchRequest(
            provider="rcsb",
            raw_id="1RBL",
            granted_capabilities=_granted_annotation(),
        )
    )
    raw = sqlite3.connect(store.db_path)
    data_files = raw.execute("SELECT COUNT(*) FROM data_file").fetchone()[0]
    resource = raw.execute(
        "SELECT data_file_id FROM external_resource WHERE id = ?",
        (response.external_resource_id,),
    ).fetchone()
    raw.close()

    assert data_files == 0
    assert resource[0] is None
    await service.aclose()
