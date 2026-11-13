""" / L2 — FastAPI TestClient integration for POST /external/neb/tm.

Exercises the full session -> capability -> service mixin -> NEB provider path
with a MockTransport-backed provider (no live NEB call).
"""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.control_plane.store import ControlPlaneStore
from src.external.providers import NebTmProvider
from src.external.service import ExternalResourcesService
from src.routes import external as external_routes
from src.routes.external import router as external_router

TEST_MCP_TOKEN = "test-mcp-session"
TM_CAP = "external-compute:tm"

_Q5_PAIR = {
    "success": True,
    "data": {
        "p1": [
            {
                "tm": 75.21894800370973,
                "fgc": 0.48,
                "len": 21,
                "seq": "GACCATGATTACGCCAAGCTT",
            }
        ],
        "tm1min": 75,
        "tm1max": 75,
        "p2": [
            {
                "tm": 72.88336470459808,
                "fgc": 0.48,
                "len": 21,
                "seq": "CAGGAAACAGCTATGACCATG",
            }
        ],
        "ta": 72,
        "conc": 500,
        "notes": ["Q5 annealing temperatures (Ta = Tm_lower+1)"],
    },
    "meta": {"version": "0.19.0"},
}


@pytest.fixture(autouse=True)
def _session_env(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_MCP_TOKEN)
    yield
    external_routes.set_service(None)  # type: ignore[arg-type]


def _build_app(tmp_path, handler) -> TestClient:
    store = ControlPlaneStore(tmp_path / "neb.sqlite3")
    store.initialize()
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ExternalResourcesService(store, client=client)
    service.register(NebTmProvider(client=client))
    external_routes.set_service(service)
    app = FastAPI()
    app.include_router(external_router)
    return TestClient(app, headers={"X-DNAForge-Session": TEST_MCP_TOKEN})


def test_post_neb_tm_pair_returns_authoritative_values(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/tm"
        assert request.url.params["prodcode"] == "q5-0"
        return httpx.Response(200, json=_Q5_PAIR)

    client = _build_app(tmp_path, handler)
    resp = client.post(
        "/external/neb/tm",
        json={
            "seq1": "GACCATGATTACGCCAAGCTT",
            "seq2": "CAGGAAACAGCTATGACCATG",
            "prodcode": "q5-0",
            "conc_nm": 500,
            "granted_capabilities": [TM_CAP],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["prodcode"] == "q5-0"
    assert body["p1"]["tm"] == pytest.approx(75.219, abs=1e-3)
    assert body["p2"]["tm"] == pytest.approx(72.883, abs=1e-3)
    assert body["ta"] == 72
    assert body["api_version"] == "0.19.0"


def test_post_neb_tm_batch_returns_one_result_per_sequence(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/tm/batch"
        return httpx.Response(
            200,
            json={
                "success": True,
                "data": [
                    {"tm1": 75.2, "seq1": "GACCATGATTACGCCAAGCTT", "conc": 500},
                    {"tm1": 72.9, "seq1": "CAGGAAACAGCTATGACCATG", "conc": 500},
                ],
                "meta": {"version": "0.19.0"},
            },
        )

    client = _build_app(tmp_path, handler)
    resp = client.post(
        "/external/neb/tm/batch",
        json={
            "sequences": [
                "GACCATGATTACGCCAAGCTT",
                "CAGGAAACAGCTATGACCATG",
            ],
            "prodcode": "q5-0",
            "conc_nm": 500,
            "granted_capabilities": [TM_CAP],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [row["p1"]["tm"] for row in body["results"]] == pytest.approx([75.2, 72.9])


def test_post_neb_tm_without_capability_is_403(tmp_path):
    client = _build_app(tmp_path, lambda req: httpx.Response(200, json=_Q5_PAIR))
    resp = client.post(
        "/external/neb/tm",
        json={"seq1": "GACCATGATTACGCCAAGCTT", "granted_capabilities": []},
    )
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "capability_denied"


def test_post_neb_tm_short_sequence_is_422(tmp_path):
    called = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(200, json=_Q5_PAIR)

    client = _build_app(tmp_path, handler)
    resp = client.post(
        "/external/neb/tm",
        json={"seq1": "GACCAT", "granted_capabilities": [TM_CAP]},
    )
    assert resp.status_code == 422
    assert called is False
