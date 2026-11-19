"""App-owned discovery and bootstrap for the public ``dnaforge mcp`` command."""

from __future__ import annotations

import asyncio
import errno
import json
import os
import subprocess
import sys
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType
from typing import Any, BinaryIO
from uuid import uuid4

import httpx

from .managed_operations_cli import (
    OperationConnection,
    describe_runtimes,
    registered_connections,
)
from .mcp_companion.options import CompanionOptions
from .mcp_companion.runner import run_stdio_server
from .mcp_companion.sidecar import SidecarClient, SidecarClientProtocol
from .operation_connection import operation_runtime_directory

_ACTIVE_JOB_STATES = {"queued", "running"}
_APP_START_TIMEOUT_SECONDS = 30.0
_APP_LAUNCH_LOCK_NAME = "mcp-app-launch.lock"


@dataclass(frozen=True, slots=True)
class LocalMcpGrant:
    identity_id: str
    api_key: str
    workspace_id: str
    workspace_label: str


def resolve_mcp_connection(
    scope_id: str | None = None,
) -> tuple[str, OperationConnection]:
    """Select one live desktop runtime or refuse an ambiguous target."""

    candidates = [item for item in registered_connections() if item[1].mcp_stdio]
    if scope_id is not None:
        candidates = [
            item
            for item in candidates
            if item[0] == scope_id or item[1].scope_id == scope_id
        ]
    if not candidates:
        raise ValueError(
            "DNAForge is not available for MCP. Open the installed app and try again."
        )
    if len(candidates) != 1:
        raise ValueError(
            "WRONG_WORKSPACE: several DNAForge app sessions are available; "
            "select the intended workspace explicitly."
        )
    return candidates[0]


def preferred_connection_order(
    candidates: list[tuple[str, OperationConnection]],
) -> list[tuple[str, OperationConnection]]:
    """Order live app sessions: the installed app first, then the newest."""

    def registered_at(key: str) -> float:
        try:
            return (
                (operation_runtime_directory() / f"{key}.connection.json")
                .stat()
                .st_mtime
            )
        except OSError:
            return 0.0

    return sorted(
        candidates,
        key=lambda item: (
            not item[1].scope_id.startswith("packaged-profile-"),
            -registered_at(item[0]),
        ),
    )


def installed_app_command(
    packaged_executable: Path,
    *,
    platform_name: str = sys.platform,
) -> list[str]:
    """Derive the signed desktop executable from its bundled sidecar path."""

    executable = packaged_executable.resolve(strict=True)
    if platform_name == "darwin":
        contents = next(
            (parent for parent in executable.parents if parent.name == "Contents"),
            None,
        )
        if contents is None:
            raise ValueError("The bundled DNAForge application could not be located.")
        if not (contents / "MacOS" / "DNAForge").is_file():
            raise ValueError("The bundled DNAForge application could not be located.")
        return ["/usr/bin/open", "-g", "-a", str(contents.parent), "--args"]
    if platform_name == "win32":
        resources = next(
            (parent for parent in executable.parents if parent.name == "resources"),
            None,
        )
        app = resources.parent / "DNAForge.exe" if resources is not None else None
        if app is None or not app.is_file():
            raise ValueError("The bundled DNAForge application could not be located.")
        return [str(app)]
    resources = next(
        (parent for parent in executable.parents if parent.name == "resources"),
        None,
    )
    app = resources.parent / "dnaforge" if resources is not None else None
    if app is None or not app.is_file():
        raise ValueError("The bundled DNAForge application could not be located.")
    return [str(app)]


def workspace_binding_from_result(
    result: dict[str, object],
    requested_workspace: str | None,
) -> tuple[str, str]:
    """Validate a renderer-reported workspace against an explicit target."""

    if requested_workspace is None:
        return "app-following", "DNAForge registered projects"
    workspace_id = result.get("workspaceId")
    folder_paths: list[Path] = []
    folders: list[object] = []
    fields = ("projects", "referenceFolders") if "projects" in result else ("folders",)
    for field in fields:
        candidates = result.get(field)
        if candidates is None and field == "referenceFolders":
            continue
        if not isinstance(candidates, list):
            raise ValueError(
                "DNAForge did not report an authoritative project catalog."
            )
        folders.extend(candidates)
    if isinstance(folders, list):
        for folder in folders:
            if isinstance(folder, dict) and isinstance(folder.get("path"), str):
                folder_paths.append(
                    Path(folder["path"]).expanduser().resolve(strict=False)
                )
    workspace_file = result.get("workspaceFile")
    workspace_file_path: Path | None = None
    if isinstance(workspace_file, str) and workspace_file:
        workspace_file_path = Path(workspace_file).expanduser().resolve(strict=False)
    paths = [*folder_paths]
    if workspace_file_path is not None:
        paths.append(workspace_file_path)
    if requested_workspace is not None:
        requested = Path(requested_workspace).expanduser().resolve(strict=False)
        matching_folders = [
            path
            for path in folder_paths
            if os.path.normcase(str(path)) == os.path.normcase(str(requested))
        ]
        matches_workspace_file = workspace_file_path is not None and os.path.normcase(
            str(workspace_file_path)
        ) == os.path.normcase(str(requested))
        if len(matching_folders) == 1:
            path = str(matching_folders[0])
            return f"folder:{json.dumps(path, separators=(',', ':'))}", path
        if len(matching_folders) > 1 or not matches_workspace_file:
            raise ValueError(
                "WRONG_WORKSPACE: the selected DNAForge app does not own the requested workspace."
            )
    if not isinstance(workspace_id, str) or not workspace_id:
        raise ValueError("DNAForge did not report an authoritative workspace identity.")
    label = ", ".join(str(path) for path in paths) or workspace_id
    return workspace_id, label


async def bootstrap_local_mcp_grant(
    connection: OperationConnection,
    *,
    requested_workspace: str | None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> LocalMcpGrant:
    """Mint minimal authority and bind it through the existing workspace tool."""

    created = await _session_request(
        connection,
        "POST",
        "/agent-grants/local-mcp",
        body={"label": "External MCP client"},
        transport=transport,
    )
    grant = created.get("grant")
    api_key = created.get("apiKey")
    identity_id = grant.get("id") if isinstance(grant, dict) else None
    if not isinstance(identity_id, str) or not isinstance(api_key, str):
        raise ValueError("DNAForge returned an invalid local MCP grant.")

    options = CompanionOptions(
        api_url=connection.url,
        api_key=api_key,
        agent_identity=identity_id,
    )
    try:
        async with SidecarClient(options, transport=transport) as sidecar:
            status_code, workspace_job = await sidecar.call_tool(
                "get_workspace",
                {},
                idempotency_key=f"mcp-bootstrap-{uuid4()}",
            )
            if status_code >= 400:
                raise ValueError(
                    _error_message(workspace_job, "Workspace discovery failed.")
                )
            deadline = asyncio.get_running_loop().time() + options.job_timeout_seconds
            while workspace_job.get("status") in _ACTIVE_JOB_STATES:
                if asyncio.get_running_loop().time() >= deadline:
                    raise ValueError("DNAForge workspace discovery timed out.")
                job_id = workspace_job.get("jobId")
                if not isinstance(job_id, str):
                    raise ValueError("DNAForge workspace discovery returned no job id.")
                await asyncio.sleep(options.job_poll_interval_seconds)
                workspace_job = await sidecar.get_job(job_id)
        result = workspace_job.get("result")
        if workspace_job.get("status") != "completed" or not isinstance(result, dict):
            raise ValueError(
                _error_message(workspace_job, "Workspace discovery failed.")
            )
        renderer_result = result.get("result")
        if isinstance(renderer_result, dict):
            result = renderer_result
        workspace_id, workspace_label = workspace_binding_from_result(
            result,
            requested_workspace,
        )
        await _session_request(
            connection,
            "POST",
            "/agent-grants/local-mcp/bind",
            body={
                "grantId": identity_id,
                "workspaceId": workspace_id,
                "workspaceLabel": workspace_label,
            },
            transport=transport,
        )
    except (Exception, asyncio.CancelledError):
        await _revoke_grant(connection, identity_id, transport=transport)
        raise
    return LocalMcpGrant(identity_id, api_key, workspace_id, workspace_label)


class AppOwnedMcpClient(SidecarClientProtocol):
    """MCP client whose connection location is refreshed from app-owned state."""

    def __init__(
        self,
        *,
        packaged_executable: Path | None,
        requested_workspace: str | None,
        requested_runtime: str | None = None,
        launch_if_needed: bool = False,
    ) -> None:
        self.packaged_executable = packaged_executable
        self.requested_workspace = requested_workspace
        self.requested_runtime = requested_runtime
        self.launch_if_needed = launch_if_needed
        self._registry_key = ""
        self._scope_id = ""
        self._grant: LocalMcpGrant | None = None
        self._client: SidecarClient | None = None
        self._client_url = ""
        self._client_session_token = ""

    async def __aenter__(self) -> AppOwnedMcpClient:
        available = await self._connections_at_startup()
        candidates = available
        if self.requested_runtime is not None:
            candidates = [
                item
                for item in available
                if self.requested_runtime in (item[0], item[1].scope_id)
            ]
            if not candidates:
                raise ValueError(
                    f"No live DNAForge app session is named {self.requested_runtime}. "
                    f"Live sessions: {describe_runtimes(available)}"
                )
        take_first = self.requested_workspace is None
        errors: list[str] = []
        matches: list[tuple[str, OperationConnection, LocalMcpGrant]] = []
        for key, connection in preferred_connection_order(candidates):
            try:
                grant = await bootstrap_local_mcp_grant(
                    connection,
                    requested_workspace=self.requested_workspace,
                )
                matches.append((key, connection, grant))
            except httpx.HTTPError as exc:
                errors.append(f"{key} ({connection.scope_id}): not answering ({exc})")
                continue
            except (RuntimeError, ValueError) as exc:
                errors.append(f"{key} ({connection.scope_id}): {exc}")
            if take_first:
                break
        if len(matches) != 1:
            for _key, connection, grant in matches:
                await _revoke_grant(connection, grant.identity_id)
            if len(matches) > 1:
                raise ValueError(
                    "WRONG_WORKSPACE: more than one DNAForge app owns the requested workspace."
                )
            if self.requested_workspace is not None and all(
                "WRONG_WORKSPACE" in error for error in errors
            ):
                detail = (
                    "WRONG_WORKSPACE: no DNAForge app session owns the requested workspace. "
                    f"Live sessions: {describe_runtimes(candidates)}"
                )
            else:
                detail = "No DNAForge app session could be used. " + "; ".join(errors)
            raise ValueError(detail)
        self._registry_key, connection, self._grant = matches[0]
        self._scope_id = connection.scope_id
        await self._replace_client(connection)
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        if self._client is not None:
            await self._client.__aexit__(exc_type, exc, traceback)
            self._client = None

    async def discover(
        self,
        *,
        client_info: dict[str, Any] | None = None,
        include_open_workspace_resources: bool = False,
    ) -> dict[str, Any]:
        return await (await self._current_client()).discover(
            client_info=client_info,
            include_open_workspace_resources=include_open_workspace_resources,
        )

    async def lookup_tool(
        self, name: str, *, portable_names: bool
    ) -> dict[str, Any] | None:
        return await (await self._current_client()).lookup_tool(
            name, portable_names=portable_names
        )

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        *,
        idempotency_key: str,
    ) -> tuple[int, dict[str, Any]]:
        return await (await self._current_client()).call_tool(
            name,
            arguments,
            idempotency_key=idempotency_key,
        )

    async def get_job(self, job_id: str) -> dict[str, Any]:
        return await (await self._current_client()).get_job(job_id)

    async def cancel_job(self, job_id: str) -> None:
        await (await self._current_client()).cancel_job(job_id)

    async def read_resource(self, uri: str) -> dict[str, Any]:
        return await (await self._current_client()).read_resource(uri)

    async def _current_client(self) -> SidecarClient:
        connection = self._selected_connection()
        connection_changed = (
            connection.url != self._client_url
            or connection.session_token != self._client_session_token
        )
        if self._client is not None and connection_changed:
            await self._refresh_workspace_grant(connection)
        elif self.requested_workspace is None and self._grant is not None:
            await self.refresh_workspace_binding()
        if self._client is None or connection_changed:
            await self._replace_client(connection)
        assert self._client is not None
        return self._client

    async def _refresh_workspace_grant(
        self,
        connection: OperationConnection,
    ) -> None:
        """Mint fresh app-owned authority after the owning app generation changes."""

        replacement = await bootstrap_local_mcp_grant(
            connection,
            requested_workspace=self.requested_workspace,
        )
        previous = self._grant
        self._grant = replacement
        if previous is not None:
            await _revoke_grant(connection, previous.identity_id)

    async def refresh_workspace_binding(self) -> bool:
        if self.requested_workspace is not None or self._grant is None:
            return False
        previous = self._grant
        if previous.workspace_id == "app-following":
            return False
        connection = self._selected_connection()
        await _session_request(
            connection,
            "POST",
            "/agent-grants/local-mcp/bind",
            body={
                "grantId": previous.identity_id,
                "workspaceId": "app-following",
                "workspaceLabel": "DNAForge registered projects",
            },
        )
        self._grant = LocalMcpGrant(
            previous.identity_id,
            previous.api_key,
            "app-following",
            "DNAForge registered projects",
        )
        return True

    async def _replace_client(self, connection: OperationConnection) -> None:
        if self._grant is None:
            raise ValueError("The app-owned MCP grant is unavailable.")
        if self._client is not None:
            await self._client.__aexit__(None, None, None)
        self._client = SidecarClient(
            CompanionOptions(
                api_url=connection.url,
                api_key=self._grant.api_key,
                agent_identity=self._grant.identity_id,
            )
        )
        await self._client.__aenter__()
        self._client_url = connection.url
        self._client_session_token = connection.session_token

    async def _connections_at_startup(self) -> list[tuple[str, OperationConnection]]:
        """Find a live app, launching one only when the user opted in.

        Agent hosts start many MCP servers at once. The launch lock makes them
        share one launch: whoever holds it launches, the rest wait and then find
        the registration it produced.
        """

        candidates = _mcp_connections()
        if candidates:
            return candidates
        if not self.launch_if_needed:
            raise ValueError(
                "DNAForge is not running. Open DNAForge, then reconnect this MCP "
                "client (or run dnaforge mcp --launch-if-needed)."
            )
        async with _app_launch_lock():
            candidates = _mcp_connections()
            if candidates:
                return candidates
            self._launch_installed_app()
            deadline = asyncio.get_running_loop().time() + _APP_START_TIMEOUT_SECONDS
            while asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(0.1)
                candidates = _mcp_connections()
                if candidates:
                    return candidates
        raise ValueError("DNAForge did not become available for MCP within 30 seconds.")

    def _selected_connection(self) -> OperationConnection:
        exact = [
            connection
            for key, connection in _mcp_connections()
            if key == self._registry_key and connection.scope_id == self._scope_id
        ]
        if len(exact) != 1:
            raise ValueError(
                "WRONG_WORKSPACE: the originally selected DNAForge app session is "
                "unavailable. Reopen DNAForge to continue."
            )
        return exact[0]

    def _launch_installed_app(self) -> None:
        if self.packaged_executable is None:
            raise ValueError(
                "DNAForge is not running and this command is not inside an installed app."
            )
        command = [
            *installed_app_command(self.packaged_executable),
            "--launched-by=mcp",
        ]
        if self.requested_workspace is not None:
            workspace = (
                Path(self.requested_workspace).expanduser().resolve(strict=False)
            )
            command.append(f"--workspace={workspace}")
        kwargs: dict[str, Any] = {
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "close_fds": True,
        }
        if os.name == "nt":
            kwargs["creationflags"] = 0x00000008 | 0x00000200
        else:
            kwargs["start_new_session"] = True
        subprocess.Popen(command, **kwargs)


def _mcp_connections() -> list[tuple[str, OperationConnection]]:
    return [item for item in registered_connections() if item[1].mcp_stdio]


@asynccontextmanager
async def _app_launch_lock() -> AsyncIterator[None]:
    """Cross-process lock shared by every ``dnaforge mcp`` on this machine."""

    path = operation_runtime_directory() / _APP_LAUNCH_LOCK_NAME
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(descriptor, "r+b", buffering=0) as file:
        await asyncio.to_thread(_lock_file, file)
        try:
            yield
        finally:
            _unlock_file(file)


def _lock_file(file: BinaryIO) -> None:
    if os.name == "nt":
        import msvcrt

        if file.seek(0, os.SEEK_END) == 0:
            file.write(b"\0")
        while True:
            file.seek(0)
            try:
                msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
                return
            except OSError as exc:
                if exc.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                    raise
                time.sleep(0.1)

    import fcntl

    fcntl.flock(file.fileno(), fcntl.LOCK_EX)


def _unlock_file(file: BinaryIO) -> None:
    if os.name == "nt":
        import msvcrt

        file.seek(0)
        msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
        return

    import fcntl

    fcntl.flock(file.fileno(), fcntl.LOCK_UN)


async def run_external_mcp(
    *,
    packaged_executable: Path | None,
    workspace: str | None,
    runtime: str | None = None,
    launch_if_needed: bool = False,
) -> None:
    options = CompanionOptions(
        agent_identity="app-owned-external-mcp", portable_tool_names=True
    )
    async with AppOwnedMcpClient(
        packaged_executable=packaged_executable,
        requested_workspace=workspace,
        requested_runtime=runtime,
        launch_if_needed=launch_if_needed,
    ) as sidecar:
        await run_stdio_server(sidecar, options)


def main(
    *,
    packaged_executable: Path | None,
    workspace: str | None,
    runtime: str | None = None,
    launch_if_needed: bool = False,
) -> int:
    try:
        asyncio.run(
            run_external_mcp(
                packaged_executable=packaged_executable,
                workspace=workspace,
                runtime=runtime,
                launch_if_needed=launch_if_needed,
            )
        )
    except (httpx.HTTPError, OSError, ValueError) as exc:
        print(f"dnaforge mcp: {exc}", file=sys.stderr)
        return 1
    return 0


async def _session_request(
    connection: OperationConnection,
    method: str,
    path: str,
    *,
    body: dict[str, Any] | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    async with httpx.AsyncClient(
        base_url=connection.url,
        headers={"X-DNAForge-Session": connection.session_token},
        timeout=30,
        transport=transport,
        trust_env=False,
        follow_redirects=False,
    ) as client:
        response = await client.request(method, path, json=body)
    try:
        payload = response.json()
    except ValueError as exc:
        raise ValueError("DNAForge returned a non-JSON bootstrap response.") from exc
    if not isinstance(payload, dict):
        raise ValueError("DNAForge returned an invalid bootstrap response.")
    if response.status_code >= 400 or payload.get("ok") is not True:
        raise ValueError(_error_message(payload, "DNAForge refused MCP bootstrap."))
    return payload


async def _revoke_grant(
    connection: OperationConnection,
    identity_id: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> None:
    try:
        await _session_request(
            connection,
            "DELETE",
            f"/agent-grants/{identity_id}",
            transport=transport,
        )
    except (httpx.HTTPError, ValueError):
        pass


def _error_message(payload: dict[str, Any], fallback: str) -> str:
    error = payload.get("error")
    if isinstance(error, dict):
        message = error.get("message")
        code = error.get("code")
        if isinstance(message, str):
            return f"{code}: {message}" if isinstance(code, str) else message
    return fallback
