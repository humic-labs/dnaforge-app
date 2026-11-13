"""Paper-source methods mixed into ExternalResourcesService."""

from __future__ import annotations

import asyncio
import time

from .contract import Capability, FetchOptions, ProviderError, ProviderTimeoutError
from .paper_graph import (
    PaperReferenceGraph,
    PaperReferenceRecordResult,
    PaperReferenceTrace,
    get_paper_reference_graph,
    record_paper_reference_trace,
)
from .providers.paper_source import (
    PaperSourceProvider,
    PaperSourceResult,
    PaperSourceTooLarge,
)
from .service_types import CapabilityDenied, CircuitOpen, UnknownProvider

_PAPER_REQUIRED = [Capability.EXTERNAL_FETCH_PAPER.value]


class PaperServiceMixin:
    async def record_paper_reference_graph(
        self,
        *,
        workspace_id: str,
        source_sha256: str,
        traces: list[PaperReferenceTrace],
        source_metadata: dict[str, object],
    ) -> PaperReferenceRecordResult:
        """Persist a validated local trace batch under the shared DAO lock."""
        async with self._dao_lock:
            return record_paper_reference_trace(
                self._store,
                workspace_id=workspace_id,
                source_sha256=source_sha256,
                traces=traces,
                source_metadata=source_metadata,
            )

    def query_paper_reference_graph(
        self,
        *,
        workspace_id: str,
        source_sha256: str,
        depth: int,
        max_nodes: int,
    ) -> PaperReferenceGraph:
        """Read a bounded local graph; this never invokes a provider."""
        return get_paper_reference_graph(
            self._store,
            workspace_id=workspace_id,
            source_sha256=source_sha256,
            depth=depth,
            max_nodes=max_nodes,
        )

    async def capture_paper_source(
        self,
        source_url: str,
        *,
        granted_capabilities: list[str],
        workspace_id: str | None = None,
        opts: FetchOptions | None = None,
    ) -> PaperSourceResult:
        provider = self._providers.get("paper-source")
        if provider is None:
            raise UnknownProvider("no provider registered for 'paper-source'")
        if not isinstance(provider, PaperSourceProvider):
            raise UnknownProvider(
                "registered 'paper-source' provider does not support paper capture"
            )
        started = time.perf_counter()
        try:
            self._check_required_capabilities(_PAPER_REQUIRED, granted_capabilities)
        except CapabilityDenied as exc:
            self._log_thin_call(
                provider=provider,
                endpoint=source_url,
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=int((time.perf_counter() - started) * 1000),
                exc=exc,
                required_capabilities=_PAPER_REQUIRED,
            )
            raise
        request_opts = opts or FetchOptions(
            total_timeout_s=30.0,
            connect_timeout_s=8.0,
            max_retries=1,
        )

        async def _do() -> PaperSourceResult:
            if provider._client is None:
                provider._client = self._client
            return await provider.capture_source(source_url, opts=request_opts)

        try:
            try:
                async with asyncio.timeout(request_opts.total_timeout_s):
                    result = await self._run_through_resilience(
                        provider, request_opts, _do
                    )
            except TimeoutError as exc:
                raise ProviderTimeoutError(
                    "Paper source request timed out after "
                    f"{request_opts.total_timeout_s}s"
                ) from exc
        except (ProviderError, CircuitOpen, PaperSourceTooLarge) as exc:
            self._log_thin_call(
                provider=provider,
                endpoint=source_url,
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=int((time.perf_counter() - started) * 1000),
                bytes_received=getattr(exc, "byte_count", None),
                exc=exc,
                required_capabilities=_PAPER_REQUIRED,
            )
            raise
        self._log_thin_call(
            provider=provider,
            endpoint=result.canonical_url,
            granted=granted_capabilities,
            workspace_id=workspace_id,
            latency_ms=int((time.perf_counter() - started) * 1000),
            status_code=200,
            bytes_received=result.byte_count,
            required_capabilities=_PAPER_REQUIRED,
        )
        return result
