"""Jev discovery uses the existing capability, resilience and audit boundary."""

from __future__ import annotations

import asyncio
import time

from .contract import FetchOptions, ProviderError, ProviderTimeoutError
from .providers.jev import DISCOVERY_CAPABILITY, DiscoveryCandidate, JevProvider
from .service_types import UnknownProvider


class JevServiceMixin:
    async def rank_discovery(
        self,
        query: str,
        candidates: list[DiscoveryCandidate],
        *,
        granted_capabilities: list[str],
    ) -> list[str]:
        required = [DISCOVERY_CAPABILITY]
        self._check_required_capabilities(required, granted_capabilities)
        provider = self._providers.get("jev")
        if not isinstance(provider, JevProvider):
            raise UnknownProvider("Jev is not configured")
        if provider._client is None:
            provider._client = self._client
        opts = FetchOptions(total_timeout_s=4, connect_timeout_s=1, max_retries=0)
        started = time.perf_counter()
        error: Exception | None = None
        try:
            return await asyncio.wait_for(
                self._run_through_resilience(
                    provider,
                    opts,
                    lambda: provider.rank_discovery(query, candidates, opts),
                ),
                timeout=5,
            )
        except asyncio.TimeoutError as exc:
            error = ProviderTimeoutError("Jev ranking timed out")
            raise error from exc
        except asyncio.CancelledError:
            error = ProviderError("Jev ranking cancelled")
            raise
        except Exception as exc:
            error = exc
            raise
        finally:
            self._log_thin_call(
                provider=provider,
                endpoint=f"{provider.DEFAULT_BASE_URL}/v1/systemone",
                granted=granted_capabilities,
                workspace_id=None,
                latency_ms=int((time.perf_counter() - started) * 1000),
                status_code=200 if error is None else None,
                exc=error,
                required_capabilities=required,
                method="POST",
            )
