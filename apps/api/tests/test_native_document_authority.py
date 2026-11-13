from typing import Annotated

import pytest
from fastapi import Depends, FastAPI

from src.security.local_access import LocalAccessMiddleware
from src.security.native_document_authority import (
    capture_native_document_authority,
    require_native_document_authority,
)
from tests.sidecar_test_client import (
    TEST_SIDECAR_SESSION,
    AuthenticatedSidecarTestClient,
)


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("DNAFORGE_NATIVE_DOCUMENT_TOKEN", "native-document-secret")
    monkeypatch.setenv("DNAFORGE_NATIVE_DOCUMENT_OWNER_ID", "native-owner-a")
    monkeypatch.setenv("DNAFORGE_HUMAN_OPERATION_TOKEN", "human-operation-secret")
    app = FastAPI()
    app.state.native_document_authority = capture_native_document_authority()
    app.add_middleware(LocalAccessMiddleware)

    @app.post("/internal/managed-documents/settle")
    def settle(owner: Annotated[str, Depends(require_native_document_authority)]):
        return {"owner": owner}

    return AuthenticatedSidecarTestClient(app)


@pytest.mark.parametrize(
    "token", [None, "wrong", "human-operation-secret", TEST_SIDECAR_SESSION]
)
def test_public_clients_cannot_certify_a_saved_file(client, token):
    headers = {"X-DNAForge-Operation-Authority": "human-operation-secret"}
    if token is not None:
        headers["X-DNAForge-Native-Document-Authority"] = token
    response = client.post(
        "/internal/managed-documents/settle", headers=headers, json={"saved": True}
    )
    assert response.status_code == 403
    assert "native-document-secret" not in response.text


def test_private_native_authority_still_requires_the_current_session(client):
    headers = {"X-DNAForge-Native-Document-Authority": "native-document-secret"}
    assert client.post(
        "/internal/managed-documents/settle", headers=headers
    ).json() == {"owner": "native-owner-a"}
    headers["X-DNAForge-Session"] = "stale-session"
    assert (
        client.post("/internal/managed-documents/settle", headers=headers).status_code
        == 401
    )


def test_duplicate_native_authority_headers_fail_closed(client):
    headers = [
        ("X-DNAForge-Native-Document-Authority", "native-document-secret"),
        ("x-dnaforge-native-document-authority", "native-document-secret"),
    ]
    assert (
        client.post("/internal/managed-documents/settle", headers=headers).status_code
        == 403
    )


@pytest.mark.parametrize(
    "key", ["DNAFORGE_NATIVE_DOCUMENT_TOKEN", "DNAFORGE_NATIVE_DOCUMENT_OWNER_ID"]
)
def test_missing_native_bootstrap_fails_closed(client, monkeypatch, key):
    monkeypatch.setenv("DNAFORGE_NATIVE_DOCUMENT_TOKEN", "native-document-secret")
    monkeypatch.setenv("DNAFORGE_NATIVE_DOCUMENT_OWNER_ID", "native-owner-a")
    monkeypatch.delenv(key)
    client.app.state.native_document_authority = capture_native_document_authority()
    assert client.post("/internal/managed-documents/settle").status_code == 503


@pytest.mark.parametrize("token", ["human-operation-secret", TEST_SIDECAR_SESSION])
def test_native_authority_cannot_alias_a_public_client_credential(
    client, monkeypatch, token
):
    monkeypatch.setenv("DNAFORGE_NATIVE_DOCUMENT_TOKEN", token)
    monkeypatch.setenv("DNAFORGE_NATIVE_DOCUMENT_OWNER_ID", "native-owner-a")
    client.app.state.native_document_authority = capture_native_document_authority()
    response = client.post(
        "/internal/managed-documents/settle",
        headers={"X-DNAForge-Native-Document-Authority": token},
    )
    assert response.status_code == 503


def test_private_bootstrap_is_consumed_before_child_processes_can_inherit_it(client):
    import os
    import subprocess
    import sys

    assert "DNAFORGE_NATIVE_DOCUMENT_TOKEN" not in os.environ
    assert "DNAFORGE_NATIVE_DOCUMENT_OWNER_ID" not in os.environ
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import os; print(any(k.upper().startswith('DNAFORGE_NATIVE_DOCUMENT_') for k in os.environ))",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert result.stdout.strip() == "False"
    assert "native-document-secret" not in repr(
        client.app.state.native_document_authority
    )


def test_the_private_command_address_is_captured_and_removed_from_child_environment(
    monkeypatch,
):
    import os

    monkeypatch.setenv("DNAFORGE_NATIVE_DOCUMENT_TOKEN", "native-document-secret")
    monkeypatch.setenv("DNAFORGE_NATIVE_DOCUMENT_OWNER_ID", "native-owner-a")
    monkeypatch.setenv("DNAFORGE_NATIVE_DOCUMENT_URL", "http://127.0.0.1:43210/")
    authority = capture_native_document_authority()
    assert authority is not None
    assert authority.command_url == "http://127.0.0.1:43210"
    assert "DNAFORGE_NATIVE_DOCUMENT_URL" not in os.environ


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com",
        "http://localhost:1234",
        "http://127.0.0.1:0",
        "http://127.0.0.1:70000",
        "http://user:password@127.0.0.1:1234",
        "http://127.0.0.1:1234/private",
        "http://127.0.0.1:1234?redirect=outside",
        "http://127.0.0.1:1234#fragment",
    ],
)
def test_native_command_bootstrap_cannot_redirect_the_private_credential(
    monkeypatch, url
):
    monkeypatch.setenv("DNAFORGE_NATIVE_DOCUMENT_TOKEN", "native-document-secret")
    monkeypatch.setenv("DNAFORGE_NATIVE_DOCUMENT_OWNER_ID", "native-owner-a")
    monkeypatch.setenv("DNAFORGE_NATIVE_DOCUMENT_URL", url)
    assert capture_native_document_authority() is None
