"""Compatibility pins for the  boundary superseded by ."""

from __future__ import annotations

from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from src.main import app
from src.security.local_access import (
    ALLOWED_ORIGINS_ENV,
    PUBLIC_PATHS,
    LocalAccessMiddleware,
    configured_allowed_origins,
)

from .conftest import anonymous_client


def test_prior_public_surface_is_narrowed_to_startup_probes() -> None:
    assert set(PUBLIC_PATHS) == {"GET /health", "GET /ready"}
    with anonymous_client(app) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/ready").status_code == 200
        for path in (
            "/",
            "/openapi.json",
            "/docs",
            "/redoc",
            "/sidecar/health",
            "/sidecar/status",
        ):
            assert client.get(path, follow_redirects=False).status_code == 401, path


def test_authenticated_product_path_still_works() -> None:
    with TestClient(app) as client:
        response = client.get("/services/")
    assert response.status_code == 200
    assert "plannotate_service" in response.text


def test_cors_is_exact_and_outermost(monkeypatch) -> None:
    middleware = app.user_middleware
    classes = [entry.cls for entry in middleware]
    assert classes.index(CORSMiddleware) < classes.index(LocalAccessMiddleware)
    cors = next(entry for entry in middleware if entry.cls is CORSMiddleware)
    assert cors.kwargs["allow_origins"] == ["null"]

    monkeypatch.delenv(ALLOWED_ORIGINS_ENV, raising=False)
    assert configured_allowed_origins() == []

    monkeypatch.setenv(ALLOWED_ORIGINS_ENV, "null")
    assert configured_allowed_origins() == ["null"]

    monkeypatch.setenv(ALLOWED_ORIGINS_ENV, "https://attacker.example,*")
    try:
        configured_allowed_origins()
    except RuntimeError as error:
        assert "wildcard is refused" in str(error)
    else:
        raise AssertionError("wildcard origin must fail closed")


def test_malformed_and_duplicate_credentials_use_stable_bad_session_contract() -> None:
    with anonymous_client(app) as client:
        malformed = client.get("/services/", headers=[(b"X-DNAForge-Session", b"\xff")])
        duplicate = client.get(
            "/services/",
            headers=[
                ("X-DNAForge-Session", "wrong"),
                ("X-DNAForge-Session", "wrong-again"),
            ],
        )
    assert malformed.status_code == 401
    assert malformed.json()["error"]["code"] == "BAD_SESSION"
    assert malformed.json()["detail"]["code"] == "BAD_SESSION"
    assert malformed.json()["detail"]["details"]["how_to_fix"]
    assert duplicate.status_code == 401
    assert duplicate.json()["error"]["code"] == "BAD_SESSION"
    assert duplicate.json()["detail"] == duplicate.json()["error"]
