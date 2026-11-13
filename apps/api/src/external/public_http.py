"""Shared public-HTTP admission boundary for external provider fetches.

Every caller validates the original URL and every redirect before network I/O.
The check rejects credentials, nonstandard ports, and any hostname whose DNS
answers include a non-public address. Callers choose the concrete exception
type so their existing route contracts remain stable.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from dataclasses import dataclass
from urllib.parse import parse_qsl, urljoin, urlsplit, urlunsplit

import httpcore
import httpx
import idna
from httpcore._backends.auto import AutoBackend
from httpcore._backends.base import SOCKET_OPTION

Resolver = Callable[..., Awaitable[list[tuple]]]
ErrorFactory = Callable[[str], Exception]

_CREDENTIAL_QUERY_KEYS = {
    "access_token",
    "api_key",
    "apikey",
    "auth",
    "authorization",
    "awsaccesskeyid",
    "credential",
    "googleaccessid",
    "key",
    "password",
    "secret",
    "sig",
    "signature",
    "token",
}
_CREDENTIAL_QUERY_PREFIXES = ("x-amz-", "x-goog-")
_REDIRECT_CODES = {301, 302, 303, 307, 308}
_MAX_REDIRECTS = 5


class PublicHttpBoundaryError(Exception):
    """A URL did not satisfy the public-network boundary."""


@dataclass(frozen=True)
class ValidatedPublicDestination:
    """One URL hop plus the exact public addresses admitted for its socket."""

    canonical_url: str
    hostname: str
    port: int
    addresses: tuple[str, ...]


class _PinnedNetworkBackend(httpcore.AsyncNetworkBackend):
    """Connect only to the addresses admitted for the original hostname."""

    def __init__(
        self,
        destination: ValidatedPublicDestination,
        delegate: httpcore.AsyncNetworkBackend,
    ) -> None:
        self._destination = destination
        self._delegate = delegate

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[SOCKET_OPTION] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        if (
            host.casefold() != self._destination.hostname
            or port != self._destination.port
        ):
            raise httpcore.ConnectError(
                "request origin does not match validated destination"
            )
        loop = asyncio.get_running_loop()
        deadline = None if timeout is None else loop.time() + max(timeout, 0.0)
        last_error: httpcore.ConnectError | httpcore.ConnectTimeout | None = None
        for address in self._destination.addresses:
            remaining_timeout = (
                None if deadline is None else max(deadline - loop.time(), 0.0)
            )
            if remaining_timeout is not None and remaining_timeout <= 0:
                raise httpcore.ConnectTimeout(
                    "validated destination exhausted its connect timeout"
                ) from last_error
            try:
                return await self._delegate.connect_tcp(
                    address,
                    port,
                    timeout=remaining_timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                last_error = exc
        if last_error is not None:
            raise last_error
        raise httpcore.ConnectError("validated destination has no connectable address")

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: Iterable[SOCKET_OPTION] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        raise httpcore.ConnectError("public HTTP does not support Unix sockets")

    async def sleep(self, seconds: float) -> None:
        await self._delegate.sleep(seconds)


class _PinnedAsyncHttpTransport(httpx.AsyncHTTPTransport):
    def __init__(
        self,
        destination: ValidatedPublicDestination,
        network_backend: httpcore.AsyncNetworkBackend,
    ) -> None:
        super().__init__(trust_env=False)
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=httpx.create_ssl_context(verify=True, trust_env=False),
            network_backend=_PinnedNetworkBackend(destination, network_backend),
        )


class _CloseClientWithResponse(httpx.AsyncByteStream):
    def __init__(
        self, stream: httpx.AsyncByteStream, client: httpx.AsyncClient
    ) -> None:
        self._stream = stream
        self._client = client
        self._closed = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        async for chunk in self._stream:
            yield chunk

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            await self._stream.aclose()
        finally:
            await self._client.aclose()


class PublicHttpBoundary:
    """Validate public destinations and manually follow validated redirects."""

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        resolver: Resolver | None = None,
        allowed_hosts: frozenset[str] | None = None,
        allow_credential_query: bool = False,
        error_factory: ErrorFactory = PublicHttpBoundaryError,
        allowlist_error: str = "The remote source host is not approved",
        network_backend: httpcore.AsyncNetworkBackend | None = None,
    ) -> None:
        self._client = client
        self._resolver = resolver or resolve_host
        self._network_backend = network_backend or AutoBackend()
        self._allow_credential_query = allow_credential_query
        self._in_memory_client = (
            client
            if isinstance(getattr(client, "_transport", None), httpx.MockTransport)
            else None
        )
        try:
            self._allowed_hosts = (
                frozenset(_canonical_hostname(host) for host in allowed_hosts)
                if allowed_hosts is not None
                else None
            )
        except (UnicodeError, ValueError) as exc:
            raise ValueError("allowed public HTTP host is invalid") from exc
        self._error_factory = error_factory
        self._allowlist_error = allowlist_error

    async def validate_url(self, raw_url: str) -> str:
        return (await self._validate_destination(raw_url)).canonical_url

    async def _validate_destination(self, raw_url: str) -> ValidatedPublicDestination:
        try:
            parsed = urlsplit(raw_url.strip())
        except ValueError as exc:
            raise self._error("The remote source URL is invalid") from exc
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise self._error("The remote source must use HTTP or HTTPS")
        try:
            hostname = _canonical_hostname(parsed.hostname)
        except (UnicodeError, ValueError) as exc:
            raise self._error("The remote source host is invalid") from exc
        if self._allowed_hosts is not None and hostname not in self._allowed_hosts:
            raise self._error(self._allowlist_error)
        if parsed.username or parsed.password:
            raise self._error("The remote source URL may not contain credentials")
        if parsed.fragment:
            raise self._error("The remote source URL may not contain a fragment")
        try:
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
        except ValueError as exc:
            raise self._error("The remote source URL has an invalid port") from exc
        if port not in {80, 443}:
            raise self._error("The remote source URL must use port 80 or 443")
        if not self._allow_credential_query and any(
            key.casefold() in _CREDENTIAL_QUERY_KEYS
            or key.casefold().startswith(_CREDENTIAL_QUERY_PREFIXES)
            for key, _ in parse_qsl(parsed.query)
        ):
            raise self._error(
                "The remote source URL may not contain credential parameters"
            )

        try:
            addresses = await self._resolver(hostname, port, type=socket.SOCK_STREAM)
        except (OSError, socket.gaierror) as exc:
            raise self._error("The remote source host could not be resolved") from exc
        if not addresses:
            raise self._error("The remote source host could not be resolved")
        admitted_addresses: list[str] = []
        for address in addresses:
            try:
                ip = ipaddress.ip_address(address[4][0])
            except (ValueError, IndexError, TypeError) as exc:
                raise self._error(
                    "The remote source host returned an invalid address"
                ) from exc
            if not ip.is_global:
                raise self._error("The remote source must use a public host")
            normalized_ip = str(ip)
            if normalized_ip not in admitted_addresses:
                admitted_addresses.append(normalized_ip)

        canonical_host = f"[{hostname}]" if ":" in hostname else hostname
        netloc = canonical_host
        if (parsed.scheme == "https" and port != 443) or (
            parsed.scheme == "http" and port != 80
        ):
            netloc = f"{canonical_host}:{port}"
        return ValidatedPublicDestination(
            canonical_url=urlunsplit(
                (parsed.scheme, netloc, parsed.path or "/", parsed.query, "")
            ),
            hostname=hostname,
            port=port,
            addresses=tuple(admitted_addresses),
        )

    async def open_get(
        self,
        source_url: str,
        *,
        headers: dict[str, str] | None = None,
        accept: str,
        user_agent: str,
        timeout: httpx.Timeout,
    ) -> tuple[httpx.Response, str]:
        """Return an unread streaming response; the caller must close it."""

        destination = await self._validate_destination(source_url)
        guarded_origin = _destination_origin(destination) if headers else None
        for _ in range(_MAX_REDIRECTS + 1):
            response = await self._send_pinned_get(
                destination,
                headers={
                    **(headers or {}),
                    "Accept": accept,
                    "User-Agent": user_agent,
                },
                timeout=timeout,
            )
            if response.status_code not in _REDIRECT_CODES:
                return response, destination.canonical_url
            location = response.headers.get("Location")
            await response.aclose()
            if not location:
                raise self._error("The remote source returned an empty redirect")
            next_destination = await self._validate_destination(
                urljoin(destination.canonical_url, location)
            )
            if (
                guarded_origin is not None
                and _destination_origin(next_destination) != guarded_origin
            ):
                raise self._error(
                    "An authenticated remote source may not redirect to another origin"
                )
            destination = next_destination
        raise self._error("The remote source redirected too many times")

    async def _send_pinned_get(
        self,
        destination: ValidatedPublicDestination,
        *,
        headers: dict[str, str],
        timeout: httpx.Timeout,
    ) -> httpx.Response:
        if self._in_memory_client is not None:
            request = self._in_memory_client.build_request(
                "GET", destination.canonical_url, headers=headers, timeout=timeout
            )
            return await self._in_memory_client.send(
                request, follow_redirects=False, stream=True
            )

        pinned_client = httpx.AsyncClient(
            transport=_PinnedAsyncHttpTransport(destination, self._network_backend),
            trust_env=False,
        )
        try:
            request = pinned_client.build_request(
                "GET", destination.canonical_url, headers=headers, timeout=timeout
            )
            response = await pinned_client.send(
                request, follow_redirects=False, stream=True
            )
        except BaseException:
            await pinned_client.aclose()
            raise
        response.stream = _CloseClientWithResponse(response.stream, pinned_client)
        return response

    async def get(
        self,
        source_url: str,
        *,
        headers: dict[str, str] | None = None,
        accept: str,
        user_agent: str,
        timeout: httpx.Timeout,
    ) -> tuple[httpx.Response, str]:
        """Return an eagerly read response for existing small/range callers."""

        response, canonical_url = await self.open_get(
            source_url,
            headers=headers,
            accept=accept,
            user_agent=user_agent,
            timeout=timeout,
        )
        try:
            await response.aread()
        finally:
            await response.aclose()
        return response, canonical_url

    def _error(self, message: str) -> Exception:
        return self._error_factory(message)


async def resolve_host(host: str, port: int, *, type: socket.SocketKind) -> list[tuple]:
    return await asyncio.get_running_loop().getaddrinfo(host, port, type=type)


def _canonical_hostname(host: str) -> str:
    """Return the one ASCII hostname form used by DNS, HTTP, and pin checks."""

    return idna.encode(host.lower()).decode("ascii")


def _destination_origin(
    destination: ValidatedPublicDestination,
) -> tuple[str, str, int]:
    return (
        urlsplit(destination.canonical_url).scheme,
        destination.hostname,
        destination.port,
    )
