"""Authenticated, bounded byte-range access for admitted public genomic files.

The renderer never supplies an arbitrary URL to the read path. Admission first
validates the destination, range behavior, binary magic, length, and stable
validators, then returns an opaque process-local token. Reads use only that
token plus an offset and length.
"""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import os
import re
import secrets
import socket
import ssl
import stat as stat_module
import sys
import tempfile
import time
from collections import OrderedDict
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Awaitable, BinaryIO, Callable, Literal, TypeVar
from urllib.parse import parse_qsl, urljoin, urlsplit, urlunsplit

import httpx

from src.storage_capacity import read_storage_capacity

from .async_single_flight import AsyncSingleFlight
from .credential_broker import (
    CredentialAudience,
    CredentialBroker,
    CredentialBrokerError,
)
from .persistent_track_cache import PersistentTrackCache

RemoteIndexedFormat = Literal[
    "bigwig",
    "bigbed",
    "bam",
    "cram",
    "bai",
    "crai",
    "csi",
    "vcf",
    "bcf",
    "tbi",
]
Resolver = Callable[..., Awaitable[list[tuple]]]
_T = TypeVar("_T")

_BIGWIG_MAGIC = 0x888FFC26
_BIGBED_MAGIC = 0x8789F2EB
_MAGIC_FORMAT = {
    _BIGWIG_MAGIC: "bigwig",
    _BIGBED_MAGIC: "bigbed",
}
_CONTENT_RANGE_RE = re.compile(r"^bytes (\d+)-(\d+)/(\d+)$")
_REDIRECT_CODES = {301, 302, 303, 307, 308}
_CREDENTIAL_QUERY_KEYS = {
    "access_token",
    "api_key",
    "apikey",
    "auth",
    "authorization",
    "credential",
    "key",
    "password",
    "secret",
    "sig",
    "signature",
    "token",
}
_CREDENTIAL_QUERY_PREFIXES = ("x-amz-", "x-goog-")
_PROBE_BYTES = 64
_MAX_REDIRECTS = 5
_MAX_READ_BYTES = 8 * 1024 * 1024
_CONTENT_HASH_CHUNK_BYTES = _MAX_READ_BYTES
_MAX_TOKENS = 64
_TOKEN_TTL_S = 30 * 60
_MAX_CACHE_BYTES = 64 * 1024 * 1024
_MAX_CONCURRENT_READS_PER_SOURCE = 4
_MAX_PERSISTENCE_QUEUE_BYTES = 16 * 1024 * 1024
_MAX_PERSISTENCE_QUEUE_ITEMS = 8
_MANAGED_SNAPSHOT_QUOTA_BYTES = 8 * 1024 * 1024 * 1024
_MIN_MANAGED_SNAPSHOT_FREE_BYTES = 1024 * 1024 * 1024
_MANAGED_SNAPSHOT_WRITE_BATCH_BYTES = 8 * 1024 * 1024
_MATERIALIZED_NATIVE_FORMATS = frozenset({"bai", "crai", "csi", "tbi"})


class RemoteRangeSourceError(Exception):
    """A remote source failed admission or changed after admission."""

    def __init__(
        self,
        message: str,
        *,
        failure_kind: str = "source_invalid",
        retryable: bool = False,
        status_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.failure_kind = failure_kind
        self.retryable = retryable
        self.status_code = status_code


@dataclass(frozen=True)
class RemoteRangeGrant:
    source_uri: str
    source_token: str
    canonical_url_hash: str
    format: RemoteIndexedFormat
    byte_length: int
    accepts_ranges: Literal[True]
    etag: str | None
    last_modified: str | None
    expires_at: float
    expires_in_seconds: int
    provenance_id: str


@dataclass(frozen=True)
class RemoteRangeRead:
    payload: bytes
    start: int
    end: int
    byte_length: int
    etag: str | None
    last_modified: str | None


@dataclass(frozen=True)
class RemoteRangeMaterialization:
    source_path: str
    representation_sha256: str
    grant: RemoteRangeGrant


@dataclass(frozen=True)
class _BoundedHttpResponse:
    status_code: int
    headers: httpx.Headers
    content: bytes


@dataclass(frozen=True)
class _ValidatedPublicUrl:
    canonical_url: str
    connect_urls: tuple[str, ...]
    host_header: str
    sni_hostname: str


@dataclass(frozen=True)
class _RemoteAuthorizationContext:
    auth_ref: str | None
    audience: CredentialAudience
    aws_region: str | None = None
    requester_pays: bool = False
    billing_project: str | None = None
    initial_origin: str | None = None


@dataclass
class _SourceReadLimiter:
    slots: asyncio.Semaphore
    grant_refs: int = 0
    active_reads: int = 0


@dataclass
class _AdmittedSource:
    token: str
    canonical_url: str | None
    canonical_path: str | None
    allowed_hosts: frozenset[str] | None
    format: RemoteIndexedFormat
    byte_length: int
    etag: str | None
    last_modified: str | None
    expires_at: float
    provenance_id: str
    source_key: str
    generation_key: str
    limiter_identity: tuple[str, str]
    read_limiter: _SourceReadLimiter
    authorization: _RemoteAuthorizationContext | None = None
    local_identity: tuple[int, int, int, int, int] | None = None
    owned_snapshot_path: str | None = None
    owned_snapshot_bytes: int = 0


class RemoteRangeService:
    """Process-local grants with memory and the shared persistent track cache."""

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        resolver: Resolver | None = None,
        clock: Callable[[], float] = time.monotonic,
        allowed_hosts: frozenset[str] | None = None,
        persistent_cache: PersistentTrackCache | None = None,
        credential_broker: CredentialBroker | None = None,
    ) -> None:
        self._client = client
        self._resolver = resolver or _resolve_host
        self._clock = clock
        self._allowed_hosts = (
            frozenset(host.casefold() for host in allowed_hosts)
            if allowed_hosts is not None
            else None
        )
        self._persistent_cache = persistent_cache
        self._credential_broker = credential_broker or CredentialBroker()
        self._sources: OrderedDict[str, _AdmittedSource] = OrderedDict()
        self._read_limiters: dict[tuple[str, str], _SourceReadLimiter] = {}
        self._retired_snapshots: dict[str, tuple[_SourceReadLimiter, int]] = {}
        self._managed_snapshot_bytes = 0
        self._cache: OrderedDict[tuple[str, str, int, int], bytes] = OrderedDict()
        self._cache_bytes = 0
        self._range_single_flight = AsyncSingleFlight[
            tuple[str, str, int, int], bytes
        ]()
        self._content_sha256_single_flight = AsyncSingleFlight[str, str]()
        self._persistence_queue: asyncio.Queue[tuple[str, str, int, bytes]] = (
            asyncio.Queue(maxsize=_MAX_PERSISTENCE_QUEUE_ITEMS)
        )
        self._persistence_queued_bytes = 0
        self._persistence_worker: asyncio.Task[None] | None = None
        self._closing = False
        self._lock = asyncio.Lock()

    async def aclose(self) -> None:
        self._closing = True
        worker = self._persistence_worker
        if worker is not None:
            await self._persistence_queue.join()
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)
            self._persistence_worker = None
        if self._persistent_cache is not None:
            await asyncio.to_thread(self._persistent_cache.close)
        async with self._lock:
            for token in list(self._sources):
                self._remove_source_locked(token)

    async def admit(
        self,
        source_url: str,
        *,
        expected_format: RemoteIndexedFormat,
        provenance_id: str,
        allow_any_public_host: bool = False,
        auth_ref: str | None = None,
        credential_audience: CredentialAudience = "http",
        aws_region: str | None = None,
        requester_pays: bool = False,
        billing_project: str | None = None,
    ) -> RemoteRangeGrant:
        allowed_hosts = None if allow_any_public_host else self._allowed_hosts
        validated_url = await self._validate_public_url(source_url, allowed_hosts)
        authorization = (
            _RemoteAuthorizationContext(
                auth_ref=auth_ref,
                audience=credential_audience,
                aws_region=aws_region,
                requester_pays=requester_pays,
                billing_project=billing_project,
                initial_origin=_url_origin(validated_url.canonical_url),
            )
            if auth_ref is not None
            or credential_audience != "http"
            or requester_pays
            or billing_project is not None
            else None
        )
        response, canonical_url = await self._request_with_validated_redirects(
            validated_url,
            headers={"Range": f"bytes=0-{_PROBE_BYTES - 1}"},
            allowed_hosts=allowed_hosts,
            max_body_bytes=_PROBE_BYTES,
            authorization=authorization,
        )
        probe, total_length = await self._validated_partial_response(
            response,
            requested_start=0,
            requested_length=_PROBE_BYTES,
        )
        if len(probe) < 4:
            raise RemoteRangeSourceError(
                "The remote genomic file is too short to identify"
            )
        detected = _require_expected_format(
            probe, expected_format, source_kind="remote"
        )
        etag = _clean_header(response.headers.get("ETag"))
        last_modified = _clean_header(response.headers.get("Last-Modified"))
        if etag is None and last_modified is None:
            raise RemoteRangeSourceError(
                "The remote genomic source has no ETag or Last-Modified validator"
            )

        now = self._clock()
        token = secrets.token_urlsafe(32)
        source_key, generation_key = _remote_cache_identity(
            canonical_url=canonical_url,
            format=detected,
            byte_length=total_length,
            etag=etag,
            last_modified=last_modified,
        )
        source = _AdmittedSource(
            token=token,
            canonical_url=canonical_url,
            canonical_path=None,
            allowed_hosts=allowed_hosts,
            format=detected,
            byte_length=total_length,
            etag=etag,
            last_modified=last_modified,
            expires_at=now + _TOKEN_TTL_S,
            provenance_id=provenance_id,
            source_key=source_key,
            generation_key=generation_key,
            limiter_identity=(source_key, generation_key),
            read_limiter=_SourceReadLimiter(
                asyncio.Semaphore(_MAX_CONCURRENT_READS_PER_SOURCE)
            ),
            authorization=authorization,
        )
        async with self._lock:
            self._register_source_locked(source, now)

        return self._grant_for_source(source, now)

    async def admit_local(
        self,
        source_path: str,
        *,
        expected_format: RemoteIndexedFormat,
        provenance_id: str,
    ) -> RemoteRangeGrant:
        canonical_path, identity, probe = await asyncio.to_thread(
            _inspect_local_source, source_path
        )
        if len(probe) < 4:
            raise RemoteRangeSourceError(
                "The local genomic file is too short to identify"
            )
        detected = _require_expected_format(probe, expected_format, source_kind="local")

        now = self._clock()
        token = secrets.token_urlsafe(32)
        byte_length = identity[0]
        local_validator = '"local-' + "-".join(str(value) for value in identity) + '"'
        source_key, generation_key = _local_cache_identity(
            canonical_path=canonical_path,
            format=detected,
            identity=identity,
        )
        source = _AdmittedSource(
            token=token,
            canonical_url=None,
            canonical_path=canonical_path,
            allowed_hosts=None,
            format=detected,
            byte_length=byte_length,
            etag=local_validator,
            last_modified=None,
            expires_at=now + _TOKEN_TTL_S,
            provenance_id=provenance_id,
            source_key=source_key,
            generation_key=generation_key,
            limiter_identity=(source_key, generation_key),
            read_limiter=_SourceReadLimiter(
                asyncio.Semaphore(_MAX_CONCURRENT_READS_PER_SOURCE)
            ),
            local_identity=identity,
        )
        async with self._lock:
            self._register_source_locked(source, now)

        return self._grant_for_source(source, now)

    async def current_grant(self, source_token: str) -> RemoteRangeGrant:
        """Return current grant metadata using the service's authoritative clock."""

        now = self._clock()
        async with self._lock:
            self._prune_expired_locked(now)
            source = self._sources.get(source_token)
            if source is None or source.expires_at <= now:
                raise RemoteRangeSourceError(
                    "The remote range grant is missing or expired",
                    failure_kind="grant_expired",
                    retryable=True,
                )
            self._sources.move_to_end(source_token)
            return self._grant_for_source(source, now)

    async def read(self, source_token: str, start: int, length: int) -> bytes:
        return (await self.read_response(source_token, start, length)).payload

    async def content_sha256(self, source_token: str) -> str:
        """Hash every admitted source byte without trusting range-cache identity."""

        source = await self._source_for_token(source_token)
        try:
            return await self._content_sha256_single_flight.run(
                source.token,
                lambda: self._content_sha256_for_source(source),
            )
        finally:
            await self._release_source_read(source)

    async def materialize(self, source_token: str) -> RemoteRangeMaterialization:
        """Pin one remote representation to an owned immutable local snapshot.

        htslib deliberately downloads remote BAM/VCF indexes into its process
        working directory. Native callers instead receive this service-owned
        path, which is collision-free, quota-bound, validator-checked, and
        removed with the source grant.
        """

        now = self._clock()
        async with self._lock:
            self._prune_expired_locked(now)
            source = self._sources.get(source_token)
            if source is None or source.expires_at <= now:
                raise RemoteRangeSourceError(
                    "The remote range grant is missing or expired",
                    failure_kind="grant_expired",
                    retryable=True,
                )
            if (
                source.canonical_url is None
                or source.format not in _MATERIALIZED_NATIVE_FORMATS
            ):
                raise RemoteRangeSourceError(
                    "Only remote native index sources can be materialized",
                    failure_kind="source_invalid",
                )

        representation_sha256 = await self.content_sha256(source_token)
        now = self._clock()
        async with self._lock:
            self._prune_expired_locked(now)
            source = self._sources.get(source_token)
            if source is None or source.expires_at <= now:
                raise RemoteRangeSourceError(
                    "The remote range grant is missing or expired",
                    failure_kind="grant_expired",
                    retryable=True,
                )
            if source.owned_snapshot_path is None or source.canonical_path is None:
                raise RemoteRangeSourceError(
                    "Only remote indexed sources can be materialized",
                    failure_kind="source_invalid",
                )
            self._sources.move_to_end(source_token)
            return RemoteRangeMaterialization(
                source_path=source.canonical_path,
                representation_sha256=representation_sha256,
                grant=self._grant_for_source(source, now),
            )

    async def _content_sha256_for_source(self, source: _AdmittedSource) -> str:
        async with self._lock:
            source.read_limiter.active_reads += 1
        try:
            if source.canonical_path is None and source.canonical_url is not None:
                await self._reserve_managed_snapshot(source.byte_length)
                snapshot_path: str | None = None
                installed = False
                try:
                    digest, snapshot_path, local_identity = (
                        await self._fetch_full_sha256(source)
                    )
                    source_key, generation_key = _local_cache_identity(
                        canonical_path=snapshot_path,
                        format=source.format,
                        identity=local_identity,
                    )
                    refreshed_expiry = self._clock() + _TOKEN_TTL_S
                    async with self._lock:
                        if self._sources.get(source.token) is source:
                            source.canonical_path = snapshot_path
                            source.local_identity = local_identity
                            source.owned_snapshot_path = snapshot_path
                            source.owned_snapshot_bytes = source.byte_length
                            source.source_key = source_key
                            source.generation_key = generation_key
                            source.expires_at = refreshed_expiry
                            installed = True
                    if not installed:
                        raise RemoteRangeSourceError(
                            "The remote range grant is missing or expired",
                            failure_kind="grant_expired",
                            retryable=True,
                        )
                    return digest
                finally:
                    if not installed:
                        if snapshot_path is not None:
                            await _run_snapshot_operation(
                                _unlink_snapshot, snapshot_path
                            )
                        await self._release_managed_snapshot(source.byte_length)

            digest = hashlib.sha256()
            start = 0
            while start < source.byte_length:
                length = min(_CONTENT_HASH_CHUNK_BYTES, source.byte_length - start)
                payload = await self._fetch_range(source, start=start, length=length)
                digest.update(payload)
                start += length
            return digest.hexdigest()
        finally:
            await self._release_source_read(source)

    async def _fetch_full_sha256(
        self, source: _AdmittedSource
    ) -> tuple[str, str, tuple[int, int, int, int, int]]:
        """Hash and pin one coherent remote representation without buffering it."""

        async with source.read_limiter.slots:
            if source.canonical_url is None:
                raise RemoteRangeSourceError("The indexed source locator is missing")
            snapshot_directory = await _run_snapshot_operation(
                _managed_snapshot_directory
            )
            await _run_snapshot_operation(
                _require_managed_snapshot_free_space,
                snapshot_directory,
                source.byte_length,
            )
            validated_url = await self._validate_public_url(
                source.canonical_url, source.allowed_hosts
            )
            current = validated_url
            for _ in range(_MAX_REDIRECTS + 1):
                redirect_target: _ValidatedPublicUrl | None = None
                last_transport_error: httpx.TransportError | None = None
                for connect_url in current.connect_urls:
                    try:
                        request_headers = self._authorized_headers(
                            source.authorization,
                            current.canonical_url,
                            {
                                "Accept": "application/octet-stream",
                                "Accept-Encoding": "identity",
                                "Connection": "close",
                                "Host": current.host_header,
                                "User-Agent": "DNAForge/remote-range",
                            },
                        )
                        async with self._client.stream(
                            "GET",
                            connect_url,
                            headers=request_headers,
                            follow_redirects=False,
                            timeout=httpx.Timeout(20.0, connect=8.0),
                            extensions={"sni_hostname": current.sni_hostname},
                        ) as response:
                            if response.status_code in _REDIRECT_CODES:
                                location = response.headers.get("Location")
                                if not location:
                                    raise RemoteRangeSourceError(
                                        "The remote source returned an empty redirect"
                                    )
                                redirect_target = await self._validate_public_url(
                                    urljoin(current.canonical_url, location),
                                    source.allowed_hosts,
                                )
                                break
                            if current.canonical_url != source.canonical_url:
                                raise RemoteRangeSourceError(
                                    "The remote genomic source redirect changed",
                                    failure_kind="source_changed",
                                )
                            if response.status_code != 200:
                                raise RemoteRangeSourceError(
                                    _remote_http_failure_message(response.status_code),
                                    failure_kind="remote_http_error",
                                    retryable=_is_retryable_remote_http_status(
                                        response.status_code
                                    ),
                                    status_code=response.status_code,
                                )

                            raw_content_length = response.headers.get("Content-Length")
                            if raw_content_length is not None:
                                try:
                                    content_length = int(raw_content_length)
                                except ValueError as exc:
                                    raise RemoteRangeSourceError(
                                        "The remote genomic source returned an invalid length"
                                    ) from exc
                                if content_length != source.byte_length:
                                    raise RemoteRangeSourceError(
                                        "The remote genomic source length changed",
                                        failure_kind="source_changed",
                                    )

                            etag = _clean_header(response.headers.get("ETag"))
                            last_modified = _clean_header(
                                response.headers.get("Last-Modified")
                            )
                            if source.etag and etag != source.etag:
                                raise RemoteRangeSourceError(
                                    "The remote genomic source validator changed",
                                    failure_kind="source_changed",
                                )
                            if (
                                source.last_modified
                                and last_modified != source.last_modified
                            ):
                                raise RemoteRangeSourceError(
                                    "The remote genomic source validator changed",
                                    failure_kind="source_changed",
                                )

                            snapshot, snapshot_path = (
                                await _create_managed_snapshot_off_loop(
                                    snapshot_directory,
                                    source.byte_length,
                                    source.format,
                                )
                            )
                            digest = hashlib.sha256()
                            bytes_read = 0
                            bytes_written = 0
                            pending = bytearray()
                            try:
                                async for chunk in response.aiter_bytes():
                                    bytes_read += len(chunk)
                                    if bytes_read > source.byte_length:
                                        raise RemoteRangeSourceError(
                                            "The remote genomic source length changed",
                                            failure_kind="source_changed",
                                        )
                                    digest.update(chunk)
                                    pending.extend(chunk)
                                    while (
                                        len(pending)
                                        >= _MANAGED_SNAPSHOT_WRITE_BATCH_BYTES
                                    ):
                                        payload = bytes(
                                            pending[
                                                :_MANAGED_SNAPSHOT_WRITE_BATCH_BYTES
                                            ]
                                        )
                                        del pending[
                                            :_MANAGED_SNAPSHOT_WRITE_BATCH_BYTES
                                        ]
                                        remaining = source.byte_length - (
                                            bytes_written + len(payload)
                                        )
                                        await _run_snapshot_operation(
                                            _write_managed_snapshot_batch,
                                            snapshot,
                                            snapshot_path,
                                            payload,
                                            remaining,
                                        )
                                        bytes_written += len(payload)
                                if bytes_read != source.byte_length:
                                    raise RemoteRangeSourceError(
                                        "The remote genomic source returned a truncated body",
                                        failure_kind="source_changed",
                                    )
                                if pending:
                                    payload = bytes(pending)
                                    remaining = source.byte_length - (
                                        bytes_written + len(payload)
                                    )
                                    await _run_snapshot_operation(
                                        _write_managed_snapshot_batch,
                                        snapshot,
                                        snapshot_path,
                                        payload,
                                        remaining,
                                    )
                                    bytes_written += len(payload)
                                if bytes_written != source.byte_length:
                                    raise RemoteRangeSourceError(
                                        "The remote genomic source returned a truncated body",
                                        failure_kind="source_changed",
                                    )
                                await _run_snapshot_operation(
                                    _finalize_managed_snapshot, snapshot
                                )
                                (
                                    canonical_path,
                                    local_identity,
                                    probe,
                                ) = await _run_snapshot_operation(
                                    _inspect_local_source, snapshot_path
                                )
                                try:
                                    _require_expected_format(
                                        probe,
                                        source.format,
                                        source_kind="remote",
                                    )
                                except RemoteRangeSourceError as exc:
                                    raise RemoteRangeSourceError(
                                        "The remote genomic source changed format",
                                        failure_kind="source_changed",
                                    ) from exc
                                return (
                                    digest.hexdigest(),
                                    canonical_path,
                                    local_identity,
                                )
                            except BaseException:
                                await _run_snapshot_operation(
                                    _abort_managed_snapshot,
                                    snapshot,
                                    snapshot_path,
                                )
                                raise
                    except httpx.TransportError as exc:
                        last_transport_error = exc
                if redirect_target is not None:
                    current = redirect_target
                    continue
                if last_transport_error is not None:
                    raise RemoteRangeSourceError(
                        "The remote source could not be reached",
                        failure_kind="remote_unreachable",
                        retryable=_is_retryable_transport_error(last_transport_error),
                    ) from last_transport_error
                raise RemoteRangeSourceError(
                    "The remote source host could not be resolved",
                    failure_kind="remote_unreachable",
                    retryable=True,
                )
            raise RemoteRangeSourceError("The remote source redirected too many times")

    async def read_response(
        self, source_token: str, start: int, length: int
    ) -> RemoteRangeRead:
        if start < 0 or length < 1 or length > _MAX_READ_BYTES:
            raise RemoteRangeSourceError(
                f"Range reads require start >= 0 and length between 1 and {_MAX_READ_BYTES}"
            )
        source = await self._source_for_token(source_token)
        try:
            return await self._read_response_for_source(source, start, length)
        finally:
            await self._release_source_read(source)

    async def _read_response_for_source(
        self, source: _AdmittedSource, start: int, length: int
    ) -> RemoteRangeRead:
        if start >= source.byte_length:
            raise RemoteRangeSourceError(
                "The requested byte range starts beyond the source",
                failure_kind="range_not_satisfiable",
            )
        bounded_length = min(length, source.byte_length - start)
        key = (source.source_key, source.generation_key, start, bounded_length)

        if source.canonical_path is None:
            async with self._lock:
                cached = self._cache.get(key)
                if cached is not None:
                    self._cache.move_to_end(key)
                    return RemoteRangeRead(
                        payload=cached,
                        start=start,
                        end=start + len(cached) - 1,
                        byte_length=source.byte_length,
                        etag=source.etag,
                        last_modified=source.last_modified,
                    )

        payload = await self._range_single_flight.run(
            key,
            lambda: self._fetch_and_cache_range(
                key,
                source,
                start=start,
                length=bounded_length,
            ),
        )
        return RemoteRangeRead(
            payload=payload,
            start=start,
            end=start + len(payload) - 1,
            byte_length=source.byte_length,
            etag=source.etag,
            last_modified=source.last_modified,
        )

    async def _fetch_and_cache_range(
        self,
        key: tuple[str, str, int, int],
        source: _AdmittedSource,
        *,
        start: int,
        length: int,
    ) -> bytes:
        async with self._lock:
            source.read_limiter.active_reads += 1
        try:
            if self._persistent_cache is not None and source.canonical_url is not None:
                persisted = await asyncio.to_thread(
                    self._persistent_cache.get,
                    source.source_key,
                    source.generation_key,
                    start,
                    length,
                )
                if persisted is not None:
                    await self._remember_range(key, persisted)
                    return persisted

            payload = await self._fetch_range(source, start=start, length=length)
            if source.canonical_path is None:
                await self._remember_range(key, payload)
            if self._persistent_cache is not None and source.canonical_url is not None:
                self._enqueue_persistence(
                    source.source_key,
                    source.generation_key,
                    start,
                    payload,
                )
            return payload
        finally:
            await self._release_source_read(source)

    def _enqueue_persistence(
        self,
        source_key: str,
        generation_key: str,
        start: int,
        payload: bytes,
    ) -> None:
        """Best-effort persistence with one worker and a strict memory budget.

        Rendering never waits for disk caching. When the writer is slower than
        incoming range reads, excess blocks remain in the normal in-memory LRU
        and are simply not persisted instead of creating an unbounded task and
        payload backlog.
        """

        if self._closing or self._persistent_cache is None:
            return
        payload_bytes = len(payload)
        if (
            payload_bytes > _MAX_PERSISTENCE_QUEUE_BYTES
            or self._persistence_queued_bytes + payload_bytes
            > _MAX_PERSISTENCE_QUEUE_BYTES
            or self._persistence_queue.full()
        ):
            return
        self._persistence_queued_bytes += payload_bytes
        self._persistence_queue.put_nowait((source_key, generation_key, start, payload))
        if self._persistence_worker is None or self._persistence_worker.done():
            self._persistence_worker = asyncio.create_task(
                self._run_persistence_worker()
            )

    async def _run_persistence_worker(self) -> None:
        while True:
            source_key, generation_key, start, payload = (
                await self._persistence_queue.get()
            )
            try:
                if self._persistent_cache is not None:
                    await asyncio.to_thread(
                        self._persistent_cache.put,
                        source_key,
                        generation_key,
                        start,
                        payload,
                    )
            except Exception:
                pass
            finally:
                self._persistence_queued_bytes -= len(payload)
                self._persistence_queue.task_done()

    async def _remember_range(
        self, key: tuple[str, str, int, int], payload: bytes
    ) -> None:
        async with self._lock:
            if key not in self._cache:
                self._cache[key] = payload
                self._cache_bytes += len(payload)
                self._trim_cache_locked()

    async def _fetch_range(
        self, source: _AdmittedSource, *, start: int, length: int
    ) -> bytes:
        async with source.read_limiter.slots:
            if source.canonical_path is not None:
                identity, payload = await asyncio.to_thread(
                    _read_local_range, source.canonical_path, start, length
                )
                if identity != source.local_identity:
                    raise RemoteRangeSourceError(
                        "The local genomic source changed after admission",
                        failure_kind="source_changed",
                    )
                if len(payload) != length:
                    raise RemoteRangeSourceError(
                        "The local genomic source returned a truncated byte range",
                        failure_kind="source_changed",
                    )
                return payload

            if source.canonical_url is None:
                raise RemoteRangeSourceError("The indexed source locator is missing")
            validated_url = await self._validate_public_url(
                source.canonical_url, source.allowed_hosts
            )
            response, final_url = await self._request_with_validated_redirects(
                validated_url,
                headers={"Range": f"bytes={start}-{start + length - 1}"},
                allowed_hosts=source.allowed_hosts,
                max_body_bytes=length,
                authorization=source.authorization,
            )
            if final_url != source.canonical_url:
                raise RemoteRangeSourceError(
                    "The remote genomic source redirect changed",
                    failure_kind="source_changed",
                )
            payload, total_length = await self._validated_partial_response(
                response,
                requested_start=start,
                requested_length=length,
            )
            if total_length != source.byte_length:
                raise RemoteRangeSourceError(
                    "The remote genomic source length changed",
                    failure_kind="source_changed",
                )
            etag = _clean_header(response.headers.get("ETag"))
            last_modified = _clean_header(response.headers.get("Last-Modified"))
            if source.etag and etag != source.etag:
                raise RemoteRangeSourceError(
                    "The remote genomic source validator changed",
                    failure_kind="source_changed",
                )
            if source.last_modified and last_modified != source.last_modified:
                raise RemoteRangeSourceError(
                    "The remote genomic source validator changed",
                    failure_kind="source_changed",
                )
            return payload

    async def _source_for_token(self, token: str) -> _AdmittedSource:
        now = self._clock()
        async with self._lock:
            self._prune_expired_locked(now)
            source = self._sources.get(token)
            if source is None or source.expires_at <= now:
                raise RemoteRangeSourceError(
                    "The remote range grant is missing or expired",
                    failure_kind="grant_expired",
                    retryable=True,
                )
            self._sources.move_to_end(token)
            source.read_limiter.active_reads += 1
            return source

    @staticmethod
    def _grant_for_source(source: _AdmittedSource, now: float) -> RemoteRangeGrant:
        if source.canonical_url is not None:
            canonical_locator = source.canonical_url
            source_uri = source.canonical_url
        elif source.canonical_path is not None:
            canonical_locator = source.canonical_path
            source_uri = Path(source.canonical_path).as_uri()
        else:
            raise RemoteRangeSourceError("The indexed source locator is missing")
        return RemoteRangeGrant(
            source_uri=source_uri,
            source_token=source.token,
            canonical_url_hash=hashlib.sha256(canonical_locator.encode()).hexdigest(),
            format=source.format,
            byte_length=source.byte_length,
            accepts_ranges=True,
            etag=source.etag,
            last_modified=source.last_modified,
            expires_at=source.expires_at,
            expires_in_seconds=max(0, int(source.expires_at - now)),
            provenance_id=source.provenance_id,
        )

    async def _release_source_read(self, source: _AdmittedSource) -> None:
        async with self._lock:
            source.read_limiter.active_reads -= 1
            if source.read_limiter.active_reads == 0:
                retired = [
                    (path, snapshot_bytes)
                    for path, (
                        limiter,
                        snapshot_bytes,
                    ) in self._retired_snapshots.items()
                    if limiter is source.read_limiter
                ]
                for path, snapshot_bytes in retired:
                    _unlink_snapshot(path)
                    self._retired_snapshots.pop(path, None)
                    self._managed_snapshot_bytes -= snapshot_bytes
            self._remove_read_limiter_if_unused_locked(source)

    async def _reserve_managed_snapshot(self, expected_bytes: int) -> None:
        if expected_bytes > _MANAGED_SNAPSHOT_QUOTA_BYTES:
            raise RemoteRangeSourceError(
                "The remote genomic source exceeds the managed snapshot byte quota",
                failure_kind="snapshot_quota_exceeded",
            )
        async with self._lock:
            if (
                self._managed_snapshot_bytes + expected_bytes
                > _MANAGED_SNAPSHOT_QUOTA_BYTES
            ):
                raise RemoteRangeSourceError(
                    "The managed snapshot byte quota is currently exhausted",
                    failure_kind="snapshot_quota_exceeded",
                    retryable=True,
                )
            self._managed_snapshot_bytes += expected_bytes

    async def _release_managed_snapshot(self, expected_bytes: int) -> None:
        async with self._lock:
            self._managed_snapshot_bytes -= expected_bytes

    def _register_source_locked(self, source: _AdmittedSource, now: float) -> None:
        self._prune_expired_locked(now)
        identity = source.limiter_identity
        limiter = self._read_limiters.get(identity)
        if limiter is None:
            limiter = source.read_limiter
            self._read_limiters[identity] = limiter
        source.read_limiter = limiter
        limiter.grant_refs += 1
        self._sources[source.token] = source
        self._sources.move_to_end(source.token)
        while len(self._sources) > _MAX_TOKENS:
            expired_token = next(iter(self._sources))
            self._remove_source_locked(expired_token)

    def _remove_source_locked(self, token: str) -> None:
        source = self._sources.pop(token, None)
        if source is None:
            return
        if source.owned_snapshot_path is not None:
            if source.read_limiter.active_reads == 0:
                _unlink_snapshot(source.owned_snapshot_path)
                self._managed_snapshot_bytes -= source.owned_snapshot_bytes
            else:
                self._retired_snapshots[source.owned_snapshot_path] = (
                    source.read_limiter,
                    source.owned_snapshot_bytes,
                )
            source.owned_snapshot_path = None
        source.read_limiter.grant_refs -= 1
        self._remove_read_limiter_if_unused_locked(source)

    def _remove_read_limiter_if_unused_locked(self, source: _AdmittedSource) -> None:
        limiter = source.read_limiter
        if limiter.grant_refs > 0 or limiter.active_reads > 0:
            return
        identity = source.limiter_identity
        if self._read_limiters.get(identity) is limiter:
            self._read_limiters.pop(identity, None)

    async def _validate_public_url(
        self, raw_url: str, allowed_hosts: frozenset[str] | None
    ) -> _ValidatedPublicUrl:
        try:
            parsed = urlsplit(raw_url.strip())
        except ValueError as exc:
            raise RemoteRangeSourceError("The remote source URL is invalid") from exc
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise RemoteRangeSourceError("The remote source must use HTTP or HTTPS")
        hostname = parsed.hostname.casefold()
        if allowed_hosts is not None and hostname not in allowed_hosts:
            raise RemoteRangeSourceError(
                "The remote source host is not approved for indexed genomic data"
            )
        if parsed.username or parsed.password or parsed.fragment:
            raise RemoteRangeSourceError(
                "The remote source URL may not contain credentials"
            )
        try:
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
        except ValueError as exc:
            raise RemoteRangeSourceError(
                "The remote source URL has an invalid port"
            ) from exc
        if port not in {80, 443}:
            raise RemoteRangeSourceError(
                "The remote source URL must use port 80 or 443"
            )
        if any(_is_credential_query_key(key) for key, _ in parse_qsl(parsed.query)):
            raise RemoteRangeSourceError(
                "The remote source URL may not contain credential parameters"
            )

        try:
            addresses = await self._resolver(
                parsed.hostname, port, type=socket.SOCK_STREAM
            )
        except socket.gaierror as exc:
            raise RemoteRangeSourceError(
                "The remote source host could not be resolved",
                failure_kind="remote_unreachable",
                retryable=_is_retryable_dns_error(exc),
            ) from exc
        except OSError as exc:
            raise RemoteRangeSourceError(
                "The remote source host could not be resolved",
                failure_kind="remote_unreachable",
                retryable=True,
            ) from exc
        if not addresses:
            raise RemoteRangeSourceError(
                "The remote source host could not be resolved",
                failure_kind="remote_unreachable",
                retryable=False,
            )
        public_addresses: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
        for address in addresses:
            try:
                ip = ipaddress.ip_address(address[4][0])
            except (ValueError, IndexError, TypeError) as exc:
                raise RemoteRangeSourceError(
                    "The remote source host returned an invalid address"
                ) from exc
            if not ip.is_global:
                raise RemoteRangeSourceError("The remote source must use a public host")
            if ip not in public_addresses:
                public_addresses.append(ip)

        netloc = hostname
        if (parsed.scheme == "https" and port != 443) or (
            parsed.scheme == "http" and port != 80
        ):
            netloc = f"{hostname}:{port}"
        canonical_url = urlunsplit(
            (parsed.scheme, netloc, parsed.path or "/", parsed.query, "")
        )
        default_port = 443 if parsed.scheme == "https" else 80
        connect_urls = tuple(
            urlunsplit(
                (
                    parsed.scheme,
                    _ip_connect_netloc(ip, port, default_port),
                    parsed.path or "/",
                    parsed.query,
                    "",
                )
            )
            for ip in public_addresses
        )
        return _ValidatedPublicUrl(
            canonical_url=canonical_url,
            connect_urls=connect_urls,
            host_header=netloc,
            sni_hostname=hostname,
        )

    async def _request_with_validated_redirects(
        self,
        source_url: _ValidatedPublicUrl,
        *,
        headers: dict[str, str],
        allowed_hosts: frozenset[str] | None,
        max_body_bytes: int,
        authorization: _RemoteAuthorizationContext | None = None,
    ) -> tuple[_BoundedHttpResponse, str]:
        current = source_url
        for _ in range(_MAX_REDIRECTS + 1):
            redirect_target: _ValidatedPublicUrl | None = None
            last_transport_error: httpx.TransportError | None = None
            for connect_url in current.connect_urls:
                try:
                    request_headers = self._authorized_headers(
                        authorization,
                        current.canonical_url,
                        {
                            **headers,
                            "Accept": "application/octet-stream",
                            "Accept-Encoding": "identity",
                            "Connection": "close",
                            "Host": current.host_header,
                            "User-Agent": "DNAForge/remote-range",
                        },
                    )
                    async with self._client.stream(
                        "GET",
                        connect_url,
                        headers=request_headers,
                        follow_redirects=False,
                        timeout=httpx.Timeout(20.0, connect=8.0),
                        extensions={"sni_hostname": current.sni_hostname},
                    ) as response:
                        if response.status_code not in _REDIRECT_CODES:
                            return (
                                _BoundedHttpResponse(
                                    status_code=response.status_code,
                                    headers=response.headers,
                                    content=await _read_bounded_response_body(
                                        response, max_body_bytes=max_body_bytes
                                    ),
                                ),
                                current.canonical_url,
                            )
                        location = response.headers.get("Location")
                        if not location:
                            raise RemoteRangeSourceError(
                                "The remote source returned an empty redirect"
                            )
                        redirect_target = await self._validate_public_url(
                            urljoin(current.canonical_url, location), allowed_hosts
                        )
                        break
                except httpx.TransportError as exc:
                    last_transport_error = exc
            if redirect_target is not None:
                current = redirect_target
                continue
            if last_transport_error is not None:
                raise RemoteRangeSourceError(
                    "The remote source could not be reached",
                    failure_kind="remote_unreachable",
                    retryable=_is_retryable_transport_error(last_transport_error),
                ) from last_transport_error
            raise RemoteRangeSourceError(
                "The remote source host could not be resolved",
                failure_kind="remote_unreachable",
                retryable=True,
            )
        raise RemoteRangeSourceError("The remote source redirected too many times")

    def _authorized_headers(
        self,
        authorization: _RemoteAuthorizationContext | None,
        canonical_url: str,
        headers: dict[str, str],
    ) -> dict[str, str]:
        if authorization is None:
            return headers
        if (
            authorization.initial_origin is not None
            and _url_origin(canonical_url) != authorization.initial_origin
        ):
            raise RemoteRangeSourceError(
                "An authenticated genomic source may not redirect to another origin.",
                failure_kind="credential_redirect_forbidden",
            )
        authorized = dict(headers)
        if authorization.requester_pays:
            authorized["x-amz-request-payer"] = "requester"
        if authorization.billing_project:
            authorized["x-goog-user-project"] = authorization.billing_project
        if authorization.auth_ref is None:
            return authorized
        try:
            return self._credential_broker.authorize(
                auth_ref=authorization.auth_ref,
                audience=authorization.audience,
                url=canonical_url,
                headers=authorized,
                aws_region=authorization.aws_region,
            )
        except CredentialBrokerError as exc:
            raise RemoteRangeSourceError(
                str(exc), failure_kind=exc.failure_kind
            ) from exc

    @staticmethod
    async def _validated_partial_response(
        response: _BoundedHttpResponse,
        *,
        requested_start: int,
        requested_length: int,
    ) -> tuple[bytes, int]:
        if response.status_code != 206:
            failure_kind = (
                "range_unsupported"
                if response.status_code == 200
                else "remote_http_error"
            )
            raise RemoteRangeSourceError(
                _remote_http_failure_message(response.status_code),
                failure_kind=failure_kind,
                retryable=_is_retryable_remote_http_status(response.status_code),
                status_code=response.status_code,
            )
        match = _CONTENT_RANGE_RE.match(response.headers.get("Content-Range", ""))
        if match is None:
            raise RemoteRangeSourceError(
                "The remote source returned an invalid Content-Range"
            )
        actual_start, actual_end, total_length = (
            int(value) for value in match.groups()
        )
        expected_end = requested_start + requested_length - 1
        actual_length = actual_end - actual_start + 1
        if (
            actual_start != requested_start
            or actual_end > expected_end
            or actual_end < actual_start
            or total_length <= actual_end
            or (actual_end != expected_end and actual_end != total_length - 1)
        ):
            raise RemoteRangeSourceError(
                "The remote source returned the wrong byte range"
            )
        payload = response.content
        if len(payload) != actual_length:
            raise RemoteRangeSourceError(
                "The remote source returned a truncated byte range"
            )
        return payload, total_length

    def _prune_expired_locked(self, now: float) -> None:
        for token, source in list(self._sources.items()):
            if source.expires_at <= now and source.read_limiter.active_reads == 0:
                self._remove_source_locked(token)

    def _trim_cache_locked(self) -> None:
        while self._cache_bytes > _MAX_CACHE_BYTES and self._cache:
            _, payload = self._cache.popitem(last=False)
            self._cache_bytes -= len(payload)


async def _resolve_host(
    host: str, port: int, *, type: socket.SocketKind
) -> list[tuple]:
    return await asyncio.get_running_loop().getaddrinfo(host, port, type=type)


def _clean_header(value: str | None) -> str | None:
    clean = (value or "").strip()
    return clean or None


def _is_retryable_remote_http_status(status_code: int) -> bool:
    return status_code in {408, 425, 429} or status_code >= 500


def _ip_connect_netloc(
    ip: ipaddress.IPv4Address | ipaddress.IPv6Address,
    port: int,
    default_port: int,
) -> str:
    host = f"[{ip.compressed}]" if ip.version == 6 else ip.compressed
    return host if port == default_port else f"{host}:{port}"


def _is_retryable_dns_error(error: socket.gaierror) -> bool:
    return error.errno == socket.EAI_AGAIN


def _is_retryable_transport_error(error: httpx.TransportError) -> bool:
    current: BaseException | None = error
    for _ in range(8):
        if isinstance(current, ssl.SSLCertVerificationError):
            return False
        message = str(current).casefold()
        if (
            "certificate_verify_failed" in message
            or "certificate verify failed" in message
        ):
            return False
        current = current.__cause__ or current.__context__
        if current is None:
            break
    return True


def _remote_http_failure_message(status_code: int) -> str:
    if status_code == 200:
        return "The remote source does not support byte ranges (HTTP 200)"
    if status_code == 404:
        return "The remote track file was not found (HTTP 404)"
    if status_code == 410:
        return "The remote track file is no longer available (HTTP 410)"
    if status_code in {401, 403}:
        return f"The remote track file did not allow access (HTTP {status_code})"
    return f"The remote track request failed (HTTP {status_code})"


def _require_expected_format(
    probe: bytes,
    expected_format: RemoteIndexedFormat,
    *,
    source_kind: Literal["local", "remote"],
) -> RemoteIndexedFormat:
    """Validate the declared indexed-container family before issuing a grant.

    BAM, VCF, BCF, TBI, CRAI, and CSI files emitted by htslib are gzip/BGZF containers, so
    their inner magic is not necessarily visible in the first range. The
    alignment-header admission that consumes these grants remains the paired
    format/index authority; this boundary proves the container family, stable
    validators, and safe range behavior before htslib sees a URL.
    """

    detected_bbi = (
        _MAGIC_FORMAT.get(int.from_bytes(probe[:4], "little"))
        if len(probe) >= 4
        else None
    )
    if expected_format in {"bigwig", "bigbed"}:
        if detected_bbi is None:
            raise RemoteRangeSourceError(
                f"The {source_kind} source is not a BigWig or BigBed file"
            )
        if detected_bbi != expected_format:
            raise RemoteRangeSourceError(
                f"The {source_kind} source is {detected_bbi}, not the expected {expected_format}"
            )
        return detected_bbi

    matches = {
        "bam": _is_bgzf_probe(probe),
        "cram": probe.startswith(b"CRAM"),
        "bai": probe.startswith(b"BAI\x01"),
        "crai": _is_gzip_probe(probe) or _is_plain_crai_probe(probe),
        "csi": probe.startswith(b"CSI\x01") or _is_bgzf_probe(probe),
        "vcf": _is_bgzf_probe(probe),
        "bcf": _is_bgzf_probe(probe),
        "tbi": _is_bgzf_probe(probe),
    }[expected_format]
    if not matches:
        raise RemoteRangeSourceError(
            f"The {source_kind} source does not match the expected {expected_format} container"
        )
    return expected_format


def _is_gzip_probe(probe: bytes) -> bool:
    return len(probe) >= 3 and probe[:3] == b"\x1f\x8b\x08"


def _is_bgzf_probe(probe: bytes) -> bool:
    if len(probe) < 18 or not _is_gzip_probe(probe) or probe[3] & 0x04 == 0:
        return False
    extra_length = int.from_bytes(probe[10:12], "little")
    extra_end = 12 + extra_length
    if extra_end > len(probe):
        return False
    offset = 12
    while offset + 4 <= extra_end:
        subfield_id = probe[offset : offset + 2]
        subfield_length = int.from_bytes(probe[offset + 2 : offset + 4], "little")
        offset += 4
        if offset + subfield_length > extra_end:
            return False
        if subfield_id == b"BC" and subfield_length == 2:
            return True
        offset += subfield_length
    return False


def _is_plain_crai_probe(probe: bytes) -> bool:
    try:
        prefix = probe.decode("ascii").lstrip()
    except UnicodeDecodeError:
        return False
    first_field = prefix.split("\t", 1)[0]
    return first_field.removeprefix("-").isdigit()


def _remote_cache_identity(
    *,
    canonical_url: str,
    format: RemoteIndexedFormat,
    byte_length: int,
    etag: str | None,
    last_modified: str | None,
) -> tuple[str, str]:
    source_key = _identity_digest("remote-url-v1", canonical_url)
    generation_key = _identity_digest(
        "remote-generation-v1",
        format,
        byte_length,
        etag or "",
        last_modified or "",
    )
    return source_key, generation_key


def _local_cache_identity(
    *,
    canonical_path: str,
    format: RemoteIndexedFormat,
    identity: tuple[int, int, int, int, int],
) -> tuple[str, str]:
    source_key = _identity_digest("local-path-v1", canonical_path)
    generation_key = _identity_digest("local-generation-v1", format, *identity)
    return source_key, generation_key


def _identity_digest(contract: str, *parts: str | int) -> str:
    encoded = json.dumps([contract, *parts], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def _is_credential_query_key(key: str) -> bool:
    normalized = key.casefold()
    return normalized in _CREDENTIAL_QUERY_KEYS or normalized.startswith(
        _CREDENTIAL_QUERY_PREFIXES
    )


def _url_origin(raw_url: str) -> str:
    parsed = urlsplit(raw_url)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return f"{parsed.scheme}://{parsed.hostname.casefold() if parsed.hostname else ''}:{port}"


async def _read_bounded_response_body(
    response: httpx.Response, *, max_body_bytes: int
) -> bytes:
    if response.status_code != 206:
        return b""
    content_encoding = (
        response.headers.get("Content-Encoding") or "identity"
    ).casefold()
    if content_encoding != "identity":
        raise RemoteRangeSourceError(
            "The remote source may not compress indexed byte-range responses"
        )
    declared_length = response.headers.get("Content-Length")
    if declared_length is not None:
        try:
            parsed_length = int(declared_length)
        except ValueError as exc:
            raise RemoteRangeSourceError(
                "The remote source returned an invalid Content-Length"
            ) from exc
        if parsed_length < 0 or parsed_length > max_body_bytes:
            raise RemoteRangeSourceError(
                "The remote source returned more data than the requested byte range"
            )

    if response.is_stream_consumed:
        if len(response.content) > max_body_bytes:
            raise RemoteRangeSourceError(
                "The remote source returned more data than the requested byte range"
            )
        return response.content

    payload = bytearray()
    async for chunk in response.aiter_raw():
        if len(payload) + len(chunk) > max_body_bytes:
            raise RemoteRangeSourceError(
                "The remote source returned more data than the requested byte range"
            )
        payload.extend(chunk)
    return bytes(payload)


async def _run_snapshot_operation(operation: Callable[..., _T], *args: object) -> _T:
    """Run one file operation off-loop and settle it before cancellation."""

    task = asyncio.create_task(asyncio.to_thread(operation, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        try:
            await task
        except BaseException:
            pass
        raise


async def _create_managed_snapshot_off_loop(
    directory: str,
    expected_bytes: int,
    format_id: RemoteIndexedFormat,
) -> tuple[BinaryIO, str]:
    """Create a snapshot off-loop without losing ownership on cancellation."""

    task = asyncio.create_task(
        asyncio.to_thread(
            _create_managed_snapshot,
            directory,
            expected_bytes,
            format_id,
        )
    )
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        try:
            snapshot, snapshot_path = await task
        except BaseException:
            pass
        else:
            await _run_snapshot_operation(
                _abort_managed_snapshot, snapshot, snapshot_path
            )
        raise


def _managed_snapshot_directory() -> str:
    return tempfile.gettempdir()


def _snapshot_free_bytes(directory: str) -> int:
    try:
        if sys.platform == "darwin":
            return _snapshot_macos_capacity(directory, int(time.monotonic()))
        return read_storage_capacity(directory, purpose="important").available_bytes
    except OSError as exc:
        raise RemoteRangeSourceError(
            "The managed snapshot available capacity is unknown",
            failure_kind="snapshot_storage_unavailable",
            retryable=True,
        ) from exc


@lru_cache(maxsize=16)
def _snapshot_macos_capacity(directory: str, second: int) -> int:
    return read_storage_capacity(directory, purpose="important").available_bytes


def _require_managed_snapshot_free_space(
    directory: str, bytes_still_required: int
) -> None:
    required = bytes_still_required + _MIN_MANAGED_SNAPSHOT_FREE_BYTES
    if _snapshot_free_bytes(directory) < required:
        raise RemoteRangeSourceError(
            "The managed snapshot does not have enough free space",
            failure_kind="snapshot_storage_unavailable",
            retryable=True,
        )


def _create_managed_snapshot(
    directory: str,
    expected_bytes: int,
    format_id: RemoteIndexedFormat,
) -> tuple[BinaryIO, str]:
    _require_managed_snapshot_free_space(directory, expected_bytes)
    try:
        descriptor, snapshot_path = tempfile.mkstemp(
            dir=directory,
            prefix="dnaforge-remote-range-",
            suffix=f".{format_id}",
        )
    except OSError as exc:
        raise RemoteRangeSourceError(
            "The managed snapshot could not be created",
            failure_kind="snapshot_storage_unavailable",
            retryable=True,
        ) from exc
    try:
        return os.fdopen(descriptor, "wb", buffering=0), snapshot_path
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        _unlink_snapshot(snapshot_path)
        raise


def _write_managed_snapshot_batch(
    snapshot: BinaryIO,
    snapshot_path: str,
    payload: bytes,
    remaining_after_write: int,
) -> None:
    if remaining_after_write < 0:
        raise RemoteRangeSourceError(
            "The remote genomic source length changed",
            failure_kind="source_changed",
        )
    directory = str(Path(snapshot_path).parent)
    _require_managed_snapshot_free_space(
        directory, len(payload) + remaining_after_write
    )
    try:
        written = snapshot.write(payload)
    except OSError as exc:
        raise RemoteRangeSourceError(
            "The managed snapshot could not be written",
            failure_kind="snapshot_storage_unavailable",
            retryable=True,
        ) from exc
    if written != len(payload):
        raise RemoteRangeSourceError(
            "The managed snapshot could not be written completely",
            failure_kind="snapshot_storage_unavailable",
            retryable=True,
        )
    _require_managed_snapshot_free_space(directory, remaining_after_write)


def _finalize_managed_snapshot(snapshot: BinaryIO) -> None:
    try:
        snapshot.flush()
        os.fsync(snapshot.fileno())
        snapshot.close()
    except OSError as exc:
        try:
            snapshot.close()
        except OSError:
            pass
        raise RemoteRangeSourceError(
            "The managed snapshot could not be finalized",
            failure_kind="snapshot_storage_unavailable",
            retryable=True,
        ) from exc


def _abort_managed_snapshot(snapshot: BinaryIO, snapshot_path: str) -> None:
    try:
        snapshot.close()
    except OSError:
        pass
    _unlink_snapshot(snapshot_path)


def _inspect_local_source(
    source_path: str,
) -> tuple[str, tuple[int, int, int, int, int], bytes]:
    try:
        canonical_path = os.path.realpath(os.path.abspath(source_path))
        before = os.stat(canonical_path)
    except (OSError, ValueError) as exc:
        raise RemoteRangeSourceError(
            "The selected local genomic source could not be opened"
        ) from exc
    if not stat_module.S_ISREG(before.st_mode):
        raise RemoteRangeSourceError(
            "The selected local genomic source is not a regular file"
        )
    try:
        with open(canonical_path, "rb", buffering=0) as handle:
            opened = os.fstat(handle.fileno())
            probe = handle.read(_PROBE_BYTES)
        after = os.stat(canonical_path)
    except OSError as exc:
        raise RemoteRangeSourceError(
            "The selected local genomic source could not be read"
        ) from exc
    before_identity = _local_identity(before)
    opened_identity = _local_identity(opened)
    after_identity = _local_identity(after)
    if before_identity != opened_identity or opened_identity != after_identity:
        raise RemoteRangeSourceError(
            "The local genomic source changed during admission"
        )
    return canonical_path, after_identity, probe


def _read_local_range(
    canonical_path: str, start: int, length: int
) -> tuple[tuple[int, int, int, int, int], bytes]:
    try:
        before = os.stat(canonical_path)
        if not stat_module.S_ISREG(before.st_mode):
            raise RemoteRangeSourceError(
                "The local genomic source is no longer a regular file"
            )
        with open(canonical_path, "rb", buffering=0) as handle:
            opened_before = os.fstat(handle.fileno())
            handle.seek(start)
            payload = handle.read(length)
            opened_after = os.fstat(handle.fileno())
        after = os.stat(canonical_path)
    except RemoteRangeSourceError:
        raise
    except OSError as exc:
        raise RemoteRangeSourceError(
            "The local genomic source could not be read"
        ) from exc
    before_identity = _local_identity(before)
    opened_before_identity = _local_identity(opened_before)
    opened_after_identity = _local_identity(opened_after)
    after_identity = _local_identity(after)
    if (
        before_identity != opened_before_identity
        or opened_before_identity != opened_after_identity
        or opened_after_identity != after_identity
    ):
        raise RemoteRangeSourceError(
            "The local genomic source changed during the range read"
        )
    return after_identity, payload


def _unlink_snapshot(snapshot_path: str) -> None:
    """Remove one service-owned immutable snapshot without masking its caller."""

    try:
        Path(snapshot_path).unlink(missing_ok=True)
    except OSError:
        pass


def _local_identity(metadata: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
        metadata.st_dev,
        metadata.st_ino,
    )
