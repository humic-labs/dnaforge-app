from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.control_plane.store import ControlPlaneStore
from src.external.service import ExternalResourcesService
from src.routes import external as external_routes
from src.routes.external import router as external_router
from tests.conftest import anonymous_client


@pytest.fixture(autouse=True)
def _clear_service():
    yield
    external_routes.set_service(None)  # type: ignore[arg-type]


def _build_app(tmp_path) -> tuple[FastAPI, TestClient, ControlPlaneStore]:
    store = ControlPlaneStore(tmp_path / "paper-graph-route.sqlite3")
    store.initialize()
    external_routes.set_service(ExternalResourcesService(store))
    app = FastAPI()
    app.include_router(external_router)
    return app, TestClient(app), store


def _record_body() -> dict:
    return {
        "workspace_id": 'folders:["/workspace-alpha"]',
        "source_sha256": "a" * 64,
        "source": {"kind": "pdf", "path": "papers/source.pdf", "title": "Source"},
        "traces": [
            {
                "relationship": "uses_method_from",
                "target": {
                    "scheme": "doi",
                    "value": "https://doi.org/10.1000/Example",
                },
                "evidence": {
                    "block_ids": ["p1-b2"],
                    "quote": "The method follows doi:10.1000/example.",
                    "locator": {
                        "kind": "pdf_rects",
                        "page": 1,
                        "rects": [{"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.04}],
                    },
                },
            }
        ],
        "granted_capabilities": ["read-workspace", "create-entity"],
    }


def test_record_and_query_paper_reference_graph_routes(tmp_path):
    _app, client, store = _build_app(tmp_path)

    recorded = client.post(
        "/external/paper/reference-graph/record", json=_record_body()
    )
    assert recorded.status_code == 200, recorded.text
    assert recorded.json() == {
        "source_uri": f"paper://sha256/{'a' * 64}",
        "source_sha256": "a" * 64,
        "edge_count": 1,
        "identifiers": [
            {
                "scheme": "doi",
                "value": "10.1000/example",
                "node_id": "publication:doi:10.1000/example",
            }
        ],
        "replayed": False,
    }

    queried = client.post(
        "/external/paper/reference-graph/query",
        json={
            "workspace_id": 'folders:["/workspace-alpha"]',
            "source_sha256": "a" * 64,
            "depth": 1,
            "max_nodes": 20,
            "granted_capabilities": ["read-workspace"],
        },
    )
    assert queried.status_code == 200, queried.text
    body = queried.json()
    assert body["source_uri"] == f"paper://sha256/{'a' * 64}"
    assert {node["id"] for node in body["nodes"]} == {
        f"paper://sha256/{'a' * 64}",
        "publication:doi:10.1000/example",
    }
    assert body["edges"][0]["relationship"] == "uses_method_from"
    assert body["edges"][0]["trace"]["block_ids"] == ["p1-b2"]
    assert body["truncated"] is False
    assert (
        len(store.list_external_resource_bindings('folders:["/workspace-alpha"]')) == 1
    )
    store.close()


def test_record_route_requires_declared_renderer_capabilities(tmp_path):
    _app, client, store = _build_app(tmp_path)
    body = _record_body()
    body["granted_capabilities"] = ["read-workspace"]

    response = client.post("/external/paper/reference-graph/record", json=body)

    assert response.status_code == 403
    assert response.json()["detail"]["required"] == ["read-workspace", "create-entity"]
    assert store.list_external_resources() == []
    store.close()


def test_record_route_rejects_malformed_identifier_before_write(tmp_path):
    _app, client, store = _build_app(tmp_path)
    body = _record_body()
    body["traces"][0]["target"] = {"scheme": "pmid", "value": "24-157548"}

    response = client.post("/external/paper/reference-graph/record", json=body)

    assert response.status_code == 422
    assert store.list_external_resources() == []
    store.close()


def test_paper_reference_graph_routes_require_sidecar_session(tmp_path):
    app, _client, store = _build_app(tmp_path)
    client = anonymous_client(app)

    record = client.post("/external/paper/reference-graph/record", json=_record_body())
    query = client.post(
        "/external/paper/reference-graph/query",
        json={
            "workspace_id": 'folders:["/workspace-alpha"]',
            "source_sha256": "a" * 64,
            "granted_capabilities": ["read-workspace"],
        },
    )

    assert record.status_code == 401
    assert query.status_code == 401
    store.close()
