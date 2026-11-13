"""Reusable NVIDIA Cloud Functions (NVCF) long-poll compute driver.

The driver knows the NVCF lifecycle, not NVIDIA biology model names: POST may
finish with 200 or return 202 plus a request id; pending work is polled at a
manifest path. Tool paths, schemas, search metadata, and result codec all live
in the manifest. Any other provider or self-hosted gateway speaking this shape
can use the driver without a provider-id registry entry.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any, Mapping
from urllib.parse import quote

import httpx

from .contract import (
    ComputeProviderError,
    CostEstimate,
    InvalidJobSettingsError,
    JobState,
    JobStatus,
    OutputKind,
    ProviderCredential,
    ProviderJobRef,
    ProviderUnavailableError,
    ResultBundle,
    SubmitRequest,
    ToolDescriptor,
    UnknownJobError,
    ValidationResult,
)
from .json_schema import schema_problems
from .manifests import ProviderManifest
from .rest_binding import RestProviderBinding
from .result_codecs import RESULT_CODECS

POLL_SECONDS_HEADER = "NVCF-POLL-SECONDS"
REQUEST_ID_HEADER = "nvcf-reqid"
INLINE_PREFIX = "inline:"
PENDING_PREFIX = "nvcf:"

ResultCodec = Callable[[ProviderJobRef, str, Any, Mapping[str, Any]], ResultBundle]


class NvcfBinding(RestProviderBinding):
    """Manifest-driven NVCF implementation of the stable compute contract."""

    def __init__(
        self,
        manifest: ProviderManifest,
        *,
        client: httpx.AsyncClient | None = None,
        poll_seconds: int | None = None,
    ) -> None:
        super().__init__(manifest, client=client)
        if manifest.driver_kind != "nvcf":
            raise ValueError(
                f"{manifest.id}: NvcfBinding requires driver 'nvcf', got {manifest.driver_kind!r}"
            )
        driver = manifest.driver
        configured_poll = driver.get("pollSeconds", 30)
        self.poll_seconds = int(
            poll_seconds if poll_seconds is not None else configured_poll
        )
        self.poll_seconds_header = str(
            driver.get("pollSecondsHeader") or POLL_SECONDS_HEADER
        )
        self.request_id_header = str(driver.get("requestIdHeader") or REQUEST_ID_HEADER)
        self.status_path_template = str(
            driver.get("statusPathTemplate") or "/status/{request_id}"
        )
        codec_name = str(driver.get("resultCodec") or "raw-json")
        try:
            self._result_codec: ResultCodec = RESULT_CODECS[codec_name]
        except KeyError as exc:
            raise ValueError(
                f"{manifest.id}: unknown NVCF result codec {codec_name!r}"
            ) from exc
        self._tools: dict[str, Mapping[str, Any]] = {
            str(tool["id"]): tool for tool in manifest.static_tools
        }
        self._inline_results: dict[str, tuple[str, Any]] = {}

    async def list_tools(
        self,
        credential: ProviderCredential,
        *,
        search: str | None = None,
        tags: tuple[str, ...] = (),
    ) -> list[ToolDescriptor]:
        requested_tags = {tag.lower() for tag in tags}
        out: list[ToolDescriptor] = []
        for tool in self._tools.values():
            tool_id = str(tool["id"])
            display = str(tool.get("displayName") or tool_id)
            description = str(tool.get("description") or display)
            kind = tool.get("outputKind")
            tool_tags = tuple(
                str(tag) for tag in tool.get("tags") or ("protein", str(kind or ""))
            )
            keywords = " ".join(str(keyword) for keyword in tool.get("keywords") or ())
            haystack = f"{tool_id} {display} {description} {keywords}".lower()
            if search and not all(word in haystack for word in search.lower().split()):
                continue
            if requested_tags and not requested_tags.issubset(
                {tag.lower() for tag in tool_tags}
            ):
                continue
            out.append(
                ToolDescriptor(
                    id=tool_id,
                    display_name=display,
                    description=description,
                    tags=tool_tags,
                    output_kind=(
                        OutputKind(str(kind)) if isinstance(kind, str) else None
                    ),
                )
            )
        return out

    async def get_schema(
        self, credential: ProviderCredential, tool_id: str
    ) -> Mapping[str, Any]:
        tool = self._tool_or_raise(tool_id)
        schema = tool.get("inputSchema")
        if not isinstance(schema, Mapping):
            raise ComputeProviderError(
                f"{self.provider_id}: tool {tool_id!r} has no input schema"
            )
        return dict(schema)

    async def validate(
        self,
        credential: ProviderCredential,
        tool_id: str,
        settings: Mapping[str, Any],
    ) -> ValidationResult:
        schema = await self.get_schema(credential, tool_id)
        problems = schema_problems(settings, schema)
        return ValidationResult(ok=not problems, problems=tuple(problems))

    async def estimate(
        self,
        credential: ProviderCredential,
        tool_id: str,
        settings: Mapping[str, Any],
    ) -> CostEstimate:
        self._tool_or_raise(tool_id)
        return CostEstimate(
            amount=None,
            unit=self.manifest.cost,
            note=f"{self.manifest.display_name} does not publish a pre-submit estimate.",
        )

    async def submit(
        self, credential: ProviderCredential, request: SubmitRequest
    ) -> ProviderJobRef:
        tool = self._tool_or_raise(request.tool_id)
        validation = await self.validate(credential, request.tool_id, request.settings)
        if not validation.ok:
            raise InvalidJobSettingsError(
                f"{self.provider_id}: invalid settings", problems=validation.problems
            )
        headers = {
            self.poll_seconds_header: str(self.poll_seconds),
            "Content-Type": "application/json",
        }
        response = await self._request(
            "POST",
            str(tool["path"]),
            credential,
            json_body=dict(request.settings),
            headers=headers,
            accept_statuses=(200, 202),
        )
        if response.status_code == 202:
            request_id = response.headers.get(self.request_id_header)
            if not request_id:
                raise ComputeProviderError(
                    f"{self.provider_id}: 202 without {self.request_id_header}"
                )
            return ProviderJobRef(
                self.provider_id,
                f"{PENDING_PREFIX}{request_id}",
                request.tool_id,
            )
        inline_id = f"{INLINE_PREFIX}{uuid.uuid4()}"
        self._inline_results[inline_id] = (request.tool_id, self.json_of(response))
        return ProviderJobRef(self.provider_id, inline_id, request.tool_id)

    async def status(
        self, credential: ProviderCredential, ref: ProviderJobRef
    ) -> JobStatus:
        if ref.remote_id.startswith(INLINE_PREFIX):
            if ref.remote_id not in self._inline_results:
                raise UnknownJobError(
                    f"{self.provider_id}: inline result {ref.remote_id} is gone after restart",
                    status_code=404,
                )
            return JobStatus(ref, JobState.COMPLETED, provider_state="inline-200")
        request_id = ref.remote_id.removeprefix(PENDING_PREFIX)
        path = self.status_path_template.replace(
            "{request_id}", quote(request_id, safe="")
        )
        response = await self._request(
            "GET",
            path,
            credential,
            headers={self.poll_seconds_header: "1"},
            accept_statuses=(200, 202),
        )
        if response.status_code == 202:
            return JobStatus(ref, JobState.RUNNING, provider_state="202 pending")
        self._inline_results[ref.remote_id] = (ref.tool_id, self.json_of(response))
        return JobStatus(ref, JobState.COMPLETED, provider_state="200")

    async def fetch_result(
        self, credential: ProviderCredential, ref: ProviderJobRef
    ) -> ResultBundle:
        cached = self._inline_results.get(ref.remote_id)
        if cached is None:
            status = await self.status(credential, ref)
            if status.state is not JobState.COMPLETED:
                raise ProviderUnavailableError(
                    f"{self.provider_id}: job {ref.remote_id} is not finished"
                )
            cached = self._inline_results[ref.remote_id]
        tool_id, payload = cached
        return self._result_codec(ref, tool_id, payload, self._tools.get(tool_id, {}))

    async def cancel(
        self, credential: ProviderCredential, ref: ProviderJobRef
    ) -> JobStatus:
        raise ComputeProviderError(
            f"{self.provider_id}: cannot cancel remote NVCF work: {self.manifest.cancellation_note}"
        )

    def _tool_or_raise(self, tool_id: str) -> Mapping[str, Any]:
        tool = self._tools.get(tool_id)
        if tool is None:
            raise InvalidJobSettingsError(
                f"{self.provider_id}: unknown tool {tool_id!r}",
                problems=(f"tool_id: unknown ({', '.join(sorted(self._tools))})",),
            )
        return tool


__all__ = [
    "INLINE_PREFIX",
    "NvcfBinding",
    "PENDING_PREFIX",
    "POLL_SECONDS_HEADER",
    "REQUEST_ID_HEADER",
]
