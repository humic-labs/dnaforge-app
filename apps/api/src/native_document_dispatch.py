"""One bounded private dispatch; uncertainty never authorizes another file write."""

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal

import httpx

from .security.native_document_authority import (
    NativeDocumentAuthority,
    native_document_command_url,
)

_REFUSALS = {
    400: {"INVALID_NATIVE_DOCUMENT_REQUEST"},
    403: {"NATIVE_DOCUMENT_AUTHORITY_REQUIRED"},
    404: {"NATIVE_DOCUMENT_ENDPOINT_UNAVAILABLE"},
    409: {"NATIVE_DOCUMENT_OWNER_CHANGED", "NATIVE_DOCUMENT_REQUEST_REFUSED"},
    413: {"INVALID_NATIVE_DOCUMENT_REQUEST"},
    503: {"NATIVE_DOCUMENT_OWNER_UNAVAILABLE"},
}
_UNCONFIRMED = "The native document outcome is not confirmed. Observe the original action before repeating work."


def _response_limit(command: dict[str, Any]) -> int:
    limit = 17 * 1024 * 1024
    if command.get("command") == "annotation.inspect":
        authority = command.get("authority", {})
        target = command.get("target", {})
        if isinstance(authority, dict) and isinstance(target, dict):
            result = authority.get("result", {})
            operation_id = target.get("operationId")
            features = result.get("features") if isinstance(result, dict) else None
            if isinstance(features, list) and isinstance(operation_id, str):
                limit += len(features) * (len(json.dumps(operation_id)) + 96)
    return limit


@dataclass(frozen=True)
class NativeDocumentDispatchResult:
    disposition: Literal["completed", "refused", "outcome-unresolved"]
    result: dict[str, Any] | None = None
    reason: str = ""


async def dispatch_native_document_command(
    authority: NativeDocumentAuthority,
    command: dict[str, Any],
    *,
    post: Callable[..., Awaitable[httpx.Response]] | None = None,
) -> NativeDocumentDispatchResult:
    base_url = native_document_command_url(authority.command_url)
    if base_url is None or not authority.token or not authority.owner_instance_id:
        return NativeDocumentDispatchResult(
            "refused", reason="No native document owner is connected."
        )
    body = {**command, "ownerInstanceId": authority.owner_instance_id}
    headers = {"X-DNAForge-Native-Document-Authority": authority.token}
    response_limit = _response_limit(command)

    async def receive(
        send: Callable[..., Awaitable[httpx.Response]],
    ) -> NativeDocumentDispatchResult:
        try:
            response = await send(
                base_url + "/internal/native-documents/call", json=body, headers=headers
            )
            try:
                content = bytearray()
                async for chunk in response.aiter_bytes(chunk_size=64 * 1024):
                    if len(content) + len(chunk) > response_limit:
                        return NativeDocumentDispatchResult(
                            "outcome-unresolved", reason=_UNCONFIRMED
                        )
                    content.extend(chunk)
                payload = json.loads(content)
            finally:
                await response.aclose()
        except (httpx.TransportError, ValueError):
            return NativeDocumentDispatchResult(
                "outcome-unresolved", reason=_UNCONFIRMED
            )
        if not isinstance(payload, dict):
            return NativeDocumentDispatchResult(
                "outcome-unresolved", reason=_UNCONFIRMED
            )
        if (
            response.status_code == 200
            and payload.get("ok") is True
            and payload.get("ownerInstanceId") == authority.owner_instance_id
            and isinstance(payload.get("result"), dict)
        ):
            return NativeDocumentDispatchResult("completed", result=payload["result"])
        error = payload.get("error")
        if (
            payload.get("ok") is False
            and payload.get("accepted") is False
            and isinstance(error, dict)
            and isinstance(error.get("code"), str)
            and error["code"] in _REFUSALS.get(response.status_code, set())
        ):
            return NativeDocumentDispatchResult(
                "refused",
                reason="The native owner refused the document command before accepting it.",
            )
        return NativeDocumentDispatchResult("outcome-unresolved", reason=_UNCONFIRMED)

    if post is not None:
        return await receive(post)
    async with httpx.AsyncClient(
        timeout=30.0, follow_redirects=False, trust_env=False
    ) as client:

        async def stream_post(url: str, **kwargs: Any) -> httpx.Response:
            return await client.send(
                client.build_request("POST", url, **kwargs), stream=True
            )

        return await receive(stream_post)
