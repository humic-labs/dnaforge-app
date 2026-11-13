"""A delegated agent session must not become human operation authority."""

import pytest
from fastapi import Depends, FastAPI

from src.security.local_access import LocalAccessMiddleware
from src.security.operation_authority import (
    human_operation_authority_configured,
    require_human_operation_authority,
)
from tests.sidecar_test_client import AuthenticatedSidecarTestClient as TestClient


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("DNAFORGE_HUMAN_OPERATION_TOKEN", "human-operation-secret")
    app = FastAPI()
    app.add_middleware(LocalAccessMiddleware)

    @app.get("/operations", dependencies=[Depends(require_human_operation_authority)])
    def operations():
        return {"authorized": True}

    return TestClient(app)


def test_launch_session_alone_does_not_confer_human_authority(client):
    response = client.get("/operations")
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "OPERATION_AUTHORITY_REQUIRED"


def test_explicit_human_authority_uses_existing_session_boundary(client):
    headers = {"X-DNAForge-Operation-Authority": "human-operation-secret"}
    assert client.get("/operations", headers=headers).json() == {"authorized": True}
    headers["X-DNAForge-Session"] = "wrong-session"
    assert client.get("/operations", headers=headers).status_code == 401


@pytest.mark.parametrize("value", ["wrong", "", "human-operation-secret,wrong"])
def test_invalid_authority_cannot_be_repaired_by_actor_headers(client, value):
    response = client.get(
        "/operations",
        headers={
            "X-DNAForge-Operation-Authority": value,
            "X-DNAForge-Actor-Kind": "human",
            "X-DNAForge-Actor-Identity": "local-human",
            "X-DNAForge-Agent-Capabilities": "*",
        },
    )
    assert response.status_code == 403
    assert "human-operation-secret" not in response.text


def test_duplicate_authority_headers_are_rejected(client):
    response = client.get(
        "/operations",
        headers=[
            ("X-DNAForge-Operation-Authority", "human-operation-secret"),
            ("x-dnaforge-operation-authority", "human-operation-secret"),
        ],
    )
    assert response.status_code == 403


def test_unconfigured_human_authority_fails_closed(client, monkeypatch):
    monkeypatch.delenv("DNAFORGE_HUMAN_OPERATION_TOKEN")
    response = client.get(
        "/operations",
        headers={
            "X-DNAForge-Operation-Authority": "human-operation-secret",
        },
    )
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "OPERATION_AUTHORITY_UNAVAILABLE"


def test_human_authority_is_unconfigured_without_a_distinct_token(monkeypatch):
    monkeypatch.delenv("DNAFORGE_HUMAN_OPERATION_TOKEN", raising=False)
    monkeypatch.delenv("DNAFORGE_MCP_SESSION_TOKEN", raising=False)
    assert human_operation_authority_configured() is False

    monkeypatch.setenv("DNAFORGE_HUMAN_OPERATION_TOKEN", "same-token")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", "same-token")
    assert human_operation_authority_configured() is False

    monkeypatch.setenv("DNAFORGE_HUMAN_OPERATION_TOKEN", "human-operation-secret")
    assert human_operation_authority_configured() is True


def test_runtime_cannot_reuse_the_delegated_agent_session_as_human_authority(
    client, monkeypatch
):
    from tests.sidecar_test_client import TEST_SIDECAR_SESSION

    monkeypatch.setenv("DNAFORGE_HUMAN_OPERATION_TOKEN", TEST_SIDECAR_SESSION)
    response = client.get(
        "/operations",
        headers={
            "X-DNAForge-Operation-Authority": TEST_SIDECAR_SESSION,
        },
    )
    assert response.status_code == 503
