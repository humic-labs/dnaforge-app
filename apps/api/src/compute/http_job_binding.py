"""Constrained declarative driver for ordinary asynchronous HTTP jobs.

The manifest supplies relative paths, response selectors, a status map, and a
JSON body template. The template language is deliberately not executable: it
can insert only the stable submit values and cannot read environment variables,
files, cookies, or arbitrary headers.
"""

from __future__ import annotations

import hashlib
import json
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
    ValidationResult,
)
from .json_schema import schema_problems
from .manifests import ProviderManifest
from .rest_binding import RestProviderBinding
from .result_codecs import RESULT_CODECS

_PLACEHOLDERS = frozenset({"$settings", "$tool_id", "$label", "$idempotency_key"})


def _walk(value: Any, path: str) -> Any:
    current = value
    if not path:
        return current
    for part in path.split("."):
        if isinstance(current, Mapping) and part in current:
            current = current[part]
            continue
        if isinstance(current, list) and part.isdigit():
            index = int(part)
            if index < len(current):
                current = current[index]
                continue
        raise ComputeProviderError(f"response has no value at {path!r}")
    return current


def _resolve_body_template(template: Any, values: Mapping[str, Any]) -> Any:
    if isinstance(template, str) and template.startswith("$"):
        if template not in _PLACEHOLDERS:
            raise ComputeProviderError(f"unsafe HTTP job placeholder {template!r}")
        return values.get(template)
    if isinstance(template, Mapping):
        return {
            str(key): _resolve_body_template(value, values)
            for key, value in template.items()
        }
    if isinstance(template, list):
        return [_resolve_body_template(value, values) for value in template]
    return template


class HttpJobBinding(RestProviderBinding):
    """Manifest-driven async submit/status/result/cancel REST lifecycle."""

    def __init__(
        self, manifest: ProviderManifest, *, client: httpx.AsyncClient | None = None
    ) -> None:
        super().__init__(manifest, client=client)
        if manifest.driver_kind != "http-job":
            raise ValueError(
                f"{manifest.id}: HttpJobBinding requires driver 'http-job', got {manifest.driver_kind!r}"
            )
        self._driver = manifest.driver
        self._tools: dict[str, Mapping[str, Any]] = {
            str(tool["id"]): tool for tool in manifest.static_tools
        }
        status = self._mapping("status")
        self._status_map = {
            str(provider_state).lower(): JobState(str(state))
            for provider_state, state in self._mapping_value(
                status, "statusMap"
            ).items()
        }
        result = self._mapping("result")
        codec_name = str(result.get("codec") or "raw-json")
        try:
            self._result_codec = RESULT_CODECS[codec_name]
        except KeyError as exc:
            raise ValueError(
                f"{manifest.id}: unknown HTTP job result codec {codec_name!r}"
            ) from exc
        self._terminal_payloads: dict[tuple[str, str, str], tuple[str, Any]] = {}

    async def list_tools(
        self,
        credential: ProviderCredential,
        *,
        search: str | None = None,
        tags: tuple[str, ...] = (),
    ) -> list[ToolDescriptor]:
        requested_tags = {tag.lower() for tag in tags}
        tools: list[ToolDescriptor] = []
        for tool in self._tools.values():
            tool_id = str(tool["id"])
            display_name = str(tool.get("displayName") or tool_id)
            description = str(tool.get("description") or display_name)
            output_kind = tool.get("outputKind")
            tool_tags = tuple(str(tag) for tag in tool.get("tags") or ())
            keywords = " ".join(str(value) for value in tool.get("keywords") or ())
            haystack = f"{tool_id} {display_name} {description} {keywords}".lower()
            if search and not all(word in haystack for word in search.lower().split()):
                continue
            if requested_tags and not requested_tags.issubset(
                {tag.lower() for tag in tool_tags}
            ):
                continue
            tools.append(
                ToolDescriptor(
                    id=tool_id,
                    display_name=display_name,
                    description=description,
                    tags=tool_tags,
                    output_kind=(
                        OutputKind(str(output_kind))
                        if isinstance(output_kind, str)
                        else None
                    ),
                )
            )
        return tools

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
        unit = self.manifest.cost if self.manifest.cost != "none" else "not_available"
        return CostEstimate(
            amount=None,
            unit=unit,
            note=f"{self.manifest.display_name} did not provide a pre-submit estimate.",
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
        spec = self._mapping("submit")
        template = spec.get("bodyTemplate", "$settings")
        body = _resolve_body_template(
            template,
            {
                "$settings": dict(request.settings),
                "$tool_id": request.tool_id,
                "$label": request.label,
                "$idempotency_key": request.idempotency_key,
            },
        )
        accepted = tuple(
            int(code) for code in spec.get("acceptedStatuses") or (200, 201, 202)
        )
        response = await self._request(
            str(spec.get("method") or "POST"),
            str(tool["path"]),
            credential,
            json_body=body,
            headers={
                str(key): str(value)
                for key, value in (spec.get("headers") or {}).items()
            },
            accept_statuses=accepted,
        )
        payload = self.json_of(response)
        remote_id = _walk(payload, str(spec["idPath"]))
        if not isinstance(remote_id, (str, int)) or not str(remote_id):
            raise ProviderUnavailableError(
                f"{self.provider_id}: submit response did not contain a usable job id"
            )
        return ProviderJobRef(self.provider_id, str(remote_id), request.tool_id)

    async def status(
        self, credential: ProviderCredential, ref: ProviderJobRef
    ) -> JobStatus:
        spec = self._mapping("status")
        response = await self._request(
            str(spec.get("method") or "GET"),
            self._job_path(str(spec["pathTemplate"]), ref.remote_id),
            credential,
        )
        payload = self.json_of(response)
        raw_state = _walk(payload, str(spec["statePath"]))
        normalized = str(raw_state).lower()
        state = self._status_map.get(normalized)
        if state is None:
            raise ProviderUnavailableError(
                f"{self.provider_id}: unmapped job state {raw_state!r}"
            )
        if state is JobState.COMPLETED:
            self._terminal_payloads[self._result_key(credential, ref)] = (
                ref.tool_id,
                payload,
            )
        elif state in (JobState.FAILED, JobState.CANCELED):
            self._terminal_payloads.pop(self._result_key(credential, ref), None)
        progress = ""
        if isinstance(payload, Mapping):
            error = payload.get("error")
            if error:
                progress = str(error)[:500]
        return JobStatus(
            ref,
            state,
            provider_state=str(raw_state),
            progress_note=progress,
        )

    async def fetch_result(
        self, credential: ProviderCredential, ref: ProviderJobRef
    ) -> ResultBundle:
        cached = self._terminal_payloads.get(self._result_key(credential, ref))
        if cached is None:
            status = await self.status(credential, ref)
            if status.state is not JobState.COMPLETED:
                raise ComputeProviderError(
                    f"{self.provider_id}: job {ref.remote_id} is {status.state.value}, not completed"
                )
            cached = self._terminal_payloads[self._result_key(credential, ref)]
        tool_id, payload = cached
        result_spec = self._mapping("result")
        result_payload = _walk(payload, str(result_spec.get("payloadPath") or ""))
        return self._result_codec(
            ref, tool_id, result_payload, self._tools.get(tool_id, {})
        )

    async def cancel(
        self, credential: ProviderCredential, ref: ProviderJobRef
    ) -> JobStatus:
        raw_spec = self._driver.get("cancel")
        if not isinstance(raw_spec, Mapping):
            raise ComputeProviderError(
                f"{self.provider_id}: cannot cancel remote work: {self.manifest.cancellation_note}"
            )
        response = await self._request(
            str(raw_spec.get("method") or "POST"),
            self._job_path(str(raw_spec["pathTemplate"]), ref.remote_id),
            credential,
            accept_statuses=(200, 201, 202, 204),
        )
        payload = self.json_of(response)
        state_path = str(
            raw_spec.get("statePath") or self._mapping("status")["statePath"]
        )
        if payload is None and response.status_code == 204:
            confirmed = await self.status(credential, ref)
            if confirmed.state is JobState.CANCELED:
                return confirmed
            raise ProviderUnavailableError(
                f"{self.provider_id}: cancel was not acknowledged as canceled "
                f"({confirmed.provider_state!r})"
            )
        raw_state = _walk(payload, state_path)
        state = self._status_map.get(str(raw_state).lower())
        if state is not JobState.CANCELED:
            raise ProviderUnavailableError(
                f"{self.provider_id}: cancel was not acknowledged as canceled ({raw_state!r})"
            )
        self._terminal_payloads.pop(self._result_key(credential, ref), None)
        return JobStatus(ref, state, provider_state=str(raw_state))

    @staticmethod
    def _result_key(
        credential: ProviderCredential, ref: ProviderJobRef
    ) -> tuple[str, str, str]:
        scope = json.dumps(
            [
                credential.provider_id,
                credential.scheme.value,
                credential.as_headers(),
                ref.provider_id,
            ],
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(scope.encode()).hexdigest(), ref.remote_id, ref.tool_id

    def _mapping(self, key: str) -> Mapping[str, Any]:
        return self._mapping_value(self._driver, key)

    @staticmethod
    def _mapping_value(value: Mapping[str, Any], key: str) -> Mapping[str, Any]:
        nested = value.get(key)
        if not isinstance(nested, Mapping):
            raise ValueError(f"HTTP job driver lacks {key!r}")
        return nested

    @staticmethod
    def _job_path(template: str, remote_id: str) -> str:
        return template.replace("{remote_id}", quote(remote_id, safe=""))

    def _tool_or_raise(self, tool_id: str) -> Mapping[str, Any]:
        tool = self._tools.get(tool_id)
        if tool is None:
            raise InvalidJobSettingsError(
                f"{self.provider_id}: unknown tool {tool_id!r}",
                problems=(f"tool_id: unknown ({', '.join(sorted(self._tools))})",),
            )
        return tool


__all__ = ["HttpJobBinding"]
