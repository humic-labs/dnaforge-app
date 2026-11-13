from __future__ import annotations

import asyncio
import socket
from datetime import UTC, datetime

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.control_plane.store import ControlPlaneStore
from src.external.credential_broker import CredentialBroker
from src.external.service import ExternalResourcesService
from src.routes import external as external_routes
from src.routes.external import router as external_router


async def _public_resolver(
    _host: str, _port: int, *, type: socket.SocketKind
) -> list[tuple]:
    assert type == socket.SOCK_STREAM
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))]


def test_broker_authorizes_each_supported_credential_without_repr_leaks() -> None:
    canary = "INERT_SOURCE_CREDENTIAL_CANARY_123456"
    broker = CredentialBroker(now=lambda: datetime(2026, 9, 21, tzinfo=UTC))
    broker.register(
        auth_ref="credential:http",
        kind="http-bearer",
        material={"token": canary},
    )
    broker.register(
        auth_ref="credential:aws",
        kind="aws-sigv4",
        material={
            "access_key_id": "TESTACCESSKEY1234",
            "secret_access_key": canary,
            "session_token": f"session-{canary}",
        },
    )
    broker.register(
        auth_ref="credential:gcs",
        kind="gcs-oauth",
        material={"access_token": canary},
    )

    assert (
        broker.authorize(
            auth_ref="credential:http",
            audience="http",
            url="https://data.example.org/sample.bai",
        )["Authorization"]
        == f"Bearer {canary}"
    )
    aws = broker.authorize(
        auth_ref="credential:aws",
        audience="s3",
        url="https://s3.us-west-2.amazonaws.com/research/sample.bai",
        headers={"Range": "bytes=0-15", "x-amz-request-payer": "requester"},
        aws_region="us-west-2",
    )
    assert aws["Authorization"].startswith(
        "AWS4-HMAC-SHA256 Credential=TESTACCESSKEY1234/"
    )
    assert aws["x-amz-security-token"] == f"session-{canary}"
    assert "x-amz-request-payer" in aws["Authorization"]
    assert (
        broker.authorize(
            auth_ref="credential:gcs",
            audience="gcs",
            url="https://storage.googleapis.com/research/sample.bai",
        )["Authorization"]
        == f"Bearer {canary}"
    )
    assert canary not in repr(broker)
    assert canary not in repr(
        broker._entries
    )  # noqa: SLF001 - explicit leak boundary test


def test_private_http_s3_and_gcs_admission_uses_broker_only(
    tmp_path, monkeypatch
) -> None:
    session = "credential-broker-session"
    operation = "credential-broker-human-operation"
    canary = "INERT_SOURCE_CREDENTIAL_CANARY_987654"
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", session)
    monkeypatch.setenv("DNAFORGE_HUMAN_OPERATION_TOKEN", operation)
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "*")
    payload = b"BAI\x01" + bytes(124)
    observed: list[httpx.Request] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        observed.append(request)
        assert request.headers["range"].startswith("bytes=")
        start_text, end_text = (
            request.headers["range"].removeprefix("bytes=").split("-")
        )
        start, end = int(start_text), int(end_text)
        content = payload[start : end + 1]
        return httpx.Response(
            206,
            content=content,
            headers={
                "Content-Range": f"bytes {start}-{start + len(content) - 1}/{len(payload)}",
                "Content-Length": str(len(content)),
                "ETag": '"private-source-v1"',
            },
        )

    store = ControlPlaneStore(tmp_path / "credential-broker.sqlite3")
    store.initialize()
    upstream_client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    service = ExternalResourcesService(
        store,
        client=upstream_client,
        remote_range_resolver=_public_resolver,
    )
    external_routes.set_service(service)
    app = FastAPI()
    app.include_router(external_router)
    headers = {
        "X-DNAForge-Session": session,
        "X-DNAForge-Operation-Authority": operation,
    }

    try:
        with TestClient(app, headers=headers) as client:
            denied = client.post(
                "/external/credential-broker/register",
                headers={"X-DNAForge-Operation-Authority": "wrong"},
                json={
                    "auth_ref": "credential:private-http",
                    "kind": "http-bearer",
                    "material": {"token": canary},
                },
            )
            assert denied.status_code == 403

            registrations = (
                (
                    "credential:private-http",
                    "http-bearer",
                    {"token": canary},
                ),
                (
                    "credential:private-s3",
                    "aws-sigv4",
                    {
                        "access_key_id": "TESTACCESSKEY1234",
                        "secret_access_key": canary,
                        "session_token": f"session-{canary}",
                    },
                ),
                (
                    "credential:private-gcs",
                    "gcs-oauth",
                    {"access_token": canary},
                ),
            )
            for auth_ref, kind, material in registrations:
                response = client.post(
                    "/external/credential-broker/register",
                    json={"auth_ref": auth_ref, "kind": kind, "material": material},
                )
                assert response.status_code == 200, response.text
                assert response.json() == {"auth_ref": auth_ref, "kind": kind}
                assert canary not in response.text

            admissions = (
                {
                    "source_kind": "url",
                    "source": "https://private.example.org/sample.bai",
                    "auth_ref": "credential:private-http",
                },
                {
                    "source_kind": "s3",
                    "bucket": "research-bucket",
                    "object_key": "cohort/sample.bai",
                    "region": "us-west-2",
                    "requester_pays": True,
                    "auth_ref": "credential:private-s3",
                },
                {
                    "source_kind": "gcs",
                    "bucket": "research-bucket",
                    "object_key": "cohort/sample.bai",
                    "billing_project": "genomics-billing",
                    "auth_ref": "credential:private-gcs",
                },
            )
            for index, locator in enumerate(admissions):
                response = client.post(
                    "/external/indexed-tracks/admit",
                    json={
                        **locator,
                        "format_id": "bai",
                        "provenance_id": f"private:{index}",
                        "granted_capabilities": ["external-fetch:annotation"],
                    },
                )
                assert response.status_code == 200, response.text
                assert canary not in response.text

        assert observed[0].headers["authorization"] == f"Bearer {canary}"
        assert observed[1].headers["authorization"].startswith("AWS4-HMAC-SHA256 ")
        assert observed[1].headers["x-amz-request-payer"] == "requester"
        assert observed[1].headers["x-amz-security-token"] == f"session-{canary}"
        assert observed[2].headers["authorization"] == f"Bearer {canary}"
        assert observed[2].headers["x-goog-user-project"] == "genomics-billing"
        assert "private.example.org" in observed[0].headers["host"]
        assert "s3.us-west-2.amazonaws.com" in observed[1].headers["host"]
        assert "storage.googleapis.com" in observed[2].headers["host"]
    finally:
        asyncio.run(service.aclose())
        store.close()
        external_routes.set_service(None)  # type: ignore[arg-type]
