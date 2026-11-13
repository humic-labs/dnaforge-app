"""MCP Streamable HTTP endpoint on the loopback sidecar .

The same handlers as the stdio companion serve every request, re-entering the
sidecar's own ``/mcp/*`` routes with the key the request carried, so the tool
catalog, grant scopes, bound workspace, and audit are identical to stdio.

Access requires ``Authorization: Bearer dna_key_...``. Host and Origin are
checked against DNS rebinding: loopback hosts plus any host names the person
added in Settings (for a Tailscale or similar relay), and no browser origin.
A session is bound to the identity that opened it, so another key cannot use it.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import socket
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, nullcontext
from typing import Any

import uvicorn
from mcp.server.auth.middleware.bearer_auth import AuthenticatedUser
from mcp.server.auth.provider import AccessToken
from mcp.server.context import ServerRequestContext
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.routing import Route
from starlette.types import Receive, Scope, Send

from ..external_access_observation import (
    emit_external_access_observation,
    transport_refusal_observation,
)
from ..routes.mcp_auth import API_KEY_PREFIX, get_identity_for_api_key
from .options import CompanionOptions
from .server import create_mcp_server
from .sidecar import SidecarClient, SidecarClientProtocol

MCP_HTTP_PATH = "/mcp"
_CLIENT_STATE_KEY = "dnaforge_mcp_sidecar"
ALLOWED_HOSTS_FILE_ENV = "DNAFORGE_MCP_HTTP_ALLOWED_HOSTS_FILE"
INTERNAL_PORT_ENV = "DNAFORGE_MCP_HTTP_INTERNAL_PORT"
_LOOPBACK_NAMES = frozenset({"127.0.0.1", "localhost", "[::1]"})
_HOST_ENTRY = re.compile(
    r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*"
    r"(?::[0-9]{1,5})?$"
)
_MAX_EXTRA_HOSTS = 16
_SESSION_IDLE_SECONDS = 30 * 60


class McpHttpEndpoint:
    """ASGI app for ``/mcp``; enter :meth:`run` for the application lifetime."""

    def __init__(self) -> None:
        self._manager: StreamableHTTPSessionManager | None = None

    @asynccontextmanager
    async def run(self) -> AsyncIterator[None]:
        manager = StreamableHTTPSessionManager(
            create_mcp_server(
                None,
                CompanionOptions(agent_identity="http-mcp", portable_tool_names=True),
                sidecar_for=_request_sidecar,
            ),
            security_settings=TransportSecuritySettings(
                enable_dns_rebinding_protection=False
            ),
            session_idle_timeout=_SESSION_IDLE_SECONDS,
        )
        try:
            async with manager.run():
                self._manager = manager
                yield
        finally:
            self._manager = None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        api_key = _bearer_key(scope)
        if api_key is None:
            await _unauthorized(send, None)
            return
        manager = self._manager
        if manager is None:
            await _json_response(
                send, 503, _error("NOT_READY", "DNAForge is starting.")
            )
            return
        if _header(scope, b"origin") is not None:
            await _json_response(
                send, 403, _error("ORIGIN_REFUSED", "Browser requests are refused.")
            )
            return
        if not _host_allowed(_header(scope, b"host")):
            await _json_response(
                send,
                421,
                _error(
                    "HOST_REFUSED",
                    "This host name is not accepted. Configure allowedHosts through "
                    "configure_external_agent_access.",
                ),
            )
            return
        identity, error = get_identity_for_api_key(api_key)
        if identity is None:
            await _unauthorized(send, error)
            try:
                code = str(((error or {}).get("error") or {}).get("code", ""))
                await emit_external_access_observation(
                    transport_refusal_observation(code)
                )
            except Exception:
                pass
            return
        scope["user"] = AuthenticatedUser(
            AccessToken(
                token=_fingerprint(api_key),
                client_id=str(identity["id"]),
                scopes=[],
            )
        )

        async with self._client_for(scope, api_key, str(identity["id"])) as client:
            scope.setdefault("state", {})[_CLIENT_STATE_KEY] = client
            await manager.handle_request(scope, receive, send)

    def _client_for(
        self, scope: Scope, api_key: str, identity_id: str
    ) -> SidecarClient:
        host, port = scope["server"]
        api_url = os.environ.get("DNAFORGE_OPERATION_URL") or (
            f"http://{_loopback_literal(host)}:{port}"
        )
        return SidecarClient(
            CompanionOptions(
                api_url=api_url,
                api_key=api_key,
                agent_identity=identity_id,
            )
        )


def _request_sidecar(ctx: ServerRequestContext[Any]) -> SidecarClientProtocol:
    request = ctx.request
    client = getattr(getattr(request, "state", None), _CLIENT_STATE_KEY, None)
    if client is None:  # pragma: no cover - the endpoint always sets it
        raise RuntimeError("The MCP HTTP request carried no authenticated client.")
    return client


def _header(scope: Scope, name: bytes) -> str | None:
    values = [value for key, value in scope.get("headers", []) if key.lower() == name]
    if not values:
        return None
    return values[0].decode("latin-1") if len(values) == 1 else ""


def _host_allowed(host: str | None) -> bool:
    if not host:
        return False
    host = host.strip().lower()
    if host.startswith("["):
        name = host[: host.find("]") + 1]
    else:
        name = host.rsplit(":", 1)[0]
    if name in _LOOPBACK_NAMES:
        return True
    return any(entry in (host, name) for entry in extra_allowed_hosts())


def extra_allowed_hosts() -> list[str]:
    """Host names the person added in Settings; an unreadable list means none."""
    path = os.environ.get(ALLOWED_HOSTS_FILE_ENV)
    if not path:
        return []
    try:
        with open(path, encoding="utf-8") as source:
            raw = json.load(source)
    except (OSError, ValueError):
        return []
    if not isinstance(raw, list):
        return []
    return [
        entry.strip().lower()
        for entry in raw[:_MAX_EXTRA_HOSTS]
        if isinstance(entry, str) and _HOST_ENTRY.fullmatch(entry.strip().lower())
    ]


def _bearer_key(scope: Scope) -> str | None:
    values = [
        value.decode("latin-1")
        for name, value in scope.get("headers", [])
        if name.lower() == b"authorization"
    ]
    if len(values) != 1:
        return None
    scheme, _, token = values[0].partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token.startswith(API_KEY_PREFIX):
        return None
    return token


def _fingerprint(api_key: str) -> str:
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()


def _loopback_literal(host: str) -> str:
    return f"[{host}]" if ":" in host else host


async def _unauthorized(send: Send, error: dict[str, Any] | None) -> None:
    body = error or _error(
        "BAD_API_KEY",
        "Send Authorization: Bearer with a DNAForge API key created in Settings.",
    )
    await _json_response(
        send, 401, body, [(b"www-authenticate", b'Bearer realm="DNAForge"')]
    )


def _error(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message}}


async def _json_response(
    send: Send,
    status: int,
    body: dict[str, Any],
    extra_headers: list[tuple[bytes, bytes]] | None = None,
) -> None:
    payload = json.dumps(body).encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(payload)).encode("ascii")),
                *(extra_headers or []),
            ],
        }
    )
    await send({"type": "http.response.body", "body": payload})


class _SignalNeutralServer(uvicorn.Server):
    """A second server in the sidecar process must not take over its signals."""

    def capture_signals(self):  # type: ignore[override]
        return nullcontext()


@asynccontextmanager
async def serve_mcp_only_port(endpoint: McpHttpEndpoint) -> AsyncIterator[int | None]:
    """Serve exactly /mcp on the private port the desktop app pipes its fixed
    address to, so a relay reaching that address can never reach another route.
    Without the port setting (development servers, tests) nothing is started.
    """
    raw_port = os.environ.get(INTERNAL_PORT_ENV, "").strip()
    if not raw_port.isdecimal():
        yield
        return
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", int(raw_port)))
        port = listener.getsockname()[1]
        server = _SignalNeutralServer(
            uvicorn.Config(
                Starlette(
                    routes=[
                        Route(
                            MCP_HTTP_PATH,
                            endpoint=endpoint,
                            methods=["GET", "POST", "DELETE"],
                        )
                    ]
                ),
                lifespan="off",
                log_config=None,
                access_log=False,
            )
        )
        task = asyncio.create_task(server.serve(sockets=[listener]))
        try:
            while not server.started:
                if task.done():
                    await task
                    raise RuntimeError(
                        "The private MCP listener stopped before startup"
                    )
                await asyncio.sleep(0)
            yield port
        finally:
            server.should_exit = True
            await task
