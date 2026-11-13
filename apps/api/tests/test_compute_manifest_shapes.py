from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.compute.manifests import ManifestError, load_manifests, parse_manifest
from src.compute.service import ComputeService
from src.routes import compute as compute_routes

MANIFESTS = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "core"
    / "compute-endpoints"
    / "manifests"
)
DISCOVER = "external-compute:discover"
SESSION = "manifest-shape-test-session"
INVALID_MAPPINGS = [[], ["invalid"], False, 0, "", None]
SHAPE_CASES = (
    [
        ("tamarind", ("auth", "headerName"), value)
        for value in [7, ["x-api-key"], {"name": "x-api-key"}]
    ]
    + [
        ("tamarind", path, value)
        for path in [("toolMap",), ("statusMap",), ("toolMap", "submit", "args")]
        for value in INVALID_MAPPINGS
    ]
    + [
        ("tamarind", ("toolMap", "submit", "args", "jobName"), value)
        for value in [[], {}]
    ]
    + [
        ("replicate", path, value)
        for path in [
            ("driver", "submit", "method"),
            ("driver", "status", "method"),
            ("driver", "cancel", "method"),
            ("driver", "status", "statusMap", "succeeded"),
            ("staticTools", 0, "inputSchema", "type"),
        ]
        for value in [[], {}]
    ]
    + [
        ("replicate", ("driver", "submit", "headers"), value)
        for value in INVALID_MAPPINGS
    ]
)


def malformed_manifest(name, path, value):
    raw = json.loads((MANIFESTS / f"{name}.json").read_text())
    raw["id"] = "shape-validation-test"
    raw["schemaVersion"] = 2
    if raw["transport"] == "mcp":
        raw["driver"] = {"kind": "mcp-tool-map"}
    owner = raw
    for key in path[:-1]:
        owner = owner[key]
    owner[path[-1]] = value
    return raw


def field_label(path):
    return ".".join(str(key) for key in path).replace(".0.", "[0].")


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", SESSION)
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", DISCOVER)
    service = ComputeService(load_manifests(MANIFESTS), binding_factory=lambda _m: None)
    compute_routes.set_service(service)
    app = FastAPI()
    app.include_router(compute_routes.router)
    try:
        with TestClient(app, headers={"X-DNAForge-Session": SESSION}) as connection:
            yield connection
    finally:
        compute_routes.set_service(None)


@pytest.mark.parametrize(("name", "path", "value"), SHAPE_CASES)
def test_malformed_nested_shapes_raise_contextual_manifest_error(name, path, value):
    raw = malformed_manifest(name, path, value)
    with pytest.raises(ManifestError) as error:
        parse_manifest(raw, source="user")
    expected = field_label(path)
    if path[-2:] == ("statusMap", "succeeded"):
        expected = "driver.status.statusMap"
    assert expected in str(error.value)
    assert raw["id"] in str(error.value)


@pytest.mark.parametrize(("name", "path", "value"), SHAPE_CASES)
def test_authenticated_validation_returns_typed_rejection(client, name, path, value):
    raw = malformed_manifest(name, path, value)
    before = client.get("/compute/providers").json()
    response = client.post(
        "/compute/providers/validate-manifest",
        json={"granted_capabilities": [DISCOVER], "manifest": raw},
    )
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["error"] == "invalid_compute_manifest"
    expected = field_label(path)
    if path[-2:] == ("statusMap", "succeeded"):
        expected = "driver.status.statusMap"
    assert expected in detail["message"]
    assert client.get("/compute/providers").json() == before


def test_malformed_validation_still_requires_session_and_discovery_grant(
    client, monkeypatch
):
    raw = malformed_manifest("tamarind", ("auth", "headerName"), 7)
    response = client.post(
        "/compute/providers/validate-manifest",
        json={"granted_capabilities": [DISCOVER], "manifest": raw},
        headers={"X-DNAForge-Session": "untrusted-session"},
    )
    assert response.status_code == 401
    monkeypatch.delenv("DNAFORGE_MCP_GRANT_CAPABILITIES")
    response = client.post(
        "/compute/providers/validate-manifest",
        json={"granted_capabilities": [], "manifest": raw},
    )
    assert response.status_code == 403


def test_missing_optional_python_mapping_fields_keep_existing_defaults():
    raw = malformed_manifest("tamarind", ("auth", "headerName"), "x-api-key")
    raw.pop("statusMap")
    raw["toolMap"]["submit"].pop("args")
    parsed = parse_manifest(raw, source="user")
    assert parsed.status_map == {}
    assert parsed.tool_map["submit"].args == {}
    raw = malformed_manifest("replicate", ("driver", "submit", "method"), "POST")
    assert "headers" not in raw["driver"]["submit"]
    assert parse_manifest(raw, source="user").driver["submit"]["method"] == "POST"


def test_validation_keeps_custom_schema_version_restriction(client):
    raw = malformed_manifest("tamarind", ("auth", "headerName"), "x-api-key")
    raw["schemaVersion"] = 1
    raw.pop("driver")
    response = client.post(
        "/compute/providers/validate-manifest",
        json={"granted_capabilities": [DISCOVER], "manifest": raw},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == {
        "error": "invalid_compute_manifest",
        "message": "custom manifests must use schemaVersion 2",
    }
    raw["schemaVersion"] = 2
    raw["driver"] = {"kind": "mcp-tool-map"}
    response = client.post(
        "/compute/providers/validate-manifest",
        json={"granted_capabilities": [DISCOVER], "manifest": raw},
    )
    assert response.status_code == 200
    assert response.json()["custom"] is True
    assert response.json()["id"] == raw["id"]


def test_validation_keeps_unsupported_driver_rejection(client):
    raw = malformed_manifest("tamarind", ("driver", "kind"), "unknown-driver")
    response = client.post(
        "/compute/providers/validate-manifest",
        json={"granted_capabilities": [DISCOVER], "manifest": raw},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["error"] == "invalid_compute_manifest"
    assert "unsupported driver" in response.json()["detail"]["message"]
