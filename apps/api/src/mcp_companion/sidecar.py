"""Authenticated asynchronous loopback client used by the MCP projection."""

from __future__ import annotations

import asyncio
import json
import os
import stat
from types import TracebackType
from typing import Any, Protocol, runtime_checkable
from urllib.parse import urlsplit

import httpx

from .options import CompanionOptions

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


class SidecarClientProtocol(Protocol):
    async def discover(
        self,
        *,
        client_info: dict[str, Any] | None = None,
        include_open_workspace_resources: bool = False,
    ) -> dict[str, Any]: ...

    async def lookup_tool(
        self, name: str, *, portable_names: bool
    ) -> dict[str, Any] | None: ...

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        *,
        idempotency_key: str,
    ) -> tuple[int, dict[str, Any]]: ...

    async def get_job(self, job_id: str) -> dict[str, Any]: ...

    async def cancel_job(self, job_id: str) -> None: ...

    async def read_resource(self, uri: str) -> dict[str, Any]: ...


@runtime_checkable
class WorkspaceBindingRefresher(Protocol):
    """App-owned clients can follow workspace changes without renewing authority."""

    async def refresh_workspace_binding(self) -> bool: ...


class SidecarHTTPError(RuntimeError):
    def __init__(self, message: str, status_code: int, body: dict[str, Any]):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.body = body


class SidecarClient:
    """Thin HTTP client; authorization remains authoritative in FastAPI."""

    def __init__(
        self,
        options: CompanionOptions,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.options = options
        self.api_url = validate_loopback_api_url(options.api_url)
        self._session_token = options.session_token
        self._generation: int | None = None
        self._job_generations: dict[str, int | None] = {}
        initial = self._read_authority()
        if initial and initial.get("sessionToken") == self._session_token:
            self._generation = initial["generation"]
        self._client = httpx.AsyncClient(
            base_url=self.api_url,
            headers=self._auth_headers(),
            timeout=options.request_timeout_seconds,
            transport=transport,
            trust_env=False,
        )

    async def __aenter__(self) -> SidecarClient:
        await self._client.__aenter__()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self._client.__aexit__(exc_type, exc, traceback)

    async def discover(
        self,
        *,
        client_info: dict[str, Any] | None = None,
        include_open_workspace_resources: bool = False,
    ) -> dict[str, Any]:
        payload = {"clientInfo": client_info} if client_info is not None else {}
        if include_open_workspace_resources:
            payload["includeOpenWorkspaceResources"] = True

        for attempt in range(2):
            try:
                status_code, body = await self._request_json(
                    "POST", "/mcp/discover", json_body=payload
                )
                break
            except (
                httpx.ReadError,
                httpx.RemoteProtocolError,
                SidecarHTTPError,
            ) as exc:
                if (
                    isinstance(exc, SidecarHTTPError)
                    and exc.body.get("error", {}).get("code")
                    != "MCP_TRANSPORT_UNAVAILABLE"
                ):
                    raise
                if attempt == 0:
                    continue
                kind = (
                    exc.body.get("error", {})
                    .get("details", {})
                    .get("exceptionType", type(exc).__name__)
                    if isinstance(exc, SidecarHTTPError)
                    else type(exc).__name__
                )
                message = f"DNAForge sidecar catalog read failed ({kind})."
                raise SidecarHTTPError(
                    message,
                    503,
                    {
                        "error": {
                            "code": "MCP_DISCOVERY_TRANSPORT_UNAVAILABLE",
                            "message": message,
                        }
                    },
                ) from exc
        self._raise_for_error("DNAForge sidecar rejected discovery.", status_code, body)
        if body.get("ok") is not True:
            raise SidecarHTTPError(
                "DNAForge sidecar returned an invalid discovery response.",
                status_code,
                body,
            )
        return body

    async def lookup_tool(
        self, name: str, *, portable_names: bool
    ) -> dict[str, Any] | None:
        status, body = await self._request_json(
            "POST",
            "/mcp/discover",
            json_body={"toolLookup": {"name": name, "portableNames": portable_names}},
        )
        self._raise_for_error("DNAForge sidecar rejected tool lookup.", status, body)
        tool = body.get("tool")
        if body.get("ok") is not True or (
            tool is not None
            and (
                not isinstance(tool, dict)
                or not isinstance(tool.get("name"), str)
                or not isinstance(tool.get("cancelable"), bool)
            )
        ):
            raise SidecarHTTPError("Invalid DNAForge tool lookup response.", 502, body)
        return tool

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        *,
        idempotency_key: str,
    ) -> tuple[int, dict[str, Any]]:
        status_code, body = await self._request_json(
            "POST",
            "/mcp/call",
            json_body={"params": {"name": name, "arguments": arguments}},
            headers={"Idempotency-Key": idempotency_key, "Prefer": "respond-async"},
            admission=True,
        )
        return status_code, body

    async def get_job(self, job_id: str) -> dict[str, Any]:
        status_code, body = await self._request_json("GET", f"/mcp/jobs/{job_id}")
        body = self._lost_job(job_id, body)
        self._raise_for_error(
            "DNAForge sidecar rejected job status.", status_code, body
        )
        if body.get("status") not in {"queued", "running"}:
            self._job_generations.pop(job_id, None)
        return body

    async def cancel_job(self, job_id: str) -> None:
        status_code, body = await self._request_json("DELETE", f"/mcp/jobs/{job_id}")
        if status_code >= 400:
            body = self._lost_job(job_id, body)
            self._raise_for_error(
                "DNAForge sidecar rejected job cancellation.",
                status_code,
                body,
            )
        self._job_generations.pop(job_id, None)

    async def read_resource(self, uri: str) -> dict[str, Any]:
        status_code, body = await self._request_json(
            "POST", "/mcp/resources/read", json_body={"uri": uri}
        )
        self._raise_for_error(
            "DNAForge sidecar rejected the resource read.", status_code, body
        )
        return body

    def _auth_headers(self) -> dict[str, str]:
        headers = {"X-DNAForge-Agent-Identity": self.options.agent_identity}
        if self.options.agent_capabilities is not None:
            headers["X-DNAForge-Agent-Capabilities"] = json.dumps(
                list(self.options.agent_capabilities), separators=(",", ":")
            )
        if self._session_token:
            headers["X-DNAForge-Session"] = self._session_token
        if self.options.api_key:
            headers["X-DNAForge-API-Key"] = self.options.api_key
        if self.options.turn_id:
            headers["X-DNAForge-Turn-Id"] = self.options.turn_id
        return headers

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        admission: bool = False,
    ) -> tuple[int, dict[str, Any]]:
        sent_token, sent_generation = self._session_token, self._generation

        async def send() -> httpx.Response:
            try:
                return await self._client.request(
                    method, path, json=json_body, headers=headers
                )
            except httpx.TransportError as exc:
                timeout = isinstance(exc, httpx.TimeoutException)
                code = (
                    "MCP_TRANSPORT_TIMEOUT" if timeout else "MCP_TRANSPORT_UNAVAILABLE"
                )
                message = f"DNAForge {method} {path} {'timed out' if timeout else 'lost its connection'} ({type(exc).__name__})."
                details = {
                    "method": method,
                    "path": path,
                    "exceptionType": type(exc).__name__,
                    "stateMayHaveChanged": admission,
                }
                if admission:
                    details["requestId"] = (headers or {}).get("Idempotency-Key")
                raise SidecarHTTPError(
                    message,
                    504 if timeout else 502,
                    {"error": {"code": code, "message": message, "details": details}},
                ) from exc

        response = await send()
        body = _response_json(response)

        error = body.get("error")
        if (
            response.status_code == 401
            and isinstance(error, dict)
            and error.get("code") == "BAD_SESSION"
            and (self._session_token != sent_token or await self._refresh_session())
        ):
            sent_generation = self._generation
            response = await send()
            body = _response_json(response)
        job_id = body.get("jobId")
        if admission and response.status_code < 400 and isinstance(job_id, str):
            self._job_generations[job_id] = sent_generation
        return response.status_code, body

    def _read_authority(self) -> dict[str, Any] | None:
        if (
            not self.options.session_authority_path
            or not self.options.session_authority_owner
        ):
            return None
        if self.options.api_key:
            return None
        try:
            fd = os.open(
                self.options.session_authority_path,
                os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
            )
            with os.fdopen(fd, "r") as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > 16384:
                    return None
                if os.name == "posix" and (
                    info.st_uid != os.getuid() or info.st_mode & 0o077
                ):
                    return None
                record = json.load(source)
            if (
                not isinstance(record, dict)
                or record.get("version") != 1
                or record.get("ownerId") != self.options.session_authority_owner
                or not isinstance(record.get("generation"), int)
                or isinstance(record["generation"], bool)
                or record["generation"] < 0
            ):
                return None
            validate_loopback_api_url(record.get("apiUrl", ""))
            return record
        except (OSError, ValueError, TypeError, AttributeError):
            return None

    async def _refresh_session(self) -> bool:
        deadline = (
            asyncio.get_running_loop().time() + self.options.request_timeout_seconds
        )
        while True:
            record = self._read_authority()
            if record is None or record.get("state") == "stopped":
                return False
            if record.get("state") == "ready":
                token = record.get("sessionToken")
                if (
                    not isinstance(token, str)
                    or not token
                    or record["generation"]
                    <= (self._generation if self._generation is not None else -1)
                    or token == self._session_token
                ):
                    return False
                self._session_token = token
                self._generation = record["generation"]
                self.api_url = validate_loopback_api_url(record["apiUrl"])
                self._client.base_url = httpx.URL(self.api_url)
                self._client.headers = self._auth_headers()
                return True
            if record.get("state") not in {"starting", "restarting"}:
                return False
            if asyncio.get_running_loop().time() >= deadline:
                return False
            await asyncio.sleep(0.05)

    def _lost_job(self, job_id: str, body: dict[str, Any]) -> dict[str, Any]:
        error = body.get("error")
        admitted_generation = self._job_generations.get(job_id)
        if (
            isinstance(error, dict)
            and error.get("code") == "UNKNOWN_JOB"
            and admitted_generation is not None
            and self._generation is not None
            and admitted_generation != self._generation
        ):
            return {
                "ok": False,
                "jobId": job_id,
                "status": "failed",
                "error": {
                    "code": "MCP_JOB_LOST_AFTER_RESTART",
                    "message": "The compute service restarted after this job was admitted; its completion is unknown. Inspect the actual state before retrying.",
                    "retriable": False,
                    "details": {"job_id": job_id, "stateMayHaveChanged": True},
                },
            }
        return body

    @staticmethod
    def _raise_for_error(message: str, status_code: int, body: dict[str, Any]) -> None:
        if status_code >= 400:
            error = body.get("error")
            if isinstance(error, dict) and isinstance(error.get("message"), str):
                message = error["message"]
            raise SidecarHTTPError(message, status_code, body)


def validate_loopback_api_url(raw_url: str) -> str:
    parsed = urlsplit(raw_url.rstrip("/"))
    if parsed.scheme != "http" or parsed.hostname not in LOOPBACK_HOSTS:
        raise ValueError(
            "DNAForge MCP companion API URL must be an http loopback address."
        )
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("DNAForge MCP companion API URL contains unsupported parts.")
    if parsed.path not in ("", "/"):
        raise ValueError("DNAForge MCP companion API URL must not include a path.")
    return raw_url.rstrip("/")


def _response_json(response: httpx.Response) -> dict[str, Any]:
    if not response.content:
        return {}
    try:
        body = response.json()
    except ValueError as exc:
        raise SidecarHTTPError(
            "DNAForge sidecar returned a non-JSON response.",
            response.status_code,
            {},
        ) from exc
    if not isinstance(body, dict):
        raise SidecarHTTPError(
            "DNAForge sidecar returned a non-object JSON response.",
            response.status_code,
            {},
        )
    return body
