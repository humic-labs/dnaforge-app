"""UCSC-specific methods mixed into ExternalResourcesService."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, TypeVar

from .contract import Capability, FetchOptions, ProviderContractError, ProviderError
from .persistent_track_cache import PersistentTrackCache
from .providers.ucsc import (
    UcscApiEndpoint,
    UcscApiPayload,
    UcscCatalogLeaf,
    UcscProvider,
    UcscRegionResult,
)
from .remote_range import RemoteRangeGrant, RemoteRangeMaterialization, RemoteRangeRead
from .service_types import CircuitOpen, UnknownProvider

_UCSC_REQUIRED = [Capability.EXTERNAL_FETCH_ANNOTATION.value]
_MAX_SPLIT_DEPTH = 12
_MAX_COMBINED_RECORDS = 250_000
_UCSC_SPARSE_SNAPSHOT_NAMESPACE = "ucsc-sparse-snapshot.v1"
_UCSC_SPARSE_SNAPSHOT_CONTRACT = "dnaforge.ucsc-sparse-snapshot.v1"
_UCSC_SPARSE_SNAPSHOT_MAX_AGE_NS = 7 * 24 * 60 * 60 * 1_000_000_000
_STRONG_ETAG_RE = re.compile(r'^"[\x21\x23-\x7e\x80-\xff]*"$')
_UcscApiResult = TypeVar("_UcscApiResult")


@dataclass(frozen=True)
class UcscTrackAdmissionResult:
    source_uri: str
    grant: RemoteRangeGrant
    representation_sha256: str
    representation_identity_kind: str


class UcscServiceMixin:
    """Search UCSC tracks and fetch complete regional record sets."""

    async def request_ucsc_api(
        self,
        endpoint: UcscApiEndpoint,
        *,
        params: Mapping[str, str],
        granted_capabilities: list[str],
        workspace_id: str | None = None,
        opts: FetchOptions | None = None,
    ) -> dict[str, Any] | str:
        """Run one allowlisted UCSC API endpoint through shared resilience."""

        async def request(
            provider: UcscProvider,
            request_opts: FetchOptions,
        ) -> dict[str, Any] | str:
            return await provider.request_api(
                endpoint,
                params=params,
                opts=request_opts,
            )

        return await self._request_ucsc_api_with(
            endpoint,
            granted_capabilities=granted_capabilities,
            workspace_id=workspace_id,
            opts=opts,
            request=request,
        )

    async def request_ucsc_api_payload(
        self,
        endpoint: UcscApiEndpoint,
        *,
        params: Mapping[str, str],
        granted_capabilities: list[str],
        workspace_id: str | None = None,
        opts: FetchOptions | None = None,
    ) -> UcscApiPayload:
        """Run one allowlisted UCSC API endpoint into a bounded disk spool."""

        async def request(
            provider: UcscProvider,
            request_opts: FetchOptions,
        ) -> UcscApiPayload:
            return await provider.request_api_payload(
                endpoint,
                params=params,
                opts=request_opts,
            )

        return await self._request_ucsc_api_with(
            endpoint,
            granted_capabilities=granted_capabilities,
            workspace_id=workspace_id,
            opts=opts,
            request=request,
        )

    async def _request_ucsc_api_with(
        self,
        endpoint: UcscApiEndpoint,
        *,
        granted_capabilities: list[str],
        workspace_id: str | None,
        opts: FetchOptions | None,
        request: Callable[[UcscProvider, FetchOptions], Awaitable[_UcscApiResult]],
    ) -> _UcscApiResult:
        """Apply one resilience and audit boundary to either response shape."""

        provider = self._ucsc_provider()
        self._check_required_capabilities(_UCSC_REQUIRED, granted_capabilities)
        request_opts = opts or FetchOptions()
        target = f"{provider.DEFAULT_BASE_URL}{endpoint.value}"

        async def _do() -> _UcscApiResult:
            if provider._client is None:
                provider._client = self._client
            return await request(provider, request_opts)

        t0 = time.perf_counter()
        try:
            result = await self._run_through_resilience(
                provider,
                request_opts,
                _do,
            )
        except (ProviderError, CircuitOpen) as exc:
            self._log_thin_call(
                provider=provider,
                endpoint=target,
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=int((time.perf_counter() - t0) * 1000),
                exc=exc,
                required_capabilities=_UCSC_REQUIRED,
            )
            raise
        self._log_thin_call(
            provider=provider,
            endpoint=target,
            granted=granted_capabilities,
            workspace_id=workspace_id,
            latency_ms=int((time.perf_counter() - t0) * 1000),
            status_code=200,
            required_capabilities=_UCSC_REQUIRED,
        )
        return result

    async def list_ucsc_catalog(
        self,
        genome: str,
        *,
        granted_capabilities: list[str],
        workspace_id: str | None = None,
        hub_url: str | None = None,
        opts: FetchOptions | None = None,
    ) -> Sequence[UcscCatalogLeaf]:
        """Every renderable track an assembly's catalog declares.

        The catalog is small enough to hand over whole. Human is the
        largest assembly UCSC publishes and it is a couple of megabytes of
        JSON. A caller holding all of it can match, group, and count
        against the real set, so a folder size and a result total become
        facts instead of artifacts of how much the server chose to return.
        """
        return await self._resolve_ucsc_catalog(
            genome,
            granted_capabilities=granted_capabilities,
            workspace_id=workspace_id,
            hub_url=hub_url,
            opts=opts,
        )

    async def search_ucsc_tracks(
        self,
        genome: str,
        query: str,
        *,
        limit: int,
        granted_capabilities: list[str],
        workspace_id: str | None = None,
        hub_url: str | None = None,
        opts: FetchOptions | None = None,
    ) -> list[UcscCatalogLeaf]:
        """Substring search kept for callers that want one exact track.

        The picker no longer calls this: it takes the whole catalog once
        and matches locally, which is the only way its counts can be
        right. A resolver looking up a single saved track identifier still
        wants a one-shot answer, so this stays.
        """
        leaves = await self._resolve_ucsc_catalog(
            genome,
            granted_capabilities=granted_capabilities,
            workspace_id=workspace_id,
            hub_url=hub_url,
            opts=opts,
        )
        clean_query = query.strip()
        needle = clean_query.casefold()
        if needle:
            leaves = [
                leaf
                for leaf in leaves
                if needle
                in " ".join(
                    filter(
                        None,
                        (
                            leaf.track,
                            leaf.short_label,
                            leaf.long_label,
                            leaf.group,
                            leaf.track_type,
                            leaf.parent_track,
                            leaf.parent_parent_track,
                            leaf.experiment_accession,
                            leaf.file_accession,
                            " ".join(
                                f"{attribute.key} {attribute.value}"
                                for attribute in leaf.attributes
                            ),
                            " ".join(
                                container.short_label
                                for container in leaf.container_path
                            ),
                        ),
                    )
                ).casefold()
            ]
            exact = next((leaf for leaf in leaves if leaf.track == clean_query), None)
            if exact is not None:
                leaves = [exact, *(leaf for leaf in leaves if leaf is not exact)]
        return list(leaves[:limit])

    async def _resolve_ucsc_catalog(
        self,
        genome: str,
        *,
        granted_capabilities: list[str],
        workspace_id: str | None,
        hub_url: str | None,
        opts: FetchOptions | None,
    ) -> Sequence[UcscCatalogLeaf]:
        """Fetch-or-reuse the normalized catalog for one assembly."""
        provider = self._ucsc_provider()
        self._check_required_capabilities(_UCSC_REQUIRED, granted_capabilities)
        request_opts = opts or FetchOptions()
        clean_hub_url = provider.normalize_hub_url(hub_url) if hub_url else None
        if clean_hub_url:
            await self._require_ucsc_hub_genome(
                provider=provider,
                genome=genome,
                hub_url=clean_hub_url,
                request_opts=request_opts,
                granted_capabilities=granted_capabilities,
                workspace_id=workspace_id,
            )
        endpoint = f"{provider.DEFAULT_BASE_URL}{provider.LIST_TRACKS_PATH}"

        async def _do() -> list[UcscCatalogLeaf]:
            if provider._client is None:
                provider._client = self._client
            return await provider.list_tracks(
                genome,
                hub_url=clean_hub_url,
                opts=request_opts,
            )

        t0 = time.perf_counter()
        leaves = provider.get_cached_tracks(genome, hub_url=clean_hub_url)
        cache_hit = leaves is not None
        try:
            if leaves is None:
                leaves = await self._run_through_resilience(provider, request_opts, _do)
        except (ProviderError, CircuitOpen) as exc:
            self._log_thin_call(
                provider=provider,
                endpoint=endpoint,
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=int((time.perf_counter() - t0) * 1000),
                exc=exc,
                required_capabilities=_UCSC_REQUIRED,
            )
            raise
        if not cache_hit:
            self._log_thin_call(
                provider=provider,
                endpoint=endpoint,
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=int((time.perf_counter() - t0) * 1000),
                status_code=200,
                required_capabilities=_UCSC_REQUIRED,
            )
        return leaves

    async def fetch_ucsc_track_region(
        self,
        *,
        genome: str,
        track: str,
        chrom: str | None,
        start: int | None,
        end: int | None,
        max_items_output: int,
        granted_capabilities: list[str],
        workspace_id: str | None = None,
        hub_url: str | None = None,
        opts: FetchOptions | None = None,
    ) -> UcscRegionResult:
        provider = self._ucsc_provider()
        self._check_required_capabilities(_UCSC_REQUIRED, granted_capabilities)
        request_opts = opts or FetchOptions()
        clean_hub_url = provider.normalize_hub_url(hub_url) if hub_url else None
        if clean_hub_url is None:
            if provider._client is None:
                provider._client = self._client
            clean_hub_url = await provider.resolve_genark_hub_url(
                genome, opts=request_opts
            )
        endpoint = f"{provider.DEFAULT_BASE_URL}{provider.GET_TRACK_PATH}"
        t0 = time.perf_counter()

        if chrom is None and start is None and end is None:
            snapshot_identity = _ucsc_snapshot_identity(
                genome=genome,
                track=track,
                hub_url=clean_hub_url,
                max_items_output=max_items_output,
            )

            async def _load_whole_snapshot() -> UcscRegionResult:
                cache = self._persistent_track_cache
                if cache is not None:
                    cached_payload = await asyncio.to_thread(
                        cache.get_blob,
                        _UCSC_SPARSE_SNAPSHOT_NAMESPACE,
                        snapshot_identity,
                        max_age_ns=_UCSC_SPARSE_SNAPSHOT_MAX_AGE_NS,
                    )
                    cached = await asyncio.to_thread(
                        _decode_ucsc_snapshot,
                        cached_payload,
                        expected_max_items_output=max_items_output,
                    )
                    if cached is not None:
                        return cached

                async def _fetch_whole() -> UcscRegionResult:
                    if provider._client is None:
                        provider._client = self._client
                    return await provider.fetch_track_region(
                        genome=genome,
                        track=track,
                        chrom=None,
                        start=None,
                        end=None,
                        max_items_output=max_items_output,
                        hub_url=clean_hub_url,
                        opts=request_opts,
                    )

                try:
                    whole = await self._run_through_resilience(
                        provider, request_opts, _fetch_whole
                    )
                except (ProviderError, CircuitOpen) as exc:
                    self._log_thin_call(
                        provider=provider,
                        endpoint=endpoint,
                        granted=granted_capabilities,
                        workspace_id=workspace_id,
                        latency_ms=int((time.perf_counter() - t0) * 1000),
                        exc=exc,
                        required_capabilities=_UCSC_REQUIRED,
                    )
                    raise
                self._log_thin_call(
                    provider=provider,
                    endpoint=endpoint,
                    granted=granted_capabilities,
                    workspace_id=workspace_id,
                    latency_ms=int((time.perf_counter() - t0) * 1000),
                    status_code=200,
                    required_capabilities=_UCSC_REQUIRED,
                )
                if cache is not None and whole.complete:
                    await asyncio.to_thread(
                        _persist_ucsc_snapshot,
                        cache,
                        snapshot_identity,
                        whole,
                    )
                return whole

            return await self._ucsc_snapshot_single_flight.run(
                snapshot_identity,
                _load_whole_snapshot,
            )

        if chrom is None or start is None or end is None:
            raise ProviderContractError(
                "UCSC chromosome, start, and end must be supplied together",
                status_code=422,
            )

        async def _fetch_slice(
            slice_start: int,
            slice_end: int,
            depth: int,
        ) -> list[UcscRegionResult]:
            async def _do() -> UcscRegionResult:
                if provider._client is None:
                    provider._client = self._client
                return await provider.fetch_track_region(
                    genome=genome,
                    track=track,
                    chrom=chrom,
                    start=slice_start,
                    end=slice_end,
                    max_items_output=max_items_output,
                    hub_url=clean_hub_url,
                    opts=request_opts,
                )

            result = await self._run_through_resilience(provider, request_opts, _do)
            if result.complete:
                return [result]
            if depth >= _MAX_SPLIT_DEPTH or slice_end - slice_start <= 1:
                return [result]
            midpoint = slice_start + (slice_end - slice_start) // 2
            left = await _fetch_slice(slice_start, midpoint, depth + 1)
            right = await _fetch_slice(midpoint, slice_end, depth + 1)
            return [*left, *right]

        try:
            slices = await _fetch_slice(start, end, 0)
        except (ProviderError, CircuitOpen) as exc:
            self._log_thin_call(
                provider=provider,
                endpoint=endpoint,
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=int((time.perf_counter() - t0) * 1000),
                exc=exc,
                required_capabilities=_UCSC_REQUIRED,
            )
            raise

        records: list[dict[str, Any]] = []
        seen: set[str] = set()
        for result in slices:
            for record in result.records:
                key = json.dumps(record, sort_keys=True, separators=(",", ":"))
                if key in seen:
                    continue
                seen.add(key)
                records.append(record)
                if len(records) >= _MAX_COMBINED_RECORDS:
                    break
            if len(records) >= _MAX_COMBINED_RECORDS:
                break
        complete = all(result.complete for result in slices) and (
            len(records) < _MAX_COMBINED_RECORDS
        )
        combined = UcscRegionResult(
            records=records,
            complete=complete,
            items_returned=len(records),
            max_items_output=max_items_output,
            track_type=next(
                (result.track_type for result in slices if result.track_type),
                None,
            ),
            big_data_url=next(
                (result.big_data_url for result in slices if result.big_data_url),
                None,
            ),
        )
        self._log_thin_call(
            provider=provider,
            endpoint=endpoint,
            granted=granted_capabilities,
            workspace_id=workspace_id,
            latency_ms=int((time.perf_counter() - t0) * 1000),
            status_code=200,
            required_capabilities=_UCSC_REQUIRED,
        )
        return combined

    async def admit_ucsc_track(
        self,
        *,
        genome: str,
        track: str,
        format_id: str,
        probe_chrom: str,
        granted_capabilities: list[str],
        workspace_id: str | None = None,
        hub_url: str | None = None,
        opts: FetchOptions | None = None,
    ) -> UcscTrackAdmissionResult:
        """Resolve a UCSC leaf to an admitted indexed binary source."""

        if format_id not in {"bigwig", "bigbed"}:
            raise ProviderContractError(
                f"UCSC {format_id} sources do not use the BBI reader",
                status_code=422,
            )
        provider = self._ucsc_provider()
        self._check_required_capabilities(_UCSC_REQUIRED, granted_capabilities)

        async def _probe(chrom: str) -> UcscRegionResult:
            return await self.fetch_ucsc_track_region(
                genome=genome,
                track=track,
                chrom=chrom,
                start=0,
                end=1,
                max_items_output=1,
                granted_capabilities=granted_capabilities,
                workspace_id=workspace_id,
                hub_url=hub_url,
                opts=opts,
            )

        try:
            probe = await _probe(probe_chrom)
        except ProviderError as exc:
            if getattr(exc, "status_code", None) not in {400, 404}:
                raise
            fallback = await self._first_ucsc_chromosome(
                genome,
                granted_capabilities=granted_capabilities,
                hub_url=hub_url,
                opts=opts,
            )
            if not fallback or fallback == probe_chrom:
                raise
            probe = await _probe(fallback)
        resolved_big_data_url = probe.big_data_url
        if not resolved_big_data_url:
            raise ProviderContractError(
                f"UCSC track {track!r} does not expose an indexed binary source",
                status_code=422,
            )
        source_uri = provider.resolve_big_data_url(
            resolved_big_data_url,
            hub_url=hub_url,
        )
        grant = await self._remote_range.admit(
            source_uri,
            expected_format=format_id,
            provenance_id=f"ucsc:{genome}:{track}",
            allow_any_public_host=hub_url is not None,
        )
        (
            representation_sha256,
            representation_identity_kind,
        ) = await self._ucsc_representation_identity(grant)
        grant = await self._remote_range.current_grant(grant.source_token)
        return UcscTrackAdmissionResult(
            source_uri=source_uri,
            grant=grant,
            representation_sha256=representation_sha256,
            representation_identity_kind=representation_identity_kind,
        )

    async def _ucsc_representation_identity(
        self, grant: RemoteRangeGrant
    ) -> tuple[str, str]:
        """Return an exact, portable identity without defeating range streaming."""

        if grant.etag is not None and _STRONG_ETAG_RE.fullmatch(grant.etag) is not None:
            receipt = "\0".join(
                (
                    "dnaforge.http-strong-representation.v1",
                    grant.canonical_url_hash,
                    grant.format,
                    str(grant.byte_length),
                    grant.etag,
                )
            )
            return hashlib.sha256(receipt.encode()).hexdigest(), "strong-etag"

        return (
            await self._remote_range.content_sha256(grant.source_token),
            "content-sha256",
        )

    async def read_remote_track_range(
        self, source_token: str, start: int, length: int
    ) -> RemoteRangeRead:
        return await self._remote_range.read_response(source_token, start, length)

    async def get_remote_track_grant(self, source_token: str) -> RemoteRangeGrant:
        return await self._remote_range.current_grant(source_token)

    async def materialize_remote_track_source(
        self, source_token: str
    ) -> RemoteRangeMaterialization:
        return await self._remote_range.materialize(source_token)

    async def _first_ucsc_chromosome(
        self,
        genome: str,
        *,
        granted_capabilities: list[str],
        hub_url: str | None,
        opts: FetchOptions | None,
    ) -> str | None:
        """Any chromosome UCSC agrees this assembly has, or None."""

        provider = self._ucsc_provider()
        if provider._client is None:
            provider._client = self._client
        params = {"genome": genome}
        if hub_url:
            params["hubUrl"] = provider.normalize_hub_url(hub_url)
        try:
            body = await provider.request_api(
                UcscApiEndpoint.LIST_CHROMOSOMES,
                params=params,
                opts=opts or FetchOptions(),
            )
        except (ProviderError, ProviderContractError, CircuitOpen):
            return None
        if not isinstance(body, dict):
            return None
        chromosomes = body.get("chromosomes")
        if not isinstance(chromosomes, dict):
            return None
        for name in chromosomes:
            clean = str(name).strip()
            if clean:
                return clean
        return None

    async def _require_ucsc_hub_genome(
        self,
        *,
        provider: UcscProvider,
        genome: str,
        hub_url: str,
        request_opts: FetchOptions,
        granted_capabilities: list[str],
        workspace_id: str | None,
    ) -> None:
        """Fail before catalog loading when a hub is not exactly compatible."""

        endpoint = f"{provider.DEFAULT_BASE_URL}{provider.LIST_HUB_GENOMES_PATH}"
        genomes = provider.get_cached_hub_genomes(hub_url)
        cache_hit = genomes is not None
        t0 = time.perf_counter()

        async def _do() -> set[str]:
            if provider._client is None:
                provider._client = self._client
            return await provider.list_hub_genomes(hub_url, opts=request_opts)

        try:
            if genomes is None:
                genomes = await self._run_through_resilience(
                    provider,
                    request_opts,
                    _do,
                )
        except (ProviderError, CircuitOpen) as exc:
            self._log_thin_call(
                provider=provider,
                endpoint=endpoint,
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=int((time.perf_counter() - t0) * 1000),
                exc=exc,
                required_capabilities=_UCSC_REQUIRED,
            )
            raise
        if not cache_hit:
            self._log_thin_call(
                provider=provider,
                endpoint=endpoint,
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=int((time.perf_counter() - t0) * 1000),
                status_code=200,
                required_capabilities=_UCSC_REQUIRED,
            )
        clean_genome = genome.strip()
        if clean_genome not in genomes:
            available = ", ".join(sorted(genomes)[:8])
            suffix = f" It advertises: {available}." if available else ""
            raise ProviderContractError(
                f"This UCSC hub does not advertise exact {clean_genome}.{suffix}",
                status_code=422,
            )

    def _ucsc_provider(self) -> UcscProvider:
        provider = self._providers.get("ucsc")
        if provider is None:
            raise UnknownProvider("no provider registered for 'ucsc'")
        if not isinstance(provider, UcscProvider):
            raise UnknownProvider(
                "registered 'ucsc' provider does not support track queries "
                f"(got {provider.__class__.__name__})"
            )
        return provider


def _ucsc_snapshot_identity(
    *,
    genome: str,
    track: str,
    hub_url: str | None,
    max_items_output: int,
) -> str:
    return json.dumps(
        [
            _UCSC_SPARSE_SNAPSHOT_CONTRACT,
            genome,
            track,
            hub_url or "",
            max_items_output,
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _encode_ucsc_snapshot(result: UcscRegionResult) -> bytes:
    return json.dumps(
        {
            "contract": _UCSC_SPARSE_SNAPSHOT_CONTRACT,
            "records": result.records,
            "complete": result.complete,
            "itemsReturned": result.items_returned,
            "maxItemsOutput": result.max_items_output,
            "trackType": result.track_type,
            "bigDataUrl": result.big_data_url,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _persist_ucsc_snapshot(
    cache: PersistentTrackCache,
    identity: str,
    result: UcscRegionResult,
) -> bool:
    """Serialize and publish a snapshot entirely off the asyncio event loop."""

    return cache.put_blob(
        _UCSC_SPARSE_SNAPSHOT_NAMESPACE,
        identity,
        _encode_ucsc_snapshot(result),
    )


def _decode_ucsc_snapshot(
    payload: bytes | None,
    *,
    expected_max_items_output: int,
) -> UcscRegionResult | None:
    if payload is None:
        return None
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if (
        not isinstance(value, dict)
        or value.get("contract") != _UCSC_SPARSE_SNAPSHOT_CONTRACT
    ):
        return None
    records = value.get("records")
    items_returned = value.get("itemsReturned")
    max_items_output = value.get("maxItemsOutput")
    complete = value.get("complete")
    track_type = value.get("trackType")
    big_data_url = value.get("bigDataUrl")
    if (
        not isinstance(records, list)
        or not all(isinstance(record, dict) for record in records)
        or not isinstance(items_returned, int)
        or isinstance(items_returned, bool)
        or items_returned < len(records)
        or items_returned >= expected_max_items_output
        or max_items_output != expected_max_items_output
        or complete is not True
        or (track_type is not None and not isinstance(track_type, str))
        or (big_data_url is not None and not isinstance(big_data_url, str))
    ):
        return None
    return UcscRegionResult(
        records=records,
        complete=True,
        items_returned=items_returned,
        max_items_output=max_items_output,
        track_type=track_type,
        big_data_url=big_data_url,
    )
