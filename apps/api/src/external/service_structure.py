"""Structure / AlphaFold provider-domain methods for ExternalResourcesService.

A mixin extracted from service.py : AFDB existence validation, the
structure-bytes fetch, and the RCSB/AlphaFold poster fetch, plus their
structure-exclusive private helpers. Runs on the composed
ExternalResourcesService and REQUIRES the host's substrate primitives via
`self` (`_client`, `_store`, `_bucket_for`, `_breaker_for`,
`_check_required_capabilities`, `_log_thin_call`, the `_log_*`/`_maybe_*`
helpers). Imports nothing from service.py (keeps the split cycle-free); the
pure structure-format machinery lives in structure_identity.py.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time

import httpx

from .afdb import DEFAULT_AFDB_BASE_URL, AfdbHit
from .afdb import validate_afdb_exists as _afdb_validate
from .alphafold_poster import (
    ALPHAFOLD_CARTOON_PLDDT_RENDER_VERSION,
    read_cached_alphafold_cartoon_plddt_poster,
    render_alphafold_cartoon_plddt_png,
    write_cached_alphafold_cartoon_plddt_poster,
)
from .contract import (
    Capability,
    FetchOptions,
    ParsedId,
    ProviderContractError,
    ProviderError,
    ProviderHttpError,
    ProviderRateLimitError,
    ProviderTimeoutError,
)
from .providers.rcsb import (
    RCSBProvider,
    rcsb_provider_identity_key,
)
from .resilience import (
    _backoff_wait,
    _is_non_retryable_client_error,
    _is_provider_contract_error,
    _parse_content_length,
    _should_record_breaker_failure,
    _TokenBucket,
)
from .service_types import (
    CapabilityDenied,
    CircuitOpen,
    StructureBytesResponse,
    StructurePosterResponse,
    StructureTooLarge,
)
from .structure_identity import (
    CanonicalStructureIdentity,
    _alphafold_provider_identity_key,
    _canonical_structure_identity,
    _rcsb_identity_has_scope,
    _structure_download_info,
    _validate_alphafold_cif_url,
    _validate_structure_bytes_content,
)

logger = logging.getLogger(__name__)


def _structure_response_identities(
    provider: str, identity: CanonicalStructureIdentity
) -> tuple[str, str]:
    key = identity.provider_identity_key
    if provider == "rcsb" and identity.pdb_id:
        return key, rcsb_provider_identity_key(identity.pdb_id)
    return key, key


def _alphafold_direct_structure_url(identity: CanonicalStructureIdentity) -> str | None:
    if identity.model_id:
        return f"https://alphafold.ebi.ac.uk/files/{identity.model_id}.cif"
    if identity.version and identity.version != "LATEST":
        return (
            "https://alphafold.ebi.ac.uk/files/"
            f"AF-{identity.accession}-{identity.fragment}-model_v{identity.version[1:]}.cif"
        )
    return None


class StructureServiceMixin:
    """AFDB validate / structure-bytes / poster methods. See module docstring."""

    async def validate_afdb_exists(
        self,
        accession: str,
        *,
        fragment: str = "F1",
        granted_capabilities: list[str],
        workspace_id: str | None = None,
        opts: FetchOptions | None = None,
    ) -> AfdbHit | None:
        """Check AFDB has a structure prediction for `accession`. Powers 
        steps 2-7, post-UniProt-resolution AFDB existence guard."""
        required = [Capability.EXTERNAL_FETCH_ANNOTATION.value]
        if Capability.EXTERNAL_FETCH_ANNOTATION.value not in set(granted_capabilities):
            raise CapabilityDenied(
                required=required, granted=sorted(granted_capabilities)
            )

        opts = opts or FetchOptions()
        breaker = self._breaker_for("alphafold")
        permit = breaker.try_acquire()
        if permit is None:
            raise CircuitOpen("alphafold", breaker.opens_at_s())
        try:
            bucket = self._bucket_for("alphafold")

            last_exc: ProviderError | None = None
            t0 = time.perf_counter()
            for attempt in range(opts.max_retries + 1):
                wait_s = bucket.take()
                if wait_s > 0:
                    await asyncio.sleep(wait_s)
                try:
                    hit = await _afdb_validate(
                        self._client,
                        accession,
                        opts,
                        fragment=fragment,
                    )
                    breaker.record_success(permit)
                    latency_ms = int((time.perf_counter() - t0) * 1000)
                    self._log_thin_call(
                        provider=None,
                        endpoint=f"https://alphafold.ebi.ac.uk/api/prediction/{accession}",
                        granted=granted_capabilities,
                        workspace_id=workspace_id,
                        latency_ms=latency_ms,
                        status_code=200 if hit else 404,
                        provider_id="alphafold",
                    )
                    return hit
                except ProviderRateLimitError as exc:
                    last_exc = exc
                    if attempt < opts.max_retries:
                        wait = exc.retry_after_s or _backoff_wait(attempt, opts)
                        await asyncio.sleep(wait)
                except ProviderTimeoutError as exc:
                    last_exc = exc
                    if attempt < opts.max_retries:
                        await asyncio.sleep(_backoff_wait(attempt, opts))
                except ProviderError as exc:
                    last_exc = exc
                    if _is_non_retryable_client_error(
                        exc
                    ) or _is_provider_contract_error(exc):
                        latency_ms = int((time.perf_counter() - t0) * 1000)
                        self._log_thin_call(
                            provider=None,
                            endpoint=f"https://alphafold.ebi.ac.uk/api/prediction/{accession}",
                            granted=granted_capabilities,
                            workspace_id=workspace_id,
                            latency_ms=latency_ms,
                            exc=exc,
                            provider_id="alphafold",
                        )
                        raise
                    if attempt < opts.max_retries:
                        await asyncio.sleep(_backoff_wait(attempt, opts))

            latency_ms = int((time.perf_counter() - t0) * 1000)
            if last_exc is None:
                last_exc = ProviderError(
                    "AFDB validate exhausted retries with no error"
                )
            self._log_thin_call(
                provider=None,
                endpoint=f"https://alphafold.ebi.ac.uk/api/prediction/{accession}",
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=latency_ms,
                exc=last_exc,
                provider_id="alphafold",
            )
            raise last_exc
        except ProviderError as exc:
            if _should_record_breaker_failure(exc):
                breaker.record_failure(permit)
            raise
        finally:
            breaker.release(permit)

    async def fetch_alphafold_poster(
        self,
        *,
        accession: str,
        fragment: str,
        version: str,
        granted_capabilities: list[str],
        workspace_id: str | None = None,
        opts: FetchOptions | None = None,
        max_bytes: int = 20_000_000,
    ) -> StructurePosterResponse:
        """Render and cache a pLDDT-colored AlphaFold structural thumbnail."""
        if Capability.EXTERNAL_FETCH_STRUCTURE.value not in set(granted_capabilities):
            raise CapabilityDenied(
                required=[Capability.EXTERNAL_FETCH_STRUCTURE.value],
                granted=sorted(granted_capabilities),
            )
        canonical = accession.strip().upper()
        canonical_fragment = fragment.strip().upper() or "F1"
        if not re.fullmatch(r"[0-9A-Za-z]+", canonical):
            raise ProviderError(
                f"invalid AlphaFold accession for poster: {accession!r}",
                status_code=422,
            )
        if not re.fullmatch(r"F[1-9][0-9]*", canonical_fragment):
            raise ProviderError(
                f"invalid AlphaFold fragment for poster: {fragment!r}",
                status_code=422,
            )

        opts = opts or FetchOptions()
        origin = "alphafold"
        breaker = self._breaker_for(origin)
        permit = breaker.try_acquire()
        if permit is None:
            raise CircuitOpen(origin, breaker.opens_at_s())
        try:
            bucket = self._bucket_for(origin)

            normalized_version = version.strip().lower()
            if normalized_version == "latest":
                wait_s = bucket.take()
                if wait_s > 0:
                    await asyncio.sleep(wait_s)
                hit = await _afdb_validate(
                    self._client,
                    canonical,
                    opts,
                    fragment=canonical_fragment,
                )
                if hit is None or hit.latest_version is None:
                    raise ProviderHttpError(
                        f"AlphaFold poster version not found for {canonical}:{canonical_fragment}",
                        status_code=404,
                    )
                version_int = hit.latest_version
            else:
                version_match = re.fullmatch(r"v([1-9][0-9]*)", normalized_version)
                if version_match is None:
                    raise ProviderError(
                        f"invalid AlphaFold poster version: {version!r}",
                        status_code=422,
                    )
                version_int = int(version_match.group(1))

            model_prefix = f"AF-{canonical}-{canonical_fragment}"
            source_url = (
                "https://alphafold.ebi.ac.uk/files/"
                f"{model_prefix}-model_v{version_int}.cif"
            )
            external_id = f"AF:{canonical}:{canonical_fragment}:V{version_int}:POSTER:CARTOON_PLDDT"

            cached = read_cached_alphafold_cartoon_plddt_poster(external_id)
            if cached is not None:
                return StructurePosterResponse(
                    provider=origin,
                    external_id=external_id,
                    content=cached.content,
                    content_type="image/png",
                    source_url=source_url,
                    etag=cached.etag,
                    style="cartoon-plddt",
                    cache_hit=True,
                    render_version=ALPHAFOLD_CARTOON_PLDDT_RENDER_VERSION,
                )

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
                                "Accept": "chemical/x-mmcif,text/plain,*/*",
                            },
                        )
                    if response.status_code == 429:
                        from .providers.uniprot import _parse_retry_after

                        raise ProviderRateLimitError(
                            f"AlphaFold poster rate-limited for {canonical}:{canonical_fragment}:v{version_int}",
                            retry_after_s=_parse_retry_after(
                                response.headers.get("Retry-After")
                            ),
                        )
                    if response.status_code >= 400:
                        raise ProviderHttpError(
                            f"AlphaFold returned HTTP {response.status_code} for model poster source {canonical}:{canonical_fragment}:v{version_int}",
                            status_code=response.status_code,
                        )
                    content = response.content
                    if len(content) > max_bytes:
                        raise StructureTooLarge(len(content), max_bytes)
                    try:
                        mmcif_text = content.decode(response.encoding or "utf-8")
                        poster = render_alphafold_cartoon_plddt_png(mmcif_text)
                    except (UnicodeDecodeError, ValueError) as exc:
                        raise ProviderContractError(
                            f"AlphaFold model CIF could not be rendered as a poster for {canonical}:{canonical_fragment}:v{version_int}",
                            status_code=response.status_code,
                        ) from exc
                    if not poster.startswith(b"\x89PNG\r\n\x1a\n"):
                        raise ProviderContractError(
                            f"AlphaFold poster renderer did not produce a PNG for {canonical}:{canonical_fragment}:v{version_int}",
                            status_code=response.status_code,
                        )
                    etag = write_cached_alphafold_cartoon_plddt_poster(
                        external_id,
                        poster,
                    )
                    breaker.record_success(permit)
                    return StructurePosterResponse(
                        provider=origin,
                        external_id=external_id,
                        content=poster,
                        content_type="image/png",
                        source_url=source_url,
                        etag=etag,
                        style="cartoon-plddt",
                        cache_hit=False,
                        render_version=ALPHAFOLD_CARTOON_PLDDT_RENDER_VERSION,
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
                        f"AlphaFold poster timed out for {canonical}:{canonical_fragment}:v{version_int}"
                    )
                    if attempt >= opts.max_retries:
                        raise last_exc from exc
                    await asyncio.sleep(_backoff_wait(attempt, opts))
                except (httpx.HTTPError, OSError) as exc:
                    last_exc = ProviderHttpError(
                        f"AlphaFold poster request failed for {canonical}:{canonical_fragment}:v{version_int}: {exc}",
                        status_code=502,
                    )
                    if attempt >= opts.max_retries:
                        raise last_exc from exc
                    await asyncio.sleep(_backoff_wait(attempt, opts))

            raise last_exc or ProviderHttpError(
                f"AlphaFold poster request failed for {canonical}:{canonical_fragment}:v{version_int}",
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

    async def fetch_structure_bytes(
        self,
        *,
        provider: str,
        external_id: str,
        format: str,
        pdb_id: str | None = None,
        pdb_entity_id: str | None = None,
        label_asym_ids: list[str] | None = None,
        auth_asym_ids: list[str] | None = None,
        assembly_id: str | None = None,
        accession: str | None = None,
        fragment: str | None = None,
        version: str | None = None,
        model_id: str | None = None,
        granted_capabilities: list[str],
        workspace_id: str | None = None,
        opts: FetchOptions | None = None,
        max_bytes: int | None = None,
    ) -> StructureBytesResponse:
        """Fetch structure bytes for known providers through the sidecar.

        No arbitrary URLs are accepted; renderer callers send provider/id and
        this method maps them to provider-owned download URLs.
        """
        if Capability.EXTERNAL_FETCH_STRUCTURE.value not in set(granted_capabilities):
            exc_cap = CapabilityDenied(
                required=[Capability.EXTERNAL_FETCH_STRUCTURE.value],
                granted=sorted(granted_capabilities),
            )
            self._log_structure_bytes_call(
                provider=provider,
                endpoint=f"{provider}:{external_id}",
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=0,
                status_code=None,
                bytes_received=None,
                exc=exc_cap,
            )
            raise exc_cap
        opts = opts or FetchOptions()
        t0 = time.perf_counter()
        try:
            identity = _canonical_structure_identity(
                provider,
                external_id,
                pdb_id=pdb_id,
                pdb_entity_id=pdb_entity_id,
                label_asym_ids=label_asym_ids,
                auth_asym_ids=auth_asym_ids,
                assembly_id=assembly_id,
                accession=accession,
                fragment=fragment,
                version=version,
                model_id=model_id,
            )
        except ProviderError as exc:
            self._log_structure_bytes_call(
                provider=provider,
                endpoint=f"{provider}:{external_id}",
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=0,
                status_code=exc.status_code,
                bytes_received=None,
                exc=exc,
            )
            raise
        origin = provider
        breaker = self._breaker_for(origin)
        permit = breaker.try_acquire()
        if permit is None:
            exc_open = CircuitOpen(origin, breaker.opens_at_s())
            self._log_structure_bytes_call(
                provider=provider,
                endpoint=f"{provider}:{identity.provider_identity_key}",
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=int((time.perf_counter() - t0) * 1000),
                status_code=None,
                bytes_received=None,
                exc=exc_open,
            )
            raise exc_open
        try:
            bucket = self._bucket_for(origin)
            source_url, content_type, license_text, attribution = (
                _structure_download_info(identity, format)
            )
            response_external_id, served_external_id = _structure_response_identities(
                provider, identity
            )
            if provider == "rcsb" and _rcsb_identity_has_scope(identity):
                await self._validate_rcsb_structure_scope(
                    identity=identity,
                    granted_capabilities=granted_capabilities,
                    workspace_id=workspace_id,
                    opts=opts,
                    bucket=bucket,
                )
            if provider == "alphafold":
                direct_url = _alphafold_direct_structure_url(identity)
                if direct_url is not None:
                    source_url = direct_url
                else:
                    (
                        source_url,
                        resolved_version,
                        resolved_model_id,
                    ) = await self._resolve_alphafold_structure_url(
                        accession=identity.accession or "",
                        fragment=identity.fragment or "F1",
                        granted_capabilities=granted_capabilities,
                        workspace_id=workspace_id,
                        opts=opts,
                        bucket=bucket,
                    )
                    response_external_id = _alphafold_provider_identity_key(
                        identity.accession or "",
                        fragment=identity.fragment or "F1",
                        version=resolved_version,
                        model_id=resolved_model_id,
                    )
                    served_external_id = response_external_id

            last_exc: ProviderError | None = None
            for attempt in range(opts.max_retries + 1):
                wait_s = bucket.take()
                if wait_s > 0:
                    await asyncio.sleep(wait_s)
                try:
                    async with asyncio.timeout(opts.total_timeout_s):
                        async with self._client.stream(
                            "GET",
                            source_url,
                            timeout=httpx.Timeout(
                                timeout=opts.total_timeout_s,
                                connect=opts.connect_timeout_s,
                            ),
                            headers={
                                "User-Agent": opts.user_agent,
                                "Accept": content_type,
                            },
                        ) as response:
                            content_length = _parse_content_length(
                                response.headers.get("Content-Length")
                            )
                            if (
                                max_bytes is not None
                                and content_length is not None
                                and content_length > max_bytes
                            ):
                                raise StructureTooLarge(content_length, max_bytes)
                            if response.status_code == 429:
                                from .providers.uniprot import _parse_retry_after

                                raise ProviderRateLimitError(
                                    f"{provider} structure bytes rate-limited for {identity.provider_identity_key}",
                                    retry_after_s=_parse_retry_after(
                                        response.headers.get("Retry-After")
                                    ),
                                )
                            if response.status_code >= 400:
                                raise ProviderHttpError(
                                    f"{provider} returned HTTP {response.status_code} for structure {identity.provider_identity_key}",
                                    status_code=response.status_code,
                                )
                            chunks: list[bytes] = []
                            bytes_received = 0
                            async for chunk in response.aiter_bytes():
                                bytes_received += len(chunk)
                                if max_bytes is not None and bytes_received > max_bytes:
                                    raise StructureTooLarge(bytes_received, max_bytes)
                                chunks.append(chunk)
                            content = b"".join(chunks)
                            response_content_type = response.headers.get(
                                "Content-Type", content_type
                            )
                            response_etag = response.headers.get("ETag")
                    _validate_structure_bytes_content(
                        content,
                        format=format,
                        content_type=response_content_type,
                        provider=provider,
                        identity=identity.provider_identity_key,
                        canonical_identity=identity,
                        status_code=response.status_code,
                    )
                    breaker.record_success(permit)
                    latency_ms = int((time.perf_counter() - t0) * 1000)
                    self._log_structure_bytes_call(
                        provider=provider,
                        endpoint=source_url,
                        granted=granted_capabilities,
                        workspace_id=workspace_id,
                        latency_ms=latency_ms,
                        status_code=response.status_code,
                        bytes_received=len(content),
                    )
                    return StructureBytesResponse(
                        provider=provider,
                        external_id=response_external_id,
                        served_external_id=served_external_id,
                        format=format,
                        content=content,
                        content_type=response_content_type,
                        source_url=source_url,
                        license=license_text,
                        attribution=attribution,
                        etag=response_etag,
                    )
                except StructureTooLarge as exc:
                    latency_ms = int((time.perf_counter() - t0) * 1000)
                    self._log_structure_bytes_call(
                        provider=provider,
                        endpoint=source_url,
                        granted=granted_capabilities,
                        workspace_id=workspace_id,
                        latency_ms=latency_ms,
                        status_code=413,
                        bytes_received=exc.byte_count,
                        exc=exc,
                    )
                    raise
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
                        latency_ms = int((time.perf_counter() - t0) * 1000)
                        self._log_structure_bytes_call(
                            provider=provider,
                            endpoint=source_url,
                            granted=granted_capabilities,
                            workspace_id=workspace_id,
                            latency_ms=latency_ms,
                            status_code=exc.status_code,
                            bytes_received=None,
                            exc=exc,
                        )
                        raise
                    if attempt < opts.max_retries:
                        await asyncio.sleep(_backoff_wait(attempt, opts))
                except (httpx.TimeoutException, TimeoutError):
                    last_exc = ProviderTimeoutError(
                        f"{provider} structure bytes timed out for {identity.provider_identity_key}"
                    )
                    if attempt < opts.max_retries:
                        await asyncio.sleep(_backoff_wait(attempt, opts))
                except (httpx.HTTPError, OSError) as exc:
                    last_exc = ProviderHttpError(
                        f"{provider} structure bytes network error for {identity.provider_identity_key}: "
                        f"{exc.__class__.__name__}"
                    )
                    if attempt < opts.max_retries:
                        await asyncio.sleep(_backoff_wait(attempt, opts))

            latency_ms = int((time.perf_counter() - t0) * 1000)
            if last_exc is None:
                last_exc = ProviderError(
                    "structure bytes fetch exhausted retries with no error"
                )
            self._log_structure_bytes_call(
                provider=provider,
                endpoint=source_url,
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=latency_ms,
                status_code=getattr(last_exc, "status_code", None),
                bytes_received=None,
                exc=last_exc,
            )
            raise last_exc
        except ProviderError as exc:
            if _should_record_breaker_failure(exc):
                breaker.record_failure(permit)
            raise
        finally:
            breaker.release(permit)

    async def _validate_rcsb_structure_scope(
        self,
        *,
        identity: CanonicalStructureIdentity,
        granted_capabilities: list[str],
        workspace_id: str | None,
        opts: FetchOptions,
        bucket: _TokenBucket,
    ) -> None:
        """Verify requested RCSB entity/chain/assembly scopes before bytes.

        RCSB structure files are entry-level downloads, so syntax-only
        canonicalization would otherwise let callers mint nonexistent scoped
        identities such as `RCSB:1RBL:ENTRY:ENTITY:999`. Fetch the entry
        metadata and let the RCSB provider's metadata validator prove the
        requested scope exists before returning bytes under that identity.
        """
        provider = RCSBProvider(client=self._client)
        parsed = ParsedId(
            canonical_id=identity.pdb_id or "",
            provider="rcsb",
            chain=",".join(identity.auth_asym_ids) or None,
            entity=identity.pdb_entity_id,
            scope=identity.provider_identity_key,
        )
        endpoint = f"{provider.DEFAULT_BASE_URL}{provider.ENTRY_PATH}/{identity.pdb_id}"
        last_exc: ProviderError | None = None
        t0 = time.perf_counter()
        for attempt in range(opts.max_retries + 1):
            wait_s = bucket.take()
            if wait_s > 0:
                await asyncio.sleep(wait_s)
            try:
                await provider.fetch(parsed, opts)
                return
            except ProviderRateLimitError as exc:
                last_exc = exc
                if attempt < opts.max_retries:
                    wait = exc.retry_after_s or _backoff_wait(attempt, opts)
                    await asyncio.sleep(wait)
            except ProviderHttpError as exc:
                last_exc = exc
                if _is_non_retryable_client_error(exc) or _is_provider_contract_error(
                    exc
                ):
                    latency_ms = int((time.perf_counter() - t0) * 1000)
                    self._log_structure_bytes_call(
                        provider="rcsb",
                        endpoint=endpoint,
                        granted=granted_capabilities,
                        workspace_id=workspace_id,
                        latency_ms=latency_ms,
                        status_code=exc.status_code,
                        bytes_received=None,
                        exc=exc,
                    )
                    raise
                if attempt < opts.max_retries:
                    await asyncio.sleep(_backoff_wait(attempt, opts))
            except ProviderTimeoutError as exc:
                last_exc = exc
                if attempt < opts.max_retries:
                    await asyncio.sleep(_backoff_wait(attempt, opts))

        latency_ms = int((time.perf_counter() - t0) * 1000)
        if last_exc is None:
            last_exc = ProviderError(
                "RCSB scope validation exhausted retries with no error"
            )
        self._log_structure_bytes_call(
            provider="rcsb",
            endpoint=endpoint,
            granted=granted_capabilities,
            workspace_id=workspace_id,
            latency_ms=latency_ms,
            status_code=getattr(last_exc, "status_code", None),
            bytes_received=None,
            exc=last_exc,
        )
        raise last_exc

    async def _resolve_alphafold_structure_url(
        self,
        *,
        accession: str,
        fragment: str,
        granted_capabilities: list[str],
        workspace_id: str | None,
        opts: FetchOptions,
        bucket: _TokenBucket,
    ) -> tuple[str, str, str | None]:
        """Resolve the current AlphaFold CIF URL through the AFDB API.

        AlphaFold file URLs include model versions. The AFDB API reports the
        current `cifUrl`, so the byte proxy must resolve that before fetching
        the structure file instead of assuming a static model version.
        """
        canonical = accession.strip().upper()
        canonical_fragment = fragment.strip().upper() or "F1"
        endpoint = f"{DEFAULT_AFDB_BASE_URL}/{canonical}"
        last_exc: ProviderError | None = None
        t0 = time.perf_counter()
        for attempt in range(opts.max_retries + 1):
            wait_s = bucket.take()
            if wait_s > 0:
                await asyncio.sleep(wait_s)
            try:
                hit = await _afdb_validate(
                    self._client,
                    canonical,
                    opts,
                    fragment=canonical_fragment,
                )
                if hit is None:
                    last_exc = ProviderHttpError(
                        f"alphafold prediction not found for {canonical}",
                        status_code=404,
                    )
                    raise last_exc
                if hit.accession != canonical:
                    last_exc = ProviderHttpError(
                        f"alphafold prediction returned accession {hit.accession!r} for {canonical!r}",
                        status_code=502,
                    )
                    break
                if hit.fragment != canonical_fragment:
                    last_exc = ProviderHttpError(
                        f"alphafold prediction returned fragment {hit.fragment!r} for {canonical_fragment!r}",
                        status_code=502,
                    )
                    break
                resolved_version: str | None = None
                resolved_model_id: str | None = hit.model_id
                if hit.cif_url:
                    try:
                        resolved_url, resolved_version, resolved_model_id = (
                            _validate_alphafold_cif_url(
                                hit.cif_url,
                                accession=canonical,
                                fragment=canonical_fragment,
                                latest_version=hit.latest_version,
                            )
                        )
                    except ProviderContractError as exc:
                        last_exc = exc
                        break
                elif hit.latest_version is not None:
                    resolved_version = f"V{hit.latest_version}"
                    resolved_model_id = f"AF-{canonical}-{canonical_fragment}-model_v{hit.latest_version}"
                    resolved_url = (
                        f"https://alphafold.ebi.ac.uk/files/{resolved_model_id}.cif"
                    )
                else:
                    last_exc = ProviderHttpError(
                        f"alphafold prediction for {canonical} omitted a CIF URL",
                        status_code=502,
                    )
                    break
                return resolved_url, resolved_version, resolved_model_id
            except ProviderRateLimitError as exc:
                last_exc = exc
                if attempt < opts.max_retries:
                    wait = exc.retry_after_s or _backoff_wait(attempt, opts)
                    await asyncio.sleep(wait)
            except ProviderTimeoutError as exc:
                last_exc = exc
                if attempt < opts.max_retries:
                    await asyncio.sleep(_backoff_wait(attempt, opts))
            except ProviderError as exc:
                last_exc = exc
                if _is_non_retryable_client_error(exc) or _is_provider_contract_error(
                    exc
                ):
                    latency_ms = int((time.perf_counter() - t0) * 1000)
                    self._log_structure_bytes_call(
                        provider="alphafold",
                        endpoint=endpoint,
                        granted=granted_capabilities,
                        workspace_id=workspace_id,
                        latency_ms=latency_ms,
                        status_code=exc.status_code,
                        bytes_received=None,
                        exc=exc,
                    )
                    raise
                if attempt < opts.max_retries:
                    await asyncio.sleep(_backoff_wait(attempt, opts))

        latency_ms = int((time.perf_counter() - t0) * 1000)
        if last_exc is None:
            last_exc = ProviderError(
                "AlphaFold structure URL resolve exhausted retries"
            )
        self._log_structure_bytes_call(
            provider="alphafold",
            endpoint=endpoint,
            granted=granted_capabilities,
            workspace_id=workspace_id,
            latency_ms=latency_ms,
            status_code=getattr(last_exc, "status_code", None),
            bytes_received=None,
            exc=last_exc,
        )
        raise last_exc

    def _log_structure_bytes_call(
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
        failure_kind: str | None = None
        if exc is not None:
            if isinstance(exc, CapabilityDenied):
                failure_kind = "capability_denied"
            elif isinstance(exc, CircuitOpen):
                failure_kind = "circuit_open"
            else:
                failure_kind = getattr(exc, "failure_kind", "service_error")
        try:
            required_granted = Capability.EXTERNAL_FETCH_STRUCTURE.value in set(granted)
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
                    "required": [Capability.EXTERNAL_FETCH_STRUCTURE.value],
                    "granted": list(granted),
                    "satisfied": required_granted,
                },
            )
        except Exception:  # nosec
            logger.warning(
                "failed to write external_fetch_log structure-bytes row",
                exc_info=True,
            )
