from __future__ import annotations

import asyncio
import base64
import socket
from collections.abc import AsyncIterator

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.control_plane.store import ControlPlaneStore
from src.external.contract import FetchOptions, ProviderTimeoutError
from src.external.providers import PaperSourceProvider
from src.external.service import ExternalResourcesService
from src.routes import external as external_routes
from src.routes.external import router as external_router

TEST_MCP_TOKEN = "test-mcp-session"
PAPER_CAP = "external-fetch:paper"


async def _public_resolver(
    _host: str, _port: int, *, type: socket.SocketKind
) -> list[tuple]:
    assert type == socket.SOCK_STREAM
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))]


@pytest.fixture(autouse=True)
def _session_env(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_MCP_TOKEN)
    yield
    external_routes.set_service(None)  # type: ignore[arg-type]


def _build_app(tmp_path, handler) -> tuple[TestClient, ControlPlaneStore]:
    store = ControlPlaneStore(tmp_path / "paper.sqlite3")
    store.initialize()
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ExternalResourcesService(store, client=client)
    service.register(PaperSourceProvider(client=client, resolver=_public_resolver))
    external_routes.set_service(service)
    app = FastAPI()
    app.include_router(external_router)
    return TestClient(app, headers={"X-DNAForge-Session": TEST_MCP_TOKEN}), store


def _build_service(
    tmp_path, handler, *, resolver=_public_resolver
) -> tuple[ExternalResourcesService, httpx.AsyncClient, ControlPlaneStore]:
    store = ControlPlaneStore(tmp_path / "paper-service.sqlite3")
    store.initialize()
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ExternalResourcesService(store, client=client)
    service.register(PaperSourceProvider(client=client, resolver=resolver))
    return service, client, store


def test_post_paper_source_returns_exact_pdf_bytes_and_provenance(tmp_path):
    pdf = b"%PDF-1.7\nroute fixture"

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == "https://example.org/paper.pdf"
        return httpx.Response(
            200, content=pdf, headers={"Content-Type": "application/pdf"}
        )

    client, _store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/paper/source",
        json={
            "url": "https://example.org/paper.pdf",
            "granted_capabilities": [PAPER_CAP],
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["kind"] == "pdf"
    assert base64.b64decode(body["pdf_base64"]) == pdf
    assert body["response_sha256"].startswith("sha256:")
    assert body["canonical_url"] == "https://example.org/paper.pdf"
    assert body["captured_at"].endswith("Z")


def test_post_paper_source_requires_the_distinct_paper_capability(tmp_path):
    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("network must not run after capability denial")

    client, store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/paper/source",
        json={
            "url": "https://example.org/paper",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"]["required"] == [PAPER_CAP]
    logs = store.list_external_fetch_log(provider="paper-source")
    assert len(logs) == 1
    assert logs[0]["failure_kind"] == "capability_denied"
    assert logs[0]["capability_check_json"] == {
        "required": [PAPER_CAP],
        "granted": ["external-fetch:annotation"],
        "satisfied": False,
    }


def test_post_paper_source_maps_oversize_to_413(tmp_path):
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"small",
            headers={
                "Content-Type": "text/plain",
                "Content-Length": str(25 * 1024 * 1024 + 1),
            },
        )

    client, _store = _build_app(tmp_path, handler)
    response = client.post(
        "/external/paper/source",
        json={"url": "https://example.org/paper", "granted_capabilities": [PAPER_CAP]},
    )

    assert response.status_code == 413
    assert response.json()["detail"]["error"] == "paper_source_too_large"


@pytest.mark.asyncio
async def test_capture_paper_source_bounds_dns_and_logs_one_timeout(tmp_path) -> None:
    resolver_cancelled = asyncio.Event()

    async def slow_resolver(
        _host: str, _port: int, *, type: socket.SocketKind
    ) -> list[tuple]:
        assert type == socket.SOCK_STREAM
        try:
            await asyncio.Event().wait()
        finally:
            resolver_cancelled.set()
        raise AssertionError("cancelled resolver must not resume")

    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("network must not run before DNS admission completes")

    service, client, store = _build_service(tmp_path, handler, resolver=slow_resolver)
    try:
        with pytest.raises(ProviderTimeoutError, match="timed out"):
            await service.capture_paper_source(
                "https://example.org/paper",
                granted_capabilities=[PAPER_CAP],
                opts=FetchOptions(
                    total_timeout_s=0.02,
                    connect_timeout_s=0.01,
                    max_retries=0,
                ),
            )
    finally:
        await client.aclose()

    assert resolver_cancelled.is_set()
    logs = store.list_external_fetch_log(provider="paper-source")
    assert len(logs) == 1
    assert logs[0]["failure_kind"] == "timeout"


class _SlowPaperStream(httpx.AsyncByteStream):
    def __init__(self) -> None:
        self.close_count = 0

    async def __aiter__(self) -> AsyncIterator[bytes]:
        yield b"%PDF-1.7\n"
        await asyncio.Event().wait()

    async def aclose(self) -> None:
        self.close_count += 1


@pytest.mark.asyncio
async def test_capture_paper_source_bounds_trickle_stream_and_closes_it(
    tmp_path,
) -> None:
    stream = _SlowPaperStream()

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            stream=stream,
            headers={"Content-Type": "application/pdf"},
        )

    service, client, store = _build_service(tmp_path, handler)
    try:
        with pytest.raises(ProviderTimeoutError, match="timed out"):
            await service.capture_paper_source(
                "https://example.org/paper.pdf",
                granted_capabilities=[PAPER_CAP],
                opts=FetchOptions(
                    total_timeout_s=0.02,
                    connect_timeout_s=0.01,
                    max_retries=0,
                ),
            )
    finally:
        await client.aclose()

    assert stream.close_count == 1
    logs = store.list_external_fetch_log(provider="paper-source")
    assert len(logs) == 1
    assert logs[0]["failure_kind"] == "timeout"
