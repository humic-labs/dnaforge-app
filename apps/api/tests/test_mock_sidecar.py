"""Tests for the mutable mock sidecar server.

Verifies:
- Serves canned responses from scenario fixtures
- State can be mutated mid-test (both direct and via HTTP)
- Transition endpoint updates individual components
- Health and retry endpoints work
"""

import pytest
from fastapi.testclient import TestClient

from src.models.toolbox import ToolboxStatusResponse

from .mock_sidecar import MockSidecar
from .scenarios import (
    downloading_tools,
    fresh_install,
    fully_ready,
    mixed_component_status,
    tools_error,
)


@pytest.fixture
def mock_ready():
    return MockSidecar(fully_ready())


@pytest.fixture
def client_ready(mock_ready):
    return TestClient(mock_ready.app)


@pytest.fixture
def mock_fresh():
    return MockSidecar(fresh_install())


@pytest.fixture
def client_fresh(mock_fresh):
    return TestClient(mock_fresh.app)


class TestBasicEndpoints:
    def test_health(self, client_ready):
        resp = client_ready.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

    def test_toolbox_status_ready(self, client_ready):
        resp = client_ready.get("/toolbox/status")
        assert resp.status_code == 200
        data = resp.json()
        parsed = ToolboxStatusResponse.model_validate(data)
        for cap in parsed.capabilities:
            assert cap.status == "ready", f"{cap.id} not ready"

    def test_toolbox_status_fresh(self, client_fresh):
        resp = client_fresh.get("/toolbox/status")
        data = resp.json()
        parsed = ToolboxStatusResponse.model_validate(data)
        ann = next(c for c in parsed.capabilities if c.id == "annotation")
        assert ann.status == "unavailable"

    def test_retry(self, client_ready):
        resp = client_ready.post("/toolbox/retry/annotation")
        assert resp.status_code == 200
        assert resp.json()["retrying"] is True

    def test_health_check(self, client_ready):
        resp = client_ready.post("/toolbox/health/annotation")
        assert resp.status_code == 200
        assert resp.json()["capability"] == "annotation"


class TestDirectMutation:
    def test_set_state(self, mock_ready):
        client = TestClient(mock_ready.app)

        resp = client.get("/toolbox/status")
        data = ToolboxStatusResponse.model_validate(resp.json())
        ann = next(c for c in data.capabilities if c.id == "annotation")
        assert ann.status == "ready"

        mock_ready.set_state(tools_error())

        resp = client.get("/toolbox/status")
        data = ToolboxStatusResponse.model_validate(resp.json())
        ann = next(c for c in data.capabilities if c.id == "annotation")
        assert ann.status == "error"


class TestHttpMutation:
    def test_set_state_endpoint(self, client_ready):
        new_state = fresh_install()
        resp = client_ready.post("/_control/set-state", json=new_state.model_dump())
        assert resp.status_code == 200
        assert resp.json()["ok"] is True

        resp = client_ready.get("/toolbox/status")
        data = ToolboxStatusResponse.model_validate(resp.json())
        ann = next(c for c in data.capabilities if c.id == "annotation")
        assert ann.status == "unavailable"

    def test_transition_single_component(self, client_fresh, mock_fresh):
        resp = client_fresh.get("/toolbox/status")
        data = ToolboxStatusResponse.model_validate(resp.json())
        ann = next(c for c in data.capabilities if c.id == "annotation")
        blastn = next(c for c in ann.components if c.id == "blastn")
        assert blastn.status == "unavailable"

        resp = client_fresh.post(
            "/_control/transition",
            json={
                "capability_id": "annotation",
                "component_id": "blastn",
                "status": "downloading",
                "progress_percent": 50,
            },
        )
        assert resp.status_code == 200
        assert resp.json()["ok"] is True

        resp = client_fresh.get("/toolbox/status")
        data = ToolboxStatusResponse.model_validate(resp.json())
        ann = next(c for c in data.capabilities if c.id == "annotation")
        blastn = next(c for c in ann.components if c.id == "blastn")
        assert blastn.status == "downloading"
        assert blastn.progress is not None
        assert blastn.progress.percent == 50

    def test_transition_to_ready_clears_progress(self, mock_fresh):
        client = TestClient(mock_fresh.app)

        mock_fresh.set_state(downloading_tools(75))

        resp = client.post(
            "/_control/transition",
            json={
                "capability_id": "annotation",
                "component_id": "blastn",
                "status": "ready",
            },
        )
        assert resp.json()["ok"] is True

        resp = client.get("/toolbox/status")
        data = resp.json()
        ann = next(c for c in data["capabilities"] if c["id"] == "annotation")
        blastn = next(c for c in ann["components"] if c["id"] == "blastn")
        assert blastn["status"] == "ready"
        assert "progress" not in blastn

    def test_transition_nonexistent_component(self, client_ready):
        resp = client_ready.post(
            "/_control/transition",
            json={
                "capability_id": "annotation",
                "component_id": "nonexistent",
                "status": "ready",
            },
        )
        assert resp.json()["ok"] is False


class TestStateTransitionScenario:
    """Full lifecycle: fresh → downloading → ready."""

    def test_full_lifecycle(self, mock_fresh):
        client = TestClient(mock_fresh.app)

        resp = client.get("/toolbox/status")
        data = ToolboxStatusResponse.model_validate(resp.json())
        ann = next(c for c in data.capabilities if c.id == "annotation")
        assert ann.status == "unavailable"

        mock_fresh.set_state(downloading_tools(0))
        resp = client.get("/toolbox/status")
        data = ToolboxStatusResponse.model_validate(resp.json())
        ann = next(c for c in data.capabilities if c.id == "annotation")
        assert ann.status == "downloading"

        mock_fresh.set_state(downloading_tools(50))
        resp = client.get("/toolbox/status")
        data = ToolboxStatusResponse.model_validate(resp.json())
        ann = next(c for c in data.capabilities if c.id == "annotation")
        blastn = next(c for c in ann.components if c.id == "blastn")
        assert blastn.progress is not None
        assert blastn.progress.percent == 50

        mock_fresh.set_state(fully_ready())
        resp = client.get("/toolbox/status")
        data = ToolboxStatusResponse.model_validate(resp.json())
        for cap in data.capabilities:
            assert cap.status == "ready"


class TestEdgeCases:
    """Error paths and edge cases."""

    def test_transition_nonexistent_capability(self, client_ready):
        """Transitioning a component in a nonexistent capability returns ok=False."""
        resp = client_ready.post(
            "/_control/transition",
            json={
                "capability_id": "nonexistent",
                "component_id": "blastn",
                "status": "ready",
            },
        )
        assert resp.json()["ok"] is False

    def test_set_state_invalid_json(self, client_ready):
        """Setting state with invalid data raises validation error."""
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            client_ready.post(
                "/_control/set-state",
                json={"capabilities": [{"id": "x", "bad_field": True}]},
            )

    def test_set_state_empty_capabilities(self, client_ready):
        """Empty capabilities list is valid."""
        resp = client_ready.post("/_control/set-state", json={"capabilities": []})
        assert resp.status_code == 200
        resp = client_ready.get("/toolbox/status")
        assert resp.json()["capabilities"] == []

    def test_mixed_component_status_scenario(self):
        """mixed_component_status: blastn ready + diamond downloading → downloading."""
        mock = MockSidecar(mixed_component_status())
        client = TestClient(mock.app)
        resp = client.get("/toolbox/status")
        data = ToolboxStatusResponse.model_validate(resp.json())
        ann = next(c for c in data.capabilities if c.id == "annotation")
        assert ann.status == "downloading"
        blastn = next(c for c in ann.components if c.id == "blastn")
        diamond = next(c for c in ann.components if c.id == "diamond")
        assert blastn.status == "ready"
        assert diamond.status == "downloading"

    def test_100_percent_still_downloading(self, mock_ready):
        """100% progress but still marked downloading is valid."""
        client = TestClient(mock_ready.app)
        resp = client.post(
            "/_control/transition",
            json={
                "capability_id": "annotation",
                "component_id": "blastn",
                "status": "downloading",
                "progress_percent": 100,
            },
        )
        assert resp.json()["ok"] is True
        resp = client.get("/toolbox/status")
        data = resp.json()
        ann = next(c for c in data["capabilities"] if c["id"] == "annotation")
        blastn = next(c for c in ann["components"] if c["id"] == "blastn")
        assert blastn["status"] == "downloading"
        assert blastn["progress"]["percent"] == 100
