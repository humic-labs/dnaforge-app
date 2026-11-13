"""Boltz hosted API binding. Shapes are the official `boltz-api` 0.50.0 SDK types and
the live unauthenticated 401 body (2026-09-10); no network."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from src.compute.contract import (
    BadCredentialError,
    BudgetExhaustedError,
    ComputeProviderError,
    ComputeRateLimitError,
    CredentialScheme,
    InvalidJobSettingsError,
    JobState,
    OutputKind,
    ProviderBinding,
    ProviderCredential,
    ProviderJobRef,
    ProviderUnavailableError,
    SubmitRequest,
    UnknownJobError,
)
from src.compute.manifests import load_manifests
from src.compute.providers.boltz import MODEL, PREDICTIONS_PATH, BoltzBinding
from src.compute.service import ComputeService

REPO_ROOT = Path(__file__).resolve().parents[3]
MANIFESTS = REPO_ROOT / "packages" / "core" / "compute-endpoints" / "manifests"
BZ_KEY = "boltz-test"
RESULTS_HOST = "results.storage.example"
JOB_ID = "sab_pred_2X7Ab9Cd3Ef6Gh1JkLmN"
CIF = "data_model\nloop_\n_atom_site.group_PDB\n_atom_site.id\n_atom_site.type_symbol\n_atom_site.label_atom_id\nATOM 1 N N\nATOM 2 C CA\n"
METRICS = {
    "complex_ipde": 0.0,
    "complex_iplddt": 0.93,
    "complex_pde": 0.32,
    "complex_plddt": 0.93,
    "iptm": 0.0,
    "ligand_iptm": 0.0,
    "protein_iptm": 0.0,
    "ptm": 0.92,
    "structure_confidence": 0.75,
}


def _cred(secret: str = BZ_KEY) -> ProviderCredential:
    return ProviderCredential(
        "boltz", CredentialScheme.HEADER, secret, header_name="x-api-key"
    )


class BoltzFake:
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.jobs: dict[str, dict] = {}
        self.script = ["pending", "running", "succeeded"]
        self.force: list[httpx.Response] = []
        self.samples = 1
        self.download_status = 200

    def _job(self, job_id: str, status: str, body: dict) -> dict:
        job = {
            "id": job_id,
            "status": status,
            "model": MODEL,
            "livemode": False,
            "created_at": "2026-09-10T17:00:00Z",
            "version": "2.1.0",
            "workspace_id": "ws_123",
            "idempotency_key": body.get("idempotency_key"),
            "error": None,
            "output": None,
            "data_deleted_at": None,
        }
        if status == "succeeded":
            sample = {
                "metrics": METRICS,
                "structure": {
                    "url": f"https://{RESULTS_HOST}/{job_id}/sample_0.cif?X-Goog-Signature=abc",
                    "url_expires_at": "2026-09-10T18:00:00Z",
                },
            }
            job["output"] = {
                "best_sample": sample,
                "all_sample_results": [sample] * self.samples,
                "archive": {
                    "url": f"https://{RESULTS_HOST}/{job_id}.tar.gz",
                    "url_expires_at": "2026-09-10T18:00:00Z",
                },
                "binding_metrics": None,
            }
        return job

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.host == RESULTS_HOST:
            if "x-api-key" in request.headers:
                return httpx.Response(400, text="credential sent to storage host")
            if self.download_status != 200:
                return httpx.Response(self.download_status, text="Request has expired")
            return httpx.Response(200, content=CIF.encode())
        if self.force:
            return self.force.pop(0)
        if request.headers.get("x-api-key") != BZ_KEY:
            return httpx.Response(
                401,
                json={"code": "unauthorized", "message": "Invalid or missing API key"},
            )
        path = request.url.path
        if path == "/compute/v1/auth/me":
            return httpx.Response(
                200,
                json={
                    "api_key_id": "key_1",
                    "key_type": "workspace",
                    "mode": "test",
                    "organization_id": "org_1",
                    "principal_type": "api_key",
                    "selected_organization_id": "org_1",
                    "workspace_id": "ws_123",
                },
            )
        body = json.loads(request.content) if request.content else {}
        if path == f"{PREDICTIONS_PATH}/estimate-cost":
            if not body.get("input", {}).get("entities"):
                return httpx.Response(
                    400,
                    json={
                        "code": "invalid_request",
                        "message": "input.entities: Field required",
                    },
                )
            return httpx.Response(
                200,
                json={
                    "breakdown": {
                        "application": "structure_and_binding",
                        "cost_per_unit_usd": "0.025",
                        "num_units": 1,
                    },
                    "disclaimer": "Final billing is based on the exact compute measured at run time.",
                    "estimated_cost_usd": "0.025",
                },
            )
        if path == PREDICTIONS_PATH and request.method == "POST":
            self.jobs[JOB_ID] = body
            return httpx.Response(200, json=self._job(JOB_ID, "pending", body))
        if path.startswith(f"{PREDICTIONS_PATH}/") and request.method == "GET":
            job_id = path.rsplit("/", 1)[-1]
            if job_id not in self.jobs:
                return httpx.Response(
                    404, json={"code": "not_found", "message": "Prediction not found"}
                )
            status = self.script.pop(0) if len(self.script) > 1 else self.script[0]
            return httpx.Response(
                200, json=self._job(job_id, status, self.jobs[job_id])
            )
        return httpx.Response(404, json={"code": "not_found", "message": "no route"})


@pytest.fixture
def boltz():
    fake = BoltzFake()
    binding = BoltzBinding(
        load_manifests(MANIFESTS)["boltz"],
        client=httpx.AsyncClient(transport=httpx.MockTransport(fake)),
        retry_delay_s=0,
    )
    return fake, binding


async def test_boltz_is_a_bound_protocol_provider(boltz):
    _fake, binding = boltz
    assert isinstance(binding, ProviderBinding)
    service = ComputeService.from_manifest_dir(MANIFESTS)
    assert service.has_binding("boltz")
    assert service.credential_for("boltz", "k").header_name == "x-api-key"


async def test_boltz_verify_uses_auth_me_and_rejects_a_wrong_key(boltz):
    fake, binding = boltz
    with pytest.raises(BadCredentialError):
        await binding.verify_credential(_cred("sk_bc_ws_live_wrong"))
    await binding.verify_credential(_cred())
    assert fake.requests[-1].url.path == "/compute/v1/auth/me"
    assert fake.requests[-1].headers["x-api-key"] == BZ_KEY


async def test_boltz_schema_validation_and_sequence_shortcut(boltz):
    _fake, binding = boltz
    assert [t.id for t in await binding.list_tools(_cred(), search="structure")] == [
        "boltz-2"
    ]
    schema = await binding.get_schema(_cred(), "boltz-2")
    assert "entities" in schema["properties"] and "sequence" in schema["properties"]
    empty = await binding.validate(_cred(), "boltz-2", {})
    assert empty.ok is False and empty.problems[0].startswith("entities: required")
    assert (await binding.validate(_cred(), "boltz-2", {"sequence": "MKT VLA"})).ok
    bad = await binding.validate(
        _cred(),
        "boltz-2",
        {
            "entities": [{"type": "peptide", "value": "", "chain_ids": []}],
            "num_samples": 11,
        },
    )
    assert bad.problems == (
        "entities[0].type: must be one of protein, dna, rna, ligand_smiles, ligand_ccd",
        "entities[0].value: required",
        'entities[0].chain_ids: required, e.g. ["A"]',
        "num_samples: must be an integer from 1 to 10",
    )
    with pytest.raises(InvalidJobSettingsError):
        await binding.get_schema(_cred(), "nope")


async def test_boltz_estimate_uses_the_no_gpu_endpoint(boltz):
    fake, binding = boltz
    est = await binding.estimate(_cred(), "boltz-2", {"sequence": "MKT"})
    assert est.amount == 0.025 and est.unit == "USD" and "measured" in est.note
    assert json.loads(fake.requests[-1].content) == {
        "model": "boltz-2.1",
        "input": {
            "entities": [{"type": "protein", "value": "MKT", "chain_ids": ["A"]}]
        },
    }
    with pytest.raises(InvalidJobSettingsError):
        await binding.estimate(_cred(), "boltz-2", {})


async def test_boltz_lifecycle_downloads_the_structure_without_the_key(boltz):
    fake, binding = boltz
    ref = await binding.submit(
        _cred(),
        SubmitRequest(
            "boltz-2",
            {"sequence": "MKT", "num_samples": 1},
            idempotency_key="dnaforge-abc",
        ),
    )
    assert ref.remote_id == JOB_ID
    submitted = json.loads(fake.requests[-1].content)
    assert submitted["idempotency_key"] == "dnaforge-abc"
    assert submitted["input"]["num_samples"] == 1

    states = [(await binding.status(_cred(), ref)) for _ in range(3)]
    assert [s.state for s in states] == [
        JobState.QUEUED,
        JobState.RUNNING,
        JobState.COMPLETED,
    ]
    assert "Test-mode key" in states[-1].progress_note

    bundle = await binding.fetch_result(_cred(), ref)
    assert bundle.output_kind is OutputKind.STRUCTURE
    assert [f.name for f in bundle.files] == [f"{JOB_ID}_best.cif"]
    assert (bundle.files[0].content or b"").startswith(b"data_")
    download = next(r for r in fake.requests if r.url.host == RESULTS_HOST)
    assert "x-api-key" not in download.headers
    assert bundle.metrics["ptm"] == 0.92 and None not in bundle.metrics.values()
    assert (
        bundle.provenance["livemode"] == "false"
        and bundle.provenance["model"] == "boltz-2.1"
    )
    assert all(f.url is None for f in bundle.files)


async def test_boltz_multiple_samples_each_become_a_file(boltz):
    fake, binding = boltz
    fake.samples = 3
    fake.script = ["succeeded"]
    ref = await binding.submit(
        _cred(), SubmitRequest("boltz-2", {"sequence": "MKT", "num_samples": 3})
    )
    bundle = await binding.fetch_result(_cred(), ref)
    assert [f.name for f in bundle.files] == [
        f"{JOB_ID}_best.cif",
        f"{JOB_ID}_sample_1.cif",
        f"{JOB_ID}_sample_2.cif",
        f"{JOB_ID}_sample_3.cif",
    ]


async def test_boltz_error_mapping(boltz):
    fake, binding = boltz
    with pytest.raises(UnknownJobError):
        await binding.status(
            _cred(), ProviderJobRef("boltz", "sab_pred_missing", "boltz-2")
        )
    fake.force.append(
        httpx.Response(
            429,
            headers={"Retry-After": "4"},
            json={"code": "rate_limited", "message": "slow down"},
        )
    )
    with pytest.raises(ComputeRateLimitError) as info:
        await binding.submit(_cred(), SubmitRequest("boltz-2", {"sequence": "MKT"}))
    assert info.value.retry_after_s == 4.0
    fake.force.append(
        httpx.Response(
            403,
            json={
                "code": "spending_limit_exceeded",
                "message": "Workspace spending limit reached",
            },
        )
    )
    with pytest.raises(BudgetExhaustedError):
        await binding.submit(_cred(), SubmitRequest("boltz-2", {"sequence": "MKT"}))
    fake.force.append(httpx.Response(503))
    with pytest.raises(ProviderUnavailableError):
        await binding.submit(_cred(), SubmitRequest("boltz-2", {"sequence": "MKT"}))
    fake.force.append(httpx.Response(503))
    ref = await binding.submit(
        _cred(), SubmitRequest("boltz-2", {"sequence": "MKT"}, idempotency_key="k1")
    )
    with pytest.raises(ComputeProviderError, match="cannot cancel"):
        await binding.cancel(_cred(), ref)


async def test_boltz_unfinished_or_expired_results_are_reported(boltz):
    fake, binding = boltz
    ref = await binding.submit(_cred(), SubmitRequest("boltz-2", {"sequence": "MKT"}))
    fake.script = ["running"]
    with pytest.raises(ProviderUnavailableError, match="not finished"):
        await binding.fetch_result(_cred(), ref)
    fake.script = ["succeeded"]
    fake.download_status = 403
    with pytest.raises(ProviderUnavailableError, match="expired"):
        await binding.fetch_result(_cred(), ref)
