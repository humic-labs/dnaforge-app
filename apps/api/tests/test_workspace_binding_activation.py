from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.concurrency import workspace_binding_activation


@pytest.mark.parametrize(
    ("method", "path", "status", "calls"),
    [
        ("POST", "/agent-grants/local-mcp/bind", 200, 1),
        ("POST", "/agent-grants/local-mcp/bind", 401, 0),
        ("POST", "/agent-grants/local-mcp/bind", 404, 0),
        ("POST", "/agent-grants/local-mcp/bind", 422, 0),
        ("GET", "/agent-grants/local-mcp/bind", 200, 0),
        ("POST", "/agent-grants/local-mcp", 200, 0),
    ],
)
def test_activation_follows_only_successful_bind_response(
    monkeypatch, method, path, status, calls
):
    from starlette.responses import JSONResponse

    app = FastAPI()
    activate = AsyncMock(return_value=True)
    monkeypatch.setattr(
        workspace_binding_activation, "activate_bound_workspace", activate
    )

    async def endpoint():
        return JSONResponse({"ok": status == 200}, status_code=status)

    app.add_api_route(path, endpoint, methods=[method])
    app.add_middleware(
        workspace_binding_activation.WorkspaceBindingActivationMiddleware
    )
    response = TestClient(app).request(method, path)
    assert response.status_code == status
    assert response.json() == {"ok": status == 200}
    assert activate.await_count == calls


def test_app_activates_after_binding_is_committed(tmp_path, monkeypatch):
    from src.control_plane import initialize_control_plane
    from src.main import app

    store = initialize_control_plane(tmp_path / "activation.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", "activation-session")
    headers = {"X-DNAForge-Session": "activation-session"}
    client = TestClient(app)
    grant_id = client.post(
        "/agent-grants/local-mcp", headers=headers, json={"label": "Local MCP"}
    ).json()["grant"]["id"]

    async def activate():
        assert store.get_agent_identity(grant_id)["bound_workspace_id"] == "workspace"
        return True

    activation = AsyncMock(side_effect=activate)
    monkeypatch.setattr(
        workspace_binding_activation, "activate_bound_workspace", activation
    )
    body = {
        "grantId": grant_id,
        "workspaceId": "workspace",
        "workspaceLabel": "Workspace",
    }
    assert (
        client.post(
            "/agent-grants/local-mcp/bind", headers=headers, json=body
        ).status_code
        == 200
    )
    activation.assert_awaited_once()
    assert (
        client.post(
            "/agent-grants/local-mcp/bind",
            headers=headers,
            json={**body, "grantId": "missing"},
        ).status_code
        == 404
    )
    activation.assert_awaited_once()
