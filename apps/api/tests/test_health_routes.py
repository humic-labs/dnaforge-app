import hashlib
from types import ModuleType

from fastapi import FastAPI
from fastapi.testclient import TestClient

from src import runtime_capabilities
from src.build_identity import intrinsic_sidecar_source_fingerprint
from src.routes.health import router as health_router
from src.services import dna_coverage_shellout

from .conftest import anonymous_client

STUB_ENGINE_IDENTITY = f"dna-coverage:schema-1:sha256-{'a' * 64}"


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(health_router)
    return TestClient(app)


def _stub_coverage_engine(monkeypatch):
    """Stand in for a host-built coverage helper, which no source checkout owns."""
    monkeypatch.setattr(
        dna_coverage_shellout,
        "coverage_engine_identity",
        lambda: STUB_ENGINE_IDENTITY,
    )


def _stub_pysam(monkeypatch):
    """Keep capability tests independent of the host's optional pysam wheel."""
    stub = ModuleType("pysam")
    stub.__version__ = "0.test"
    real_import_module = runtime_capabilities.importlib.import_module

    def import_module(name: str, package: str | None = None):
        if name == "pysam":
            return stub
        return real_import_module(name, package)

    monkeypatch.setattr(runtime_capabilities.importlib, "import_module", import_module)


def test_authenticated_health_reports_compatibility_without_token_derived_material(
    monkeypatch,
):
    _stub_pysam(monkeypatch)
    _stub_coverage_engine(monkeypatch)
    monkeypatch.setenv("WAYPOINT_APP_VERSION", "0.2.0")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", "same-launch-token")
    monkeypatch.setenv(
        "DNAFORGE_MCP_GRANT_CAPABILITIES",
        "external-fetch:annotation,external-fetch:xref-resolution,external-fetch:structure",
    )

    response = _client().get(
        "/health", headers={"X-DNAForge-Session": "same-launch-token"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["app_version"] == "0.2.0"
    assert body["sidecar_source_fingerprint"] == intrinsic_sidecar_source_fingerprint()
    assert "mcp_session_fingerprint" not in body
    assert hashlib.sha256(b"same-launch-token").hexdigest() not in str(body)
    assert body["mcp_grant_capabilities"] == [
        "external-fetch:annotation",
        "external-fetch:xref-resolution",
        "external-fetch:structure",
    ]
    assert "tiles.coverage-readiness.v1" in body["route_features"]
    assert "tiles.coverage-assembly.v1" in body["route_features"]
    assert body["runtime_capabilities"] == ["genome.pysam-htslib.v1"]


def test_public_health_stays_minimal_when_session_unconfigured(monkeypatch):
    monkeypatch.delenv("DNAFORGE_MCP_SESSION_TOKEN", raising=False)
    monkeypatch.delenv("DNAFORGE_MCP_GRANT_CAPABILITIES", raising=False)

    response = anonymous_client(_client().app).get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "healthy", "service": "molbio-api"}


def test_health_does_not_advertise_bam_runtime_when_pysam_cannot_import(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", "same-launch-token")
    real_import_module = runtime_capabilities.importlib.import_module

    def fail_pysam_import(name: str):
        if name == "pysam":
            raise ModuleNotFoundError("No module named 'pysam'")
        return real_import_module(name)

    monkeypatch.setattr(
        runtime_capabilities.importlib, "import_module", fail_pysam_import
    )

    response = _client().get(
        "/health", headers={"X-DNAForge-Session": "same-launch-token"}
    )

    assert response.status_code == 200
    assert response.json()["runtime_capabilities"] == []


def test_health_does_not_advertise_bam_runtime_when_the_coverage_helper_is_rejected(
    monkeypatch,
):
    """A missing or stale coverage helper withholds the genome capability ."""
    _stub_pysam(monkeypatch)
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", "same-launch-token")
    helper_calls = 0

    def rejected() -> str:
        nonlocal helper_calls
        helper_calls += 1
        raise dna_coverage_shellout.DnaCoverageNotFoundError([])

    monkeypatch.setattr(dna_coverage_shellout, "coverage_engine_identity", rejected)

    response = _client().get(
        "/health", headers={"X-DNAForge-Session": "same-launch-token"}
    )

    assert response.status_code == 200
    assert response.json()["runtime_capabilities"] == []
    assert helper_calls == 1


def test_bad_session_is_refused_not_reported_healthy(monkeypatch):
    """A bad session must NOT get a 200 "healthy" answer.

    . Fault injection put an unconditional ``return {"status": "ok"}`` at
    the top of the health route — a dead or hostile session reported as alive —
    and every existing test still passed. That is the whole point of this route:
    Electron uses it to tell "mine" from "orphan", so a health check that answers
    healthy before checking the session is worse than no health check.

    The assertion is on the STATUS CODE, not the body. An early return
    short-circuits before any auth branch runs, so the status is what moves.
    """
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", "the-real-launch-token")

    wrong = _client().get("/health", headers={"X-DNAForge-Session": "some-other-token"})
    assert wrong.status_code != 200, (
        "health answered 200 for a wrong session token; an orphaned or hostile "
        "sidecar would look alive to Electron"
    )
    assert wrong.json().get("status") != "healthy"

    malformed = _client().get(
        "/health", headers=[(b"x-dnaforge-session", b"\xff-not-ascii")]
    )
    assert (
        malformed.status_code != 200
    ), "health answered 200 for a malformed non-ASCII session header"
    assert malformed.json().get("status") != "healthy"

    duplicated = _client().get(
        "/health",
        headers=[
            ("X-DNAForge-Session", "the-real-launch-token"),
            ("X-DNAForge-Session", "some-other-token"),
        ],
    )
    assert (
        duplicated.status_code != 200
    ), "health answered 200 when two conflicting sessions were presented"


def test_only_authenticated_health_reports_the_bound_private_mcp_port(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", "private-port-session")
    client = _client()
    client.app.state.mcp_http_internal_port = 35769
    response = client.get(
        "/health", headers={"X-DNAForge-Session": "private-port-session"}
    )
    assert response.status_code == 200
    assert response.json()["mcp_http_internal_port"] == 35769
    public = anonymous_client(client.app).get("/health")
    assert public.json() == {"status": "healthy", "service": "molbio-api"}
    wrong = client.get("/health", headers={"X-DNAForge-Session": "wrong-session"})
    assert wrong.status_code == 401
    assert "mcp_http_internal_port" not in wrong.json()
