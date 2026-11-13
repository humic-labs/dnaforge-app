"""ComputeService — registry of provider bindings plus per-provider resilience .

Borrows the `external/` token bucket and circuit breaker; owns nothing about
jobs (the job registry is desktop-side SQLite, slice 5). Holds no credentials:
every call receives the user's `ProviderCredential` and forgets it.

Failure accounting for the breaker is deliberate: only provider-unavailable and
rate-limit failures count. A bad key, an exhausted budget, or invalid settings
are the caller's problem and must not trip the breaker for everyone else.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from functools import partial
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping, TypeVar

import httpx

from ..external.resilience import (
    DEFAULT_BREAKER_FAILURE_THRESHOLD,
    DEFAULT_BREAKER_RECOVERY_S,
    _CircuitBreaker,
    _TokenBucket,
)
from .contract import (
    ComputeOperation,
    ComputeProviderError,
    ComputeRateLimitError,
    CostEstimate,
    CredentialScheme,
    JobStatus,
    ProviderBinding,
    ProviderCredential,
    ProviderJobRef,
    ProviderUnavailableError,
    ResultBundle,
    SubmitRequest,
    ToolDescriptor,
    ValidationResult,
)
from .http_job_binding import HttpJobBinding
from .manifests import ProviderManifest, load_manifests
from .mcp_binding import McpProviderBinding
from .nvcf_binding import NvcfBinding
from .providers.boltz import BoltzBinding
from .providers.subseq import SubseqBinding

LEGACY_REST_BINDINGS: dict[str, Callable[..., ProviderBinding]] = {
    "boltz": BoltzBinding,
    "subseq": SubseqBinding,
}

REST_DRIVER_BINDINGS: dict[str, Callable[..., ProviderBinding]] = {
    "http-job": HttpJobBinding,
    "nvcf": NvcfBinding,
}

logger = logging.getLogger(__name__)

T = TypeVar("T")


class UnknownComputeProvider(KeyError):
    pass


class ComputeCircuitOpen(ComputeProviderError):
    failure_kind = "circuit_open"

    def __init__(self, provider_id: str, opens_at_s: float) -> None:
        super().__init__(
            f"{provider_id}: circuit open; retry in {opens_at_s:.0f}s", status_code=503
        )
        self.provider_id = provider_id
        self.opens_at_s = opens_at_s


@dataclass
class _ProviderRuntime:
    manifest: ProviderManifest
    binding: ProviderBinding
    bucket: _TokenBucket
    breaker: _CircuitBreaker = field(
        default_factory=lambda: _CircuitBreaker(
            failure_threshold=DEFAULT_BREAKER_FAILURE_THRESHOLD,
            recovery_timeout_s=DEFAULT_BREAKER_RECOVERY_S,
        )
    )


BindingFactory = Callable[[ProviderManifest], ProviderBinding | None]


def default_binding_factory(
    manifest: ProviderManifest,
    *,
    rest_client: httpx.AsyncClient | None = None,
) -> ProviderBinding | None:
    if manifest.driver_kind == "mcp-tool-map":
        return McpProviderBinding(manifest)
    factory = REST_DRIVER_BINDINGS.get(manifest.driver_kind)
    if factory is not None:
        return factory(manifest, client=rest_client)
    factory = LEGACY_REST_BINDINGS.get(manifest.id)
    return factory(manifest, client=rest_client) if factory else None


class ComputeService:
    def __init__(
        self,
        manifests: Mapping[str, ProviderManifest],
        *,
        binding_factory: BindingFactory = default_binding_factory,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._manifests = dict(manifests)
        self._runtimes: dict[str, _ProviderRuntime] = {}
        self._sleep = sleep
        for provider_id, manifest in self._manifests.items():
            binding = binding_factory(manifest)
            if binding is None:
                logger.info(
                    "compute: provider %s listed without a binding (transport=%s)",
                    provider_id,
                    manifest.transport,
                )
                continue
            self._runtimes[provider_id] = _ProviderRuntime(
                manifest=manifest,
                binding=binding,
                bucket=_TokenBucket(
                    capacity=max(1.0, manifest.rate_limit_rps),
                    refill_rate_per_s=manifest.rate_limit_rps,
                ),
            )

    @classmethod
    def from_manifest_dir(
        cls,
        directory: Path | None = None,
        *,
        rest_client: httpx.AsyncClient | None = None,
        **kwargs: Any,
    ) -> "ComputeService":
        if rest_client is not None and "binding_factory" not in kwargs:
            kwargs["binding_factory"] = partial(
                default_binding_factory, rest_client=rest_client
            )
        return cls(load_manifests(directory), **kwargs)

    def manifests(self) -> list[ProviderManifest]:
        return list(self._manifests.values())

    def manifest(self, provider_id: str) -> ProviderManifest:
        try:
            return self._manifests[provider_id]
        except KeyError as exc:
            raise UnknownComputeProvider(provider_id) from exc

    def has_binding(self, provider_id: str) -> bool:
        return provider_id in self._runtimes

    def register_binding(
        self, binding: ProviderBinding, manifest: ProviderManifest | None = None
    ) -> None:
        """Test/extension seam: install a binding for a manifest id."""
        manifest = manifest or self.manifest(binding.provider_id)
        self._manifests[manifest.id] = manifest
        self._runtimes[manifest.id] = _ProviderRuntime(
            manifest=manifest,
            binding=binding,
            bucket=_TokenBucket(
                capacity=max(1.0, manifest.rate_limit_rps),
                refill_rate_per_s=manifest.rate_limit_rps,
            ),
        )

    def credential_for(self, provider_id: str, secret: str) -> ProviderCredential:
        manifest = self.manifest(provider_id)
        return ProviderCredential(
            provider_id=provider_id,
            scheme=CredentialScheme(manifest.auth_scheme),
            secret=secret,
            header_name=manifest.auth_header_name,
        )

    def _runtime(self, provider_id: str) -> _ProviderRuntime:
        if provider_id not in self._manifests:
            raise UnknownComputeProvider(provider_id)
        runtime = self._runtimes.get(provider_id)
        if runtime is None:
            raise ProviderUnavailableError(
                f"{provider_id}: no binding available for transport {self._manifests[provider_id].transport!r}"
            )
        return runtime

    async def _guarded(
        self,
        provider_id: str,
        operation: ComputeOperation,
        fn: Callable[[ProviderBinding], Awaitable[T]],
    ) -> T:
        runtime = self._runtime(provider_id)
        permit = runtime.breaker.try_acquire()
        if permit is None:
            raise ComputeCircuitOpen(provider_id, runtime.breaker.opens_at_s())
        try:
            wait_s = runtime.bucket.take()
            if wait_s > 0:
                await self._sleep(wait_s)
            try:
                result = await fn(runtime.binding)
            except (ProviderUnavailableError, ComputeRateLimitError) as exc:
                runtime.breaker.record_failure(permit)
                logger.warning(
                    "compute.%s.%s failed (%s)",
                    provider_id,
                    operation.value,
                    exc.failure_kind,
                )
                raise
            except ComputeProviderError as exc:
                logger.info(
                    "compute.%s.%s rejected (%s)",
                    provider_id,
                    operation.value,
                    exc.failure_kind,
                )
                raise
            runtime.breaker.record_success(permit)
            return result
        finally:
            runtime.breaker.release(permit)

    async def list_tools(
        self,
        provider_id: str,
        credential: ProviderCredential,
        *,
        search: str | None = None,
        tags: tuple[str, ...] = (),
    ) -> list[ToolDescriptor]:
        return await self._guarded(
            provider_id,
            ComputeOperation.LIST_TOOLS,
            lambda b: b.list_tools(credential, search=search, tags=tags),
        )

    async def get_schema(
        self, provider_id: str, credential: ProviderCredential, tool_id: str
    ) -> Mapping[str, Any]:
        return await self._guarded(
            provider_id,
            ComputeOperation.GET_SCHEMA,
            lambda b: b.get_schema(credential, tool_id),
        )

    async def validate(
        self,
        provider_id: str,
        credential: ProviderCredential,
        tool_id: str,
        settings: Mapping[str, Any],
    ) -> ValidationResult:
        return await self._guarded(
            provider_id,
            ComputeOperation.VALIDATE,
            lambda b: b.validate(credential, tool_id, settings),
        )

    async def estimate(
        self,
        provider_id: str,
        credential: ProviderCredential,
        tool_id: str,
        settings: Mapping[str, Any],
    ) -> CostEstimate:
        return await self._guarded(
            provider_id,
            ComputeOperation.ESTIMATE,
            lambda b: b.estimate(credential, tool_id, settings),
        )

    async def submit(
        self, provider_id: str, credential: ProviderCredential, request: SubmitRequest
    ) -> ProviderJobRef:
        return await self._guarded(
            provider_id,
            ComputeOperation.SUBMIT,
            lambda b: b.submit(credential, request),
        )

    async def status(
        self, provider_id: str, credential: ProviderCredential, ref: ProviderJobRef
    ) -> JobStatus:
        return await self._guarded(
            provider_id, ComputeOperation.STATUS, lambda b: b.status(credential, ref)
        )

    async def fetch_result(
        self, provider_id: str, credential: ProviderCredential, ref: ProviderJobRef
    ) -> ResultBundle:
        return await self._guarded(
            provider_id,
            ComputeOperation.FETCH_RESULT,
            lambda b: b.fetch_result(credential, ref),
        )

    async def cancel(
        self, provider_id: str, credential: ProviderCredential, ref: ProviderJobRef
    ) -> JobStatus:
        return await self._guarded(
            provider_id, ComputeOperation.CANCEL, lambda b: b.cancel(credential, ref)
        )

    async def verify_credential(
        self, provider_id: str, credential: ProviderCredential
    ) -> list[ToolDescriptor]:
        """Connect-time check. Runs the binding's manifest-driven verify call, which
        requires auth and never spends, then lists tools for the count. Listing
        alone is not proof: a public or static catalog answers any key."""
        runtime = self._runtime(provider_id)
        if callable(getattr(runtime.binding, "verify_credential", None)):
            await self._guarded(
                provider_id,
                ComputeOperation.LIST_TOOLS,
                lambda b: b.verify_credential(credential),  # type: ignore[attr-defined]
            )
        return await self.list_tools(provider_id, credential)


__all__ = [
    "ComputeCircuitOpen",
    "ComputeService",
    "LEGACY_REST_BINDINGS",
    "REST_DRIVER_BINDINGS",
    "UnknownComputeProvider",
    "default_binding_factory",
]
