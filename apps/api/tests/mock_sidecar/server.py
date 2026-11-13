"""Mutable mock sidecar server.

A lightweight FastAPI app that serves canned responses from scenario fixtures.
Supports mid-test state mutation via /_control endpoints or direct set_state().

Usage:
    from tests.scenarios import fully_ready, downloading_tools
    from tests.mock_sidecar import MockSidecar

    # In-process (pytest with TestClient):
    mock = MockSidecar(fully_ready())
    client = TestClient(mock.app)
    response = client.get("/toolbox/status")

    # Mutate mid-test:
    mock.set_state(downloading_tools(50))
    response = client.get("/toolbox/status")  # now returns downloading

    # Via HTTP control endpoint:
    client.post("/_control/transition", json={
        "capability_id": "annotation",
        "component_id": "blastn",
        "status": "ready",
    })
"""

from __future__ import annotations

from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel

from src.models.toolbox import (
    ComponentStatusResponse,
    ToolboxStatusResponse,
)
from src.toolbox.registry import derive_capability_status


class TransitionRequest(BaseModel):
    """Request body for /_control/transition."""

    capability_id: str
    component_id: str
    status: Literal["ready", "downloading", "error", "unavailable"]
    progress_percent: float | None = None


class MockSidecar:
    """A mock sidecar server with mutable state.

    The state can be changed either:
    - Directly via set_state() (in-process tests)
    - Via /_control endpoints (HTTP tests)
    """

    def __init__(self, initial_scenario: ToolboxStatusResponse):
        self.current_state = initial_scenario
        self.app = FastAPI(title="Mock Sidecar")
        self._setup_routes()

    def set_state(self, scenario: ToolboxStatusResponse) -> None:
        """Direct mutation for in-process tests (no HTTP)."""
        self.current_state = scenario

    def _setup_routes(self) -> None:
        @self.app.get("/toolbox/status")
        def toolbox_status():
            return self.current_state.model_dump(exclude_none=True)

        @self.app.get("/health")
        def health():
            return {"status": "ok"}

        @self.app.post("/toolbox/retry/{cap_id}")
        def toolbox_retry(cap_id: str):
            return {"retrying": True, "capability": cap_id}

        @self.app.post("/toolbox/health/{cap_id}")
        def toolbox_health(cap_id: str):
            cap = next(
                (c for c in self.current_state.capabilities if c.id == cap_id), None
            )
            if cap is None:
                return {"capability": cap_id, "status": "unavailable", "url": ""}
            url = ""
            for comp in cap.components:
                if comp.path:
                    url = comp.path
                    break
            return {"capability": cap_id, "status": cap.status, "url": url}

        @self.app.post("/_control/set-state")
        def set_state_endpoint(body: dict):
            """Replace entire state with a new scenario (JSON body)."""
            self.current_state = ToolboxStatusResponse.model_validate(body)
            return {"ok": True}

        @self.app.post("/_control/transition")
        def transition(body: TransitionRequest):
            """Update a single component's status within the current state."""
            for cap in self.current_state.capabilities:
                if cap.id == body.capability_id:
                    for i, comp in enumerate(cap.components):
                        if comp.id == body.component_id:
                            updates: dict = {"status": body.status}
                            if (
                                body.status == "downloading"
                                and body.progress_percent is not None
                            ):
                                updates["progress"] = (
                                    ComponentStatusResponse.downloading(
                                        comp.id, percent=body.progress_percent
                                    ).progress
                                )
                            elif body.status != "downloading":
                                updates["progress"] = None
                            cap.components[i] = comp.model_copy(update=updates)
                            cap_status = derive_capability_status(
                                [c.status for c in cap.components]
                            )
                            cap_idx = self.current_state.capabilities.index(cap)
                            self.current_state.capabilities[cap_idx] = cap.model_copy(
                                update={"status": cap_status}
                            )
                            return {"ok": True, "new_status": cap_status}
            return {"ok": False, "error": "component not found"}
