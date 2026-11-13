"""Session -> capability -> service -> actual Jev wire contract, with no paid calls."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.control_plane.store import ControlPlaneStore
from src.external.contract import FetchOptions, ProviderContractError, ProviderHttpError
from src.external.providers.jev import (
    DISCOVERY_CAPABILITY,
    JEV_MODEL,
    DiscoveryCandidate,
    JevProvider,
)
from src.external.service import ExternalResourcesService
from src.routes import external

CANDIDATES = [
    {"id": "primers", "name": "design_primers", "description": "Design PCR primers."},
    {"id": "sequence", "name": "get_sequence", "description": "Read DNA bases."},
]


def response(scores=(3, 0)):
    return {
        "model": JEV_MODEL,
        "answers": {
            str(i): {"type": "score", "score": s} for i, s in enumerate(scores)
        },
    }


@pytest.fixture
def app_client(tmp_path, monkeypatch):
    calls = []
    payload = {"value": response()}

    def handler(request):
        calls.append(request)
        assert str(request.url) == "https://api.typesafe.ai/v1/systemone"
        assert request.headers["Authorization"] == "Bearer synthetic-key"
        body = json.loads(request.content)
        assert body["model"] == JEV_MODEL
        assert body["state"] == {"task": "amplify this region"}
        assert set(body["questions"]) == {"0", "1"}
        return httpx.Response(
            200,
            content=json.dumps(payload["value"]),
            headers={"Content-Type": "application/json"},
        )

    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", DISCOVERY_CAPABILITY)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    store = ControlPlaneStore(tmp_path / "audit.sqlite")
    store.initialize()
    service = ExternalResourcesService(store, client=client)
    service.register(JevProvider(api_key="synthetic-key", client=client))
    external.set_service(service)
    app = FastAPI()
    app.include_router(external.router)
    with TestClient(app) as test_client:
        yield test_client, calls, payload, store
    external.set_service(None)
    asyncio.run(service.aclose())
    asyncio.run(client.aclose())
    store.close()


def test_rank_through_existing_service_boundary(app_client):
    client, calls, _, store = app_client
    result = client.post(
        "/external/discovery/rank",
        json={"query": "amplify this region", "candidates": CANDIDATES},
    )
    assert result.status_code == 200, result.text
    assert result.json() == {"ids": ["primers"]}
    assert len(calls) == 1
    audit = store.list_external_fetch_log(provider="jev")
    assert len(audit) == 1
    assert audit[0]["method"] == "POST"
    assert audit[0]["status_code"] == 200
    assert "amplify" not in json.dumps(audit)
    assert "synthetic-key" not in json.dumps(audit)


@pytest.mark.parametrize("grant", ["external-fetch:annotation", "read-workspace", ""])
def test_denied_capability_makes_no_vendor_call(app_client, monkeypatch, grant):
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", grant)
    client, calls, _, _ = app_client
    result = client.post(
        "/external/discovery/rank",
        json={"query": "amplify this region", "candidates": CANDIDATES},
    )
    assert result.status_code == 403
    assert not calls


def test_wrong_session_makes_no_vendor_call(app_client):
    client, calls, _, _ = app_client
    result = client.post(
        "/external/discovery/rank",
        headers={"X-DNAForge-Session": "wrong"},
        json={"query": "amplify this region", "candidates": CANDIDATES},
    )
    assert result.status_code == 401
    assert not calls


def test_no_match_is_a_valid_empty_ranking(app_client):
    client, _, payload, _ = app_client
    payload["value"] = response((0, 0.3))
    assert client.post(
        "/external/discovery/rank",
        json={"query": "amplify this region", "candidates": CANDIDATES},
    ).json() == {"ids": []}


@pytest.mark.parametrize(
    "payload",
    [
        {"model": JEV_MODEL, "answers": {}},
        {"model": "unknown-model", "answers": {}},
        {
            "model": JEV_MODEL,
            "answers": {"0": {"type": "refusal"}, "1": {"type": "score", "score": 2}},
        },
        response((float("inf"), 0)),
        response((True, 0)),
        response((4, 0)),
    ],
)
def test_invalid_or_refused_scores_reject_the_entire_ranking(app_client, payload):
    client, calls, holder, _ = app_client
    holder["value"] = payload
    result = client.post(
        "/external/discovery/rank",
        json={"query": "amplify this region", "candidates": CANDIDATES},
    )
    assert result.status_code == 502
    assert len(calls) == 1


def test_private_body_fields_are_rejected_before_vendor_call(app_client):
    client, calls, _, _ = app_client
    result = client.post(
        "/external/discovery/rank",
        json={
            "query": "amplify this region",
            "candidates": [{**CANDIDATES[0], "instructions": "PRIVATE BODY"}],
        },
    )
    assert result.status_code == 422
    assert not calls


@pytest.mark.asyncio
async def test_missing_key_and_duplicate_candidates_never_send_http():
    calls = []
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: calls.append(r))
    ) as client:
        candidates = [DiscoveryCandidate(**CANDIDATES[0])]
        with pytest.raises(ProviderHttpError, match="not configured"):
            await JevProvider(api_key=None, client=client).rank_discovery(
                "task", candidates, FetchOptions()
            )
        with pytest.raises(ProviderContractError):
            await JevProvider(api_key="synthetic-key", client=client).rank_discovery(
                "task", candidates * 2, FetchOptions()
            )
    assert not calls
