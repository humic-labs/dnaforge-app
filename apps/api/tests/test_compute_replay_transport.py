"""Compute providers use the acceptance replay transport when one is supplied."""

from pathlib import Path

import httpx

from src.compute.service import ComputeService

REPO_ROOT = Path(__file__).resolve().parents[3]
MANIFESTS = REPO_ROOT / "packages" / "core" / "compute-endpoints" / "manifests"


async def test_manifest_service_injects_the_shared_client_into_rest_bindings():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"principal_type": "workspace"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        service = ComputeService.from_manifest_dir(MANIFESTS, rest_client=client)
        await service.verify_credential(
            "boltz",
            service.credential_for("boltz", "sk_bc_acceptance_replay"),
        )
    finally:
        await client.aclose()

    assert [
        (request.method, request.url.host, request.url.path) for request in requests
    ] == [("GET", "api.boltz.bio", "/compute/v1/auth/me")]
