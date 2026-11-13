from __future__ import annotations

import asyncio
import gzip

import httpx
import pytest
from fastapi import HTTPException

from src.routes import services


class ObservedStream(httpx.AsyncByteStream):
    def __init__(self, chunks, *, wait=False, error=None):
        self.chunks = chunks
        self.wait = wait
        self.error = error
        self.started = asyncio.Event()
        self.received = 0
        self.yields = 0
        self.closed = False

    async def __aiter__(self):
        self.started.set()
        if self.wait:
            await asyncio.Event().wait()
        for chunk in self.chunks:
            self.received += len(chunk)
            self.yields += 1
            yield chunk
        if self.error:
            raise self.error

    async def aclose(self):
        self.closed = True


class ObservedTransport(httpx.MockTransport):
    def __init__(self, handler):
        super().__init__(handler)
        self.closed = False

    async def aclose(self):
        self.closed = True
        await super().aclose()


@pytest.fixture
def upstream(monkeypatch):
    client_type = httpx.AsyncClient
    requests = []

    def configure(chunks, *, status=200, headers=None, wait=False, error=None):
        stream = ObservedStream(chunks, wait=wait, error=error)

        def handler(request):
            requests.append(request)
            return httpx.Response(status, headers=headers, stream=stream)

        transport = ObservedTransport(handler)
        monkeypatch.setattr(
            services.httpx, "AsyncClient", lambda: client_type(transport=transport)
        )
        return stream, transport

    monkeypatch.setattr(services, "PLUGIN_RESPONSE_MAX_BYTES", 64)
    return configure, requests


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "headers", [{}, {"Content-Length": "1"}, {"Transfer-Encoding": "chunked"}]
)
async def test_excess_stops_without_draining_and_closes(upstream, headers):
    configure, requests = upstream
    stream, transport = configure([b"x" * 8] * 100, headers=headers)
    with pytest.raises(HTTPException) as error:
        await services._execute_plugin("tool", "http://configured-plugin", {})
    assert error.value.status_code == 502
    assert error.value.detail == "Plugin 'tool' response exceeds 64 bytes"
    assert stream.received == 72
    assert stream.yields == 9
    assert stream.closed and transport.closed
    assert len(requests) == 1
    assert requests[0].headers["Accept-Encoding"] == "identity"
    assert requests[0].extensions["timeout"]["read"] == 300


@pytest.mark.asyncio
@pytest.mark.parametrize("size", [64, 65])
async def test_exact_boundary_valid_json(upstream, size):
    configure, requests = upstream
    payload = b'{"ok": true}' + b" " * (size - 12)
    stream, transport = configure([payload[:32], payload[32:64], payload[64:]])
    if size == 64:
        assert await services._execute_plugin(
            "tool", "http://configured-plugin", {"x": 1}
        ) == {"ok": True}
    else:
        with pytest.raises(HTTPException, match="response exceeds 64 bytes"):
            await services._execute_plugin("tool", "http://configured-plugin", {"x": 1})
    assert stream.closed and transport.closed
    assert len(requests) == 1
    assert requests[0].content == b'{"x":1}'
    assert str(requests[0].url) == "http://configured-plugin/execute"


@pytest.mark.asyncio
async def test_declared_excess_is_refused_before_first_body_chunk(upstream):
    configure, requests = upstream
    stream, transport = configure([b"x" * 8] * 100, headers={"Content-Length": "800"})
    with pytest.raises(HTTPException, match="response exceeds 64 bytes"):
        await services._execute_plugin("tool", "http://configured-plugin", {})
    assert stream.received == 0
    assert stream.closed and transport.closed
    assert len(requests) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("encoding", ["gzip", "deflate", "br", "gzip, identity"])
async def test_encoded_body_is_refused_before_consumption_or_decompression(
    upstream, encoding, monkeypatch
):
    configure, requests = upstream
    stream, transport = configure(
        [gzip.compress(b"x" * 100_000)], headers={"Content-Encoding": encoding}
    )
    from httpx._decoders import GZipDecoder

    def decode(self, data):
        pytest.fail("Plugin response must not enter the HTTPX decompressor")

    monkeypatch.setattr(GZipDecoder, "decode", decode)
    with pytest.raises(HTTPException, match="unsupported content encoding") as error:
        await services._execute_plugin("tool", "http://configured-plugin", {})
    assert error.value.status_code == 502
    assert stream.received == 0
    assert stream.closed and transport.closed
    assert len(requests) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("encoding", [None, "", "identity", "Identity"])
async def test_identity_success(upstream, encoding):
    configure, requests = upstream
    headers = {} if encoding is None else {"Content-Encoding": encoding}
    stream, transport = configure([b'{"ok":', b"true}"], headers=headers)
    assert await services._execute_plugin("tool", "http://configured-plugin", {}) == {
        "ok": True
    }
    assert stream.closed and transport.closed
    assert len(requests) == 1


@pytest.mark.asyncio
async def test_http_error_does_not_drain_body(upstream):
    configure, requests = upstream
    stream, transport = configure([b"x" * 8] * 100, status=500)
    with pytest.raises(HTTPException, match="Plugin 'tool' returned HTTP 500"):
        await services._execute_plugin("tool", "http://configured-plugin", {})
    assert stream.received == 0
    assert stream.closed and transport.closed
    assert len(requests) == 1


@pytest.mark.asyncio
async def test_invalid_json_is_typed_and_closed(upstream):
    configure, requests = upstream
    stream, transport = configure([b"not json"])
    with pytest.raises(
        HTTPException, match="Plugin 'tool' returned invalid JSON"
    ) as error:
        await services._execute_plugin("tool", "http://configured-plugin", {})
    assert error.value.status_code == 502
    assert stream.closed and transport.closed
    assert len(requests) == 1


@pytest.mark.asyncio
async def test_read_error_is_not_retried_and_closes(upstream):
    configure, requests = upstream
    stream, transport = configure([b"{"], error=httpx.ReadError("broken stream"))
    with pytest.raises(
        HTTPException, match="Plugin 'tool' is unreachable: broken stream"
    ):
        await services._execute_plugin("tool", "http://configured-plugin", {})
    assert stream.closed and transport.closed
    assert len(requests) == 1


@pytest.mark.asyncio
async def test_cancellation_propagates_and_closes(upstream):
    configure, requests = upstream
    stream, transport = configure([], wait=True)
    task = asyncio.create_task(
        services._execute_plugin("tool", "http://configured-plugin", {})
    )
    await stream.started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert stream.closed and transport.closed
    assert len(requests) == 1


@pytest.mark.parametrize("authorized", [True, False])
def test_authenticated_route_keeps_session_boundary(upstream, authorized):
    from src.main import app
    from src.plugins.registry import plugin_registry
    from tests.sidecar_test_client import AuthenticatedSidecarTestClient

    configure, requests = upstream
    stream, transport = configure([b'{"ok":true}'])
    plugin_registry.register("streaming-tool", "http://configured-plugin", {})
    try:
        client = AuthenticatedSidecarTestClient(app)
        if not authorized:
            del client.headers["X-DNAForge-Session"]
            assert (
                client.post("/services/streaming-tool/execute", json={}).status_code
                == 401
            )
            client.headers["X-DNAForge-Session"] = "incorrect-session"
            assert (
                client.post("/services/streaming-tool/execute", json={}).status_code
                == 401
            )
            assert not requests
            assert stream.received == 0
        else:
            response = client.post("/services/streaming-tool/execute", json={})
            assert response.status_code == 200
            assert response.json() == {"ok": True}
            assert stream.closed and transport.closed
            assert len(requests) == 1
    finally:
        plugin_registry.unregister("streaming-tool")


@pytest.mark.asyncio
@pytest.mark.parametrize("length", ["-1", "invalid", "9" * 5000])
async def test_invalid_declared_length_is_refused_before_consumption(upstream, length):
    configure, requests = upstream
    stream, transport = configure([b"{}"], headers={"Content-Length": length})
    with pytest.raises(HTTPException, match="invalid Content-Length"):
        await services._execute_plugin("tool", "http://configured-plugin", {})
    assert stream.received == 0
    assert stream.closed and transport.closed
    assert len(requests) == 1


def test_in_process_route_survives_oversize_and_next_plugin_succeeds(upstream):
    from src.main import app
    from src.plugins.registry import plugin_registry
    from tests.sidecar_test_client import AuthenticatedSidecarTestClient

    configure, requests = upstream
    stream, transport = configure([b"x" * 8] * 100)
    plugin_registry.register("streaming-tool", "http://configured-plugin", {})
    try:
        client = AuthenticatedSidecarTestClient(app)
        response = client.post("/services/streaming-tool/execute", json={})
        assert response.status_code == 502
        assert (
            response.json()["detail"]
            == "Plugin 'streaming-tool' response exceeds 64 bytes"
        )
        assert stream.received == 72
        assert stream.closed and transport.closed
        session = client.headers.pop("X-DNAForge-Session")
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json() == {"status": "healthy", "service": "molbio-api"}
        client.headers["X-DNAForge-Session"] = session
        next_stream, next_transport = configure([b'{"recovered":true}'])
        recovered = client.post("/services/streaming-tool/execute", json={})
        assert recovered.status_code == 200
        assert recovered.json() == {"recovered": True}
        assert next_stream.closed and next_transport.closed
        assert len(requests) == 2
    finally:
        plugin_registry.unregister("streaming-tool")
