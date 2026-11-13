"""REST binding kind for compute providers without an MCP server .

`RestProviderBinding` is the shared base: credential headers from the manifest
scheme, a single injectable `httpx.AsyncClient` (tests use MockTransport), JSON
helpers, and the translation of HTTP failures into the typed contract errors
(401/403 → bad credential, 402/insufficient-credit bodies → budget, 429 with
Retry-After → rate limit, 5xx/connection → provider unavailable, 400/422 →
invalid settings, 404 → unknown job). Concrete providers implement the eight
operations on top of it: `nvidia_nim.py`, `subseq.py`.
"""

from __future__ import annotations

import json
from typing import Any, Mapping

import httpx

from .contract import (
    BadCredentialError,
    BudgetExhaustedError,
    ComputeProviderError,
    ComputeRateLimitError,
    InvalidJobSettingsError,
    ProviderCredential,
    ProviderUnavailableError,
    UnknownJobError,
)
from .manifests import ProviderManifest

DEFAULT_TIMEOUT = httpx.Timeout(30.0, read=330.0)


def _retry_after_seconds(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _body_text(response: httpx.Response, limit: int = 400) -> str:
    try:
        return response.text[:limit]
    except Exception:  # noqa: BLE001 - body decoding is best-effort for error text
        return ""


class RestProviderBinding:
    """Shared plumbing for REST compute providers. Subclasses implement the protocol."""

    def __init__(
        self, manifest: ProviderManifest, *, client: httpx.AsyncClient | None = None
    ) -> None:
        if manifest.transport != "rest" or not manifest.base_url:
            raise ValueError(
                f"{manifest.id}: RestProviderBinding requires transport 'rest' with baseUrl"
            )
        self.manifest = manifest
        self.provider_id = manifest.id
        self.base_url = manifest.base_url.rstrip("/")
        self._client = client or httpx.AsyncClient(
            timeout=DEFAULT_TIMEOUT, follow_redirects=False
        )

    def _url(self, path: str) -> str:
        if (
            not path.startswith("/")
            or path.startswith("//")
            or "\\" in path
            or "#" in path
            or any(ord(character) < 32 or ord(character) == 127 for character in path)
        ):
            raise ComputeProviderError(
                f"{self.provider_id}: refusing a non-relative provider request target"
            )
        return f"{self.base_url}/{path.lstrip('/')}"

    async def _request(
        self,
        method: str,
        path: str,
        credential: ProviderCredential,
        *,
        json_body: Any | None = None,
        data: Mapping[str, Any] | None = None,
        files: Mapping[str, Any] | None = None,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        accept_statuses: tuple[int, ...] = (200, 201, 202),
    ) -> httpx.Response:
        merged_headers: dict[str, str] = {
            "Accept": "application/json",
            **credential.as_headers(),
        }
        if headers:
            merged_headers.update(headers)
        try:
            response = await self._client.request(
                method,
                self._url(path),
                json=json_body,
                data=data,
                files=files,
                params=params,
                headers=merged_headers,
            )
        except (httpx.TransportError, httpx.TimeoutException) as exc:
            raise ProviderUnavailableError(
                f"{self.provider_id}: cannot reach provider: {exc}"
            ) from exc
        if response.status_code in accept_statuses:
            return response
        raise self.error_for(response)

    def error_for(self, response: httpx.Response) -> ComputeProviderError:
        status = response.status_code
        text = _body_text(response)
        lowered = text.lower()
        if status in (401, 403):
            if "budget" in lowered or "credit" in lowered or "quota" in lowered:
                return BudgetExhaustedError(
                    f"{self.provider_id}: {text or 'budget exhausted'}",
                    status_code=status,
                )
            return BadCredentialError(
                f"{self.provider_id}: provider rejected the credential ({status})",
                status_code=status,
            )
        if (
            status == 402
            or "insufficient credits" in lowered
            or "insufficient_credits" in lowered
        ):
            return BudgetExhaustedError(
                f"{self.provider_id}: {text or 'insufficient credits'}",
                status_code=status,
            )
        if status == 429:
            return ComputeRateLimitError(
                f"{self.provider_id}: rate limited",
                retry_after_s=_retry_after_seconds(response.headers.get("Retry-After")),
            )
        if status == 404:
            return UnknownJobError(
                f"{self.provider_id}: not found: {text}", status_code=404
            )
        if status in (400, 422):
            return InvalidJobSettingsError(
                f"{self.provider_id}: {text or 'invalid request'}",
                problems=(text,) if text else (),
            )
        if status >= 500:
            return ProviderUnavailableError(
                f"{self.provider_id}: provider error {status}", status_code=status
            )
        return ComputeProviderError(
            f"{self.provider_id}: unexpected status {status}: {text}",
            status_code=status,
        )

    async def verify_credential(self, credential: ProviderCredential) -> None:
        """Connect-time proof that the provider accepts this key, from the manifest's
        `verify` request. It must be a call that REQUIRES auth: subseq's catalog is
        public and NVIDIA's is static, so listing tools accepted any string (found
        against the live providers on 2026-09-10). `okStatuses` names a non-2xx
        answer that still proves authentication: NVIDIA refuses an empty Boltz-2
        body with 422 only after accepting the key (a wrong key gets 403 first),
        which also guarantees the check never starts a job."""
        spec = self.manifest.verify
        target = str(spec.get("target") or "")
        if not target:
            raise ComputeProviderError(
                f"{self.provider_id}: manifest has no verify request"
            )
        method = str(spec.get("method") or "GET").upper()
        ok_statuses = tuple(int(s) for s in spec.get("okStatuses") or ())
        response = await self._request(
            method,
            target,
            credential,
            json_body={} if method == "POST" else None,
            accept_statuses=(200, 201, 202, *ok_statuses),
        )
        expect_key = spec.get("expectKey")
        if expect_key:
            payload = self.json_of(response)
            if not isinstance(payload, Mapping) or expect_key not in payload:
                raise ProviderUnavailableError(
                    f"{self.provider_id}: the verify response did not come from the expected API"
                )

    @staticmethod
    def json_of(response: httpx.Response) -> Any:
        try:
            return response.json()
        except json.JSONDecodeError:
            return None


__all__ = ["DEFAULT_TIMEOUT", "RestProviderBinding"]
