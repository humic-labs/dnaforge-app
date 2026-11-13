""" — /external/sequence/bytes route + service-level resilience tests.

Two tiers, both hermetic (httpx.MockTransport, no network):

  - Service tier: calls `ExternalResourcesService.fetch_sequence_bytes`
    directly with controlled `FetchOptions(max_retries=0)` so the resilience
    paths (rate-limit, timeout, contract violation) resolve instantly without
    real backoff sleeps.
  - Route tier: drives the FastAPI route through TestClient to verify Pydantic
    validation, capability gating, session gating, and HTTP status mapping.
"""

from __future__ import annotations

import socket

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.control_plane.store import ControlPlaneStore
from src.external.contract import FetchOptions, ProviderError
from src.external.providers.ncbi_nuccore import NcbiNuccoreProvider
from src.external.public_http import PublicHttpBoundaryError
from src.external.service import (
    CapabilityDenied,
    CircuitOpen,
    ExternalResourcesService,
    SequenceTooLarge,
)
from src.routes import external as external_routes
from src.routes.external import router as external_router

from .conftest import anonymous_client

_GENBANK = """LOCUS       NC_000913            4641652 bp    DNA     circular CON 09-MAR-2022
DEFINITION  Escherichia coli str. K-12 substr. MG1655, complete genome.
ACCESSION   NC_000913
VERSION     NC_000913.3
SOURCE      Escherichia coli str. K-12 substr. MG1655
  ORGANISM  Escherichia coli str. K-12 substr. MG1655
FEATURES             Location/Qualifiers
     source          1..4641652
                     /organism="Escherichia coli str. K-12 substr. MG1655"
                     /db_xref="taxon:511145"
ORIGIN
        1 atgc
//
"""

TEST_MCP_TOKEN = "test-mcp-session"


@pytest.fixture(autouse=True)
def _reset_external_service(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_MCP_TOKEN)
    yield
    external_routes.set_service(None)  # type: ignore[arg-type]


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def _public_resolver(host: str, port: int, **_kwargs) -> list[tuple]:
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]


def _service(tmp_path, handler) -> ExternalResourcesService:
    store = ControlPlaneStore(tmp_path / "seqbytes.sqlite3")
    store.initialize()
    client = _client(handler)
    service = ExternalResourcesService(
        store,
        client=client,
        public_http_resolver=_public_resolver,
    )
    service.register(NcbiNuccoreProvider(client=client))
    return service


def _build_app(tmp_path, handler):
    service = _service(tmp_path, handler)
    external_routes.set_service(service)
    app = FastAPI()
    app.include_router(external_router)
    return (
        TestClient(app, headers={"X-DNAForge-Session": TEST_MCP_TOKEN}),
        service,
        service._store,  # type: ignore[attr-defined]
    )


def _ok_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, text=_GENBANK)


_ANNOTATION = ["external-fetch:annotation"]


async def test_service_success_returns_content_and_provenance(tmp_path):
    service = _service(tmp_path, _ok_handler)
    result = await service.fetch_sequence_bytes(
        provider="ncbi-nuccore",
        external_id="nc_000913.3",
        granted_capabilities=_ANNOTATION,
    )
    assert result.provider == "ncbi-nuccore"
    assert result.external_id == "NC_000913.3"
    assert result.content.startswith(b"LOCUS")
    assert len(result.content_sha256) == 64
    assert result.metadata["organism"].startswith("Escherichia coli")
    assert result.metadata["length"] == 4641652
    assert result.metadata["topology"] == "circular"
    assert result.metadata["taxon_id"] == "511145"
    assert result.source_url and "nuccore/NC_000913.3" in result.source_url
    assert result.license and result.license.startswith("Public domain")
    await service.aclose()


async def test_service_fetches_public_sequence_url_with_bounded_provenance(tmp_path):
    service = _service(tmp_path, _ok_handler)

    result = await service.fetch_sequence_url_bytes(
        source_url="https://example.com/plasmid.gb",
        granted_capabilities=_ANNOTATION,
        workspace_id="workspace-1",
    )

    assert result.provider == "public-url"
    assert result.external_id == "https://example.com/plasmid.gb"
    assert result.content.startswith(b"LOCUS")
    assert len(result.content_sha256) == 64
    assert result.source_url == "https://example.com/plasmid.gb"
    logs = service._store.list_external_fetch_log(provider="public-url")  # type: ignore[attr-defined]
    assert logs[0]["workspace_id"] == "workspace-1"
    await service.aclose()


async def test_service_rejects_private_sequence_url_before_network_io(tmp_path):
    called = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(200, text=_GENBANK)

    async def private_resolver(host: str, port: int, **_kwargs) -> list[tuple]:
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))]

    store = ControlPlaneStore(tmp_path / "private-url.sqlite3")
    store.initialize()
    client = _client(handler)
    service = ExternalResourcesService(
        store,
        client=client,
        public_http_resolver=private_resolver,
    )

    with pytest.raises(PublicHttpBoundaryError, match="public host"):
        await service.fetch_sequence_url_bytes(
            source_url="https://private.example/plasmid.gb",
            granted_capabilities=_ANNOTATION,
        )
    assert called is False
    await service.aclose()


async def test_service_unrecognized_id_raises_422(tmp_path):
    service = _service(tmp_path, _ok_handler)
    with pytest.raises(ProviderError) as exc:
        await service.fetch_sequence_bytes(
            provider="ncbi-nuccore",
            external_id="not-an-accession",
            granted_capabilities=_ANNOTATION,
        )
    assert exc.value.status_code == 422
    await service.aclose()


async def test_service_capability_denied(tmp_path):
    service = _service(tmp_path, _ok_handler)
    with pytest.raises(CapabilityDenied):
        await service.fetch_sequence_bytes(
            provider="ncbi-nuccore",
            external_id="NC_000913.3",
            granted_capabilities=[],
        )
    await service.aclose()


async def test_service_unknown_provider(tmp_path):
    from src.external.service import UnknownProvider

    service = _service(tmp_path, _ok_handler)
    with pytest.raises(UnknownProvider):
        await service.fetch_sequence_bytes(
            provider="ensembl",
            external_id="NC_000913.3",
            granted_capabilities=_ANNOTATION,
        )
    await service.aclose()


async def test_service_malformed_body_raises_contract_error(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="not a genbank record at all")

    service = _service(tmp_path, handler)
    with pytest.raises(ProviderError) as exc:
        await service.fetch_sequence_bytes(
            provider="ncbi-nuccore",
            external_id="NC_000913.3",
            granted_capabilities=_ANNOTATION,
            opts=FetchOptions(max_retries=0),
        )
    assert exc.value.failure_kind == "provider_contract_error"
    await service.aclose()


async def test_service_rate_limited_exhausts_retries(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="slow down")

    service = _service(tmp_path, handler)
    with pytest.raises(ProviderError) as exc:
        await service.fetch_sequence_bytes(
            provider="ncbi-nuccore",
            external_id="NC_000913.3",
            granted_capabilities=_ANNOTATION,
            opts=FetchOptions(max_retries=0),
        )
    assert exc.value.failure_kind == "rate_limited"
    await service.aclose()


async def test_service_timeout(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("too slow", request=request)

    service = _service(tmp_path, handler)
    with pytest.raises(ProviderError) as exc:
        await service.fetch_sequence_bytes(
            provider="ncbi-nuccore",
            external_id="NC_000913.3",
            granted_capabilities=_ANNOTATION,
            opts=FetchOptions(max_retries=0),
        )
    assert exc.value.failure_kind == "timeout"
    await service.aclose()


async def test_service_circuit_opens_after_repeated_failure(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    service = _service(tmp_path, handler)
    for _ in range(10):
        try:
            await service.fetch_sequence_bytes(
                provider="ncbi-nuccore",
                external_id="NC_000913.3",
                granted_capabilities=_ANNOTATION,
                opts=FetchOptions(max_retries=0),
            )
        except CircuitOpen:
            break
        except ProviderError:
            continue
    else:
        pytest.fail("circuit breaker never opened after repeated 5xx")
    await service.aclose()


def test_route_success(tmp_path):
    client, service, _store = _build_app(tmp_path, _ok_handler)
    resp = client.post(
        "/external/sequence/bytes",
        json={
            "provider": "ncbi-nuccore",
            "external_id": "NC_000913.3",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["provider"] == "ncbi-nuccore"
    assert body["external_id"] == "NC_000913.3"
    assert body["content"].startswith("LOCUS")
    assert len(body["content_sha256"]) == 64
    assert body["metadata"]["organism"].startswith("Escherichia coli")
    assert body["source_url"].endswith("/nuccore/NC_000913.3")
    assert body["license"].startswith("Public domain")


def test_url_route_success(tmp_path):
    client, _service, _store = _build_app(tmp_path, _ok_handler)
    resp = client.post(
        "/external/sequence/url-bytes",
        json={
            "url": "https://example.com/plasmid.gb",
            "workspace_id": "workspace-1",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "provider": "public-url",
        "external_id": "https://example.com/plasmid.gb",
        "format": "auto",
        "content": _GENBANK,
        "content_sha256": resp.json()["content_sha256"],
        "source_url": "https://example.com/plasmid.gb",
        "license": None,
        "attribution": "Source: example.com",
        "version_identifier": None,
        "etag": None,
        "metadata": {},
    }


def test_url_route_requires_annotation_capability(tmp_path):
    client, _service, _store = _build_app(tmp_path, _ok_handler)
    resp = client.post(
        "/external/sequence/url-bytes",
        json={"url": "https://example.com/plasmid.gb", "granted_capabilities": []},
    )

    assert resp.status_code == 403


def test_route_bad_accession_error_body_maps_to_502(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="Error: nothing to do\n")

    client, _service, _store = _build_app(tmp_path, handler)
    resp = client.post(
        "/external/sequence/bytes",
        json={
            "provider": "ncbi-nuccore",
            "external_id": "NC_999999.9",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert resp.status_code == 502
    assert resp.json()["detail"]["failure_kind"] == "provider_contract_error"


def test_route_unrecognized_id_maps_to_422(tmp_path):
    client, _service, _store = _build_app(tmp_path, _ok_handler)
    resp = client.post(
        "/external/sequence/bytes",
        json={
            "provider": "ncbi-nuccore",
            "external_id": "definitely-not-an-id",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert resp.status_code == 422


def test_route_records_fetch_log_row(tmp_path):
    client, _service, store = _build_app(tmp_path, _ok_handler)
    resp = client.post(
        "/external/sequence/bytes",
        json={
            "provider": "ncbi-nuccore",
            "external_id": "NC_000913.3",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert resp.status_code == 200
    logs = store.list_external_fetch_log(provider="ncbi-nuccore")
    assert any(row["bytes_received"] and row["bytes_received"] > 0 for row in logs)


def test_route_missing_session_rejected(tmp_path):
    service = _service(tmp_path, _ok_handler)
    external_routes.set_service(service)
    app = FastAPI()
    app.include_router(external_router)
    no_auth = anonymous_client(app)
    resp = no_auth.post(
        "/external/sequence/bytes",
        json={"provider": "ncbi-nuccore", "external_id": "NC_000913.3"},
    )
    assert resp.status_code == 401


def test_route_rejects_unknown_provider_via_pydantic(tmp_path):
    client, _service, _store = _build_app(tmp_path, _ok_handler)
    resp = client.post(
        "/external/sequence/bytes",
        json={"provider": "ensembl", "external_id": "NC_000913.3"},
    )
    assert resp.status_code == 422


def _granted(extra: dict | None = None) -> dict:
    body = {
        "provider": "ncbi-nuccore",
        "external_id": "NC_000913.3",
        "granted_capabilities": ["external-fetch:annotation"],
    }
    if extra:
        body.update(extra)
    return body


async def test_service_oversized_record_rejected(tmp_path):
    service = _service(tmp_path, _ok_handler)
    with pytest.raises(SequenceTooLarge):
        await service.fetch_sequence_bytes(
            provider="ncbi-nuccore",
            external_id="NC_000913.3",
            granted_capabilities=_ANNOTATION,
            max_bytes=10,
        )
    await service.aclose()


async def test_service_within_cap_succeeds(tmp_path):
    service = _service(tmp_path, _ok_handler)
    result = await service.fetch_sequence_bytes(
        provider="ncbi-nuccore",
        external_id="NC_000913.3",
        granted_capabilities=_ANNOTATION,
        max_bytes=10_000_000,
    )
    assert result.content.startswith(b"LOCUS")
    await service.aclose()


def test_route_oversized_maps_to_413(tmp_path, monkeypatch):
    client, service, _store = _build_app(tmp_path, _ok_handler)

    async def _raise(**_kwargs):
        raise SequenceTooLarge(200_000_000, 100_000_000)

    monkeypatch.setattr(service, "fetch_sequence_bytes", _raise)
    resp = client.post("/external/sequence/bytes", json=_granted())
    assert resp.status_code == 413
    detail = resp.json()["detail"]
    assert detail["failure_kind"] == "sequence_too_large"
    assert detail["max_bytes"] == 100_000_000


def test_route_rate_limited_maps_to_502(tmp_path, monkeypatch):
    monkeypatch.setattr("src.external.service._backoff_wait", lambda *a, **k: 0.0)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="slow down")

    client, _service, _store = _build_app(tmp_path, handler)
    resp = client.post("/external/sequence/bytes", json=_granted())
    assert resp.status_code == 502
    assert resp.json()["detail"]["failure_kind"] == "rate_limited"


def test_route_timeout_maps_to_502(tmp_path, monkeypatch):
    monkeypatch.setattr("src.external.service._backoff_wait", lambda *a, **k: 0.0)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("too slow", request=request)

    client, _service, _store = _build_app(tmp_path, handler)
    resp = client.post("/external/sequence/bytes", json=_granted())
    assert resp.status_code == 502
    assert resp.json()["detail"]["failure_kind"] == "timeout"


def test_route_circuit_open_maps_to_503(tmp_path):
    import time as _time

    from src.external.service import _CircuitBreaker

    client, service, _store = _build_app(tmp_path, _ok_handler)
    service._breakers["ncbi-nuccore"] = _CircuitBreaker(
        consecutive_failures=5, opened_at_monotonic=_time.monotonic()
    )
    resp = client.post("/external/sequence/bytes", json=_granted())
    assert resp.status_code == 503
    assert resp.json()["detail"]["error"] == "circuit_open"
