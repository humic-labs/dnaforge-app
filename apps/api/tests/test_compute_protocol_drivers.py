"""Reusable compute protocol drivers are selected by protocol, not provider id."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from src.compute.contract import (
    ComputeProviderError,
    CredentialScheme,
    JobState,
    OutputKind,
    ProviderCredential,
    ProviderJobRef,
    SubmitRequest,
)
from src.compute.http_job_binding import HttpJobBinding
from src.compute.json_schema import schema_problems
from src.compute.manifests import parse_manifest
from src.compute.nvcf_binding import NvcfBinding
from src.compute.rest_binding import RestProviderBinding
from src.compute.service import LEGACY_REST_BINDINGS, default_binding_factory

REPO_ROOT = Path(__file__).resolve().parents[3]
NVIDIA_MANIFEST = (
    REPO_ROOT
    / "packages"
    / "core"
    / "compute-endpoints"
    / "manifests"
    / "nvidia-nim.json"
)


def _manifest(*, provider_id: str = "acme-nvcf", result_codec: str = "raw-json"):
    raw = json.loads(NVIDIA_MANIFEST.read_text())
    raw.update(
        id=provider_id,
        displayName="Acme NVCF",
        summary="A second NVCF deployment used to prove protocol-based dispatch.",
        baseUrl="https://nvcf.example.test/v1",
        disclosure=(
            "This sends inputs to Acme NVCF under your own account. Acme NVCF bills that "
            "account; DNAForge does not charge for it."
        ),
    )
    raw["driver"]["resultCodec"] = result_codec
    raw["staticTools"] = [
        {
            "id": "predict",
            "displayName": "Prediction",
            "path": "/biology/acme/predict",
            "outputKind": "binary",
            "inputSchema": {
                "type": "object",
                "required": ["input"],
                "properties": {"input": {"type": "string", "minLength": 1}},
            },
        }
    ]
    raw["verify"] = {
        "method": "POST",
        "target": "/biology/acme/predict",
        "okStatuses": [422],
    }
    return parse_manifest(raw)


async def test_factory_selects_nvcf_by_driver_for_an_unregistered_provider_id():
    manifest = _manifest()
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"answer": 42})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        binding = default_binding_factory(manifest, rest_client=client)
        assert isinstance(binding, NvcfBinding)
        assert binding.provider_id == "acme-nvcf"
        assert "nvidia-nim" not in LEGACY_REST_BINDINGS

        credential = ProviderCredential(
            "acme-nvcf", CredentialScheme.BEARER, "secret-key"
        )
        ref = await binding.submit(
            credential, SubmitRequest("predict", {"input": "example"})
        )
        assert (await binding.status(credential, ref)).state is JobState.COMPLETED
        result = await binding.fetch_result(credential, ref)
        assert result.output_kind is OutputKind.BINARY
        assert result.files[0].name == "result.json"
        assert json.loads(result.files[0].content) == {"answer": 42}
        assert seen[-1].url.path == "/v1/biology/acme/predict"
    finally:
        await client.aclose()


async def test_generic_nvcf_202_request_id_survives_a_new_binding_instance():
    manifest = _manifest()
    polls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal polls
        if request.method == "POST":
            return httpx.Response(202, headers={"nvcf-reqid": "req-generic-nvcf-1"})
        polls += 1
        if polls == 1:
            return httpx.Response(202, headers={"nvcf-reqid": "req-generic-nvcf-1"})
        return httpx.Response(200, json={"answer": "finished"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        first = NvcfBinding(manifest, client=client, poll_seconds=1)
        credential = ProviderCredential(
            "acme-nvcf", CredentialScheme.BEARER, "secret-key"
        )
        ref = await first.submit(
            credential, SubmitRequest("predict", {"input": "example"})
        )
        assert ref.remote_id == "nvcf:req-generic-nvcf-1"

        restarted = NvcfBinding(manifest, client=client, poll_seconds=1)
        assert (await restarted.status(credential, ref)).state is JobState.RUNNING
        assert (await restarted.status(credential, ref)).state is JobState.COMPLETED
        result = await restarted.fetch_result(credential, ref)
        assert json.loads(result.files[0].content) == {"answer": "finished"}
    finally:
        await client.aclose()


def _http_job_manifest():
    raw = json.loads(NVIDIA_MANIFEST.read_text())
    raw.update(
        id="generic-http-jobs",
        displayName="Generic HTTP Jobs",
        summary="A declarative asynchronous HTTP job provider used by protocol tests.",
        baseUrl="https://jobs.example.test/v1",
        jobModel="async",
        cost="none",
        disclosure=(
            "This sends inputs to Generic HTTP Jobs under your own account. Generic HTTP Jobs "
            "bills that account when applicable; DNAForge does not charge for it."
        ),
    )
    raw["driver"] = {
        "kind": "http-job",
        "submit": {
            "method": "POST",
            "idPath": "id",
            "bodyTemplate": {"input": "$settings", "label": "$label"},
        },
        "status": {
            "method": "GET",
            "pathTemplate": "/jobs/{remote_id}",
            "statePath": "status",
            "statusMap": {
                "waiting": "queued",
                "working": "running",
                "succeeded": "completed",
                "failed": "failed",
                "canceled": "canceled",
            },
        },
        "result": {"payloadPath": "output", "codec": "raw-json"},
        "cancel": {"method": "POST", "pathTemplate": "/jobs/{remote_id}/cancel"},
    }
    raw["staticTools"] = [
        {
            "id": "predict",
            "displayName": "Prediction",
            "path": "/jobs",
            "outputKind": "binary",
            "inputSchema": {
                "type": "object",
                "required": ["value"],
                "properties": {"value": {"type": "string"}},
            },
        }
    ]
    raw["verify"] = {"method": "GET", "target": "/account", "expectKey": "id"}
    raw["cancellation"] = {
        "mode": "provider",
        "note": "Generic HTTP Jobs accepts remote cancellation.",
    }
    return parse_manifest(raw)


async def test_declarative_http_job_driver_runs_and_cancels_without_provider_code():
    manifest = _http_job_manifest()
    requests: list[httpx.Request] = []
    status_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal status_calls
        requests.append(request)
        if request.method == "POST" and request.url.path.endswith("/jobs"):
            assert json.loads(request.content) == {
                "input": {"value": "sample"},
                "label": "journey",
            }
            return httpx.Response(201, json={"id": "job-123", "status": "waiting"})
        if request.method == "GET" and request.url.path.endswith("/jobs/job-123"):
            status_calls += 1
            if status_calls == 1:
                return httpx.Response(200, json={"id": "job-123", "status": "working"})
            return httpx.Response(
                200,
                json={"id": "job-123", "status": "succeeded", "output": {"score": 0.9}},
            )
        if request.method == "POST" and request.url.path.endswith(
            "/jobs/job-123/cancel"
        ):
            return httpx.Response(200, json={"id": "job-123", "status": "canceled"})
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        binding = default_binding_factory(manifest, rest_client=client)
        assert isinstance(binding, HttpJobBinding)
        credential = ProviderCredential(
            "generic-http-jobs", CredentialScheme.BEARER, "secret-key"
        )
        ref = await binding.submit(
            credential,
            SubmitRequest("predict", {"value": "sample"}, label="journey"),
        )
        assert ref.remote_id == "job-123"
        assert (await binding.status(credential, ref)).state is JobState.RUNNING
        assert (await binding.status(credential, ref)).state is JobState.COMPLETED
        result = await binding.fetch_result(credential, ref)
        assert json.loads(result.files[0].content) == {"score": 0.9}
        assert (await binding.cancel(credential, ref)).state is JobState.CANCELED
    finally:
        await client.aclose()


@pytest.mark.parametrize("provider_state", ["failed", "canceled"])
async def test_http_job_does_not_import_cached_negative_terminal_payloads(
    provider_state,
):
    manifest = _http_job_manifest()
    ref = ProviderJobRef(manifest.id, "negative-job", "predict")
    credential = ProviderCredential(manifest.id, CredentialScheme.BEARER, "secret-key")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": ref.remote_id,
                "status": provider_state,
                "output": {"partial": True},
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        binding = HttpJobBinding(manifest, client=client)
        assert (await binding.status(credential, ref)).state is JobState(provider_state)
        with pytest.raises(ComputeProviderError, match="not completed"):
            await binding.fetch_result(credential, ref)


def test_rest_binding_refuses_absolute_and_scheme_relative_authenticated_targets():
    binding = RestProviderBinding(_http_job_manifest())
    for target in (
        "https://attacker.example/jobs",
        "//attacker.example/jobs",
        "/jobs#https://attacker.example",
        "jobs/without-a-leading-slash",
    ):
        with pytest.raises(
            ComputeProviderError, match="non-relative provider request target"
        ):
            binding._url(target)


def test_safe_json_schema_subset_enforces_upper_and_numeric_bounds():
    schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["name", "count", "items"],
        "properties": {
            "name": {"type": "string", "minLength": 2, "maxLength": 4},
            "count": {"type": "integer", "minimum": 1, "maximum": 3},
            "items": {"type": "array", "minItems": 1, "maxItems": 2},
        },
    }
    problems = schema_problems(
        {"name": "toolong", "count": 4, "items": [1, 2, 3], "unexpected": True}, schema
    )
    assert problems == [
        "settings.name: must contain at most 4 characters",
        "settings.count: must be at most 3",
        "settings.items: allows at most 2 items",
        "settings.unexpected: is not an allowed field",
    ]


def test_json_schema_runtime_never_evaluates_an_unsafe_pattern():
    assert schema_problems(
        "a" * 10_000 + "!", {"type": "string", "pattern": "^(a+)+$"}
    ) == ["settings: does not match the required format"]
