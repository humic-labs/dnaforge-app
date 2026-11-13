"""Existing output imports are pure parsing, independently of managed execution."""

import hashlib
import json

import pytest
from fastapi import FastAPI

from src.routes.annotation_output import MAX_ANNOTATION_OUTPUT_BYTES, router
from src.security.local_access import LocalAccessMiddleware
from tests.conftest import anonymous_client
from tests.sidecar_test_client import AuthenticatedSidecarTestClient


@pytest.fixture
def app():
    app = FastAPI()
    app.add_middleware(LocalAccessMiddleware)
    app.include_router(router)
    return app


def test_parse_output_requires_launch_session(app):
    with anonymous_client(app) as client:
        response = client.post(
            "/annotation/output/parse", json={"content": "{}", "format": "json"}
        )
    assert response.status_code == 401


@pytest.mark.parametrize(
    "format,content",
    [
        ("json", json.dumps({"features": [], "sequence_length": 20})),
        ("gff3", "##gff-version 3\n##sequence-region sample 1 20\n"),
    ],
)
def test_parse_existing_output_needs_no_owner_or_engine(
    app, monkeypatch, format, content
):
    def forbidden(*_args, **_kwargs):
        pytest.fail("Parsing output must not execute an analysis")

    monkeypatch.setattr("dnaforge_annotation.core.run_annotation", forbidden)
    with AuthenticatedSidecarTestClient(app) as client:
        response = client.post(
            "/annotation/output/parse", json={"content": content, "format": format}
        )
    assert response.status_code == 200, response.text
    assert response.json() == {
        "output_sha256": hashlib.sha256(content.encode()).hexdigest(),
        "result": {"features": [], "sequence_length": 20, "error": None},
    }


@pytest.mark.parametrize(
    "content",
    [
        '{"features": [], "sequence_length": 20, "error": "engine failed"}',
        '{"features": [{"name": "private file contents"}], "sequence_length": 20}',
        '{"features": [], "sequence_length": false}',
        "{}",
    ],
)
def test_invalid_output_is_not_a_successful_empty_result(app, content):
    with AuthenticatedSidecarTestClient(app) as client:
        response = client.post(
            "/annotation/output/parse", json={"content": content, "format": "json"}
        )
    assert response.status_code == 422
    assert "private file contents" not in response.text


def test_parse_limit_counts_utf8_bytes(app):
    with AuthenticatedSidecarTestClient(app) as client:
        response = client.post(
            "/annotation/output/parse",
            json={
                "content": "é" * (MAX_ANNOTATION_OUTPUT_BYTES // 2 + 1),
                "format": "json",
            },
        )
    assert response.status_code == 413


def test_parse_does_not_accept_paths_or_receipt_authority(app):
    with AuthenticatedSidecarTestClient(app) as client:
        response = client.post(
            "/annotation/output/parse",
            json={
                "content": "{}",
                "format": "json",
                "path": "/private/input.json",
                "actor_id": "human",
            },
        )
    assert response.status_code == 422
