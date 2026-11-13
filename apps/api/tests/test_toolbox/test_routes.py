"""Tests for /toolbox/status and /toolbox/retry endpoints."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from src.main import app
from src.operations import OperationState
from src.toolbox.registry import Capability, Component, toolbox_registry
from tests.sidecar_test_client import AuthenticatedSidecarTestClient as TestClient


class TestToolboxStatusEndpoint:
    """GET /toolbox/status returns capability inventory."""

    def setup_method(self):
        """Clear registry before each test."""
        toolbox_registry._capabilities.clear()

    def test_empty_registry(self):
        client = TestClient(app)
        resp = client.get("/toolbox/status")
        assert resp.status_code == 200
        data = resp.json()
        assert "capabilities" in data
        assert data["capabilities"] == []

    def test_single_capability(self):
        toolbox_registry.register(
            Capability(
                id="test_annotation",
                label="Annotation Engine",
                source="builtin",
                tier="base",
                auto_install=True,
                components=[
                    Component(
                        id="blastn",
                        label="BLAST+",
                        status="ready",
                        version="2.16.0",
                        source="downloaded",
                    ),
                ],
            )
        )
        client = TestClient(app)
        resp = client.get("/toolbox/status")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["capabilities"]) == 1
        cap = data["capabilities"][0]
        assert cap["id"] == "test_annotation"
        assert cap["status"] == "ready"
        assert cap["tier"] == "base"
        assert len(cap["components"]) == 1
        assert cap["components"][0]["version"] == "2.16.0"

    def test_downloading_capability(self):
        toolbox_registry.register(
            Capability(
                id="test_downloading",
                label="Test Downloading",
                source="builtin",
                tier="base",
                auto_install=True,
                components=[
                    Component(
                        id="blastn",
                        label="BLAST+",
                        status="downloading",
                        source="downloaded",
                        progress={"phase": "downloading", "percent": 42},
                    ),
                ],
            )
        )
        client = TestClient(app)
        resp = client.get("/toolbox/status")
        cap = resp.json()["capabilities"][0]
        assert cap["status"] == "downloading"
        assert cap["components"][0]["progress"]["percent"] == 42

    def test_multiple_capabilities(self):
        toolbox_registry.register(
            Capability(
                id="annotation",
                label="Annotation",
                source="builtin",
                tier="base",
                auto_install=True,
                components=[],
            )
        )
        toolbox_registry.register(
            Capability(
                id="alignment",
                label="Alignment",
                source="builtin",
                tier="base",
                auto_install=True,
                components=[],
            )
        )
        client = TestClient(app)
        resp = client.get("/toolbox/status")
        assert len(resp.json()["capabilities"]) == 2

    def test_annotation_status_removed(self):
        """Old /annotation/status should no longer exist."""
        client = TestClient(app)
        resp = client.get("/annotation/status")
        assert resp.status_code == 404

    def test_annotation_setup_removed(self):
        """Old /annotation/setup should no longer exist."""
        client = TestClient(app)
        resp = client.post("/annotation/setup")
        assert resp.status_code == 404

    def test_none_values_stripped_from_components(self):
        """Components with None version/path/progress should omit those keys."""
        toolbox_registry.register(
            Capability(
                id="x",
                label="X",
                source="builtin",
                tier="base",
                auto_install=True,
                components=[
                    Component(id="a", label="A", status="ready", source="builtin"),
                ],
            )
        )
        client = TestClient(app)
        comp = client.get("/toolbox/status").json()["capabilities"][0]["components"][0]
        assert "version" not in comp
        assert "path" not in comp
        assert "progress" not in comp


class TestToolboxRetryEndpoint:
    """POST /toolbox/retry/{cap_id} triggers re-download for failed capabilities."""

    def setup_method(self):
        toolbox_registry._capabilities.clear()

    def test_retry_unknown_capability_returns_404(self):
        client = TestClient(app)
        resp = client.post("/toolbox/retry/nonexistent")
        assert resp.status_code == 404

    def test_retry_annotation_triggers_download(self, monkeypatch):
        """Retry returns the one durable annotation-provisioning operation."""
        monkeypatch.setenv("DNAFORGE_HUMAN_OPERATION_TOKEN", "human-operation-secret")
        toolbox_registry.register(
            Capability(
                id="annotation",
                label="Annotation Engine",
                source="builtin",
                tier="base",
                auto_install=True,
                components=[
                    Component(
                        id="databases",
                        label="Databases",
                        status="error",
                        source="downloaded",
                    ),
                ],
            )
        )
        coordinator = SimpleNamespace(
            retry=AsyncMock(
                return_value=SimpleNamespace(
                    id="0199a4f1-1111-7000-8000-000000000001",
                    state=OperationState.QUEUED,
                )
            )
        )
        app.state.annotation_provisioning = coordinator
        try:
            client = TestClient(app)
            resp = client.post(
                "/toolbox/retry/annotation",
                headers={"X-DNAForge-Operation-Authority": "human-operation-secret"},
            )
            assert resp.status_code == 200
            assert resp.json() == {
                "retrying": True,
                "capability": "annotation",
                "operation_id": "0199a4f1-1111-7000-8000-000000000001",
                "state": "queued",
            }
            coordinator.retry.assert_awaited_once_with()
        finally:
            app.state.annotation_provisioning = None

    def test_retry_annotation_rejects_an_agent_session(self, monkeypatch):
        """The delegated sidecar session cannot submit a human-owned operation."""
        monkeypatch.setenv("DNAFORGE_HUMAN_OPERATION_TOKEN", "human-operation-secret")
        toolbox_registry.register(
            Capability(
                id="annotation",
                label="Annotation Engine",
                source="builtin",
                tier="base",
                auto_install=True,
                components=[],
            )
        )
        coordinator = SimpleNamespace(retry=AsyncMock())
        app.state.annotation_provisioning = coordinator
        try:
            response = TestClient(app).post("/toolbox/retry/annotation")
            assert response.status_code == 403
            assert response.json()["detail"]["code"] == "OPERATION_AUTHORITY_REQUIRED"
            coordinator.retry.assert_not_awaited()
        finally:
            app.state.annotation_provisioning = None

    def test_retry_non_annotation_returns_400(self):
        """Only annotation has a retry mechanism (for now)."""
        toolbox_registry.register(
            Capability(
                id="alignment",
                label="Alignment",
                source="builtin",
                tier="base",
                auto_install=True,
                components=[],
            )
        )
        client = TestClient(app)
        resp = client.post("/toolbox/retry/alignment")
        assert resp.status_code == 400


class TestToolboxHealthEndpoint:
    """POST /toolbox/health/{cap_id} checks plugin health lazily."""

    def setup_method(self):
        toolbox_registry._capabilities.clear()

    def test_health_unknown_capability_returns_404(self):
        client = TestClient(app)
        resp = client.post("/toolbox/health/nonexistent")
        assert resp.status_code == 404

    def test_health_non_plugin_returns_400(self):
        toolbox_registry.register(
            Capability(
                id="annotation",
                label="Annotation",
                source="builtin",
                tier="base",
                auto_install=True,
                components=[],
            )
        )
        client = TestClient(app)
        resp = client.post("/toolbox/health/annotation")
        assert resp.status_code == 400

    def test_health_plugin_reachable(self):
        toolbox_registry.register(
            Capability(
                id="alphafold",
                label="AlphaFold",
                source="plugin",
                tier="optional",
                auto_install=False,
                components=[
                    Component(
                        id="alphafold_service",
                        label="AlphaFold",
                        status="unavailable",
                        source="plugin",
                        path="http://localhost:9001",
                    ),
                ],
            )
        )
        with patch(
            "src.routes.toolbox.check_plugin_health",
            new_callable=AsyncMock,
            return_value="ready",
        ):
            client = TestClient(app)
            resp = client.post("/toolbox/health/alphafold")
            assert resp.status_code == 200
            assert resp.json()["status"] == "ready"
        cap = toolbox_registry.get_capability("alphafold")
        assert cap.components[0].status == "ready"

    def test_health_plugin_no_url_returns_400(self):
        toolbox_registry.register(
            Capability(
                id="broken",
                label="Broken Plugin",
                source="plugin",
                tier="optional",
                auto_install=False,
                components=[
                    Component(
                        id="svc",
                        label="Svc",
                        status="unavailable",
                        source="plugin",
                    ),
                ],
            )
        )
        client = TestClient(app)
        resp = client.post("/toolbox/health/broken")
        assert resp.status_code == 400
        assert "no URL" in resp.json()["detail"]

    def test_health_plugin_unreachable(self):
        toolbox_registry.register(
            Capability(
                id="alphafold",
                label="AlphaFold",
                source="plugin",
                tier="optional",
                auto_install=False,
                components=[
                    Component(
                        id="alphafold_service",
                        label="AlphaFold",
                        status="unavailable",
                        source="plugin",
                        path="http://localhost:9001",
                    ),
                ],
            )
        )
        with patch(
            "src.routes.toolbox.check_plugin_health",
            new_callable=AsyncMock,
            return_value="unavailable",
        ):
            client = TestClient(app)
            resp = client.post("/toolbox/health/alphafold")
            assert resp.status_code == 200
            assert resp.json()["status"] == "unavailable"
