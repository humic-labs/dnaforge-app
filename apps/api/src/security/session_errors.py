"""Stable compatibility envelope for sidecar session-authentication failures."""

from __future__ import annotations

from typing import Any, Mapping

_MISSING_CREDENTIAL_FIX = (
    "Send the current launch token in X-DNAForge-Session. The desktop app "
    "adds it automatically; standalone clients must send the token configured "
    "in DNAFORGE_MCP_SESSION_TOKEN."
)

_NOT_CONFIGURED_FIX = (
    "Restart the sidecar with DNAFORGE_MCP_SESSION_TOKEN configured. The "
    "desktop app sets it automatically; use run_server.py --dev-auth for a "
    "standalone development server."
)


def auth_status(error: Mapping[str, Any]) -> int:
    """Map a structured session failure onto the established HTTP status."""

    code = error.get("error", {}).get("code")
    return 500 if code == "MCP_SESSION_NOT_CONFIGURED" else 401


def auth_error_envelope(error: Mapping[str, Any]) -> dict[str, Any]:
    """Emit both maintained sidecar error shapes with actionable detail."""

    body = dict(error)
    structured_error = dict(body.get("error") or {})
    details = dict(structured_error.get("details") or {})
    details["how_to_fix"] = (
        _NOT_CONFIGURED_FIX
        if structured_error.get("code") == "MCP_SESSION_NOT_CONFIGURED"
        else _MISSING_CREDENTIAL_FIX
    )
    structured_error["details"] = details
    body["error"] = structured_error
    body["detail"] = structured_error
    return body
