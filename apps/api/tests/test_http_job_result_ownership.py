import json
from pathlib import Path

import httpx
import pytest

from src.compute.contract import (
    ComputeProviderError,
    CredentialScheme,
    ProviderCredential,
    ProviderJobRef,
)
from src.compute.http_job_binding import HttpJobBinding
from src.compute.manifests import parse_manifest


async def test_completed_job_payload_does_not_cross_request_credential_ownership():
    manifest = parse_manifest(
        json.loads(
            (
                Path(__file__).parents[3]
                / "packages/core/compute-endpoints/manifests/replicate.json"
            ).read_text()
        )
    )
    first = ProviderCredential(manifest.id, CredentialScheme.BEARER, "fixture-a")
    replacement = ProviderCredential(manifest.id, CredentialScheme.BEARER, "fixture-b")
    ref = ProviderJobRef(manifest.id, "fixture-private-job", "prediction")
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.headers["authorization"])
        if request.headers["authorization"] != "Bearer fixture-a":
            return httpx.Response(
                403, json={"detail": "This credential cannot read this job"}
            )
        return httpx.Response(
            200,
            json={
                "id": ref.remote_id,
                "status": "succeeded",
                "output": {"result": "first-account-result"},
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        binding = HttpJobBinding(manifest, client=client)
        await binding.status(first, ref)
        with pytest.raises(ComputeProviderError):
            await binding.fetch_result(replacement, ref)
    assert requests == ["Bearer fixture-a", "Bearer fixture-b"]
