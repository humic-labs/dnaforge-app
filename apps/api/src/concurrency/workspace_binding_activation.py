from __future__ import annotations

import os
from urllib.parse import urlsplit

import httpx
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class WorkspaceBindingActivationMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope["method"] != "POST"
            or scope["path"] != "/agent-grants/local-mcp/bind"
        ):
            await self.app(scope, receive, send)
            return

        async def send_bound_response(message: Message) -> None:
            if message["type"] == "http.response.start" and message["status"] == 200:
                await activate_bound_workspace()
            await send(message)

        await self.app(scope, receive, send_bound_response)


async def activate_bound_workspace() -> bool:
    url = os.environ.get("DNAFORGE_RENDERER_BRIDGE_URL", "")
    token = os.environ.get("DNAFORGE_RENDERER_BRIDGE_TOKEN", "")
    source = os.environ.get("DNAFORGE_MCP_SESSION_TOKEN", "")
    try:
        parsed = urlsplit(url)
        if (
            parsed.scheme != "http"
            or parsed.hostname != "127.0.0.1"
            or not parsed.port
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
            or not token
            or not source
        ):
            return False
        async with httpx.AsyncClient(
            timeout=1, trust_env=False, follow_redirects=False
        ) as client:
            response = await client.post(
                url.rstrip("/") + "/__external-access/workspace-bound",
                headers={
                    "X-DNAForge-Session": token,
                    "X-DNAForge-Sidecar-Session": source,
                },
                json={},
            )
            return response.status_code == 200
    except (httpx.HTTPError, ValueError):
        return False
