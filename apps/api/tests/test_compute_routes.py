""" — `/compute/*` routes: session gate, capability split, credential
header handling, error mapping, no secret in logs. Uses a scripted fake binding
(the MCP client path is covered by test_compute_mcp_binding.py).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.compute.contract import (
    BadCredentialError,
    BudgetExhaustedError,
    ComputeOperation,
    ComputeRateLimitError,
    CostEstimate,
    JobState,
    JobStatus,
    MappedToolMissingError,
    OutputKind,
    ProviderJobRef,
    ProviderUnavailableError,
    ResultBundle,
    ResultFile,
    SubmitRequest,
    ToolDescriptor,
    ValidationResult,
)
from src.compute.manifests import load_manifests
from src.compute.service import ComputeService
from src.routes import compute as compute_routes

REPO_ROOT = Path(__file__).resolve().parents[3]
MANIFESTS = REPO_ROOT / "packages" / "core" / "compute-endpoints" / "manifests"
TOKEN = "test-mcp-session"
SECRET = "tmr-route-test-SECRETVALUE"
DISCOVER = "external-compute:discover"
SUBMIT = "external-compute:submit"
MANAGE = "external-compute:manage"


class ScriptedBinding:
    provider_id = "tamarind"

    def __init__(self) -> None:
        self.fail_with: Exception | None = None
        self.seen_secrets: list[str] = []
        self.submits: list[SubmitRequest] = []

    def _maybe_fail(self, credential) -> None:
        self.seen_secrets.append(credential.secret)
        if self.fail_with is not None:
            exc, self.fail_with = self.fail_with, None
            raise exc

    async def list_tools(self, credential, *, search=None, tags=()):
        self._maybe_fail(credential)
        return [
            ToolDescriptor(
                "alphafold", "AlphaFold2", "AF2", ("protein",), OutputKind.STRUCTURE
            )
        ]

    async def get_schema(self, credential, tool_id):
        self._maybe_fail(credential)
        return {"type": "object", "properties": {"sequence": {"type": "string"}}}

    async def validate(self, credential, tool_id, settings):
        self._maybe_fail(credential)
        return ValidationResult(
            ok=bool(settings.get("sequence")),
            problems=() if settings.get("sequence") else ("sequence: required",),
        )

    async def estimate(self, credential, tool_id, settings):
        self._maybe_fail(credential)
        return CostEstimate(amount=0.4, unit="weighted_hours", estimated_seconds=90.0)

    async def submit(self, credential, request):
        self._maybe_fail(credential)
        self.submits.append(request)
        return ProviderJobRef("tamarind", request.label or "job-1", request.tool_id)

    async def status(self, credential, ref):
        self._maybe_fail(credential)
        return JobStatus(ref, JobState.RUNNING, provider_state="Running")

    async def fetch_result(self, credential, ref):
        self._maybe_fail(credential)
        return ResultBundle(
            ref,
            OutputKind.STRUCTURE,
            (ResultFile("m.pdb", content=b"ATOM\nEND\n", media_type="chemical/x-pdb"),),
            {"plddt": 88.0},
            {"provider": "tamarind"},
        )

    async def cancel(self, credential, ref):
        self._maybe_fail(credential)
        return JobStatus(ref, JobState.CANCELED, provider_state="Stopped")


@pytest.fixture(autouse=True)
def _session_env(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TOKEN)
    monkeypatch.setenv(
        "DNAFORGE_MCP_GRANT_CAPABILITIES", f"{DISCOVER},{SUBMIT},{MANAGE}"
    )
    yield
    compute_routes.set_service(None)


@pytest.fixture
def scripted() -> ScriptedBinding:
    return ScriptedBinding()


@pytest.fixture
def client(scripted) -> TestClient:
    manifests = load_manifests(MANIFESTS)
    service = ComputeService(manifests, binding_factory=lambda _m: None)
    service.register_binding(scripted, manifests["tamarind"])
    compute_routes.set_service(service)
    app = FastAPI()
    app.include_router(compute_routes.router)
    return TestClient(app, headers={"X-DNAForge-Session": TOKEN})


def _hdr(secret: str | None = SECRET) -> dict[str, str]:
    return {compute_routes.CREDENTIAL_HEADER: secret} if secret is not None else {}


def _body(caps: list[str], **extra: Any) -> dict[str, Any]:
    return {"granted_capabilities": caps, **extra}


def test_providers_lists_manifests_without_secrets_and_marks_bindings(client):
    r = client.get("/compute/providers")
    assert r.status_code == 200
    providers = {p["id"]: p for p in r.json()["providers"]}
    assert set(providers) == {"tamarind", "boltz", "nvidia-nim", "subseq", "replicate"}
    assert providers["tamarind"]["has_binding"] is True
    assert providers["nvidia-nim"]["has_binding"] is False
    assert providers["tamarind"]["auth_scheme"] == "header"
    assert providers["nvidia-nim"]["driver"] == "nvcf"
    assert providers["replicate"]["driver"] == "http-job"
    assert providers["replicate"]["custom"] is False
    assert "not yet live-qualified" in providers["replicate"]["summary"]
    assert "not required to use Jobs" in providers["replicate"]["summary"]
    assert providers["tamarind"]["cancellation_mode"] == "provider"
    assert providers["boltz"]["cancellation_mode"] == "unavailable"
    assert "cancel" in providers["boltz"]["cancellation_note"].lower()
    assert "bill" in providers["tamarind"]["disclosure"].lower()
    assert SECRET not in r.text and "toolMap" not in r.text
    assert all(p["summary"] for p in r.json()["providers"])


def test_validates_a_safe_custom_manifest_without_installing_it(client):
    import json

    raw = json.loads((MANIFESTS / "replicate.json").read_text())
    raw.update(
        id="lab-predictions",
        displayName="Lab Predictions",
        baseUrl="https://jobs.example.test/v1",
        disclosure=(
            "This sends inputs to Lab Predictions under your own account. Lab Predictions "
            "bills that account; DNAForge does not charge for it."
        ),
    )
    response = client.post(
        "/compute/providers/validate-manifest",
        json=_body([DISCOVER], manifest=raw),
    )
    assert response.status_code == 200
    assert response.json()["id"] == "lab-predictions"
    assert response.json()["driver"] == "http-job"
    assert response.json()["custom"] is True
    assert response.json()["has_binding"] is True
    assert "lab-predictions" not in {
        provider["id"]
        for provider in client.get("/compute/providers").json()["providers"]
    }

    raw["id"] = "replicate"
    duplicate = client.post(
        "/compute/providers/validate-manifest",
        json=_body([DISCOVER], manifest=raw),
    )
    assert duplicate.status_code == 409


def test_no_session_grant_means_everything_is_denied(client, monkeypatch):
    monkeypatch.delenv("DNAFORGE_MCP_GRANT_CAPABILITIES", raising=False)
    r = client.post("/compute/tamarind/tools", json=_body([DISCOVER]), headers=_hdr())
    assert r.status_code == 403 and r.json()["detail"]["granted"] == []


def test_session_gate_blocks_unauthenticated_callers(client):
    bare = TestClient(client.app)
    assert bare.get("/compute/providers").status_code == 401
    assert (
        bare.post(
            "/compute/tamarind/tools", json=_body([DISCOVER]), headers=_hdr()
        ).status_code
        == 401
    )


def test_discovery_requires_discover_scope_only(client):
    ok = client.post("/compute/tamarind/tools", json=_body([DISCOVER]), headers=_hdr())
    assert ok.status_code == 200 and ok.json()["tools"][0]["id"] == "alphafold"
    denied = client.post(
        "/compute/tamarind/tools", json=_body(["read-workspace"]), headers=_hdr()
    )
    assert denied.status_code == 403 and denied.json()["detail"]["required"] == [
        DISCOVER
    ]


def test_submit_requires_submit_scope_and_discover_is_not_enough(client, scripted):
    body = _body(
        [DISCOVER], tool_id="alphafold", settings={"sequence": "MKT"}, label="j1"
    )
    denied = client.post("/compute/tamarind/submit", json=body, headers=_hdr())
    assert denied.status_code == 403 and denied.json()["detail"]["required"] == [SUBMIT]
    assert scripted.submits == []
    ok = client.post(
        "/compute/tamarind/submit",
        json=_body(
            [SUBMIT], tool_id="alphafold", settings={"sequence": "MKT"}, label="j1"
        ),
        headers=_hdr(),
    )
    assert ok.status_code == 200 and ok.json() == {
        "provider": "tamarind",
        "remote_id": "j1",
        "tool_id": "alphafold",
        "artifact_refs": [],
    }
    assert scripted.submits[0].settings == {"sequence": "MKT"}


def test_session_grant_clamps_requested_scopes(client, monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", DISCOVER)
    assert (
        client.post(
            "/compute/tamarind/tools", json=_body([DISCOVER]), headers=_hdr()
        ).status_code
        == 200
    )
    denied = client.post(
        "/compute/tamarind/submit",
        json=_body([SUBMIT], tool_id="alphafold", settings={"sequence": "MKT"}),
        headers=_hdr(),
    )
    assert denied.status_code == 403


def test_missing_credential_is_401_and_names_the_header(client, scripted):
    r = client.post("/compute/tamarind/tools", json=_body([DISCOVER]))
    assert r.status_code == 401
    assert r.json()["detail"] == {
        "error": "missing_credential",
        "provider": "tamarind",
        "header": compute_routes.CREDENTIAL_HEADER,
    }
    assert scripted.seen_secrets == []


def test_credential_reaches_binding_with_manifest_scheme(client, scripted):
    client.post(
        "/compute/tamarind/tools",
        json=_body([DISCOVER]),
        headers=_hdr("  " + SECRET + " "),
    )
    assert scripted.seen_secrets == [SECRET]


def test_unknown_provider_is_404(client):
    r = client.post("/compute/nope/tools", json=_body([DISCOVER]), headers=_hdr())
    assert r.status_code == 404 and r.json()["detail"]["error"] == "unknown_provider"


def test_provider_without_binding_is_503(client):
    r = client.post("/compute/nvidia-nim/tools", json=_body([DISCOVER]), headers=_hdr())
    assert (
        r.status_code == 503 and r.json()["detail"]["error"] == "provider_unavailable"
    )


def test_schema_validate_estimate_status_result_cancel(client):
    s = client.post(
        "/compute/tamarind/schema",
        json=_body([DISCOVER], tool_id="alphafold"),
        headers=_hdr(),
    )
    assert s.status_code == 200 and s.json()["schema"]["type"] == "object"
    v = client.post(
        "/compute/tamarind/validate",
        json=_body([DISCOVER], tool_id="alphafold", settings={}),
        headers=_hdr(),
    )
    assert v.json() == {
        "provider": "tamarind",
        "tool_id": "alphafold",
        "ok": False,
        "problems": ["sequence: required"],
    }
    e = client.post(
        "/compute/tamarind/estimate",
        json=_body([DISCOVER], tool_id="alphafold", settings={"sequence": "M"}),
        headers=_hdr(),
    )
    assert (
        e.json()["known"] is True
        and e.json()["amount"] == 0.4
        and e.json()["unit"] == "weighted_hours"
    )
    st = client.post(
        "/compute/tamarind/status",
        json=_body([DISCOVER], remote_id="j1", tool_id="alphafold"),
        headers=_hdr(),
    )
    assert st.json()["state"] == "running" and st.json()["terminal"] is False
    res = client.post(
        "/compute/tamarind/result",
        json=_body([DISCOVER], remote_id="j1", tool_id="alphafold"),
        headers=_hdr(),
    )
    assert res.json()["output_kind"] == "structure"
    assert res.json()["files"][0]["content"].startswith("ATOM")
    assert res.json()["metrics"] == {"plddt": 88.0}
    refused = client.post(
        "/compute/tamarind/cancel",
        json=_body([DISCOVER], remote_id="j1", tool_id="alphafold"),
        headers=_hdr(),
    )
    assert refused.status_code == 403
    assert refused.json()["detail"]["required"] == [MANAGE]
    c = client.post(
        "/compute/tamarind/cancel",
        json=_body([DISCOVER, MANAGE], remote_id="j1", tool_id="alphafold"),
        headers=_hdr(),
    )
    assert c.json()["state"] == "canceled" and c.json()["terminal"] is True


def test_verify_is_read_only_and_reports_tool_count(client, scripted):
    r = client.post("/compute/tamarind/verify", json=_body([DISCOVER]), headers=_hdr())
    assert r.status_code == 200 and r.json() == {
        "provider": "tamarind",
        "ok": True,
        "tool_count": 1,
    }
    scripted.fail_with = BadCredentialError("nope", status_code=401)
    bad = client.post(
        "/compute/tamarind/verify", json=_body([DISCOVER]), headers=_hdr("wrong")
    )
    assert bad.status_code == 401 and bad.json()["detail"]["error"] == "bad_credential"


@pytest.mark.parametrize(
    ("exc", "status", "kind"),
    [
        (BadCredentialError("x", status_code=401), 401, "bad_credential"),
        (BudgetExhaustedError("x"), 402, "budget_exhausted"),
        (ComputeRateLimitError("x", retry_after_s=2.5), 429, "rate_limited"),
        (ProviderUnavailableError("x"), 503, "provider_unavailable"),
        (
            MappedToolMissingError(ComputeOperation.LIST_TOOLS, "getAvailableTools"),
            502,
            "mapped_tool_missing",
        ),
    ],
)
def test_typed_errors_map_to_stable_http_shapes(client, scripted, exc, status, kind):
    scripted.fail_with = exc
    r = client.post("/compute/tamarind/tools", json=_body([DISCOVER]), headers=_hdr())
    assert r.status_code == status
    detail = r.json()["detail"]
    assert detail["error"] == kind and detail["provider"] == "tamarind"
    if kind == "rate_limited":
        assert detail["retry_after_s"] == 2.5
    if kind == "mapped_tool_missing":
        assert detail["remote_tool"] == "getAvailableTools"


def test_circuit_opens_after_repeated_provider_failures(client, scripted):
    for _ in range(5):
        scripted.fail_with = ProviderUnavailableError("down")
        assert (
            client.post(
                "/compute/tamarind/tools", json=_body([DISCOVER]), headers=_hdr()
            ).status_code
            == 503
        )
    before = len(scripted.seen_secrets)
    r = client.post("/compute/tamarind/tools", json=_body([DISCOVER]), headers=_hdr())
    assert r.status_code == 503 and r.json()["detail"]["error"] == "circuit_open"
    assert len(scripted.seen_secrets) == before


def test_bad_credentials_never_trip_the_breaker(client, scripted):
    for _ in range(6):
        scripted.fail_with = BadCredentialError("bad", status_code=401)
        assert (
            client.post(
                "/compute/tamarind/tools", json=_body([DISCOVER]), headers=_hdr()
            ).status_code
            == 401
        )
    assert (
        client.post(
            "/compute/tamarind/tools", json=_body([DISCOVER]), headers=_hdr()
        ).status_code
        == 200
    )


def test_secret_never_in_logs_or_error_bodies(client, scripted, caplog):
    caplog.set_level(logging.DEBUG)
    client.post(
        "/compute/tamarind/submit",
        json=_body(
            [SUBMIT], tool_id="alphafold", settings={"sequence": "MKT"}, label="j1"
        ),
        headers=_hdr(),
    )
    scripted.fail_with = ProviderUnavailableError("down")
    r = client.post("/compute/tamarind/tools", json=_body([DISCOVER]), headers=_hdr())
    assert SECRET not in caplog.text
    assert SECRET not in r.text


def test_request_bodies_reject_unknown_fields(client):
    r = client.post(
        "/compute/tamarind/tools",
        json={**_body([DISCOVER]), "api_key": "leak-attempt"},
        headers=_hdr(),
    )
    assert r.status_code == 422
