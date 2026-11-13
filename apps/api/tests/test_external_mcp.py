from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import httpx
import pytest

from src.external_mcp import (
    AppOwnedMcpClient,
    LocalMcpGrant,
    bootstrap_local_mcp_grant,
    installed_app_command,
    resolve_mcp_connection,
    workspace_binding_from_result,
)
from src.operation_connection import operation_runtime_directory


def _register(directory: Path, name: str, *, mcp_stdio: bool, scope: str) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}.connection.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "url": "http://127.0.0.1:8123",
                "session_token": f"session-{name}",
                "operation_token": f"operation-{name}",
                "scope_id": scope,
                "owner_id": "local-human",
                "owner_instance": f"instance-{name}",
                "mcp_stdio": mcp_stdio,
                "pid": os.getpid(),
            }
        )
    )
    path.chmod(0o600)


def test_resolve_mcp_connection_ignores_non_app_managed_runtimes(tmp_path, monkeypatch):
    registry = tmp_path / "registry"
    monkeypatch.setenv("DNAFORGE_OPERATION_RUNTIME_DIR", str(registry))
    _register(registry, "standalone", mcp_stdio=False, scope="lab")
    _register(registry, "desktop", mcp_stdio=True, scope="installed")

    name, connection = resolve_mcp_connection()

    assert operation_runtime_directory() == registry
    assert name == "desktop"
    assert connection.scope_id == "installed"
    assert connection.mcp_stdio is True


def test_resolve_mcp_connection_refuses_ambiguous_apps(tmp_path, monkeypatch):
    registry = tmp_path / "registry"
    monkeypatch.setenv("DNAFORGE_OPERATION_RUNTIME_DIR", str(registry))
    _register(registry, "first", mcp_stdio=True, scope="profile-a")
    _register(registry, "second", mcp_stdio=True, scope="profile-b")

    with pytest.raises(ValueError, match="WRONG_WORKSPACE"):
        resolve_mcp_connection()
    assert resolve_mcp_connection("profile-b")[0] == "second"


def test_installed_app_command_is_derived_from_signed_bundle_not_path(tmp_path):
    mac_binary = (
        tmp_path
        / "DNAForge.app"
        / "Contents"
        / "Resources"
        / "binaries"
        / "waypoint-api-aarch64-apple-darwin"
        / "waypoint-api"
    )
    mac_app = tmp_path / "DNAForge.app" / "Contents" / "MacOS" / "DNAForge"
    mac_binary.parent.mkdir(parents=True)
    mac_app.parent.mkdir(parents=True)
    mac_binary.write_text("sidecar")
    mac_app.write_text("app")

    assert installed_app_command(mac_binary, platform_name="darwin") == [
        "/usr/bin/open",
        "-g",
        "-a",
        str(tmp_path / "DNAForge.app"),
        "--args",
    ]


def test_app_start_carries_the_explicit_workspace_into_the_signed_app(
    tmp_path, monkeypatch
):
    mac_binary = (
        tmp_path
        / "DNAForge.app"
        / "Contents"
        / "Resources"
        / "binaries"
        / "waypoint-api-aarch64-apple-darwin"
        / "waypoint-api"
    )
    mac_app = tmp_path / "DNAForge.app" / "Contents" / "MacOS" / "DNAForge"
    project = tmp_path / "project"
    mac_binary.parent.mkdir(parents=True)
    mac_app.parent.mkdir(parents=True)
    project.mkdir()
    mac_binary.write_text("sidecar")
    mac_app.write_text("app")
    launched: list[list[str]] = []
    monkeypatch.setattr(
        "src.external_mcp.subprocess.Popen",
        lambda command, **_kwargs: launched.append(command),
    )
    monkeypatch.setattr(
        "src.external_mcp.installed_app_command",
        lambda executable: installed_app_command(executable, platform_name="darwin"),
    )

    client = AppOwnedMcpClient(
        packaged_executable=mac_binary,
        requested_workspace=str(project),
    )
    client._launch_installed_app()

    assert launched == [
        [
            "/usr/bin/open",
            "-g",
            "-a",
            str(tmp_path / "DNAForge.app"),
            "--args",
            "--launched-by=mcp",
            f"--workspace={project}",
        ]
    ]


def test_workspace_binding_uses_a_stable_folder_root_and_refuses_wrong_target(
    tmp_path,
):
    project = tmp_path / "project"
    project.mkdir()
    result = {
        "workspaceId": f'folders:["{project}"]',
        "folders": [{"name": "project", "path": str(project)}],
    }

    workspace_id, label = workspace_binding_from_result(result, str(project))

    assert workspace_id == f'folder:"{project}"'
    assert label == str(project)
    with pytest.raises(ValueError, match="WRONG_WORKSPACE"):
        workspace_binding_from_result(result, str(tmp_path / "another"))


def test_workspace_binding_uses_the_open_workspace_without_setup(
    tmp_path,
):
    project = tmp_path / "project"
    other = tmp_path / "other"
    project.mkdir()
    other.mkdir()
    result = {
        "workspaceId": f'folders:["{project}"]',
        "folders": [{"name": "project", "path": str(project)}],
    }

    assert workspace_binding_from_result(result, None) == (
        f'folder:"{project}"',
        str(project),
    )

    result["workspaceId"] = f'folders:["{other}","{project}"]'
    result["folders"].append({"name": "other", "path": str(other)})
    assert workspace_binding_from_result(result, None) == (
        result["workspaceId"],
        f"{project}, {other}",
    )
    assert workspace_binding_from_result(result, str(project)) == (
        f'folder:"{project}"',
        str(project),
    )
    with pytest.raises(ValueError, match="WRONG_WORKSPACE"):
        workspace_binding_from_result(result, str(tmp_path / "not-open"))


@pytest.mark.asyncio
async def test_bootstrap_mints_low_scope_authority_and_binds_reported_workspace(
    tmp_path,
):
    project = tmp_path / "project"
    project.mkdir()
    calls: list[tuple[str, str, dict[str, str]]] = []

    def handle(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path, dict(request.headers)))
        if request.url.path == "/agent-grants/local-mcp":
            assert request.headers["x-dnaforge-session"] == "session-app"
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "grant": {"id": "agent_stdio_test"},
                    "apiKey": "dna_key_test",
                },
            )
        if request.url.path == "/mcp/call":
            assert request.headers["x-dnaforge-api-key"] == "dna_key_test"
            assert request.headers["x-dnaforge-agent-identity"] == "agent_stdio_test"
            assert "x-dnaforge-session" not in request.headers
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "status": "completed",
                    "jobId": "job-1",
                    "result": {
                        "ok": True,
                        "result": {
                            "workspaceId": f'folders:["{project}"]',
                            "workspaceFile": None,
                            "folders": [{"name": "project", "path": str(project)}],
                        },
                    },
                },
            )
        if request.url.path == "/agent-grants/local-mcp/bind":
            assert request.headers["x-dnaforge-session"] == "session-app"
            return httpx.Response(200, json={"ok": True})
        raise AssertionError(f"unexpected request: {request.method} {request.url.path}")

    connection = _connection("session-app")
    result = await bootstrap_local_mcp_grant(
        connection,
        requested_workspace=str(project),
        transport=httpx.MockTransport(handle),
    )

    assert result.identity_id == "agent_stdio_test"
    assert result.api_key == "dna_key_test"
    assert result.workspace_id == f'folder:"{project}"'
    assert result.workspace_label == str(project)
    assert [path for _method, path, _headers in calls] == [
        "/agent-grants/local-mcp",
        "/mcp/call",
        "/agent-grants/local-mcp/bind",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("requested_workspace", ["explicit", None])
async def test_app_restart_rebinds_with_new_app_authority(
    tmp_path, monkeypatch, requested_workspace
):
    project = tmp_path / "project"
    project.mkdir()
    requested_workspace = str(project) if requested_workspace == "explicit" else None
    previous = LocalMcpGrant("old-grant", "old-key", "old-workspace", str(project))
    replacement = LocalMcpGrant("new-grant", "new-key", "new-workspace", str(project))
    rebound: list[tuple[str, str | None]] = []
    revoked: list[str] = []

    async def fake_bootstrap(connection, *, requested_workspace, transport=None):
        del transport
        rebound.append((connection.session_token, requested_workspace))
        return replacement

    async def fake_revoke(connection, identity_id, *, transport=None):
        del connection, transport
        revoked.append(identity_id)

    monkeypatch.setattr("src.external_mcp.bootstrap_local_mcp_grant", fake_bootstrap)
    monkeypatch.setattr("src.external_mcp._revoke_grant", fake_revoke)
    client = AppOwnedMcpClient(
        packaged_executable=None,
        requested_workspace=requested_workspace,
    )
    client._grant = previous

    await client._refresh_workspace_grant(_connection("new-session"))

    assert client._grant == replacement
    assert rebound == [("new-session", requested_workspace)]
    assert revoked == ["old-grant"]


@pytest.mark.asyncio
@pytest.mark.parametrize("bind_ok", [True, False])
async def test_live_workspace_refresh_preserves_the_existing_grant(
    tmp_path, monkeypatch, bind_ok
):
    previous = LocalMcpGrant("old-grant", "old-key", "old-workspace", str(tmp_path))
    probe = LocalMcpGrant("probe-grant", "probe-key", "new-workspace", str(tmp_path))
    bound: list[dict] = []
    revoked: list[str] = []

    async def bootstrap(connection, *, requested_workspace, transport=None):
        assert requested_workspace is None
        return probe

    async def request(connection, method, path, *, body=None, transport=None):
        assert method == "POST" and path == "/agent-grants/local-mcp/bind"
        bound.append(body)
        if not bind_ok:
            raise ValueError("The active local MCP grant was not found.")
        return {"ok": True}

    async def revoke(connection, identity_id, *, transport=None):
        revoked.append(identity_id)

    monkeypatch.setattr("src.external_mcp.bootstrap_local_mcp_grant", bootstrap)
    monkeypatch.setattr("src.external_mcp._session_request", request)
    monkeypatch.setattr("src.external_mcp._revoke_grant", revoke)
    client = AppOwnedMcpClient(packaged_executable=None, requested_workspace=None)
    monkeypatch.setattr(
        client, "_selected_connection", lambda: _connection("same-session")
    )
    client._grant = previous
    if bind_ok:
        assert await client.refresh_workspace_binding() is True
        assert client._grant == LocalMcpGrant(
            previous.identity_id,
            previous.api_key,
            probe.workspace_id,
            probe.workspace_label,
        )
    else:
        with pytest.raises(ValueError, match="active local MCP grant"):
            await client.refresh_workspace_binding()
        assert client._grant is previous
    assert bound == [
        {
            "grantId": previous.identity_id,
            "workspaceId": probe.workspace_id,
            "workspaceLabel": probe.workspace_label,
        }
    ]
    assert revoked == [probe.identity_id]


@pytest.mark.asyncio
async def test_explicit_project_binding_does_not_follow_the_open_workspace(monkeypatch):
    client = AppOwnedMcpClient(
        packaged_executable=None, requested_workspace="/explicit"
    )
    monkeypatch.setattr(
        client, "_selected_connection", lambda: pytest.fail("must not rebind")
    )
    assert await client.refresh_workspace_binding() is False


def _connection(session_token: str):
    from src.managed_operations_cli import OperationConnection

    return OperationConnection(
        url="http://127.0.0.1:8123",
        session_token=session_token,
        operation_token="operation",
        scope_id="installed",
        owner_id="local-human",
        mcp_stdio=True,
    )


def _selection_client(tmp_path, monkeypatch, *, runtime=None, failing=()):
    registry = tmp_path / "registry"
    monkeypatch.setenv("DNAFORGE_OPERATION_RUNTIME_DIR", str(registry))
    attempted: list[str] = []

    async def fake_bootstrap(connection, *, requested_workspace, transport=None):
        del requested_workspace, transport
        attempted.append(connection.scope_id)
        if connection.scope_id in failing:
            raise httpx.ConnectError("not answering")
        return LocalMcpGrant(f"grant-{connection.scope_id}", "key", "ws", "label")

    async def fake_replace(self, connection):
        del self, connection

    monkeypatch.setattr("src.external_mcp.bootstrap_local_mcp_grant", fake_bootstrap)
    monkeypatch.setattr(AppOwnedMcpClient, "_replace_client", fake_replace)
    client = AppOwnedMcpClient(
        packaged_executable=None, requested_workspace=None, requested_runtime=runtime
    )
    return registry, client, attempted


def _age(registry: Path, name: str, seconds_ago: int) -> None:
    path = registry / f"{name}.connection.json"
    stamp = path.stat().st_mtime - seconds_ago
    os.utime(path, (stamp, stamp))


@pytest.mark.asyncio
async def test_several_apps_prefer_the_installed_app_over_newer_dev_builds(
    tmp_path, monkeypatch
):
    registry, client, attempted = _selection_client(tmp_path, monkeypatch)
    _register(registry, "installed", mcp_stdio=True, scope="packaged-profile-a")
    _register(registry, "dev", mcp_stdio=True, scope="dev-b")
    _age(registry, "installed", 60)

    await client.__aenter__()

    assert attempted == ["packaged-profile-a"]
    assert client._scope_id == "packaged-profile-a"


@pytest.mark.asyncio
async def test_several_dev_apps_choose_the_newest_and_skip_one_that_does_not_answer(
    tmp_path, monkeypatch
):
    registry, client, attempted = _selection_client(
        tmp_path, monkeypatch, failing={"dev-new"}
    )
    for name in ("old", "middle", "new"):
        _register(registry, name, mcp_stdio=True, scope=f"dev-{name}")
    _age(registry, "old", 120)
    _age(registry, "middle", 60)

    await client.__aenter__()

    assert attempted == ["dev-new", "dev-middle"]
    assert client._scope_id == "dev-middle"


@pytest.mark.asyncio
async def test_explicit_runtime_selects_by_registry_name_or_scope(
    tmp_path, monkeypatch
):
    registry, client, attempted = _selection_client(
        tmp_path, monkeypatch, runtime="dev-b"
    )
    _register(registry, "installed", mcp_stdio=True, scope="packaged-profile-a")
    _register(registry, "dev", mcp_stdio=True, scope="dev-b")

    await client.__aenter__()

    assert attempted == ["dev-b"]


@pytest.mark.asyncio
async def test_unknown_runtime_is_refused_with_the_live_sessions(tmp_path, monkeypatch):
    registry, client, attempted = _selection_client(
        tmp_path, monkeypatch, runtime="nope"
    )
    _register(registry, "installed", mcp_stdio=True, scope="packaged-profile-a")

    with pytest.raises(ValueError, match=r"installed \(packaged-profile-a\)"):
        await client.__aenter__()
    assert attempted == []


@pytest.mark.asyncio
async def test_a_preferred_app_that_refuses_is_reported_not_skipped(
    tmp_path, monkeypatch
):
    registry, client, _attempted = _selection_client(tmp_path, monkeypatch)
    _register(registry, "dev", mcp_stdio=True, scope="dev-b")

    _register(registry, "installed", mcp_stdio=True, scope="packaged-profile-a")
    attempted: list[str] = []

    async def several_projects(connection, *, requested_workspace, transport=None):
        del requested_workspace, transport
        attempted.append(connection.scope_id)
        raise ValueError("WRONG_WORKSPACE: run dnaforge mcp --workspace PATH.")

    monkeypatch.setattr("src.external_mcp.bootstrap_local_mcp_grant", several_projects)

    with pytest.raises(
        ValueError, match=r"installed \(packaged-profile-a\): .*--workspace PATH"
    ):
        await client.__aenter__()
    assert attempted == ["packaged-profile-a"]


@pytest.mark.asyncio
async def test_no_running_app_fails_fast_without_launch_opt_in(tmp_path, monkeypatch):
    monkeypatch.setenv("DNAFORGE_OPERATION_RUNTIME_DIR", str(tmp_path / "registry"))
    launched: list[object] = []
    monkeypatch.setattr(
        AppOwnedMcpClient, "_launch_installed_app", lambda self: launched.append(self)
    )
    client = AppOwnedMcpClient(packaged_executable=None, requested_workspace=None)

    with pytest.raises(ValueError, match="DNAForge is not running"):
        await client.__aenter__()
    assert launched == []


@pytest.mark.asyncio
async def test_concurrent_mcp_servers_share_one_app_launch(tmp_path, monkeypatch):
    registry = tmp_path / "registry"
    monkeypatch.setenv("DNAFORGE_OPERATION_RUNTIME_DIR", str(registry))
    launches: list[object] = []

    def launch_app_that_registers_later(self):
        launches.append(self)
        asyncio.get_running_loop().call_later(
            0.3,
            lambda: _register(registry, "installed", mcp_stdio=True, scope="installed"),
        )

    monkeypatch.setattr(
        AppOwnedMcpClient, "_launch_installed_app", launch_app_that_registers_later
    )
    clients = [
        AppOwnedMcpClient(
            packaged_executable=None, requested_workspace=None, launch_if_needed=True
        )
        for _ in range(8)
    ]

    found = await asyncio.gather(
        *(client._connections_at_startup() for client in clients)
    )

    assert len(launches) == 1
    assert all([key for key, _ in candidates] == ["installed"] for candidates in found)


@pytest.mark.asyncio
async def test_quitting_the_app_mid_session_does_not_relaunch_it(tmp_path, monkeypatch):
    monkeypatch.setenv("DNAFORGE_OPERATION_RUNTIME_DIR", str(tmp_path / "registry"))
    launched: list[object] = []
    monkeypatch.setattr(
        AppOwnedMcpClient, "_launch_installed_app", lambda self: launched.append(self)
    )
    client = AppOwnedMcpClient(
        packaged_executable=None, requested_workspace=None, launch_if_needed=True
    )
    client._registry_key = "installed"
    client._scope_id = "installed"

    with pytest.raises(ValueError, match="Reopen DNAForge"):
        await client.call_tool("get_workspace", {}, idempotency_key="after-quit")
    assert launched == []
