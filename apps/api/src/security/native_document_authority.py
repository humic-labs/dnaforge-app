"""Only the private native owner can certify document writes."""

import hmac
import os
import re
from dataclasses import dataclass, field

from fastapi import HTTPException, Request

from .request_headers import read_ascii_header_values

NATIVE_DOCUMENT_AUTHORITY_HEADER = b"x-dnaforge-native-document-authority"


def native_document_command_url(value: str | None) -> str | None:
    if not isinstance(value, str):
        return None
    address = re.fullmatch(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})/?", value)
    if address is None or int(address.group(1)) > 65535:
        return None
    return value.rstrip("/")


@dataclass(frozen=True)
class NativeDocumentAuthority:
    token: str = field(repr=False)
    owner_instance_id: str
    command_url: str | None = None


def capture_native_document_authority() -> NativeDocumentAuthority | None:
    expected = os.environ.get("DNAFORGE_NATIVE_DOCUMENT_TOKEN", "")
    owner_id = os.environ.get("DNAFORGE_NATIVE_DOCUMENT_OWNER_ID", "")
    command_url = os.environ.get("DNAFORGE_NATIVE_DOCUMENT_URL")
    for key in tuple(os.environ):
        if key.upper() in {
            "DNAFORGE_NATIVE_DOCUMENT_TOKEN",
            "DNAFORGE_NATIVE_DOCUMENT_OWNER_ID",
            "DNAFORGE_NATIVE_DOCUMENT_URL",
        }:
            os.environ.pop(key, None)
    if command_url is not None:
        command_url = native_document_command_url(command_url)
        if command_url is None:
            return None
    if (
        not expected
        or not owner_id.strip()
        or len(owner_id) > 128
        or any(ord(char) < 32 or ord(char) == 127 for char in owner_id)
        or expected
        in {
            os.environ.get("DNAFORGE_MCP_SESSION_TOKEN"),
            os.environ.get("DNAFORGE_HUMAN_OPERATION_TOKEN"),
            os.environ.get("DNAFORGE_RENDERER_BRIDGE_TOKEN"),
        }
    ):
        return None
    return NativeDocumentAuthority(expected, owner_id, command_url)


def require_native_document_authority(request: Request) -> str:
    authority = getattr(request.app.state, "native_document_authority", None)
    if not isinstance(authority, NativeDocumentAuthority):
        raise HTTPException(
            status_code=503,
            detail={
                "code": "NATIVE_DOCUMENT_AUTHORITY_UNAVAILABLE",
                "message": "This runtime has no private native document owner configured.",
            },
        )
    values, malformed = read_ascii_header_values(
        request.scope, NATIVE_DOCUMENT_AUTHORITY_HEADER
    )
    if (
        malformed
        or len(values) != 1
        or not hmac.compare_digest(
            values[0].encode("ascii"), authority.token.encode("utf-8")
        )
    ):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "NATIVE_DOCUMENT_AUTHORITY_REQUIRED",
                "message": "Document write confirmation requires the private native owner.",
            },
        )
    return authority.owner_instance_id
