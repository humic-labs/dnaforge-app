"""Human operation authority is separate from the session delegated to agents."""

import hmac
import os

from fastapi import HTTPException, Request

from .request_headers import read_ascii_header_values

OPERATION_AUTHORITY_HEADER = b"x-dnaforge-operation-authority"


def human_operation_authority_configured() -> bool:
    expected = os.environ.get("DNAFORGE_HUMAN_OPERATION_TOKEN", "")
    return bool(expected) and expected != os.environ.get("DNAFORGE_MCP_SESSION_TOKEN")


def require_human_operation_authority(request: Request) -> None:
    expected = os.environ.get("DNAFORGE_HUMAN_OPERATION_TOKEN", "")
    if not human_operation_authority_configured():
        raise HTTPException(
            status_code=503,
            detail={
                "code": "OPERATION_AUTHORITY_UNAVAILABLE",
                "message": "This runtime has no human operation connection configured.",
            },
        )
    values, malformed = read_ascii_header_values(
        request.scope, OPERATION_AUTHORITY_HEADER
    )
    if (
        malformed
        or len(values) != 1
        or not hmac.compare_digest(values[0].encode("ascii"), expected.encode("utf-8"))
    ):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "OPERATION_AUTHORITY_REQUIRED",
                "message": "Connect with human operation authority or use the authorized agent tools.",
            },
        )
