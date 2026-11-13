"""A successful HTTP cancel response is not proof that remote work stopped."""

import json
from pathlib import Path

import httpx
import pytest

from src.compute.contract import (
    CredentialScheme,
    JobState,
    ProviderCredential,
    ProviderJobRef,
    ProviderUnavailableError,
)
from src.compute.http_job_binding import HttpJobBinding
from src.compute.manifests import parse_manifest


@pytest.mark.parametrize("provider_state", ["processing", "succeeded", "canceled"])
async def test_empty_cancel_ack_requires_provider_status_confirmation(provider_state):
    manifest_path = (
        Path(__file__).parents[3]
        / "packages/core/compute-endpoints/manifests/replicate.json"
    )
    manifest = parse_manifest(json.loads(manifest_path.read_text()))
    credential = ProviderCredential(manifest.id, CredentialScheme.BEARER, "test-key")
    ref = ProviderJobRef(manifest.id, "cancel-confirmation", "prediction")
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.method)
        if request.method == "POST":
            return httpx.Response(204)
        return httpx.Response(200, json={"id": ref.remote_id, "status": provider_state})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        binding = HttpJobBinding(manifest, client=client)
        if provider_state == "canceled":
            assert (await binding.cancel(credential, ref)).state is JobState.CANCELED
        else:
            with pytest.raises(ProviderUnavailableError, match="not acknowledged"):
                await binding.cancel(credential, ref)
    assert requests == ["POST", "GET"]
