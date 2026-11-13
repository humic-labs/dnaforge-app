"""Public liveness/readiness and authenticated sidecar diagnostics.

Plain public health is intentionally minimal and contains no token-derived
material. Electron proves that a listener owns the expected launch session by
presenting the candidate session: authenticated detail means "mine" and a 401
means "orphan". Maintained gates use that same authenticated detail contract.
"""

import os

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..build_identity import intrinsic_sidecar_source_fingerprint
from ..runtime_capabilities import runtime_capabilities
from ..security.request_headers import read_ascii_header_values
from ..security.session_errors import auth_error_envelope, auth_status
from .mcp_auth import check_sidecar_session, session_grant_capabilities

router = APIRouter()

SIDECAR_ROUTE_FEATURES = [
    "tiles.coverage-readiness.v1",
    "tiles.coverage-assembly.v1",
    "tiles.coverage-tile.v1",
    "tiles.alignment.v1",
    "tiles.annotation.v1",
    "auth.default-deny.v1",
]


@router.get("/health", operation_id="healthCheck")
async def health_check(request: Request):
    """Return public liveness or authenticated ownership diagnostics."""

    app_version = os.environ.get("WAYPOINT_APP_VERSION", "unknown")
    sidecar_source_fingerprint = intrinsic_sidecar_source_fingerprint()
    session_values, malformed_session = read_ascii_header_values(
        request.scope, b"x-dnaforge-session"
    )
    if not session_values:
        if malformed_session:
            session_error = check_sidecar_session(None)
            if session_error is None:
                raise RuntimeError("malformed session header was accepted")
            return JSONResponse(
                status_code=auth_status(session_error),
                content=auth_error_envelope(session_error),
            )
        return {"status": "healthy", "service": "molbio-api"}

    session_error = check_sidecar_session(
        session_values[0] if len(session_values) == 1 else None
    )
    if session_error is not None:
        return JSONResponse(
            status_code=auth_status(session_error),
            content=auth_error_envelope(session_error),
        )

    return {
        "status": "healthy",
        "service": "molbio-api",
        "app_version": app_version,
        "sidecar_source_fingerprint": sidecar_source_fingerprint,
        "mcp_grant_capabilities": session_grant_capabilities(),
        "mcp_http_internal_port": getattr(
            request.app.state, "mcp_http_internal_port", None
        ),
        "route_features": SIDECAR_ROUTE_FEATURES,
        "runtime_capabilities": runtime_capabilities(),
        "external_replay": bool(os.environ.get("EXTERNAL_REPLAY_DIR")),
    }


@router.get("/ready", operation_id="readinessCheck")
async def readiness_check():
    """Fail closed until the application auth boundary is configured."""

    if not os.environ.get("DNAFORGE_MCP_SESSION_TOKEN"):
        return JSONResponse(
            status_code=503,
            content={
                "ready": False,
                "code": "MCP_SESSION_NOT_CONFIGURED",
            },
        )
    return {"ready": True}
