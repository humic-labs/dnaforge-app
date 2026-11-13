from __future__ import annotations

import asyncio
from types import SimpleNamespace

import httpx
import pytest

from src.external.contract import FetchOptions, ProviderTimeoutError
from src.external.resilience import _CircuitBreaker
from src.external.service import CircuitOpen, ExternalResourcesService


@pytest.mark.parametrize("origin", ["rcsb", "alphafold"])
async def test_late_structure_response_cannot_close_newer_cooldown(origin, monkeypatch):
    monkeypatch.setattr("src.external.resilience.time.monotonic", lambda: 100.0)
    started = asyncio.Event()
    finish = asyncio.Event()

    async def handler(request):
        started.set()
        await finish.wait()
        if origin == "rcsb":
            return httpx.Response(
                200, content=b"\xff\xd8fixture", headers={"Content-Type": "image/jpeg"}
            )
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service = ExternalResourcesService(
            None, client=client, rate_limit_per_s=1000, rate_limit_burst=1000
        )
        service._breakers[origin] = _CircuitBreaker(failure_threshold=2)
        opts = FetchOptions(max_retries=0)
        if origin == "rcsb":
            operation = service.fetch_rcsb_poster(
                pdb_id="1RBL",
                poster_kind="assembly-1",
                granted_capabilities=["external-fetch:structure"],
                opts=opts,
            )
        else:
            operation = service.validate_afdb_exists(
                "P12345",
                granted_capabilities=["external-fetch:annotation"],
                opts=opts,
            )
        pending = asyncio.create_task(operation)
        await started.wait()

        async def unavailable():
            raise ProviderTimeoutError("provider unavailable")

        async def fail():
            await service._run_through_resilience(
                SimpleNamespace(provider_id=origin), opts, unavailable
            )

        try:
            for _ in range(2):
                with pytest.raises(ProviderTimeoutError):
                    await fail()
        finally:
            finish.set()
            await pending
        with pytest.raises(CircuitOpen):
            await fail()
        await service.aclose()
