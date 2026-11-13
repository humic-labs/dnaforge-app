"""RCSB (PDB) provider-domain methods for ExternalResourcesService .

A mixin extracted from service.py so the core class isn't a god-object. These
methods are RCSB orchestration; they run on the composed ExternalResourcesService
and therefore REQUIRE the host to provide the substrate primitives they call via
`self`: `_client`, `_store`, `_bucket_for`, `_breaker_for`, `_origin_for`,
`_check_required_capabilities`, `_fetch_with_resilience`, and the `_log_*`
helpers. Import nothing from service.py here (keeps the split cycle-free).
"""

from __future__ import annotations

import asyncio
import re
import time
from typing import Any

import httpx

from .contract import (
    Capability,
    FetchOptions,
    FetchResult,
    ProviderContractError,
    ProviderError,
    ProviderHttpError,
    ProviderRateLimitError,
    ProviderTimeoutError,
)
from .providers.rcsb import (
    RCSBProvider,
)
from .resilience import (
    _backoff_wait,
    _is_non_retryable_client_error,
    _retry_after_seconds,
    _should_record_breaker_failure,
)
from .service_types import (
    _HOMOLOGY_REQUIRED,
    CapabilityDenied,
    CircuitOpen,
    RcsbSequenceSearchHit,
    StructurePosterResponse,
    StructureTooLarge,
    UnknownProvider,
)

logger = __import__("logging").getLogger(__name__)


class RcsbServiceMixin:
    """RCSB validate / sequence-search / poster methods. See module docstring."""

    async def validate_rcsb_entry(
        self,
        pdb_id: str,
        *,
        granted_capabilities: list[str],
        workspace_id: str | None = None,
        opts: FetchOptions | None = None,
    ) -> FetchResult:
        """Metadata-only RCSB validation for direct structure entrypoints.

        This intentionally does not persist an external_resource row; callers
        that commit an RCSB identity still use `/external/fetch`.
        """
        provider = self._providers.get("rcsb")
        if provider is None:
            raise UnknownProvider("no provider registered for 'rcsb'")
        if not isinstance(provider, RCSBProvider):
            raise UnknownProvider(
                f"registered 'rcsb' provider does not support validation "
                f"(got {provider.__class__.__name__})"
            )
        parsed = provider.detect_id(pdb_id)
        if parsed is None:
            raise ProviderHttpError(f"invalid RCSB PDB id {pdb_id!r}", status_code=422)
        self._check_capabilities(provider, granted_capabilities)
        opts = opts or FetchOptions()

        async def _do_validate() -> FetchResult:
            if provider._client is None:
                provider._client = self._client
            return await provider.fetch(parsed, opts)

        t0 = time.perf_counter()
        try:
            result = await self._run_through_resilience(provider, opts, _do_validate)
        except (ProviderError, CircuitOpen) as exc:
            latency_ms = int((time.perf_counter() - t0) * 1000)
            self._log_thin_call(
                provider=provider,
                endpoint=f"{provider.DEFAULT_BASE_URL}{provider.ENTRY_PATH}/{parsed.canonical_id}",
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=latency_ms,
                exc=exc,
            )
            raise
        latency_ms = int((time.perf_counter() - t0) * 1000)
        self._log_thin_call(
            provider=provider,
            endpoint=f"{provider.DEFAULT_BASE_URL}{provider.ENTRY_PATH}/{parsed.canonical_id}",
            granted=granted_capabilities,
            workspace_id=workspace_id,
            latency_ms=latency_ms,
            status_code=result.status_code,
        )
        return result

    async def search_rcsb_by_sequence(
        self,
        sequence: str,
        *,
        sequence_type: str,
        granted_capabilities: list[str],
        workspace_id: str | None = None,
        identity_cutoff: float = 0.9,
        evalue_cutoff: float = 0.1,
        size: int = 10,
        opts: FetchOptions | None = None,
    ) -> list[RcsbSequenceSearchHit]:
        """Search RCSB polymer entities by query sequence.

        This is metadata/search only, not a structure-byte fetch. It powers
        RNA/DNA structure lookup from sequence annotations and returns scoped
        polymer entity identifiers such as ``1ABC_2``.
        """
        provider = self._providers.get("rcsb")
        if provider is None:
            raise UnknownProvider("no provider registered for 'rcsb'")
        if not isinstance(provider, RCSBProvider):
            raise UnknownProvider(
                f"registered 'rcsb' provider does not support sequence search "
                f"(got {provider.__class__.__name__})"
            )
        self._check_required_capabilities(_HOMOLOGY_REQUIRED, granted_capabilities)
        opts = opts or FetchOptions()
        endpoint = "https://search.rcsb.org/rcsbsearch/v2/query"
        normalized_sequence_type = sequence_type.lower()
        if normalized_sequence_type not in {"protein", "rna", "dna"}:
            raise ProviderHttpError(
                f"unsupported RCSB sequence_type {sequence_type!r}", status_code=422
            )
        body = {
            "query": {
                "type": "terminal",
                "service": "sequence",
                "parameters": {
                    "value": sequence,
                    "sequence_type": normalized_sequence_type,
                    "identity_cutoff": identity_cutoff,
                    "evalue_cutoff": evalue_cutoff,
                },
            },
            "return_type": "polymer_entity",
            "request_options": {
                "paginate": {"start": 0, "rows": size},
                "results_verbosity": "verbose",
                "scoring_strategy": "sequence",
            },
        }

        async def _do_search() -> list[RcsbSequenceSearchHit]:
            try:
                response = await self._client.post(
                    endpoint,
                    json=body,
                    timeout=opts.total_timeout_s,
                )
            except httpx.TimeoutException as exc:
                raise ProviderTimeoutError("RCSB sequence search timed out") from exc
            except httpx.HTTPError as exc:
                raise ProviderHttpError(
                    f"RCSB sequence search network error: {exc.__class__.__name__}"
                ) from exc
            if response.status_code == 204:
                return []
            if response.status_code == 429:
                raise ProviderRateLimitError(
                    "RCSB sequence search rate-limited",
                    retry_after_s=_retry_after_seconds(
                        response.headers.get("Retry-After")
                    ),
                )
            if response.status_code >= 400:
                raise ProviderHttpError(
                    f"RCSB sequence search returned HTTP {response.status_code}",
                    status_code=response.status_code,
                )
            try:
                payload = response.json()
            except ValueError as exc:
                raise ProviderContractError(
                    "RCSB sequence search returned malformed JSON",
                    status_code=response.status_code,
                ) from exc
            return _parse_rcsb_sequence_search_hits(payload)

        t0 = time.perf_counter()
        try:
            hits = await self._run_through_resilience(provider, opts, _do_search)
        except (ProviderError, CircuitOpen) as exc:
            latency_ms = int((time.perf_counter() - t0) * 1000)
            self._log_thin_call(
                provider=provider,
                endpoint=endpoint,
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=latency_ms,
                exc=exc,
                required_capabilities=_HOMOLOGY_REQUIRED,
            )
            raise
        latency_ms = int((time.perf_counter() - t0) * 1000)
        self._log_thin_call(
            provider=provider,
            endpoint=endpoint,
            granted=granted_capabilities,
            workspace_id=workspace_id,
            latency_ms=latency_ms,
            status_code=200,
            required_capabilities=_HOMOLOGY_REQUIRED,
        )
        return hits

    async def fetch_rcsb_poster(
        self,
        *,
        pdb_id: str,
        poster_kind: str,
        granted_capabilities: list[str],
        workspace_id: str | None = None,
        opts: FetchOptions | None = None,
        max_bytes: int = 5_000_000,
    ) -> StructurePosterResponse:
        """Fetch a whitelisted RCSB poster image through the sidecar.

        Renderer callers cannot load the CDN image directly under Electron's
        COEP policy, and `<img>` cannot attach the sidecar session header.
        This route is intentionally RCSB-poster-specific, not a general URL
        proxy.
        """
        if Capability.EXTERNAL_FETCH_STRUCTURE.value not in set(granted_capabilities):
            raise CapabilityDenied(
                required=[Capability.EXTERNAL_FETCH_STRUCTURE.value],
                granted=sorted(granted_capabilities),
            )
        if not re.fullmatch(r"[0-9A-Za-z]{4}", pdb_id):
            raise ProviderError(
                f"invalid RCSB PDB id for poster: {pdb_id!r}", status_code=422
            )
        if not re.fullmatch(r"(assembly|model)-[0-9]+", poster_kind):
            raise ProviderError(
                f"invalid RCSB poster kind: {poster_kind!r}",
                status_code=422,
            )

        opts = opts or FetchOptions()
        normalized_pdb_id = pdb_id.lower()
        source_url = f"https://cdn.rcsb.org/images/structures/{normalized_pdb_id}_{poster_kind}.jpeg"
        origin = "rcsb"
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
                    async with asyncio.timeout(opts.total_timeout_s):
                        response = await self._client.get(
                            source_url,
                            timeout=httpx.Timeout(
                                timeout=opts.total_timeout_s,
                                connect=opts.connect_timeout_s,
                            ),
                            headers={
                                "User-Agent": opts.user_agent,
                                "Accept": "image/jpeg",
                            },
                        )
                    if response.status_code == 429:
                        from .providers.uniprot import _parse_retry_after

                        raise ProviderRateLimitError(
                            f"RCSB poster rate-limited for {pdb_id}:{poster_kind}",
                            retry_after_s=_parse_retry_after(
                                response.headers.get("Retry-After")
                            ),
                        )
                    if response.status_code >= 400:
                        raise ProviderHttpError(
                            f"RCSB returned HTTP {response.status_code} for poster {pdb_id}:{poster_kind}",
                            status_code=response.status_code,
                        )
                    content_type = response.headers.get("Content-Type", "image/jpeg")
                    content = response.content
                    if len(content) > max_bytes:
                        raise StructureTooLarge(len(content), max_bytes)
                    if not content_type.lower().startswith(
                        "image/"
                    ) or not content.startswith(b"\xff\xd8"):
                        raise ProviderHttpError(
                            f"RCSB poster response was not a JPEG for {pdb_id}:{poster_kind}",
                            status_code=response.status_code,
                        )
                    breaker.record_success(permit)
                    return StructurePosterResponse(
                        provider="rcsb",
                        external_id=f"RCSB:{pdb_id.upper()}:POSTER:{poster_kind}",
                        content=content,
                        content_type=content_type,
                        source_url=source_url,
                        etag=response.headers.get("ETag"),
                    )
                except ProviderRateLimitError as exc:
                    last_exc = exc
                    if attempt >= opts.max_retries:
                        raise
                    await asyncio.sleep(
                        exc.retry_after_s or _backoff_wait(attempt, opts)
                    )
                except ProviderError as exc:
                    last_exc = exc
                    if (
                        _is_non_retryable_client_error(exc)
                        or attempt >= opts.max_retries
                    ):
                        raise
                    await asyncio.sleep(_backoff_wait(attempt, opts))
                except (httpx.TimeoutException, TimeoutError) as exc:
                    last_exc = ProviderTimeoutError(
                        f"RCSB poster timed out for {pdb_id}:{poster_kind}"
                    )
                    if attempt >= opts.max_retries:
                        raise last_exc from exc
                    await asyncio.sleep(_backoff_wait(attempt, opts))
                except (httpx.HTTPError, OSError) as exc:
                    last_exc = ProviderHttpError(
                        f"RCSB poster request failed for {pdb_id}:{poster_kind}: {exc}",
                        status_code=502,
                    )
                    if attempt >= opts.max_retries:
                        raise last_exc from exc
                    await asyncio.sleep(_backoff_wait(attempt, opts))

            raise last_exc or ProviderHttpError(
                f"RCSB poster request failed for {pdb_id}:{poster_kind}",
                status_code=502,
            )
        except ProviderError as exc:
            if isinstance(
                exc, ProviderRateLimitError
            ) or _should_record_breaker_failure(exc):
                breaker.record_failure(permit)
            raise
        finally:
            breaker.release(permit)


def _parse_rcsb_sequence_search_hits(payload: Any) -> list[RcsbSequenceSearchHit]:
    if not isinstance(payload, dict):
        raise ProviderContractError("RCSB sequence search payload was not an object")
    result_set = payload.get("result_set")
    if not isinstance(result_set, list):
        return []
    hits: list[RcsbSequenceSearchHit] = []
    for item in result_set:
        if not isinstance(item, dict):
            continue
        identifier = _str_or_none(item.get("identifier"))
        if not identifier:
            continue
        pdb_id, entity_id = _parse_rcsb_polymer_entity_identifier(identifier)
        if not pdb_id:
            continue
        score = _float_or_none(item.get("score"))
        sequence_identity, evalue, bit_score = _parse_rcsb_sequence_services(item)
        hits.append(
            RcsbSequenceSearchHit(
                identifier=identifier,
                pdb_id=pdb_id,
                entity_id=entity_id,
                score=score,
                sequence_identity=sequence_identity,
                evalue=evalue,
                bit_score=bit_score,
            )
        )
    return hits


def _parse_rcsb_polymer_entity_identifier(
    identifier: str,
) -> tuple[str | None, str | None]:
    match = re.fullmatch(r"([0-9][A-Za-z0-9]{3})(?:[_:](\w+))?", identifier.strip())
    if match is None:
        return None, None
    pdb_id, entity_id = match.groups()
    return pdb_id.upper(), entity_id.upper() if entity_id else None


def _parse_rcsb_sequence_services(
    item: dict[str, Any],
) -> tuple[float | None, float | None, float | None]:
    sequence_identity: float | None = None
    evalue: float | None = None
    bit_score: float | None = None
    services = item.get("services")
    if not isinstance(services, list):
        return sequence_identity, evalue, bit_score
    for service in services:
        if not isinstance(service, dict):
            continue
        nodes = service.get("nodes")
        if not isinstance(nodes, list):
            continue
        for node in nodes:
            if not isinstance(node, dict):
                continue
            match_context = node.get("match_context")
            if not isinstance(match_context, list):
                continue
            for context in match_context:
                if not isinstance(context, dict):
                    continue
                sequence_identity = sequence_identity or _float_or_none(
                    context.get("sequence_identity")
                )
                evalue = evalue or _float_or_none(context.get("evalue"))
                bit_score = bit_score or _float_or_none(context.get("bitscore"))
    return sequence_identity, evalue, bit_score


def _float_or_none(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        parsed = float(value)
        return parsed if parsed == parsed else None
    if isinstance(value, str):
        try:
            parsed = float(value)
        except ValueError:
            return None
        return parsed if parsed == parsed else None
    return None


def _str_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None
