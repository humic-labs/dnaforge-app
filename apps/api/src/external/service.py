"""External-resource service — orchestrator for provider fetches + persistence.

Plan: tools/devops/plans/2026-05-02-bioinformatics-db-substrate.md
       (sub-ticket DNA-XXa2)

Built on top of:
  -  substrate: src/control_plane/store.py (the DAO + concurrency spec)
  -  contract: src/external/contract.py (provider Protocol)

Responsibilities — the service layer is the ONLY place that knows how to
transition a provider's wire format into the substrate's persistence shape:

  1. Capability check.    Caller's grant must intersect provider's declared
                          scopes before the fetch happens. Rejection is a
                          fast path with no provider invocation.
  2. Rate limiting.       Per-origin token bucket. Prevents the substrate
                          from accidentally DoS'ing UniProt when a workspace
                          opens a large genome with hundreds of CDS.
  3. Circuit breaker.     Closed → Open → Half-Open transitions. Saves the
                          renderer from waiting on a provider that's already
                          known broken.
  4. Exponential backoff. With jitter, on 5xx and 429 (Retry-After honored).
  5. Transactional persist. The DAO is commit-each by design 
                          chose the worst-case shape for the load test); the
                          service layer wraps the four-to-five DAO calls
                          (data_file → external_resource → fetch_log →
                          xref → binding) in ONE BEGIN IMMEDIATE block so a
                          mid-transaction crash leaves nothing partially
                          visible.
  6. License/attribution propagation. Provider sets license + attribution
                          on its FetchResult; the service writes them
                          unchanged into both data_file and external_resource.
                          UI surfaces them downstream.

V1 ships UniProt only. The service is provider-agnostic — adding NCBI in
DNA-XXa2's follow-up plan is a registry entry plus the provider class.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
from collections.abc import Awaitable, Callable
from typing import Any, Literal, TypeVar
from urllib.parse import quote, urlsplit

import httpx

from ..concurrency.renderer_bridge import RENDERER_PROVIDER_TOOL_NAMES
from ..control_plane.store import ControlPlaneStore
from .async_single_flight import AsyncSingleFlight
from .contract import (
    Capability,
    ExternalProvider,
    FetchOptions,
    FetchResult,
    ParsedId,
    ProviderError,
    ProviderHttpError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    Xref,
)
from .credential_broker import (
    CredentialBroker,
    CredentialDescriptor,
    CredentialKind,
)
from .htsget import (
    HtsgetPreparedSource,
    HtsgetRegionSnapshot,
    HtsgetService,
    HtsgetSession,
)
from .persistent_track_cache import PersistentTrackCache
from .providers.ucsc import UcscRegionResult
from .public_http import PublicHttpBoundary, PublicHttpBoundaryError
from .public_http import Resolver as PublicHttpResolver
from .remote_range import (
    RemoteIndexedFormat,
    RemoteRangeGrant,
    RemoteRangeService,
    Resolver,
)
from .resilience import (
    DEFAULT_RATE_LIMIT_BURST,
    DEFAULT_RATE_LIMIT_PER_S,
    _backoff_wait,
    _CircuitBreaker,
    _is_non_retryable_client_error,
    _is_provider_contract_error,
    _should_record_breaker_failure,
    _TokenBucket,
)
from .service_jev import JevServiceMixin
from .service_neb import NebServiceMixin
from .service_paper import PaperServiceMixin
from .service_rcsb import RcsbServiceMixin
from .service_structure import StructureServiceMixin
from .service_types import (
    _ANNOTATION_REQUIRED,
    CapabilityDenied,
    CircuitOpen,
    FetchRequest,
    FetchResponse,
    ProteinQueryEvidence,
    ProteinQueryIdentity,
    RcsbSequenceSearchHit,
    SequenceBytesResponse,
    SequenceTooLarge,
    ServiceError,
    StructureBytesResponse,
    StructurePosterResponse,
    StructureTooLarge,
    UnknownProvider,
)
from .service_ucsc import UcscServiceMixin
from .service_uniprot import UniProtServiceMixin
from .structure_identity import (
    CanonicalStructureIdentity,
)

UCSC_REMOTE_RANGE_HOSTS = frozenset(
    {
        "hgdownload.soe.ucsc.edu",
        "encode-public.s3.amazonaws.com",
    }
)

__all__ = [
    "ExternalResourcesService",
    "FetchRequest",
    "FetchResponse",
    "SequenceBytesResponse",
    "StructureBytesResponse",
    "StructurePosterResponse",
    "RcsbSequenceSearchHit",
    "ProteinQueryEvidence",
    "ProteinQueryIdentity",
    "CanonicalStructureIdentity",
    "ServiceError",
    "CapabilityDenied",
    "UnknownProvider",
    "CircuitOpen",
    "StructureTooLarge",
    "SequenceTooLarge",
]

logger = logging.getLogger(__name__)


DEFAULT_SEQUENCE_MAX_BYTES = 100_000_000
_DEFAULT_INDEXED_TRACK_RANGE_CACHE_BYTES = 1024 * 1024 * 1024
_INDEXED_TRACK_CACHE_REPAIR_STARTUP_DELAY_S = 15.0


_TARGET_PROVIDER_ALIASES = {
    "pdb": "rcsb",
}


def _object_locator_part(value: str | None, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 4096:
        raise ValueError(f"The {label} is invalid")
    normalized = value.strip()
    if "\\" in normalized or any(part == ".." for part in normalized.split("/")):
        raise ValueError(f"The {label} is invalid")
    return normalized


def _cloud_bucket(value: str | None) -> str:
    bucket = _object_locator_part(value, "object-storage bucket")
    if len(bucket) > 222 or not all(
        character.isalnum() or character in {".", "_", "-"} for character in bucket
    ):
        raise ValueError("The object-storage bucket is invalid")
    return bucket


def _s3_object_url(bucket: str | None, key: str | None, region: str | None) -> str:
    normalized_region = (region or "us-east-1").strip().lower()
    if (
        not normalized_region
        or len(normalized_region) > 63
        or not normalized_region[0].isalnum()
        or not all(
            character.isalnum() or character == "-" for character in normalized_region
        )
    ):
        raise ValueError("The S3 region is invalid")
    normalized_bucket = _cloud_bucket(bucket)
    normalized_key = _object_locator_part(key, "S3 object key")
    return (
        f"https://s3.{normalized_region}.amazonaws.com/"
        f"{quote(normalized_bucket, safe='-_.~')}/{quote(normalized_key, safe='/-_.~')}"
    )


def _gcs_object_url(bucket: str | None, object_key: str | None) -> str:
    normalized_bucket = _cloud_bucket(bucket)
    normalized_key = _object_locator_part(object_key, "GCS object name")
    return (
        "https://storage.googleapis.com/"
        f"{quote(normalized_bucket, safe='-_.~')}/{quote(normalized_key, safe='/-_.~')}"
    )


def _canonical_target_provider(target_provider: str | None) -> str | None:
    if target_provider is None:
        return None
    return _TARGET_PROVIDER_ALIASES.get(target_provider, target_provider)


def _persistent_track_cache_from_env() -> PersistentTrackCache | None:
    root = os.environ.get("WAYPOINT_INDEXED_TRACK_RANGE_CACHE_DIR", "").strip()
    if not root:
        return None
    raw_budget = os.environ.get(
        "WAYPOINT_INDEXED_TRACK_RANGE_CACHE_BYTES",
        str(_DEFAULT_INDEXED_TRACK_RANGE_CACHE_BYTES),
    ).strip()
    try:
        budget = int(raw_budget)
        if budget < 1:
            raise ValueError
    except ValueError:
        logger.warning(
            "Disabling indexed-track range cache: invalid byte budget %r", raw_budget
        )
        return None
    return PersistentTrackCache(root, max_bytes=budget)


OperationResult = TypeVar("OperationResult")


class ExternalResourcesService(
    JevServiceMixin,
    StructureServiceMixin,
    UniProtServiceMixin,
    RcsbServiceMixin,
    NebServiceMixin,
    PaperServiceMixin,
    UcscServiceMixin,
):
    """Thread-safe service. One instance per sidecar process.

    The DAO it wraps (ControlPlaneStore) uses a single sqlite3 connection that
    is NOT thread-safe under concurrent commits. The service serializes all
    DAO writes via an async lock — the sidecar's request handlers all run on
    the same event loop, so this lock is uncontended in the steady state but
    prevents the multi-thread commit-race that 's tests had to work
    around.
    """

    def __init__(
        self,
        store: ControlPlaneStore,
        *,
        client: httpx.AsyncClient | None = None,
        rate_limit_per_s: float = DEFAULT_RATE_LIMIT_PER_S,
        rate_limit_burst: float = DEFAULT_RATE_LIMIT_BURST,
        remote_range_allowed_hosts: frozenset[str] = UCSC_REMOTE_RANGE_HOSTS,
        remote_range_resolver: Resolver | None = None,
        public_http_resolver: PublicHttpResolver | None = None,
    ) -> None:
        self._store = store
        self._client = client or httpx.AsyncClient()
        self._owns_client = client is None
        self._providers: dict[str, ExternalProvider] = {}
        self._rate_limit_per_s = rate_limit_per_s
        self._rate_limit_burst = rate_limit_burst
        self._buckets: dict[str, _TokenBucket] = {}
        self._breakers: dict[str, _CircuitBreaker] = {}
        self._dao_lock = asyncio.Lock()
        self._persistent_track_cache = _persistent_track_cache_from_env()
        self._cache_maintenance_task: asyncio.Task[None] | None = None
        self._cache_maintenance_started = False
        self._public_http_resolver = public_http_resolver
        self._ucsc_snapshot_single_flight = AsyncSingleFlight[str, UcscRegionResult]()
        self._credential_broker = CredentialBroker()
        self._remote_range = RemoteRangeService(
            self._client,
            credential_broker=self._credential_broker,
            resolver=remote_range_resolver,
            allowed_hosts=remote_range_allowed_hosts,
            persistent_cache=self._persistent_track_cache,
        )
        self._htsget = HtsgetService(
            self._client,
            credential_broker=self._credential_broker,
            resolver=public_http_resolver or remote_range_resolver,
        )

    async def aclose(self) -> None:
        maintenance = self._cache_maintenance_task
        if maintenance is not None:
            if not self._cache_maintenance_started:
                maintenance.cancel()
            await asyncio.gather(maintenance, return_exceptions=True)
        await self._remote_range.aclose()
        await self._htsget.aclose()
        if self._owns_client:
            await self._client.aclose()

    def start_background_cache_maintenance(self) -> None:
        """Schedule crash-orphan cleanup outside startup and viewer reads."""

        if (
            self._persistent_track_cache is None
            or self._cache_maintenance_task is not None
        ):
            return
        self._cache_maintenance_task = asyncio.create_task(
            self._repair_persistent_track_cache_after_startup()
        )

    async def _repair_persistent_track_cache_after_startup(self) -> None:
        await asyncio.sleep(_INDEXED_TRACK_CACHE_REPAIR_STARTUP_DELAY_S)
        self._cache_maintenance_started = True
        cache = self._persistent_track_cache
        if cache is not None:
            await asyncio.to_thread(cache.repair)

    def register(self, provider: ExternalProvider) -> None:
        """Mount a provider. Idempotent on provider_id."""
        self._providers[provider.provider_id] = provider

    def get_resource(self, resource_id: str) -> dict[str, Any] | None:
        """Read-only lookup by canonical id. Public service surface so the
        route layer never reaches into `service._store` directly."""
        return self._store.get_external_resource(resource_id)

    async def admit_indexed_track_source(
        self,
        *,
        source_kind: Literal["path", "url", "s3", "gcs"],
        source: str | None,
        expected_format: RemoteIndexedFormat,
        provenance_id: str,
        bucket: str | None = None,
        object_key: str | None = None,
        region: str | None = None,
        requester_pays: bool = False,
        billing_project: str | None = None,
        auth_ref: str | None = None,
    ) -> RemoteRangeGrant:
        """Admit one source explicitly selected by the desktop user.

        A local path reaches this boundary only after the native picker returns
        it. A URL reaches it only through the Add Data URL journey. Remote
        reads retain the full public-network/redirect/range/validator checks;
        they are not constrained by the provider-only UCSC origin roster.
        """

        if source_kind == "path":
            if source is None:
                raise ValueError("A local indexed source path is required")
            return await self._remote_range.admit_local(
                source,
                expected_format=expected_format,
                provenance_id=provenance_id,
            )
        if source_kind == "url":
            if source is None:
                raise ValueError("A remote indexed source URL is required")
            source_url = source
            audience: Literal["http", "s3", "gcs"] = "http"
        elif source_kind == "s3":
            source_url = _s3_object_url(bucket, object_key, region)
            audience = "s3"
        else:
            source_url = _gcs_object_url(bucket, object_key)
            audience = "gcs"
        return await self._remote_range.admit(
            source_url,
            expected_format=expected_format,
            provenance_id=provenance_id,
            allow_any_public_host=True,
            auth_ref=auth_ref,
            credential_audience=audience,
            aws_region=region,
            requester_pays=requester_pays,
            billing_project=billing_project,
        )

    def register_source_credential(
        self,
        *,
        auth_ref: str,
        kind: CredentialKind,
        material: dict[str, object],
    ) -> CredentialDescriptor:
        return self._credential_broker.register(
            auth_ref=auth_ref, kind=kind, material=material
        )

    def remove_source_credential(self, auth_ref: str) -> bool:
        return self._credential_broker.remove(auth_ref)

    async def prepare_htsget_source(
        self,
        *,
        endpoint: str,
        resource_id: str,
        data_class: Literal["reads", "variants"],
        source_format: str,
        references: list[dict[str, object]],
        auth_ref: str | None = None,
    ) -> HtsgetPreparedSource:
        return await self._htsget.prepare(
            endpoint=endpoint,
            resource_id=resource_id,
            data_class=data_class,
            source_format=source_format,
            references=references,
            auth_ref=auth_ref,
        )

    def get_htsget_session(
        self, source_token: str, *, source_identity: str | None = None
    ) -> HtsgetSession:
        return self._htsget.get_session(source_token, source_identity=source_identity)

    async def materialize_htsget_region(
        self,
        source_token: str,
        *,
        reference_name: str,
        start: int,
        end: int,
        source_identity: str | None = None,
    ) -> HtsgetRegionSnapshot:
        return await self._htsget.materialize_region(
            source_token,
            reference_name=reference_name,
            start=start,
            end=end,
            source_identity=source_identity,
        )

    async def query_htsget_variant_page(
        self,
        source_token: str,
        *,
        source_identity: str,
        assembly_revision: str,
        references: list[dict[str, object]],
        cursor: str | None,
        limit: int,
    ) -> dict[str, Any]:
        return await self._htsget.query_variant_page(
            source_token,
            source_identity=source_identity,
            assembly_revision=assembly_revision,
            references=references,
            cursor=cursor,
            limit=limit,
        )

    async def query_htsget_variant_region(
        self,
        source_token: str,
        *,
        source_identity: str,
        assembly_revision: str,
        references: list[dict[str, object]],
        chrom: str,
        start: int,
        end: int,
        limit: int,
    ) -> dict[str, Any]:
        return await self._htsget.query_variant_region(
            source_token,
            source_identity=source_identity,
            assembly_revision=assembly_revision,
            references=references,
            chrom=chrom,
            start=start,
            end=end,
            limit=limit,
        )

    def get_resource_by_external_id(
        self, provider: str, external_id: str
    ) -> dict[str, Any] | None:
        """Read-only lookup by (provider, external_id). Public service surface."""
        return self._store.get_external_resource_by_external_id(provider, external_id)

    def list_xrefs(
        self,
        provider: str,
        external_id: str,
        target_provider: str | None = None,
    ) -> list[dict[str, Any]]:
        """List cross-references for a previously-fetched (provider, external_id).

        Read-only against the local cache — never triggers a network fetch.
        Returns an empty list when the resource isn't cached. The
        `target_provider` filter is applied DAO-side via a SQL join on
        `to_resource_id → external_resource.provider`; one indexed join, not
        N point-lookups (the prior Python-loop shape was an N+1 — a UniProt
        entry with hundreds of xrefs would issue hundreds of synchronous
        SQLite reads per call).
        """
        resource = self._store.get_external_resource_by_external_id(
            provider, external_id
        )
        if resource is None:
            return []
        canonical_target_provider = _canonical_target_provider(target_provider)
        return self._store.list_external_resource_xrefs(
            from_resource_id=resource["id"],
            target_provider=canonical_target_provider,
        )

    async def fetch(
        self,
        request: FetchRequest,
        *,
        opts: FetchOptions | None = None,
    ) -> FetchResponse:
        """Fetch + persist a provider entry; resolve + persist its xrefs.

        See module docstring for the responsibility list. This method is
        the ONE public entry point — routes call this; tests call this; the
        agent MCP tool (DNA-XXa4) will call this.

        Every error path writes one external_fetch_log row before raising
        so ops + freshness watchers + dashboards see the same failure
        signal regardless of which class fired. Pre-network failures
        (unknown provider, unrecognized id, capability denied, bind-to
        misuse) get latency_ms=0; in-flight failures (provider error,
        circuit open) get the actual measured latency.
        """
        provider = self._providers.get(request.provider)
        if provider is None:
            exc_unknown = UnknownProvider(
                f"no provider registered for {request.provider!r}"
            )
            self._log_fetch_failure(None, None, request, exc_unknown, latency_ms=0)
            raise exc_unknown

        parsed = provider.detect_id(request.raw_id)
        if parsed is None:
            exc_unrec = ProviderError(
                f"{request.provider} does not recognize id {request.raw_id!r}"
            )
            self._log_fetch_failure(provider, None, request, exc_unrec, latency_ms=0)
            raise exc_unrec

        try:
            self._check_capabilities(provider, request.granted_capabilities)
        except CapabilityDenied as exc_cap:
            self._log_fetch_failure(provider, parsed, request, exc_cap, latency_ms=0)
            raise

        if request.bind_to is not None and not request.workspace_id:
            exc_bind = ServiceError(
                "bind_to requires workspace_id; anonymous bindings are not allowed"
            )
            self._log_fetch_failure(provider, parsed, request, exc_bind, latency_ms=0)
            raise exc_bind

        opts = opts or FetchOptions()

        cache_key = parsed.cache_key()

        cached = self._store.get_external_resource_by_external_id(
            request.provider, cache_key
        )
        if cached is not None and not _is_stub_resource(cached):
            return await self._cache_hit_response(cached, parsed, request, provider)

        t0 = time.perf_counter()
        try:
            result, xrefs = await self._fetch_with_resilience(
                provider, parsed, opts, request.granted_capabilities
            )
        except (ProviderError, CircuitOpen) as exc:
            latency_ms = int((time.perf_counter() - t0) * 1000)
            self._log_fetch_failure(
                provider, parsed, request, exc, latency_ms=latency_ms
            )
            raise
        latency_ms = int((time.perf_counter() - t0) * 1000)

        return await self._persist_fetch(result, xrefs, request, latency_ms=latency_ms)

    async def fetch_sequence_bytes(
        self,
        *,
        provider: str,
        external_id: str,
        granted_capabilities: list[str],
        workspace_id: str | None = None,
        format: str = "genbank",
        opts: FetchOptions | None = None,
        max_bytes: int | None = DEFAULT_SEQUENCE_MAX_BYTES,
    ) -> SequenceBytesResponse:
        """Fetch a sequence record (GenBank text) from a registered sequence
        provider through the substrate's resilience pipeline.

         — the single sidecar entry point for the import path's NCBI
        fetch. Reuses ``provider.detect_id`` + ``_fetch_with_resilience``
        (rate-limit + circuit-breaker + exponential backoff) so the renderer
        no longer makes outbound NCBI calls. Returns the record bytes inline
        (the import tool writes them into the workspace) plus provider/source
        provenance for the import result.

        Pass-through, like ``fetch_structure_bytes``: the workspace file is
        the durable copy, so this does NOT persist an ``external_resource``
        row (substrate registration of imported sequences is a future slice).
        Every call — success or failure — writes one ``external_fetch_log``
        row so provenance + dashboards see a uniform signal.

        Capability: requires ``external-fetch:annotation`` (a GenBank record
        is annotation-shaped; the NCBI provider declares the same scope).
        """
        required = [Capability.EXTERNAL_FETCH_ANNOTATION.value]
        t0 = time.perf_counter()

        prov = self._providers.get(provider)
        if prov is None:
            exc_unknown = UnknownProvider(f"no provider registered for {provider!r}")
            self._log_sequence_bytes_call(
                provider=provider,
                endpoint=f"{provider}:{external_id}",
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=0,
                status_code=None,
                bytes_received=None,
                exc=exc_unknown,
            )
            raise exc_unknown

        try:
            self._check_required_capabilities(required, granted_capabilities)
        except CapabilityDenied as exc_cap:
            self._log_sequence_bytes_call(
                provider=provider,
                endpoint=f"{provider}:{external_id}",
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=0,
                status_code=None,
                bytes_received=None,
                exc=exc_cap,
            )
            raise

        parsed = prov.detect_id(external_id)
        if parsed is None:
            exc_id = ProviderError(
                f"{provider} does not recognize sequence id {external_id!r}",
                status_code=422,
            )
            self._log_sequence_bytes_call(
                provider=provider,
                endpoint=f"{provider}:{external_id}",
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=0,
                status_code=422,
                bytes_received=None,
                exc=exc_id,
            )
            raise exc_id

        opts = opts or FetchOptions()
        try:
            result, _xrefs = await self._fetch_with_resilience(
                prov, parsed, opts, granted_capabilities
            )
        except (ProviderError, CircuitOpen) as exc:
            self._log_sequence_bytes_call(
                provider=provider,
                endpoint=f"{provider}:{parsed.canonical_id}",
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=int((time.perf_counter() - t0) * 1000),
                status_code=getattr(exc, "status_code", None),
                bytes_received=None,
                exc=exc,
            )
            raise

        content = result.content_bytes or b""
        if max_bytes is not None and len(content) > max_bytes:
            exc_big = SequenceTooLarge(len(content), max_bytes)
            self._log_sequence_bytes_call(
                provider=provider,
                endpoint=f"{provider}:{parsed.canonical_id}",
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=int((time.perf_counter() - t0) * 1000),
                status_code=result.status_code,
                bytes_received=len(content),
                exc=exc_big,
            )
            raise exc_big
        self._log_sequence_bytes_call(
            provider=provider,
            endpoint=f"{provider}:{parsed.canonical_id}",
            granted=granted_capabilities,
            workspace_id=workspace_id,
            latency_ms=int((time.perf_counter() - t0) * 1000),
            status_code=result.status_code,
            bytes_received=len(content),
            exc=None,
        )
        return SequenceBytesResponse(
            provider=provider,
            external_id=parsed.canonical_id,
            format=format,
            content=content,
            content_type=result.content_mime_type or "text/plain",
            content_sha256=result.content_sha256 or hashlib.sha256(content).hexdigest(),
            source_url=result.external_url,
            license=result.license,
            attribution=result.attribution,
            version_identifier=result.version_identifier,
            etag=result.etag,
            metadata=dict(result.metadata or {}),
        )

    async def fetch_sequence_url_bytes(
        self,
        *,
        source_url: str,
        granted_capabilities: list[str],
        workspace_id: str | None = None,
        max_bytes: int = DEFAULT_SEQUENCE_MAX_BYTES,
    ) -> SequenceBytesResponse:
        """Fetch a credential-free public GenBank/FASTA URL for import.

        This uses the same DNS-pinned public-network boundary as the other
        arbitrary-URL providers. It rejects private destinations, credentials,
        nonstandard ports, and unsafe redirects before bytes reach the
        renderer. The import tool remains responsible for parsing the bytes as
        an accepted biology format before it writes anything.
        """
        provider = "public-url"
        started = time.perf_counter()
        try:
            self._check_required_capabilities(
                [Capability.EXTERNAL_FETCH_ANNOTATION.value],
                granted_capabilities,
            )
        except CapabilityDenied as exc:
            self._log_sequence_bytes_call(
                provider=provider,
                endpoint=source_url,
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=0,
                status_code=None,
                bytes_received=None,
                exc=exc,
            )
            raise

        boundary = PublicHttpBoundary(
            self._client,
            resolver=self._public_http_resolver,
        )
        response: httpx.Response | None = None
        canonical_url = source_url
        try:
            response, canonical_url = await boundary.open_get(
                source_url,
                accept="application/genbank, text/plain, text/x-fasta, */*;q=0.1",
                user_agent="DNAForge/1 sequence-import",
                timeout=httpx.Timeout(timeout=30.0, connect=10.0),
            )
            if response.status_code >= 400:
                raise ProviderHttpError(
                    f"Sequence URL returned HTTP {response.status_code}",
                    status_code=response.status_code,
                )
            declared_length = response.headers.get("Content-Length")
            if declared_length:
                try:
                    byte_count = int(declared_length)
                except ValueError:
                    byte_count = 0
                if byte_count > max_bytes:
                    raise SequenceTooLarge(byte_count, max_bytes)
            payload = bytearray()
            async for chunk in response.aiter_bytes():
                payload.extend(chunk)
                if len(payload) > max_bytes:
                    raise SequenceTooLarge(len(payload), max_bytes)
            content = bytes(payload)
            if not content:
                raise ProviderError("The sequence URL returned an empty response")
        except (httpx.TimeoutException, httpx.HTTPError, OSError) as exc:
            error = ProviderHttpError(
                f"Sequence URL network error: {exc.__class__.__name__}"
            )
            self._log_sequence_bytes_call(
                provider=provider,
                endpoint=canonical_url,
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=int((time.perf_counter() - started) * 1000),
                status_code=getattr(exc, "status_code", None),
                bytes_received=None,
                exc=error,
            )
            raise error from exc
        except (PublicHttpBoundaryError, ProviderError, SequenceTooLarge) as exc:
            self._log_sequence_bytes_call(
                provider=provider,
                endpoint=canonical_url,
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=int((time.perf_counter() - started) * 1000),
                status_code=getattr(exc, "status_code", None),
                bytes_received=len(payload) if "payload" in locals() else None,
                exc=exc,
            )
            raise
        finally:
            if response is not None:
                await response.aclose()

        self._log_sequence_bytes_call(
            provider=provider,
            endpoint=canonical_url,
            granted=granted_capabilities,
            workspace_id=workspace_id,
            latency_ms=int((time.perf_counter() - started) * 1000),
            status_code=response.status_code,
            bytes_received=len(content),
        )
        hostname = urlsplit(canonical_url).hostname or "public source"
        return SequenceBytesResponse(
            provider=provider,
            external_id=canonical_url,
            format="auto",
            content=content,
            content_type=response.headers.get("Content-Type", "text/plain"),
            content_sha256=hashlib.sha256(content).hexdigest(),
            source_url=canonical_url,
            license=None,
            attribution=f"Source: {hostname}",
            version_identifier=None,
            etag=response.headers.get("ETag"),
            metadata={},
        )

    async def _run_through_resilience(
        self,
        provider: ExternalProvider,
        opts: FetchOptions,
        operation: Callable[[], Awaitable[OperationResult]],
    ) -> OperationResult:
        origin = self._origin_for(provider)
        breaker = self._breaker_for(origin)
        permit = breaker.try_acquire()
        if permit is None:
            raise CircuitOpen(origin, breaker.opens_at_s())
        try:
            bucket = self._bucket_for(origin)

            last_exc: ProviderError | None = None
            for attempt in range(opts.max_retries + 1):
                wait_s = bucket.take()
                if wait_s > 0:
                    await asyncio.sleep(wait_s)
                try:
                    result = await operation()
                    breaker.record_success(permit)
                    return result
                except ProviderRateLimitError as exc:
                    last_exc = exc
                    if attempt < opts.max_retries:
                        wait = exc.retry_after_s or _backoff_wait(attempt, opts)
                        await asyncio.sleep(wait)
                except ProviderHttpError as exc:
                    last_exc = exc
                    if _is_non_retryable_client_error(
                        exc
                    ) or _is_provider_contract_error(exc):
                        if _should_record_breaker_failure(exc):
                            breaker.record_failure(permit)
                        raise
                    if attempt < opts.max_retries:
                        await asyncio.sleep(_backoff_wait(attempt, opts))
                except ProviderTimeoutError as exc:
                    last_exc = exc
                    if attempt < opts.max_retries:
                        await asyncio.sleep(_backoff_wait(attempt, opts))

            if last_exc is None or _should_record_breaker_failure(last_exc):
                breaker.record_failure(permit)
            if last_exc is None:
                last_exc = ProviderError("operation exhausted retries with no error")
            raise last_exc
        finally:
            breaker.release(permit)

    def _log_thin_call(
        self,
        *,
        provider: ExternalProvider | None,
        endpoint: str,
        granted: list[str],
        workspace_id: str | None,
        latency_ms: int,
        status_code: int | None = None,
        exc: Exception | None = None,
        provider_id: str | None = None,
        required_capabilities: list[str] | None = None,
        bytes_received: int | None = None,
        method: str = "GET",
    ) -> None:
        """One fetch_log row per thin op (search / validate). External_resource
        is None — these calls don't register entries.
        """
        failure_kind: str | None = None
        if exc is not None:
            if isinstance(exc, CapabilityDenied):
                failure_kind = "capability_denied"
            elif isinstance(exc, CircuitOpen):
                failure_kind = "circuit_open"
            else:
                failure_kind = getattr(exc, "failure_kind", "service_error")
            status_code = getattr(exc, "status_code", status_code)
        if provider is not None:
            cap = _capability_check_payload(
                provider,
                granted,
                satisfied=exc is None,
                required_capabilities=required_capabilities or _ANNOTATION_REQUIRED,
            )
        else:
            if provider_id == "alphafold":
                required = _ANNOTATION_REQUIRED
            elif "uniprot" in self._providers:
                required = _ANNOTATION_REQUIRED
            else:
                required = []
            cap = {
                "required": required,
                "granted": list(granted),
                "satisfied": exc is None,
            }
        try:
            self._store.insert_external_fetch_log(
                provider=provider_id
                or (provider.provider_id if provider else "unknown"),
                endpoint=endpoint,
                method=method,
                status_code=status_code,
                latency_ms=latency_ms,
                bytes_received=bytes_received,
                cache_hit=False,
                external_resource_id=None,
                workspace_id=workspace_id,
                failure_kind=failure_kind,
                capability_check=cap,
            )
        except Exception:  # nosec
            logger.warning(
                "failed to write external_fetch_log thin-op row", exc_info=True
            )

    def _check_capabilities(
        self,
        provider: ExternalProvider,
        granted: list[str],
    ) -> None:
        self._check_required_capabilities(_ANNOTATION_REQUIRED, granted)

    def _check_required_capabilities(
        self,
        required_capabilities: list[str],
        granted: list[str],
    ) -> None:
        required = set(required_capabilities)
        granted_set = set(granted)
        if not required.issubset(granted_set):
            raise CapabilityDenied(
                required=sorted(required), granted=sorted(granted_set)
            )

    async def _fetch_with_resilience(
        self,
        provider: ExternalProvider,
        parsed: ParsedId,
        opts: FetchOptions,
        granted_capabilities: list[str],
    ) -> tuple[FetchResult, list[Xref]]:
        async def fetch_with_xrefs() -> tuple[FetchResult, list[Xref]]:
            if hasattr(provider, "_client") and provider._client is None:  # type: ignore[attr-defined]
                provider._client = self._client  # type: ignore[attr-defined]
            result = await provider.fetch(parsed, opts)
            xref_granted = Capability.EXTERNAL_FETCH_XREF.value in set(
                granted_capabilities
            )
            if xref_granted and result.xrefs:
                xrefs = list(result.xrefs)
            elif (
                xref_granted
                and Capability.EXTERNAL_FETCH_XREF in provider.declared_capabilities()
            ):
                xrefs = await provider.resolve_xrefs(parsed)
            else:
                xrefs = []
            return result, xrefs

        return await self._run_through_resilience(provider, opts, fetch_with_xrefs)

    def _origin_for(self, provider: ExternalProvider) -> str:
        return provider.provider_id

    def _bucket_for(self, origin: str) -> _TokenBucket:
        bucket = self._buckets.get(origin)
        if bucket is None:
            provider = self._providers.get(origin)
            rate = getattr(provider, "rate_limit_per_s", None) or self._rate_limit_per_s
            burst = (
                getattr(provider, "rate_limit_burst", None) or self._rate_limit_burst
            )
            bucket = _TokenBucket(capacity=burst, refill_rate_per_s=rate)
            self._buckets[origin] = bucket
        return bucket

    def _breaker_for(self, origin: str) -> _CircuitBreaker:
        breaker = self._breakers.get(origin)
        if breaker is None:
            breaker = _CircuitBreaker()
            self._breakers[origin] = breaker
        return breaker

    async def _persist_fetch(
        self,
        result: FetchResult,
        xrefs: list[Xref],
        request: FetchRequest,
        *,
        latency_ms: int | None = None,
    ) -> FetchResponse:
        """Persist data_file + external_resource + fetch_log + xrefs +
        optional binding in one transaction."""
        async with self._dao_lock:
            with self._store.transaction():
                data_file_sha = result.content_sha256
                if result.content_bytes is not None:
                    if data_file_sha is None:
                        data_file_sha = hashlib.sha256(result.content_bytes).hexdigest()
                    self._store.upsert_data_file(
                        sha256=data_file_sha,
                        byte_size=len(result.content_bytes),
                        mime_type=result.content_mime_type,
                        source_url=result.external_url,
                        source_provider=result.parsed_id.provider,
                        license=result.license,
                        attribution=result.attribution,
                    )

                external_resource_id = self._store.upsert_external_resource(
                    provider=result.parsed_id.provider,
                    external_id=result.parsed_id.cache_key(),
                    metadata=_strip_internal(result.metadata),
                    external_url=result.external_url,
                    data_file_id=data_file_sha,
                    version_identifier=result.version_identifier,
                    etag=result.etag,
                    license=result.license,
                    attribution=result.attribution,
                )

                provider = self._providers[result.parsed_id.provider]
                self._store.insert_external_fetch_log(
                    provider=result.parsed_id.provider,
                    endpoint=result.external_url or "",
                    method="GET",
                    status_code=result.status_code,
                    latency_ms=latency_ms,
                    bytes_received=result.bytes_received,
                    cache_hit=False,
                    external_resource_id=external_resource_id,
                    workspace_id=request.workspace_id,
                    capability_check=_capability_check_payload(
                        provider,
                        request.granted_capabilities,
                        satisfied=True,
                        required_capabilities=_ANNOTATION_REQUIRED,
                    ),
                )

                for xref in xrefs:
                    target_id = self._store.upsert_external_resource_stub(
                        provider=xref.target_provider,
                        external_id=xref.target_external_id,
                    )
                    self._store.upsert_external_resource_xref(
                        from_resource_id=external_resource_id,
                        to_resource_id=target_id,
                        xref_type=xref.xref_type,
                        evidence=xref.evidence,
                        source_provider=xref.source_provider
                        or result.parsed_id.provider,
                        confidence=xref.confidence,
                        version=xref.version,
                        identity=xref.identity,
                        coverage=xref.coverage,
                        alignment_coords=xref.alignment_coords,
                        metadata=xref.metadata,
                    )

                binding_id = self._maybe_create_binding(request, external_resource_id)

                agent_artifact_id = self._maybe_create_agent_artifact(
                    request,
                    result,
                    external_resource_id=external_resource_id,
                    data_file_sha=data_file_sha,
                )

        return FetchResponse(
            external_resource_id=external_resource_id,
            external_id=result.parsed_id.cache_key(),
            cache_hit=False,
            license=result.license,
            attribution=result.attribution,
            metadata=_strip_internal(result.metadata),
            xref_count=len(xrefs),
            binding_id=binding_id,
            agent_artifact_id=agent_artifact_id,
        )

    async def _cache_hit_response(
        self,
        cached: dict[str, Any],
        parsed: ParsedId,
        request: FetchRequest,
        provider: ExternalProvider,
    ) -> FetchResponse:
        """Fast path when the (provider, external_id) row is already cached.

        Wrapped in `_dao_lock` + `store.transaction()` so the writes
        (fetch_log + optional binding + optional agent_artifact) commit
        atomically — same invariant as the cold-fetch path.
        """
        external_resource_id = cached["id"]
        async with self._dao_lock:
            with self._store.transaction():
                self._store.insert_external_fetch_log(
                    provider=request.provider,
                    endpoint=cached.get("external_url") or "",
                    method="GET",
                    status_code=None,
                    latency_ms=None,
                    bytes_received=0,
                    cache_hit=True,
                    external_resource_id=external_resource_id,
                    workspace_id=request.workspace_id,
                    capability_check=_capability_check_payload(
                        provider,
                        request.granted_capabilities,
                        satisfied=True,
                        required_capabilities=_ANNOTATION_REQUIRED,
                    ),
                )
                binding_id = self._maybe_create_binding(request, external_resource_id)
                agent_artifact_id = self._maybe_create_agent_artifact_from_cache(
                    request, cached, parsed
                )

        return FetchResponse(
            external_resource_id=external_resource_id,
            external_id=parsed.cache_key(),
            cache_hit=True,
            license=cached.get("license"),
            attribution=cached.get("attribution"),
            metadata=_strip_internal(cached.get("metadata_json") or {}),
            xref_count=0,
            binding_id=binding_id,
            agent_artifact_id=agent_artifact_id,
        )

    def _maybe_create_binding(
        self,
        request: FetchRequest,
        external_resource_id: str,
    ) -> str | None:
        """Create the optional workspace binding row. Caller has already
        verified that bind_to + workspace_id are present together."""
        if request.bind_to is None:
            return None
        return self._store.upsert_external_resource_binding(
            workspace_id=request.workspace_id or "",
            source_kind=request.bind_to["source_kind"],
            source_uri=request.bind_to["source_uri"],
            external_resource_id=external_resource_id,
            relationship=request.bind_to["relationship"],
            evidence=request.bind_to.get("evidence", "asserted"),
        )

    def _maybe_create_agent_artifact(
        self,
        request: FetchRequest,
        result: FetchResult,
        *,
        external_resource_id: str,
        data_file_sha: str | None,
    ) -> str | None:
        """Workflow-boundaries invariant: when a fetch comes from an agent
        (action_id present) AND content bytes flowed (data_file row was
        written), persist an agent_artifact row tying the artifact back to
        the agent_action root.

        Returns the artifact id when written, or None when this fetch
        doesn't qualify (no agent context, no bytes, or unknown action).
        Bytes-less providers like UniProt v1 always skip this write — that
        matches the substrate plan's "bytes when present" qualifier.
        """
        if request.agent_action_id is None or result.content_bytes is None:
            return None
        action_row = self._authorized_external_fetch_action(request)
        if action_row is None:
            return None
        return self._store.upsert_agent_artifact_for_action(
            agent_identity_id=action_row["agent_identity_id"],
            action_id=request.agent_action_id,
            kind="external",
            name=f"{result.parsed_id.provider}:{result.parsed_id.cache_key()}",
            source_uri=result.external_url,
            mime_type=result.content_mime_type,
            size_bytes=len(result.content_bytes),
            sha256=data_file_sha,
            metadata={"external_resource_id": external_resource_id},
            provenance={
                "provider": result.parsed_id.provider,
                "license": result.license,
                "attribution": result.attribution,
            },
            tags=["external-fetch", "agent-driven"],
        )

    def _maybe_create_agent_artifact_from_cache(
        self,
        request: FetchRequest,
        cached: dict[str, Any],
        parsed: ParsedId,
    ) -> str | None:
        """Cache-hit equivalent of `_maybe_create_agent_artifact`.

        The cached resource may have a `data_file_id` recorded from a prior
        cold fetch; if so, we have bytes to attribute and the 4-row invariant
        applies. Reads the data_file row to recover sha256/mime_type/size,
        then upserts the artifact idempotently keyed on (action_id, name).
        """
        if request.agent_action_id is None:
            return None
        data_file_sha = cached.get("data_file_id")
        if data_file_sha is None:
            return None
        action_row = self._authorized_external_fetch_action(request)
        if action_row is None:
            return None
        data_file_row = self._store.get_data_file(data_file_sha)
        return self._store.upsert_agent_artifact_for_action(
            agent_identity_id=action_row["agent_identity_id"],
            action_id=request.agent_action_id,
            kind="external",
            name=f"{parsed.provider}:{parsed.cache_key()}",
            source_uri=cached.get("external_url"),
            mime_type=(data_file_row or {}).get("mime_type"),
            size_bytes=(data_file_row or {}).get("byte_size"),
            sha256=data_file_sha,
            metadata={"external_resource_id": cached["id"], "cache_hit": True},
            provenance={
                "provider": parsed.provider,
                "license": cached.get("license"),
                "attribution": cached.get("attribution"),
            },
            tags=["external-fetch", "agent-driven", "cache-hit"],
        )

    def _authorized_external_fetch_action(
        self,
        request: FetchRequest,
    ) -> dict[str, Any] | None:
        if request.agent_action_id is None:
            return None
        action_row = self._store.get_agent_action(request.agent_action_id)
        if action_row is None:
            return None
        accepted_tool_names = {
            "external.fetch",
            RENDERER_PROVIDER_TOOL_NAMES.get("external.fetch"),
        }
        if action_row["tool_name"] not in accepted_tool_names:
            return None
        if action_row["authorization_state"] not in {"granted", "approved"}:
            return None
        parameters = action_row.get("parameters_json")
        if not isinstance(parameters, dict):
            return None
        if parameters.get("provider") != request.provider:
            return None
        if parameters.get("external_id") != request.raw_id:
            return None
        action_workspace = parameters.get("workspace_id")
        if action_workspace != request.workspace_id and (
            action_workspace is not None or request.workspace_id is not None
        ):
            return None
        action_scope = action_row.get("authorized_scope_json")
        if not _scope_satisfies(
            action_scope if isinstance(action_scope, list) else [],
            request.granted_capabilities,
        ):
            return None
        return action_row

    def _log_sequence_bytes_call(
        self,
        *,
        provider: str,
        endpoint: str,
        granted: list[str],
        workspace_id: str | None,
        latency_ms: int,
        status_code: int | None,
        bytes_received: int | None,
        exc: Exception | None = None,
    ) -> None:
        """ — fetch_log row for /external/sequence/bytes calls.

        Mirrors `_log_structure_bytes_call` but records the annotation
        capability (a sequence record is annotation-shaped)."""
        failure_kind: str | None = None
        if exc is not None:
            if isinstance(exc, CapabilityDenied):
                failure_kind = "capability_denied"
            elif isinstance(exc, CircuitOpen):
                failure_kind = "circuit_open"
            elif isinstance(exc, UnknownProvider):
                failure_kind = "unknown_provider"
            else:
                failure_kind = getattr(exc, "failure_kind", "service_error")
        try:
            required_granted = Capability.EXTERNAL_FETCH_ANNOTATION.value in set(
                granted
            )
            self._store.insert_external_fetch_log(
                provider=provider,
                endpoint=endpoint,
                method="GET",
                status_code=status_code,
                latency_ms=latency_ms,
                bytes_received=bytes_received,
                cache_hit=False,
                external_resource_id=None,
                workspace_id=workspace_id,
                failure_kind=failure_kind,
                capability_check={
                    "required": [Capability.EXTERNAL_FETCH_ANNOTATION.value],
                    "granted": list(granted),
                    "satisfied": required_granted,
                },
            )
        except Exception:  # nosec
            logger.warning(
                "failed to write external_fetch_log sequence-bytes row",
                exc_info=True,
            )

    def _log_fetch_failure(
        self,
        provider: ExternalProvider | None,
        parsed: ParsedId | None,
        request: FetchRequest,
        exc: Exception,
        *,
        latency_ms: int | None = None,
    ) -> None:
        """Write one external_fetch_log row per error class. Fires from
        every error path — UnknownProvider, unrecognized id, capability
        denied, bind-to misuse, in-flight ProviderError, CircuitOpen.

        `provider` is None when the request named a provider that wasn't
        registered. `parsed` is None when id parsing failed.
        Best-effort: if the log write itself fails, the warning is
        captured and the original exception keeps propagating.
        """
        if isinstance(exc, UnknownProvider):
            failure_kind = "unknown_provider"
        elif isinstance(exc, CapabilityDenied):
            failure_kind = "capability_denied"
        elif isinstance(exc, CircuitOpen):
            failure_kind = "circuit_open"
        elif isinstance(exc, ServiceError):
            failure_kind = "invalid_request"
        else:
            failure_kind = getattr(exc, "failure_kind", "service_error")
        status_code = getattr(exc, "status_code", None)

        if provider is not None:
            cap = _capability_check_payload(
                provider,
                request.granted_capabilities,
                satisfied=not isinstance(exc, CapabilityDenied),
                required_capabilities=_ANNOTATION_REQUIRED,
            )
        else:
            cap = {
                "required": [],
                "granted": list(request.granted_capabilities),
                "satisfied": False,
            }

        try:
            self._store.insert_external_fetch_log(
                provider=request.provider,
                endpoint="",
                method="GET",
                status_code=status_code,
                latency_ms=latency_ms,
                bytes_received=None,
                cache_hit=False,
                external_resource_id=None,
                workspace_id=request.workspace_id,
                failure_kind=failure_kind,
                capability_check=cap,
            )
        except Exception:  # nosec - best-effort failure logging
            logger.warning(
                "failed to write external_fetch_log failure row", exc_info=True
            )


def _strip_internal(metadata: dict[str, Any]) -> dict[str, Any]:
    """Drop keys starting with `_` — they're provider-private hints (e.g.,
    UniProt's `_uniprot_cross_references_raw`). Only public-facing metadata
    is persisted to external_resource.metadata_json."""
    return {k: v for k, v in metadata.items() if not k.startswith("_")}


def _is_stub_resource(row: dict[str, Any]) -> bool:
    metadata = row.get("metadata_json")
    return isinstance(metadata, dict) and metadata.get("_stub") is True


def _capability_check_payload(
    provider: ExternalProvider,
    granted: list[str],
    *,
    satisfied: bool,
    required_capabilities: list[str] | None = None,
) -> dict[str, Any]:
    """Standard `capability_check_json` payload written to fetch_log + audit_record."""
    return {
        "required": (
            required_capabilities
            if required_capabilities is not None
            else [c.value for c in provider.declared_capabilities()]
        ),
        "granted": list(granted),
        "satisfied": satisfied,
    }


def _scope_satisfies(actor_scope: list[str], required_capabilities: list[str]) -> bool:
    if "*" in actor_scope:
        return True
    return set(required_capabilities).issubset(set(actor_scope))
