from __future__ import annotations

import asyncio
import socket
import ssl
from collections.abc import Iterable

import httpcore
import httpx
import pytest

from src.external import public_http as public_http_module
from src.external.public_http import PublicHttpBoundary, PublicHttpBoundaryError


class _RecordingStream(httpcore.AsyncMockStream):
    def __init__(
        self,
        buffer: list[bytes],
        *,
        writes: list[bytes],
        server_hostnames: list[str | None],
    ) -> None:
        super().__init__(buffer)
        self._writes = writes
        self._server_hostnames = server_hostnames
        self.close_count = 0

    async def write(self, buffer: bytes, timeout: float | None = None) -> None:
        self._writes.append(buffer)
        await super().write(buffer, timeout)

    async def start_tls(
        self,
        ssl_context: ssl.SSLContext,
        server_hostname: str | None = None,
        timeout: float | None = None,
    ) -> httpcore.AsyncNetworkStream:
        self._server_hostnames.append(server_hostname)
        return await super().start_tls(ssl_context, server_hostname, timeout)

    async def aclose(self) -> None:
        self.close_count += 1
        await super().aclose()


class _RecordingBackend(httpcore.AsyncNetworkBackend):
    def __init__(
        self,
        responses: list[bytes],
        *,
        failing_targets: frozenset[str] | None = None,
    ) -> None:
        self._responses = list(responses)
        self._failing_targets = failing_targets or frozenset()
        self.connect_targets: list[tuple[str, int]] = []
        self.writes: list[bytes] = []
        self.server_hostnames: list[str | None] = []
        self.connect_timeouts: list[float | None] = []
        self.streams: list[_RecordingStream] = []

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[object] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        self.connect_targets.append((host, port))
        self.connect_timeouts.append(timeout)
        if host in self._failing_targets:
            raise httpcore.ConnectError(f"inert connection failure for {host}")
        stream = _RecordingStream(
            [self._responses.pop(0)],
            writes=self.writes,
            server_hostnames=self.server_hostnames,
        )
        self.streams.append(stream)
        return stream

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: Iterable[object] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        raise AssertionError("the public HTTP boundary must never use a Unix socket")

    async def sleep(self, seconds: float) -> None:
        return None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "credential_key",
    [
        "signature",
        "sig",
        "AWSAccessKeyId",
        "GoogleAccessId",
        "X-Amz-Signature",
        "X-Goog-Signature",
    ],
)
async def test_credential_query_parameters_require_an_explicit_runtime_boundary(
    credential_key: str,
) -> None:
    async def resolver(
        _host: str, port: int, *, type: socket.SocketKind
    ) -> list[tuple]:
        assert type == socket.SOCK_STREAM
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", port))]

    client = httpx.AsyncClient()
    try:
        durable_boundary = PublicHttpBoundary(client, resolver=resolver)
        with pytest.raises(PublicHttpBoundaryError, match="credential parameters"):
            await durable_boundary.validate_url(
                f"https://example.org/data?{credential_key}=ticket-secret"
            )

        runtime_boundary = PublicHttpBoundary(
            client,
            resolver=resolver,
            allow_credential_query=True,
        )
        assert (
            await runtime_boundary.validate_url(
                f"https://example.org/data?{credential_key}=ticket-secret"
            )
            == f"https://example.org/data?{credential_key}=ticket-secret"
        )
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_request_connects_only_to_the_address_validated_for_that_hop() -> None:
    """Regression check: the existing public-IP admission must pin the socket.

    The resolver's second answer is an inert loopback canary. A secure request
    never asks for that second answer and connects only to the first public IP.
    """

    resolver_calls: list[str] = []

    async def changing_resolver(
        host: str, port: int, *, type: socket.SocketKind
    ) -> list[tuple]:
        assert type == socket.SOCK_STREAM
        resolver_calls.append(host)
        address = "1.1.1.1" if len(resolver_calls) == 1 else "127.0.0.1"
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port))]

    backend = _RecordingBackend(
        [b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"]
    )
    client = httpx.AsyncClient()
    try:
        boundary = PublicHttpBoundary(
            client,
            resolver=changing_resolver,
            network_backend=backend,
        )
        response, canonical_url = await boundary.get(
            "https://example.org/paper",
            accept="application/pdf",
            user_agent="DNAForge/public-http-test",
            timeout=httpx.Timeout(2.0),
        )
    finally:
        await client.aclose()

    assert response.content == b"ok"
    assert canonical_url == "https://example.org/paper"
    assert resolver_calls == ["example.org"]
    assert backend.connect_targets == [("1.1.1.1", 443)]
    assert backend.server_hostnames == ["example.org"]
    assert b"host: example.org" in b"".join(backend.writes).lower()


@pytest.mark.asyncio
async def test_each_redirect_hop_gets_its_own_validated_connection_pin() -> None:
    resolver_calls: list[str] = []
    addresses = {"first.example": "1.1.1.1", "second.example": "8.8.8.8"}

    async def resolver(host: str, port: int, *, type: socket.SocketKind) -> list[tuple]:
        assert type == socket.SOCK_STREAM
        resolver_calls.append(host)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (addresses[host], port))]

    backend = _RecordingBackend(
        [
            b"HTTP/1.1 302 Found\r\nLocation: https://second.example/final\r\n"
            b"Content-Length: 0\r\nConnection: close\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
        ]
    )
    client = httpx.AsyncClient()
    try:
        boundary = PublicHttpBoundary(
            client, resolver=resolver, network_backend=backend
        )
        response, canonical_url = await boundary.get(
            "https://first.example/start",
            accept="application/pdf",
            user_agent="DNAForge/public-http-test",
            timeout=httpx.Timeout(2.0),
        )
    finally:
        await client.aclose()

    assert response.content == b"ok"
    assert canonical_url == "https://second.example/final"
    assert resolver_calls == ["first.example", "second.example"]
    assert backend.connect_targets == [("1.1.1.1", 443), ("8.8.8.8", 443)]
    assert backend.server_hostnames == ["first.example", "second.example"]
    assert [stream.close_count for stream in backend.streams] == [1, 1]


@pytest.mark.asyncio
async def test_connect_fallback_is_limited_to_the_originally_validated_address_set() -> (
    None
):
    async def resolver(
        _host: str, port: int, *, type: socket.SocketKind
    ) -> list[tuple]:
        assert type == socket.SOCK_STREAM
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", port)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port)),
        ]

    backend = _RecordingBackend(
        [b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"],
        failing_targets=frozenset({"1.1.1.1"}),
    )
    client = httpx.AsyncClient()
    try:
        boundary = PublicHttpBoundary(
            client, resolver=resolver, network_backend=backend
        )
        response, _canonical_url = await boundary.get(
            "https://example.org/paper",
            accept="application/pdf",
            user_agent="DNAForge/public-http-test",
            timeout=httpx.Timeout(2.0),
        )
    finally:
        await client.aclose()

    assert response.content == b"ok"
    assert backend.connect_targets == [("1.1.1.1", 443), ("8.8.8.8", 443)]
    assert backend.connect_timeouts[1] is not None
    assert backend.connect_timeouts[0] is not None
    assert backend.connect_timeouts[1] <= backend.connect_timeouts[0]


@pytest.mark.asyncio
async def test_mixed_public_and_private_dns_answers_are_rejected_before_connect() -> (
    None
):
    async def mixed_resolver(
        _host: str, port: int, *, type: socket.SocketKind
    ) -> list[tuple]:
        assert type == socket.SOCK_STREAM
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", port)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port)),
        ]

    backend = _RecordingBackend([])
    client = httpx.AsyncClient()
    try:
        boundary = PublicHttpBoundary(
            client, resolver=mixed_resolver, network_backend=backend
        )
        with pytest.raises(PublicHttpBoundaryError, match="public host"):
            await boundary.get(
                "https://example.org/paper",
                accept="application/pdf",
                user_agent="DNAForge/public-http-test",
                timeout=httpx.Timeout(2.0),
            )
    finally:
        await client.aclose()

    assert backend.connect_targets == []


@pytest.mark.asyncio
async def test_ipv6_destination_is_pinned_without_changing_the_tls_hostname() -> None:
    async def ipv6_resolver(
        _host: str, port: int, *, type: socket.SocketKind
    ) -> list[tuple]:
        assert type == socket.SOCK_STREAM
        return [
            (
                socket.AF_INET6,
                socket.SOCK_STREAM,
                6,
                "",
                ("2606:4700:4700::1111", port, 0, 0),
            )
        ]

    backend = _RecordingBackend(
        [b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"]
    )
    client = httpx.AsyncClient()
    try:
        boundary = PublicHttpBoundary(
            client, resolver=ipv6_resolver, network_backend=backend
        )
        response, _canonical_url = await boundary.get(
            "https://example.org/paper",
            accept="application/pdf",
            user_agent="DNAForge/public-http-test",
            timeout=httpx.Timeout(2.0),
        )
    finally:
        await client.aclose()

    assert response.content == b"ok"
    assert backend.connect_targets == [("2606:4700:4700::1111", 443)]
    assert backend.server_hostnames == ["example.org"]


@pytest.mark.asyncio
async def test_connect_fallback_shares_one_timeout_budget_across_all_addresses() -> (
    None
):
    async def resolver(
        _host: str, port: int, *, type: socket.SocketKind
    ) -> list[tuple]:
        assert type == socket.SOCK_STREAM
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", port)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port)),
        ]

    class BudgetConsumingBackend(_RecordingBackend):
        async def connect_tcp(
            self,
            host: str,
            port: int,
            timeout: float | None = None,
            local_address: str | None = None,
            socket_options: Iterable[object] | None = None,
        ) -> httpcore.AsyncNetworkStream:
            self.connect_targets.append((host, port))
            self.connect_timeouts.append(timeout)
            assert timeout is not None
            await asyncio.sleep(timeout)
            raise httpcore.ConnectError(f"inert connection failure for {host}")

    backend = BudgetConsumingBackend([])
    client = httpx.AsyncClient()
    try:
        boundary = PublicHttpBoundary(
            client, resolver=resolver, network_backend=backend
        )
        with pytest.raises(httpx.ConnectTimeout):
            await boundary.get(
                "https://example.org/paper",
                accept="application/pdf",
                user_agent="DNAForge/public-http-test",
                timeout=httpx.Timeout(timeout=0.1, connect=0.02),
            )
    finally:
        await client.aclose()

    assert backend.connect_targets == [("1.1.1.1", 443)]
    assert backend.connect_timeouts[0] == pytest.approx(0.02, abs=0.005)


@pytest.mark.asyncio
async def test_idn_hostname_uses_one_ascii_form_for_dns_http_and_tls() -> None:
    resolver_calls: list[str] = []

    async def resolver(host: str, port: int, *, type: socket.SocketKind) -> list[tuple]:
        assert type == socket.SOCK_STREAM
        resolver_calls.append(host)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", port))]

    backend = _RecordingBackend(
        [b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"]
    )
    client = httpx.AsyncClient()
    try:
        boundary = PublicHttpBoundary(
            client, resolver=resolver, network_backend=backend
        )
        response, canonical_url = await boundary.get(
            "https://b\N{LATIN SMALL LETTER U WITH DIAERESIS}cher.example/paper",
            accept="application/pdf",
            user_agent="DNAForge/public-http-test",
            timeout=httpx.Timeout(2.0),
        )
    finally:
        await client.aclose()

    assert response.content == b"ok"
    assert canonical_url == "https://xn--bcher-kva.example/paper"
    assert resolver_calls == ["xn--bcher-kva.example"]
    assert backend.server_hostnames == ["xn--bcher-kva.example"]
    assert b"host: xn--bcher-kva.example" in b"".join(backend.writes).lower()


@pytest.mark.asyncio
async def test_idn_mapping_cannot_change_sharp_s_to_another_public_domain() -> None:
    resolver_calls: list[str] = []

    async def resolver(host: str, port: int, *, type: socket.SocketKind) -> list[tuple]:
        assert type == socket.SOCK_STREAM
        resolver_calls.append(host)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", port))]

    backend = _RecordingBackend(
        [b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"]
    )
    client = httpx.AsyncClient()
    try:
        boundary = PublicHttpBoundary(
            client, resolver=resolver, network_backend=backend
        )
        response, canonical_url = await boundary.get(
            "https://fa\N{LATIN SMALL LETTER SHARP S}.de/paper",
            accept="application/pdf",
            user_agent="DNAForge/public-http-test",
            timeout=httpx.Timeout(2.0),
        )
    finally:
        await client.aclose()

    assert response.content == b"ok"
    assert canonical_url == "https://xn--fa-hia.de/paper"
    assert resolver_calls == ["xn--fa-hia.de"]
    assert backend.server_hostnames == ["xn--fa-hia.de"]
    assert b"host: xn--fa-hia.de" in b"".join(backend.writes).lower()


@pytest.mark.asyncio
async def test_invalid_idna_codepoint_is_rejected_before_dns_or_network() -> None:
    resolver_calls: list[str] = []

    async def resolver(host: str, port: int, *, type: socket.SocketKind) -> list[tuple]:
        resolver_calls.append(host)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", port))]

    backend = _RecordingBackend([])
    client = httpx.AsyncClient()
    try:
        boundary = PublicHttpBoundary(
            client, resolver=resolver, network_backend=backend
        )
        with pytest.raises(PublicHttpBoundaryError, match="host is invalid"):
            await boundary.get(
                "https://\N{ZERO WIDTH NON-JOINER}.example/paper",
                accept="application/pdf",
                user_agent="DNAForge/public-http-test",
                timeout=httpx.Timeout(2.0),
            )
    finally:
        await client.aclose()

    assert resolver_calls == []
    assert backend.connect_targets == []


@pytest.mark.asyncio
async def test_final_stream_close_releases_stream_and_pinned_client_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def resolver(
        _host: str, port: int, *, type: socket.SocketKind
    ) -> list[tuple]:
        assert type == socket.SOCK_STREAM
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", port))]

    backend = _RecordingBackend(
        [b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"]
    )
    pinned_close_count = 0
    original_aclose = httpx.AsyncClient.aclose

    async def recording_aclose(client: httpx.AsyncClient) -> None:
        nonlocal pinned_close_count
        if isinstance(
            getattr(client, "_transport", None),
            public_http_module._PinnedAsyncHttpTransport,
        ):
            pinned_close_count += 1
        await original_aclose(client)

    monkeypatch.setattr(httpx.AsyncClient, "aclose", recording_aclose)
    client = httpx.AsyncClient()
    try:
        boundary = PublicHttpBoundary(
            client, resolver=resolver, network_backend=backend
        )
        response, _canonical_url = await boundary.open_get(
            "https://example.org/paper",
            accept="application/pdf",
            user_agent="DNAForge/public-http-test",
            timeout=httpx.Timeout(2.0),
        )
        await response.aclose()
        await response.aclose()
    finally:
        await client.aclose()

    assert [stream.close_count for stream in backend.streams] == [1]
    assert pinned_close_count == 1


@pytest.mark.asyncio
async def test_send_error_closes_the_per_hop_pinned_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def resolver(
        _host: str, port: int, *, type: socket.SocketKind
    ) -> list[tuple]:
        assert type == socket.SOCK_STREAM
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", port))]

    backend = _RecordingBackend([], failing_targets=frozenset({"1.1.1.1"}))
    pinned_close_count = 0
    original_aclose = httpx.AsyncClient.aclose

    async def recording_aclose(client: httpx.AsyncClient) -> None:
        nonlocal pinned_close_count
        if isinstance(
            getattr(client, "_transport", None),
            public_http_module._PinnedAsyncHttpTransport,
        ):
            pinned_close_count += 1
        await original_aclose(client)

    monkeypatch.setattr(httpx.AsyncClient, "aclose", recording_aclose)
    client = httpx.AsyncClient()
    try:
        boundary = PublicHttpBoundary(
            client, resolver=resolver, network_backend=backend
        )
        with pytest.raises(httpx.ConnectError):
            await boundary.open_get(
                "https://example.org/paper",
                accept="application/pdf",
                user_agent="DNAForge/public-http-test",
                timeout=httpx.Timeout(2.0),
            )
    finally:
        await client.aclose()

    assert pinned_close_count == 1
