"""NEB Tm provider-domain method for ExternalResourcesService .

A mixin extracted like the UniProt/RCSB ones. Runs on the composed
ExternalResourcesService and uses the substrate primitives via `self`
(`_providers`, `_client`, `_run_through_resilience`, `_check_required_capabilities`,
`_log_thin_call`). Imports only leaf modules — never `service.py` — to keep the
mixin split cycle-free.

Unlike annotation fetches, NEB Tm requires the `external-compute:tm` scope
(it submits caller sequence content), so this checks that scope directly rather
than the annotation-hardcoded `_check_capabilities`.
"""

from __future__ import annotations

import time

from .contract import Capability, FetchOptions, ProviderError
from .providers.neb_tm import NebTmProvider, NebTmResult
from .service_types import CircuitOpen, UnknownProvider

_TM_REQUIRED = [Capability.EXTERNAL_COMPUTE_TM.value]


class NebServiceMixin:
    """NEB Tm calculator method. See module docstring."""

    async def compute_primer_tm(
        self,
        seq1: str,
        *,
        seq2: str | None = None,
        prodcode: str = "q5-0",
        conc_nm: float = 250.0,
        granted_capabilities: list[str],
        workspace_id: str | None = None,
        opts: FetchOptions | None = None,
    ) -> NebTmResult:
        """Compute NEB Tm/Ta for a primer (or pair) through the substrate's
        rate-limit + circuit-breaker + backoff, capability-gated and logged."""
        provider = self._providers.get("neb-tm")
        if provider is None:
            raise UnknownProvider("no provider registered for 'neb-tm'")
        if not isinstance(provider, NebTmProvider):
            raise UnknownProvider(
                f"registered 'neb-tm' provider does not support compute_tm "
                f"(got {provider.__class__.__name__})"
            )
        self._check_required_capabilities(_TM_REQUIRED, granted_capabilities)
        opts = opts or FetchOptions()
        endpoint = f"{provider.DEFAULT_BASE_URL}{provider.TM_PATH}"

        async def _do() -> NebTmResult:
            if provider._client is None:
                provider._client = self._client
            return await provider.compute_tm(
                seq1, seq2=seq2, prodcode=prodcode, conc_nm=conc_nm, opts=opts
            )

        t0 = time.perf_counter()
        try:
            result = await self._run_through_resilience(provider, opts, _do)
        except (ProviderError, CircuitOpen) as exc:
            self._log_thin_call(
                provider=provider,
                endpoint=endpoint,
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=int((time.perf_counter() - t0) * 1000),
                exc=exc,
                required_capabilities=_TM_REQUIRED,
            )
            raise
        self._log_thin_call(
            provider=provider,
            endpoint=endpoint,
            granted=granted_capabilities,
            workspace_id=workspace_id,
            latency_ms=int((time.perf_counter() - t0) * 1000),
            status_code=200,
            required_capabilities=_TM_REQUIRED,
        )
        return result

    async def compute_primer_tm_batch(
        self,
        sequences: list[str],
        *,
        prodcode: str = "q5-0",
        conc_nm: float = 250.0,
        granted_capabilities: list[str],
        workspace_id: str | None = None,
        opts: FetchOptions | None = None,
    ) -> list[NebTmResult]:
        """Compute NEB Tm for many primers in one /tm/batch call."""
        provider = self._providers.get("neb-tm")
        if provider is None:
            raise UnknownProvider("no provider registered for 'neb-tm'")
        if not isinstance(provider, NebTmProvider):
            raise UnknownProvider(
                f"registered 'neb-tm' provider does not support compute_tm "
                f"(got {provider.__class__.__name__})"
            )
        self._check_required_capabilities(_TM_REQUIRED, granted_capabilities)
        opts = opts or FetchOptions()
        endpoint = f"{provider.DEFAULT_BASE_URL}{provider.TM_BATCH_PATH}"

        async def _do() -> list[NebTmResult]:
            if provider._client is None:
                provider._client = self._client
            return await provider.compute_tm_batch(
                sequences, prodcode=prodcode, conc_nm=conc_nm, opts=opts
            )

        t0 = time.perf_counter()
        try:
            result = await self._run_through_resilience(provider, opts, _do)
        except (ProviderError, CircuitOpen) as exc:
            self._log_thin_call(
                provider=provider,
                endpoint=endpoint,
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=int((time.perf_counter() - t0) * 1000),
                exc=exc,
                required_capabilities=_TM_REQUIRED,
            )
            raise
        self._log_thin_call(
            provider=provider,
            endpoint=endpoint,
            granted=granted_capabilities,
            workspace_id=workspace_id,
            latency_ms=int((time.perf_counter() - t0) * 1000),
            status_code=200,
            required_capabilities=_TM_REQUIRED,
        )
        return result
