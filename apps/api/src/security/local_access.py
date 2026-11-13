"""Default-deny authentication and exact-origin CORS for the local sidecar.

Every ordinary HTTP route inherits the current Electron launch session at this
application boundary. The only public requests are the exact startup probes
``GET /health`` and ``GET /ready``. Persistent agent API keys are delegated only
to exact registered routes that already enforce identity, revocation, ownership,
and capability checks themselves. Native htslib reads are delegated only to the
exact loopback range-proxy route, whose handler validates an opaque grant sent
through HTTP Basic authorization. Keeping the grant out of the path prevents
ordinary HTTP access logs from persisting the short-lived bearer.

The middleware is plain ASGI rather than ``BaseHTTPMiddleware`` so streaming
responses are not buffered. CORS is defense in depth; the launch session is the
security boundary.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Mapping, Pattern

from starlette.responses import JSONResponse
from starlette.routing import compile_path
from starlette.types import ASGIApp, Receive, Scope, Send

from ..routes.mcp_auth import check_sidecar_session
from .request_headers import read_ascii_header_values
from .session_errors import auth_error_envelope, auth_status

ALLOWED_ORIGINS_ENV = "DNAFORGE_ALLOWED_RENDERER_ORIGIN"
SESSION_HEADER = b"x-dnaforge-session"
API_KEY_HEADER = b"x-dnaforge-api-key"

PUBLIC_STARTUP_ROUTES = frozenset(
    {
        ("GET", b"/health"),
        ("GET", b"/ready"),
    }
)
PUBLIC_PATHS: dict[str, str] = {
    "GET /health": (
        "Minimal anonymous liveness. Electron presents its candidate session "
        "to the same route for authenticated ownership diagnostics."
    ),
    "GET /ready": (
        "Startup readiness; returns 503 until the launch session boundary is configured."
    ),
}

logger = logging.getLogger("dnaforge.sidecar.auth")
_REJECTION_LOG_WINDOW_SECONDS = 5.0
_REJECTION_LOG_BURST = 10
_rejection_window_started = 0.0
_rejection_window_count = 0
_rejection_window_suppressed = 0


def _log_rejection(
    *, method: object, path: object, policy: str, reason: str, code: str
) -> None:
    """Bound synchronous log amplification from an unauthenticated peer."""

    global _rejection_window_started
    global _rejection_window_count
    global _rejection_window_suppressed

    now = time.monotonic()
    if now - _rejection_window_started >= _REJECTION_LOG_WINDOW_SECONDS:
        if _rejection_window_suppressed:
            logger.warning(
                "sidecar_auth_rejected_suppressed count=%s",
                _rejection_window_suppressed,
            )
        _rejection_window_started = now
        _rejection_window_count = 0
        _rejection_window_suppressed = 0

    if _rejection_window_count >= _REJECTION_LOG_BURST:
        _rejection_window_suppressed += 1
        return

    _rejection_window_count += 1
    logger.warning(
        "sidecar_auth_rejected method=%s path=%s policy=%s reason=%s code=%s generation=%s",
        method,
        path,
        policy,
        reason,
        code,
        os.environ.get("DNAFORGE_SIDECAR_SESSION_GENERATION", "unknown"),
    )


@dataclass(frozen=True)
class DelegatedAgentAuthRoute:
    """One exact registered route that keeps the existing agent resolver."""

    method: str
    path_template: str
    route_name: str
    resolver: str
    rationale: str
    excluded_paths: frozenset[str] = field(default_factory=frozenset)
    path_regex: Pattern[str] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        regex, _path_format, _param_convertors = compile_path(self.path_template)
        object.__setattr__(self, "path_regex", regex)

    def matches(self, method: str, path: str) -> bool:
        return (
            method == self.method
            and path not in self.excluded_paths
            and self.path_regex.fullmatch(path) is not None
        )


def _delegated(
    method: str,
    path_template: str,
    route_name: str,
    resolver: str = "resolve_persistent_agent_request",
    *,
    excluded_paths: frozenset[str] = frozenset(),
) -> DelegatedAgentAuthRoute:
    return DelegatedAgentAuthRoute(
        method=method,
        path_template=path_template,
        route_name=route_name,
        resolver=resolver,
        rationale="Preserve the existing revocable persistent-agent API-key contract.",
        excluded_paths=excluded_paths,
    )


DELEGATED_AGENT_AUTH_ROUTES = (
    _delegated("GET", "/jobs/{job_id}", "get_job"),
    _delegated("GET", "/jobs/{job_id}/events", "get_job_events"),
    _delegated("DELETE", "/jobs/{job_id}", "cancel_job"),
    _delegated(
        "POST", "/mcp/call", "call_mcp_tool", "resolve_authenticated_agent_context"
    ),
    _delegated(
        "POST",
        "/mcp/resources/read",
        "read_mcp_resource",
        "resolve_authenticated_agent_context",
    ),
    _delegated("GET", "/mcp/actions/{action_id}", "read_mcp_action_resource"),
    _delegated("GET", "/mcp/artifacts", "list_mcp_artifact_resources"),
    _delegated("GET", "/mcp/artifacts/{artifact_id}", "read_mcp_artifact_resource"),
    _delegated("GET", "/mcp/analysis-runs", "list_mcp_analysis_run_resources"),
    _delegated(
        "GET", "/mcp/analysis-runs/{analysis_run_id}", "read_mcp_analysis_run_resource"
    ),
    _delegated("GET", "/mcp/resource-links", "list_mcp_resource_link_resources"),
    _delegated(
        "GET",
        "/mcp/resource-links/{resource_link_id}",
        "read_mcp_resource_link_resource",
    ),
    _delegated("GET", "/mcp/agent/status", "read_mcp_agent_status_resource"),
    _delegated("GET", "/mcp/workflows", "list_mcp_workflow_resources"),
    _delegated("GET", "/mcp/workflows/{workflow_id}", "read_mcp_workflow_resource"),
    _delegated(
        "GET",
        "/mcp/workflow-ledgers/summary",
        "read_mcp_workflow_ledger_summary_resource",
    ),
    _delegated(
        "GET",
        "/mcp/workflow-ledgers/latest/{workflow_id}",
        "read_mcp_latest_workflow_ledger_resource",
    ),
    _delegated(
        "GET",
        "/mcp/discover",
        "discover_mcp_surface",
        "resolve_authenticated_agent_context",
    ),
    _delegated(
        "POST",
        "/mcp/discover",
        "discover_mcp_surface_with_context",
        "resolve_authenticated_agent_context",
    ),
    _delegated("GET", "/mcp/caller", "get_current_agent_caller"),
    _delegated(
        "GET",
        "/mcp/jobs/{job_id}",
        "get_mcp_job",
        "resolve_authenticated_agent_context",
    ),
    _delegated(
        "DELETE",
        "/mcp/jobs/{job_id}",
        "cancel_mcp_job",
        "resolve_authenticated_agent_context",
    ),
    _delegated(
        "GET", "/api/tools", "list_agent_tools", "resolve_authenticated_agent_context"
    ),
    _delegated(
        "GET",
        "/api/tools/{name}",
        "get_agent_tool",
        "resolve_authenticated_agent_context",
        excluded_paths=frozenset({"/api/tools/manifest-schema"}),
    ),
    _delegated(
        "POST",
        "/api/tools/{name}/execute",
        "execute_agent_tool",
        "resolve_authenticated_agent_context",
    ),
)


def is_delegated_agent_request(method: str, path: str) -> bool:
    """Return whether an existing agent resolver may authenticate this route."""

    return any(rule.matches(method, path) for rule in DELEGATED_AGENT_AUTH_ROUTES)


_SOURCE_GRANT_PATH_REGEX = compile_path("/external/range-proxy/{resource_name}")[0]
DELEGATED_SOURCE_GRANT_METHODS = frozenset({"GET", "HEAD"})


MCP_HTTP_METHODS = frozenset({"GET", "POST", "DELETE"})


def is_mcp_http_request(method: str, raw_path: bytes) -> bool:
    """The exact MCP Streamable HTTP endpoint, which authenticates itself."""
    return method in MCP_HTTP_METHODS and raw_path == b"/mcp"


def is_delegated_source_grant_request(
    method: str,
    path: str,
    raw_path: bytes | None = None,
) -> bool:
    """Identify the exact native route whose handler authenticates a grant.

    The runtime emits one fixed ASCII resource name per format. Requiring the
    raw and decoded paths to agree prevents percent-encoded spellings from
    broadening this narrow pre-routing exception.
    """

    if raw_path is not None:
        try:
            if raw_path.decode("ascii") != path:
                return False
        except UnicodeDecodeError:
            return False

    return (
        method in DELEGATED_SOURCE_GRANT_METHODS
        and _SOURCE_GRANT_PATH_REGEX.fullmatch(path) is not None
    )


def is_public(method: str, raw_path: bytes) -> bool:
    """Return whether an exact method/raw-path pair is public."""

    return (method.upper(), raw_path) in PUBLIC_STARTUP_ROUTES


def configured_allowed_origins() -> list[str]:
    """Return the one exact renderer origin authorized by the launcher."""

    origin = os.environ.get(ALLOWED_ORIGINS_ENV, "").strip()
    if not origin:
        return []
    if "*" in origin:
        raise RuntimeError(
            f"{ALLOWED_ORIGINS_ENV} must name one exact origin; a wildcard is refused"
        )
    if "," in origin:
        raise RuntimeError(f"{ALLOWED_ORIGINS_ENV} must name one exact origin")
    return [origin]


class LocalAccessMiddleware:
    """Fail closed before routing, body parsing, dependencies, or handlers."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        scope_type = scope["type"]
        if scope_type == "lifespan":
            await self.app(scope, receive, send)
            return
        if scope_type == "websocket":
            await send({"type": "websocket.close", "code": 4401})
            return
        if scope_type != "http":
            await self.app(scope, receive, send)
            return

        method = str(scope.get("method", "")).upper()
        raw_path = scope.get("raw_path")
        if not isinstance(raw_path, bytes):
            raw_path = str(scope.get("path", "")).encode(
                "utf-8", errors="surrogatepass"
            )
        if is_public(method, raw_path):
            await self.app(scope, receive, send)
            return

        path = str(scope.get("path", ""))
        session_values, malformed_session = read_ascii_header_values(
            scope, SESSION_HEADER
        )
        api_key_values, malformed_api_key = read_ascii_header_values(
            scope, API_KEY_HEADER
        )

        if (
            malformed_session
            or malformed_api_key
            or len(session_values) > 1
            or len(api_key_values) > 1
        ):
            await self._reject(
                scope,
                receive,
                send,
                check_sidecar_session(None),
                policy="session-default",
                reason="duplicate_or_malformed",
            )
            return

        if (
            not session_values
            and not api_key_values
            and is_delegated_source_grant_request(method, path, raw_path)
        ):
            await self.app(scope, receive, send)
            return

        if (
            not session_values
            and not api_key_values
            and is_mcp_http_request(method, raw_path)
        ):
            await self.app(scope, receive, send)
            return

        if len(api_key_values) == 1 and api_key_values[0].strip():
            if is_delegated_agent_request(method, path):
                await self.app(scope, receive, send)
                return

        provided_session = session_values[0] if len(session_values) == 1 else None
        session_error = check_sidecar_session(provided_session)
        if session_error is not None:
            reason = "missing" if provided_session is None else "empty_or_mismatch"
            await self._reject(
                scope,
                receive,
                send,
                session_error,
                policy="session-default",
                reason=reason,
            )
            return

        await self.app(scope, receive, send)

    async def _reject(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
        error: Mapping[str, Any] | None,
        *,
        policy: str,
        reason: str,
    ) -> None:
        if error is None:
            raise RuntimeError("Sidecar auth rejection requires an error envelope")
        code = str(error.get("error", {}).get("code", "BAD_SESSION"))
        _log_rejection(
            method=scope.get("method"),
            path=scope.get("path"),
            policy=policy,
            reason=reason,
            code=code,
        )
        response = JSONResponse(
            status_code=auth_status(error),
            content=auth_error_envelope(error),
            headers={"Cache-Control": "no-store"},
        )
        await response(scope, receive, send)


ALLOWED_CORS_ORIGIN_REGEX = None
ALLOWED_CORS_METHODS = ["GET", "POST", "DELETE", "OPTIONS"]
ALLOWED_CORS_HEADERS = [
    "Content-Type",
    "Idempotency-Key",
    "Range",
    "X-DNAForge-Action-Id",
    "X-DNAForge-Agent-Capabilities",
    "X-DNAForge-Agent-Identity",
    "X-DNAForge-API-Key",
    "X-DNAForge-Canary-Token",
    "X-DNAForge-Session",
    "X-DNAForge-Source-Token",
    "X-DNAForge-Turn-Id",
]
EXPOSED_CORS_HEADERS = [
    "Accept-Ranges",
    "Content-Range",
    "ETag",
    "Last-Modified",
    "X-Waypoint-Coverage-Contract",
    "X-Waypoint-Coverage-Source",
    "X-Structure-Format",
    "X-External-Id",
    "X-Source-Url",
]
