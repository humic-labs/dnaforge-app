from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping

from .contract import ComputeOperation

MANIFESTS_DIR_ENV = "DNAFORGE_COMPUTE_MANIFESTS_DIR"
USER_MANIFESTS_DIR_ENV = "DNAFORGE_COMPUTE_USER_MANIFESTS_DIR"
_REQUIRED_TOOLMAP_OPS = ("list_tools", "get_schema", "submit", "status", "fetch_result")
_ALLOWED_HEADERS = frozenset({"x-api-key", "authorization"})
_ALLOWED_HTTP_JOB_HEADERS = frozenset({"accept", "content-type", "prefer"})
_HTTP_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE"})
_HTTP_BODY_PLACEHOLDERS = frozenset(
    {"$settings", "$tool_id", "$label", "$idempotency_key"}
)
_JOB_STATES = frozenset({"queued", "running", "completed", "failed", "canceled"})
_PROVIDER_ID = re.compile(r"^[a-z][a-z0-9_-]{1,63}$")
_INPUT_SCHEMA_KEYS = frozenset(
    {
        "type",
        "title",
        "description",
        "default",
        "enum",
        "required",
        "properties",
        "items",
        "minLength",
        "maxLength",
        "pattern",
        "patternMessage",
        "minItems",
        "maxItems",
        "minimum",
        "maximum",
        "additionalProperties",
    }
)
_INPUT_SCHEMA_TYPES = frozenset(
    {"object", "array", "string", "integer", "number", "boolean", "null"}
)
_SAFE_SIMPLE_PATTERN = re.compile(
    r"^\^\[[^\]\r\n]{1,80}\](?:[+*?]|\{\d{1,4}(?:,\d{0,4})?\})?\$$"
)


class ManifestError(ValueError):
    pass


@dataclass(frozen=True)
class ToolMapping:
    tool: str
    args: Mapping[str, str] = field(default_factory=dict)
    result_path: str = ""


PLACEHOLDERS = frozenset(
    {
        "$tool_id",
        "$settings",
        "$label",
        "$remote_id",
        "$search",
        "$tags",
        "$tag",
        "$files",
        "$idempotency_key",
    }
)


@dataclass(frozen=True)
class ProviderManifest:
    schema_version: int
    id: str
    display_name: str
    summary: str
    transport: str
    auth_scheme: str
    auth_header_name: str | None
    catalog: str
    job_model: str
    staging: str
    cost: str
    rate_limit_rps: float
    disclosure: str
    retention_note: str
    cancellation_mode: str
    cancellation_note: str
    driver_kind: str
    source: str
    docs_url: str
    key_page_url: str | None
    terms_url: str
    privacy_url: str
    mcp_url: str | None = None
    base_url: str | None = None
    tool_map: Mapping[str, ToolMapping] = field(default_factory=dict)
    status_map: Mapping[str, str] = field(default_factory=dict)
    status_path: str = ""
    remote_id_path: str = ""
    static_tools: tuple[Mapping[str, Any], ...] = ()
    verify: Mapping[str, Any] = field(default_factory=dict)
    driver: Mapping[str, Any] = field(default_factory=dict)
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    def mapping_for(self, operation: ComputeOperation) -> ToolMapping | None:
        return self.tool_map.get(operation.value)

    def public_view(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "display_name": self.display_name,
            "summary": self.summary,
            "transport": self.transport,
            "driver": self.driver_kind,
            "custom": self.source == "user",
            "auth_scheme": self.auth_scheme,
            "credential_header": (
                self.auth_header_name
                if self.auth_scheme == "header"
                else "Authorization" if self.auth_scheme == "bearer" else None
            ),
            "endpoint_url": self.mcp_url or self.base_url or "",
            "verify_target": str(self.verify.get("target") or ""),
            "catalog": self.catalog,
            "job_model": self.job_model,
            "cost": self.cost,
            "disclosure": self.disclosure,
            "retention_note": self.retention_note,
            "cancellation_mode": self.cancellation_mode,
            "cancellation_note": self.cancellation_note,
            "docs_url": self.docs_url,
            "key_page_url": self.key_page_url,
            "terms_url": self.terms_url,
            "privacy_url": self.privacy_url,
        }


def _normalize_tool_map(raw: Any, manifest_id: str) -> dict[str, ToolMapping]:
    if not isinstance(raw, Mapping):
        raise ManifestError(f"{manifest_id}: toolMap must be an object")
    out: dict[str, ToolMapping] = {}
    known = {op.value for op in ComputeOperation}
    for op, entry in raw.items():
        if op not in known:
            raise ManifestError(f"{manifest_id}: toolMap has unknown operation {op!r}")
        if isinstance(entry, str):
            out[op] = ToolMapping(tool=entry)
            continue
        if not isinstance(entry, Mapping) or not isinstance(entry.get("tool"), str):
            raise ManifestError(
                f"{manifest_id}: toolMap.{op} must be a tool name or {{tool, args?, resultPath?}}"
            )
        args = entry.get("args", {})
        if not isinstance(args, Mapping):
            raise ManifestError(f"{manifest_id}: toolMap.{op}.args must be an object")
        for remote_arg, placeholder in args.items():
            if not isinstance(placeholder, str) or placeholder not in PLACEHOLDERS:
                raise ManifestError(
                    f"{manifest_id}: toolMap.{op}.args.{remote_arg} uses unknown placeholder {placeholder!r}"
                )
        out[op] = ToolMapping(
            tool=entry["tool"],
            args=dict(args),
            result_path=str(entry.get("resultPath") or ""),
        )
    for required in _REQUIRED_TOOLMAP_OPS:
        if required not in out:
            raise ManifestError(
                f"{manifest_id}: toolMap lacks required operation {required!r}"
            )
    return out


def _relative_rest_path(value: Any, label: str, manifest_id: str) -> str:
    if (
        not isinstance(value, str)
        or not value.startswith("/")
        or value.startswith("//")
        or "\\" in value
        or "#" in value
        or len(value) > 256
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise ManifestError(
            f"{manifest_id}: {label} must be a same-origin relative path beginning with one slash"
        )
    return value


def _http_method(value: Any, label: str, manifest_id: str) -> str:
    if not isinstance(value, str) or value not in _HTTP_METHODS:
        raise ManifestError(
            f"{manifest_id}: {label} must be one of {sorted(_HTTP_METHODS)}"
        )
    return str(value)


def _required_string(
    raw: Mapping[str, Any], key: str, manifest_id: str, *, minimum: int = 1
) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or len(value.strip()) < minimum:
        raise ManifestError(f"{manifest_id}: {key} must be a non-empty string")
    return value


def _validate_http_body_template(value: Any, manifest_id: str) -> None:
    if isinstance(value, str):
        if value.startswith("$") and value not in _HTTP_BODY_PLACEHOLDERS:
            raise ManifestError(
                f"{manifest_id}: driver.submit.bodyTemplate uses unknown or unsafe placeholder {value!r}"
            )
        return
    if isinstance(value, Mapping):
        for nested in value.values():
            _validate_http_body_template(nested, manifest_id)
        return
    if isinstance(value, list):
        for nested in value:
            _validate_http_body_template(nested, manifest_id)


def _validate_input_schema(
    schema: Any, manifest_id: str, label: str, *, depth: int = 0
) -> None:
    if not isinstance(schema, Mapping):
        raise ManifestError(f"{manifest_id}: {label} must be an object")
    if depth > 12:
        raise ManifestError(f"{manifest_id}: {label} may not exceed 12 nested levels")
    unknown = set(schema) - _INPUT_SCHEMA_KEYS
    if unknown:
        raise ManifestError(
            f"{manifest_id}: {label} uses unsupported schema keyword {sorted(unknown)[0]!r}"
        )
    schema_type = schema.get("type")
    if schema_type is not None and (
        not isinstance(schema_type, str) or schema_type not in _INPUT_SCHEMA_TYPES
    ):
        raise ManifestError(f"{manifest_id}: {label}.type is unsupported")
    for key in ("title", "description", "patternMessage"):
        value = schema.get(key)
        if value is not None and (not isinstance(value, str) or len(value) > 500):
            raise ManifestError(
                f"{manifest_id}: {label}.{key} must be at most 500 characters"
            )
    for key in ("minLength", "maxLength", "minItems", "maxItems"):
        value = schema.get(key)
        if value is not None and (
            not isinstance(value, int)
            or isinstance(value, bool)
            or value < 0
            or value > 1_000_000
        ):
            raise ManifestError(
                f"{manifest_id}: {label}.{key} must be an integer from 0-1000000"
            )
    for key in ("minimum", "maximum"):
        value = schema.get(key)
        if value is not None and (
            not isinstance(value, (int, float)) or isinstance(value, bool)
        ):
            raise ManifestError(f"{manifest_id}: {label}.{key} must be a number")
    for minimum, maximum in (
        ("minimum", "maximum"),
        ("minLength", "maxLength"),
        ("minItems", "maxItems"),
    ):
        if (
            isinstance(schema.get(minimum), (int, float))
            and not isinstance(schema.get(minimum), bool)
            and isinstance(schema.get(maximum), (int, float))
            and not isinstance(schema.get(maximum), bool)
            and schema[minimum] > schema[maximum]
        ):
            raise ManifestError(
                f"{manifest_id}: {label}.{minimum} may not exceed {maximum}"
            )
    pattern = schema.get("pattern")
    if pattern is not None and (
        not isinstance(pattern, str) or _SAFE_SIMPLE_PATTERN.fullmatch(pattern) is None
    ):
        raise ManifestError(
            f"{manifest_id}: {label}.pattern must be an anchored simple character-class pattern"
        )
    enum = schema.get("enum")
    if enum is not None and (not isinstance(enum, list) or len(enum) > 256):
        raise ManifestError(
            f"{manifest_id}: {label}.enum must contain at most 256 values"
        )
    additional = schema.get("additionalProperties")
    if additional is not None and not isinstance(additional, bool):
        raise ManifestError(
            f"{manifest_id}: {label}.additionalProperties must be boolean"
        )
    properties = schema.get("properties")
    if properties is not None:
        if not isinstance(properties, Mapping) or len(properties) > 128:
            raise ManifestError(
                f"{manifest_id}: {label}.properties must contain at most 128 fields"
            )
        for field_name, field_schema in properties.items():
            if not isinstance(field_name, str) or not 0 < len(field_name) <= 128:
                raise ManifestError(
                    f"{manifest_id}: {label}.properties has an invalid field name"
                )
            _validate_input_schema(
                field_schema,
                manifest_id,
                f"{label}.properties.{field_name}",
                depth=depth + 1,
            )
    required = schema.get("required")
    if required is not None and (
        not isinstance(required, list)
        or len(required) > 128
        or any(
            not isinstance(field, str) or not 0 < len(field) <= 128
            for field in required
        )
        or len(set(required)) != len(required)
    ):
        raise ManifestError(
            f"{manifest_id}: {label}.required must contain unique field names"
        )
    if "items" in schema:
        _validate_input_schema(
            schema["items"], manifest_id, f"{label}.items", depth=depth + 1
        )


def _validate_http_job_driver(
    driver: Mapping[str, Any], raw: Mapping[str, Any], manifest_id: str
) -> None:
    if raw.get("transport") != "rest":
        raise ManifestError(
            f"{manifest_id}: driver 'http-job' requires transport 'rest'"
        )
    if raw.get("jobModel") != "async":
        raise ManifestError(
            f"{manifest_id}: driver 'http-job' requires jobModel 'async'"
        )
    if raw.get("catalog") != "static":
        raise ManifestError(
            f"{manifest_id}: driver 'http-job' currently requires a static catalog"
        )
    submit = driver.get("submit")
    status = driver.get("status")
    result = driver.get("result")
    if not isinstance(submit, Mapping) or not isinstance(submit.get("idPath"), str):
        raise ManifestError(f"{manifest_id}: driver.submit.idPath is required")
    _http_method(submit.get("method", "POST"), "driver.submit.method", manifest_id)
    headers = submit.get("headers", {})
    if not isinstance(headers, Mapping):
        raise ManifestError(f"{manifest_id}: driver.submit.headers must be an object")
    if any(str(name).lower() not in _ALLOWED_HTTP_JOB_HEADERS for name in headers):
        raise ManifestError(
            f"{manifest_id}: driver.submit.headers contains a header outside the allowlist"
        )
    accepted_statuses = submit.get("acceptedStatuses")
    if accepted_statuses is not None and (
        not isinstance(accepted_statuses, list)
        or not accepted_statuses
        or len(accepted_statuses) > 8
        or any(
            not isinstance(status_code, int) or not 200 <= status_code <= 299
            for status_code in accepted_statuses
        )
    ):
        raise ManifestError(
            f"{manifest_id}: driver.submit.acceptedStatuses must contain 1-8 2xx integers"
        )
    if not isinstance(status, Mapping):
        raise ManifestError(f"{manifest_id}: driver.status is required")
    _http_method(status.get("method", "GET"), "driver.status.method", manifest_id)
    path_template = _relative_rest_path(
        status.get("pathTemplate"), "driver.status.pathTemplate", manifest_id
    )
    if "{remote_id}" not in path_template:
        raise ManifestError(
            f"{manifest_id}: driver.status.pathTemplate must be relative and contain {{remote_id}}"
        )
    if not isinstance(status.get("statePath"), str) or not status["statePath"]:
        raise ManifestError(f"{manifest_id}: driver.status.statePath is required")
    status_map = status.get("statusMap")
    if not isinstance(status_map, Mapping) or not status_map:
        raise ManifestError(f"{manifest_id}: driver.status.statusMap is required")
    if any(
        not isinstance(provider_state, str)
        or not provider_state
        or not isinstance(state, str)
        or state not in _JOB_STATES
        for provider_state, state in status_map.items()
    ):
        raise ManifestError(
            f"{manifest_id}: driver.status.statusMap has an unknown state"
        )
    if not isinstance(result, Mapping) or result.get("codec", "raw-json") != "raw-json":
        raise ManifestError(f"{manifest_id}: driver.result.codec is unsupported")
    if not isinstance(result.get("payloadPath", ""), str):
        raise ManifestError(
            f"{manifest_id}: driver.result.payloadPath must be a string"
        )
    _validate_http_body_template(submit.get("bodyTemplate"), manifest_id)
    cancel = driver.get("cancel")
    cancellation_mode = (raw.get("cancellation") or {}).get("mode")
    if cancellation_mode == "provider" and not isinstance(cancel, Mapping):
        raise ManifestError(
            f"{manifest_id}: provider cancellation requires driver.cancel"
        )
    if cancellation_mode == "unavailable" and isinstance(cancel, Mapping):
        raise ManifestError(
            f"{manifest_id}: driver.cancel requires cancellation.mode 'provider'"
        )
    if isinstance(cancel, Mapping):
        _http_method(cancel.get("method", "POST"), "driver.cancel.method", manifest_id)
        cancel_path = _relative_rest_path(
            cancel.get("pathTemplate"), "driver.cancel.pathTemplate", manifest_id
        )
        if "{remote_id}" not in cancel_path:
            raise ManifestError(
                f"{manifest_id}: driver.cancel.pathTemplate must be relative and contain {{remote_id}}"
            )
        if cancel.get("statePath") is not None and not isinstance(
            cancel.get("statePath"), str
        ):
            raise ManifestError(
                f"{manifest_id}: driver.cancel.statePath must be a string"
            )


def parse_manifest(
    raw: Mapping[str, Any], *, source: str = "bundled"
) -> ProviderManifest:
    if not isinstance(raw, Mapping):
        raise ManifestError("compute manifest must be a JSON object")
    if source not in ("bundled", "user"):
        raise ManifestError(f"compute manifest source is invalid: {source!r}")
    raw_id = raw.get("id")
    manifest_id = raw_id if isinstance(raw_id, str) else "<unknown>"
    if not isinstance(raw_id, str) or not _PROVIDER_ID.fullmatch(raw_id):
        raise ManifestError(f"{manifest_id}: id must match ^[a-z][a-z0-9_-]{{1,63}}$")
    schema_version = raw.get("schemaVersion")
    if schema_version not in (1, 2):
        raise ManifestError(
            f"{manifest_id}: unsupported schemaVersion {schema_version!r}"
        )
    transport = raw.get("transport")
    if transport not in ("mcp", "rest"):
        raise ManifestError(f"{manifest_id}: transport must be 'mcp' or 'rest'")
    display_name = _required_string(raw, "displayName", manifest_id)
    summary = _required_string(raw, "summary", manifest_id)
    if len(display_name) > 80 or len(summary) > 240:
        raise ManifestError(f"{manifest_id}: displayName or summary is too long")
    auth = raw.get("auth") or {}
    if not isinstance(auth, Mapping):
        raise ManifestError(f"{manifest_id}: auth must be an object")
    scheme = auth.get("scheme")
    header_name = auth.get("headerName")
    if scheme not in ("header", "bearer", "oauth"):
        raise ManifestError(f"{manifest_id}: auth.scheme must be header|bearer|oauth")
    if scheme == "header":
        if (
            not isinstance(header_name, str)
            or header_name.lower() not in _ALLOWED_HEADERS
        ):
            raise ManifestError(
                f"{manifest_id}: auth.headerName must be one of {sorted(_ALLOWED_HEADERS)}"
            )
    if scheme == "oauth":
        for oauth_url in ("authorizationUrl", "tokenUrl"):
            if not str(auth.get(oauth_url, "")).startswith("https://"):
                raise ManifestError(
                    f"{manifest_id}: auth.{oauth_url} must be an https:// URL"
                )
    for url_key in ("docsUrl", "termsUrl", "privacyUrl"):
        if not str(raw.get(url_key, "")).startswith("https://"):
            raise ManifestError(f"{manifest_id}: {url_key} must be an https:// URL")
    key_page_url = raw.get("keyPageUrl")
    if scheme != "oauth" and not str(key_page_url or "").startswith("https://"):
        raise ManifestError(
            f"{manifest_id}: keyPageUrl must be an https:// URL for key authentication"
        )
    verify = raw.get("verify")
    if not isinstance(verify, Mapping):
        raise ManifestError(f"{manifest_id}: verify must be an object")
    verify_method = verify.get("method")
    if verify_method not in ("GET", "POST"):
        raise ManifestError(f"{manifest_id}: verify.method must be GET or POST")
    verify_target = verify.get("target")
    if not isinstance(verify_target, str) or not verify_target:
        raise ManifestError(f"{manifest_id}: verify.target must be non-empty")
    tool_map: dict[str, ToolMapping] = {}
    mcp_url = None
    base_url = None
    if transport == "mcp":
        mcp_url = raw.get("mcpUrl")
        if not str(mcp_url or "").startswith("https://"):
            raise ManifestError(f"{manifest_id}: mcpUrl must be an https:// URL")
        tool_map = _normalize_tool_map(raw.get("toolMap", {}), manifest_id)
    else:
        base_url = raw.get("baseUrl")
        if not str(base_url or "").startswith("https://"):
            raise ManifestError(f"{manifest_id}: baseUrl must be an https:// URL")
        _relative_rest_path(verify_target, "verify.target", manifest_id)
    raw_static_tools = raw.get("staticTools") or ()
    if not isinstance(raw_static_tools, (list, tuple)):
        raise ManifestError(f"{manifest_id}: staticTools must be an array")
    static_tools = tuple(raw_static_tools)
    catalog = raw.get("catalog")
    if catalog not in ("dynamic", "static"):
        raise ManifestError(f"{manifest_id}: catalog must be dynamic or static")
    if catalog == "static" and not static_tools:
        raise ManifestError(f"{manifest_id}: static catalog requires staticTools")
    if catalog == "dynamic" and static_tools:
        raise ManifestError(
            f"{manifest_id}: dynamic catalog must not include staticTools"
        )
    tool_ids: set[str] = set()
    for index, tool in enumerate(static_tools):
        if not isinstance(tool, Mapping):
            raise ManifestError(
                f"{manifest_id}: staticTools[{index}] must be an object"
            )
        tool_id = tool.get("id")
        if not isinstance(tool_id, str) or not tool_id or tool_id in tool_ids:
            raise ManifestError(
                f"{manifest_id}: staticTools[{index}].id must be non-empty and unique"
            )
        tool_ids.add(tool_id)
        if not isinstance(tool.get("displayName"), str) or not tool["displayName"]:
            raise ManifestError(
                f"{manifest_id}: staticTools[{index}].displayName is required"
            )
        if transport == "rest":
            _relative_rest_path(
                tool.get("path"), f"staticTools[{index}].path", manifest_id
            )
        input_schema = tool.get("inputSchema")
        if input_schema is not None:
            _validate_input_schema(
                input_schema, manifest_id, f"staticTools[{index}].inputSchema"
            )

    job_model = raw.get("jobModel")
    if job_model not in ("queue", "longpoll-202", "async"):
        raise ManifestError(f"{manifest_id}: jobModel is invalid")
    staging = raw.get("staging")
    if staging not in ("inline", "upload", "multipart"):
        raise ManifestError(f"{manifest_id}: staging is invalid")
    cost = raw.get("cost")
    if cost not in ("estimate", "rate-card", "credits", "none"):
        raise ManifestError(f"{manifest_id}: cost is invalid")

    cancellation = raw.get("cancellation") or {}
    if not isinstance(cancellation, Mapping):
        raise ManifestError(f"{manifest_id}: cancellation must be an object")
    cancellation_mode = cancellation.get("mode")
    cancellation_note = cancellation.get("note")
    if cancellation_mode not in ("provider", "unavailable"):
        raise ManifestError(
            f"{manifest_id}: cancellation.mode must be 'provider' or 'unavailable'"
        )
    if not isinstance(cancellation_note, str) or not cancellation_note.strip():
        raise ManifestError(f"{manifest_id}: cancellation.note must be non-empty")

    driver_raw = raw.get("driver")
    if schema_version == 2:
        if not isinstance(driver_raw, Mapping):
            raise ManifestError(f"{manifest_id}: driver is required in schemaVersion 2")
        driver_kind = driver_raw.get("kind")
        if driver_kind not in ("mcp-tool-map", "nvcf", "http-job"):
            raise ManifestError(f"{manifest_id}: unsupported driver {driver_kind!r}")
    else:
        driver_kind = "mcp-tool-map" if transport == "mcp" else "legacy-rest"
        driver_raw = {}

    if driver_kind == "mcp-tool-map" and transport != "mcp":
        raise ManifestError(
            f"{manifest_id}: driver 'mcp-tool-map' requires transport 'mcp'"
        )
    if driver_kind == "nvcf":
        if transport != "rest":
            raise ManifestError(
                f"{manifest_id}: driver 'nvcf' requires transport 'rest'"
            )
        if raw.get("jobModel") != "longpoll-202":
            raise ManifestError(
                f"{manifest_id}: driver 'nvcf' requires jobModel 'longpoll-202'"
            )
        if catalog != "static":
            raise ManifestError(
                f"{manifest_id}: driver 'nvcf' currently requires a static catalog"
            )
        poll_seconds = driver_raw.get("pollSeconds", 30)
        if not isinstance(poll_seconds, int) or not 1 <= poll_seconds <= 300:
            raise ManifestError(f"{manifest_id}: driver.pollSeconds must be 1-300")
        status_path = _relative_rest_path(
            driver_raw.get("statusPathTemplate", "/status/{request_id}"),
            "driver.statusPathTemplate",
            manifest_id,
        )
        if "{request_id}" not in status_path:
            raise ManifestError(
                f"{manifest_id}: driver.statusPathTemplate must contain {{request_id}}"
            )
        if driver_raw.get("resultCodec", "raw-json") not in (
            "raw-json",
            "nvidia-biology",
        ):
            raise ManifestError(f"{manifest_id}: driver.resultCodec is unsupported")
        for index, tool in enumerate(static_tools):
            if not isinstance(tool, Mapping) or not isinstance(
                tool.get("inputSchema"), Mapping
            ):
                raise ManifestError(
                    f"{manifest_id}: staticTools[{index}].inputSchema is required for driver 'nvcf'"
                )
    if driver_kind == "http-job":
        _validate_http_job_driver(driver_raw, raw, manifest_id)
        for index, tool in enumerate(static_tools):
            if not isinstance(tool, Mapping) or not isinstance(
                tool.get("inputSchema"), Mapping
            ):
                raise ManifestError(
                    f"{manifest_id}: staticTools[{index}].inputSchema is required for driver 'http-job'"
                )
    rps = raw.get("rateLimitRps")
    if (
        not isinstance(rps, (int, float))
        or isinstance(rps, bool)
        or rps <= 0
        or rps > 50
    ):
        raise ManifestError(f"{manifest_id}: rateLimitRps must be a positive number")
    disclosure = _required_string(raw, "disclosure", manifest_id, minimum=40)
    if display_name not in disclosure or "bill" not in disclosure.lower():
        raise ManifestError(
            f"{manifest_id}: disclosure must name the provider and say who is billed"
        )
    retention_note = _required_string(raw, "retentionNote", manifest_id)
    raw_status_map = raw.get("statusMap", {})
    if not isinstance(raw_status_map, Mapping):
        raise ManifestError(f"{manifest_id}: statusMap must be an object")
    status_map = {str(k).lower(): str(v) for k, v in raw_status_map.items()}
    return ProviderManifest(
        schema_version=int(schema_version),
        id=manifest_id,
        display_name=display_name,
        summary=summary,
        transport=transport,
        auth_scheme=scheme,
        auth_header_name=header_name,
        catalog=catalog,
        job_model=str(job_model),
        staging=str(staging),
        cost=str(cost),
        rate_limit_rps=float(rps),
        disclosure=disclosure,
        retention_note=retention_note,
        cancellation_mode=cancellation_mode,
        cancellation_note=cancellation_note.strip(),
        driver_kind=str(driver_kind),
        source=source,
        docs_url=str(raw["docsUrl"]),
        key_page_url=key_page_url,
        terms_url=str(raw["termsUrl"]),
        privacy_url=str(raw["privacyUrl"]),
        mcp_url=mcp_url,
        base_url=base_url,
        tool_map=tool_map,
        status_map=status_map,
        status_path=str(raw.get("statusPath") or ""),
        remote_id_path=str(raw.get("remoteIdPath") or ""),
        static_tools=static_tools,
        verify=dict(verify),
        driver=dict(driver_raw),
        raw=dict(raw),
    )


def _dedupe(paths: Iterable[Path]) -> list[Path]:
    seen: set[Path] = set()
    out: list[Path] = []
    for p in paths:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


def manifests_candidate_dirs() -> list[Path]:
    candidates: list[Path] = []
    module_path = Path(__file__).resolve()
    for ancestor in (module_path.parent, *module_path.parents):
        candidates.append(ancestor / "packages/core/compute-endpoints/manifests")
        candidates.append(ancestor / "compute-endpoints/manifests")
    if sys.argv and sys.argv[0]:
        executable_dir = Path(sys.argv[0]).resolve().parent
        candidates.append(executable_dir / "compute-endpoints/manifests")
    candidates.append(Path.cwd() / "packages/core/compute-endpoints/manifests")
    return _dedupe(candidates)


def resolve_manifests_dir() -> Path:
    configured = os.environ.get(MANIFESTS_DIR_ENV)
    if configured:
        path = Path(configured).expanduser()
        if path.is_dir():
            return path
        raise RuntimeError(
            f"{MANIFESTS_DIR_ENV} is configured but is not a directory: {path}"
        )
    checked: list[Path] = []
    for directory in manifests_candidate_dirs():
        checked.append(directory)
        if directory.is_dir() and any(directory.glob("*.json")):
            return directory
    raise RuntimeError(
        "Compute provider manifests not found. Checked:\n"
        + "\n".join(f"  - {p}" for p in checked)
    )


def load_manifests(
    directory: Path | None = None, *, user_directory: Path | None = None
) -> dict[str, ProviderManifest]:
    use_environment_user_dir = directory is None and user_directory is None
    directory = directory or resolve_manifests_dir()
    out: dict[str, ProviderManifest] = {}
    directories: list[tuple[Path, str]] = [(directory, "bundled")]
    if use_environment_user_dir:
        configured_user_dir = os.environ.get(USER_MANIFESTS_DIR_ENV)
        if configured_user_dir:
            candidate = Path(configured_user_dir).expanduser()
            if candidate.exists() and not candidate.is_dir():
                raise RuntimeError(
                    f"{USER_MANIFESTS_DIR_ENV} is configured but is not a directory: {candidate}"
                )
            if candidate.is_dir():
                user_directory = candidate
    if user_directory is not None:
        directories.append((user_directory, "user"))
    for manifest_directory, source in directories:
        if not manifest_directory.is_dir():
            continue
        for path in sorted(manifest_directory.glob("*.json")):
            manifest = parse_manifest(json.loads(path.read_text()), source=source)
            if source == "user" and manifest.schema_version != 2:
                raise ManifestError(
                    f"{manifest.id}: custom manifests must use schemaVersion 2"
                )
            if manifest.id in out:
                raise ManifestError(
                    f"duplicate provider id {manifest.id!r} ({path.name})"
                )
            out[manifest.id] = manifest
    return out


__all__ = [
    "MANIFESTS_DIR_ENV",
    "USER_MANIFESTS_DIR_ENV",
    "ManifestError",
    "PLACEHOLDERS",
    "ProviderManifest",
    "ToolMapping",
    "load_manifests",
    "manifests_candidate_dirs",
    "parse_manifest",
    "resolve_manifests_dir",
]
