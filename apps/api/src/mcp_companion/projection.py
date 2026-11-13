"""Lossless conversion from loopback JSON into typed MCP SDK results."""

from __future__ import annotations

import json
from copy import deepcopy
from typing import Any

from mcp import types
from pydantic import TypeAdapter, ValidationError

from .options import ClientSurface

_CONTENT_ADAPTER = TypeAdapter(types.ContentBlock)
_RESOURCE_CONTENT_ADAPTER = TypeAdapter(
    types.TextResourceContents | types.BlobResourceContents
)
_STANDARD_TOOL_ANNOTATIONS = {
    "title",
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
}
DNAFORGE_TOOL_META_KEY = "com.dnaforge/tool"
DNAFORGE_JOB_META_KEY = "com.dnaforge/job"
INPUT_FORM_SCHEMA_SENTENCE = (
    "Use one valid input form; do not mix fields from multiple alternatives."
)
INPUT_FORM_TOOL_SENTENCE = (
    "For this tool, provide the fields for exactly one supported input form; "
    "the desktop app validates the full request before execution."
)


def project_tool(raw: dict[str, Any]) -> types.Tool:
    """Project a sidecar tool without leaking custom keys into MCP annotations."""

    name = raw.get("name")
    input_schema = raw.get("inputSchema")
    if not isinstance(name, str) or not name:
        raise ValueError("Discovered tools must have a non-empty name.")
    if not isinstance(input_schema, dict):
        raise ValueError(f"Discovered tool {name!r} must have an inputSchema object.")
    normalized_input_schema = normalize_mcp_input_schema(input_schema)
    removed_top_level_alternatives = normalized_input_schema is not input_schema

    raw_annotations = raw.get("annotations")
    if not isinstance(raw_annotations, dict):
        raw_annotations = {}
    standard_annotations = {
        key: value
        for key, value in raw_annotations.items()
        if key in _STANDARD_TOOL_ANNOTATIONS
    }
    extension_annotations = {
        key: value
        for key, value in raw_annotations.items()
        if key not in _STANDARD_TOOL_ANNOTATIONS
    }

    meta = dict(raw.get("_meta") if isinstance(raw.get("_meta"), dict) else {})
    if extension_annotations:
        existing = meta.get(DNAFORGE_TOOL_META_KEY)
        dnaforge_meta = dict(existing) if isinstance(existing, dict) else {}
        dnaforge_meta.update(extension_annotations)
        meta[DNAFORGE_TOOL_META_KEY] = dnaforge_meta

    output_schema = raw.get("outputSchema")
    if output_schema is not None and not isinstance(output_schema, dict):
        raise ValueError(f"Discovered tool {name!r} has an invalid outputSchema.")
    normalized_output_schema = (
        normalize_mcp_output_schema(output_schema, tool_name=name)
        if output_schema is not None
        else None
    )

    if name == "mol_capture_screenshot" and normalized_output_schema is not None:

        normalized_output_schema = deepcopy(normalized_output_schema)
        image_schema = normalized_output_schema["properties"]["result"]
        image_schema["properties"].pop("data")
        image_schema["required"] = [
            field for field in image_schema["required"] if field != "data"
        ]

    return types.Tool(
        name=name,
        title=_optional_string(raw.get("title")),
        description=(
            append_sentence(
                _optional_string(raw.get("description")),
                INPUT_FORM_TOOL_SENTENCE,
            )
            if removed_top_level_alternatives
            else _optional_string(raw.get("description"))
        ),
        inputSchema=normalized_input_schema,
        outputSchema=normalized_output_schema,
        annotations=(
            types.ToolAnnotations.model_validate(standard_annotations)
            if standard_annotations
            else None
        ),
        _meta=meta or None,
    )


def project_resource(raw: dict[str, Any]) -> types.Resource:
    uri = raw.get("uri")
    if not isinstance(uri, str) or not uri:
        raise ValueError("Discovered resources must have a non-empty uri.")
    name = raw.get("name")
    return types.Resource(
        uri=uri,
        name=name if isinstance(name, str) and name else uri,
        title=_optional_string(raw.get("title")),
        description=_optional_string(raw.get("description")),
        mimeType=_optional_string(raw.get("mimeType")),
        size=raw.get("size") if isinstance(raw.get("size"), int) else None,
        _meta=raw.get("_meta") if isinstance(raw.get("_meta"), dict) else None,
    )


def project_resource_template(raw: dict[str, Any]) -> types.ResourceTemplate:
    uri_template = raw.get("uriTemplate")
    if not isinstance(uri_template, str) or not uri_template:
        raise ValueError("Discovered resource templates must have a uriTemplate.")
    name = raw.get("name")
    return types.ResourceTemplate(
        uriTemplate=uri_template,
        name=name if isinstance(name, str) and name else uri_template,
        title=_optional_string(raw.get("title")),
        description=_optional_string(raw.get("description")),
        mimeType=_optional_string(raw.get("mimeType")),
        _meta=raw.get("_meta") if isinstance(raw.get("_meta"), dict) else None,
    )


def project_call_result(
    status_code: int,
    body: dict[str, Any],
    *,
    client_surface: ClientSurface = "external",
    tool_name: str | None = None,
) -> types.CallToolResult:
    """Preserve typed content and structured data from a sidecar tool result."""

    if client_surface == "external":
        body = _external_reference_links(body)
    is_error = (
        status_code >= 400
        or body.get("isError") is True
        or sidecar_indicates_tool_error(body)
    )
    if is_error and body.get("ok") is True:
        body = {**body, "ok": False}
    envelope = _find_result_envelope(body)
    is_error = (
        status_code >= 400
        or envelope.get("isError") is True
        or sidecar_indicates_tool_error(body)
    )
    raw_content = envelope.get("content")
    content = _project_explicit_content(raw_content)
    if client_surface == "external":
        content = [_external_reference_content(block) for block in content]
    domain_result = body.get("result")
    if tool_name == "mol_capture_screenshot":
        _extend_unique_content(content, _project_screenshot_image(domain_result))
    _extend_unique_content(content, _project_embedded_resources(domain_result))
    _extend_unique_content(content, _project_resource_links(domain_result))
    if not content:
        public_body = {**body, "ok": False} if is_error else body
        content = [types.TextContent(text=_stable_json(public_body))]

    structured = _project_structured_content(
        envelope, body, screenshot=tool_name == "mol_capture_screenshot"
    )
    return types.CallToolResult(
        content=content,
        structuredContent=structured,
        isError=is_error,
        _meta=_project_job_meta(body),
    )


def _external_reference_links(value: Any) -> Any:
    if isinstance(value, list):
        return [_external_reference_links(item) for item in value]
    if not isinstance(value, dict):
        return value
    if isinstance(value.get("type"), str):
        return value
    projected = {
        key: _external_reference_links(nested) for key, nested in value.items()
    }
    inline = value.get("inlineLink")
    if (
        isinstance(value.get("referenceId"), str)
        and isinstance(inline, str)
        and inline.startswith("dnaforge-chat://")
    ):
        external = value.get("externalUrl")
        target = value.get("target")
        if (
            isinstance(external, str)
            and external
            and isinstance(target, dict)
            and isinstance(target.get("entityId"), str)
        ):
            projected["inlineLink"] = external
        else:
            projected.pop("inlineLink", None)
    return projected


def _external_reference_content(block: types.ContentBlock) -> types.ContentBlock:
    if not isinstance(block, types.TextContent):
        return block
    try:
        payload = json.loads(block.text)
    except (ValueError, TypeError):
        return block
    projected = _external_reference_links(payload)
    return (
        block.model_copy(update={"text": _stable_json(projected)})
        if projected != payload
        else block
    )


def _project_structured_content(
    envelope: dict[str, Any],
    body: dict[str, Any],
    *,
    screenshot: bool = False,
) -> dict[str, Any] | None:
    """Return the value governed by the advertised tool output schema.

    FastAPI transports completed tools as a job snapshot whose ``result`` is
    the handler's domain output. The outer ``ok/jobId/status`` fields are
    transport metadata and must not be validated against the tool's
    ``outputSchema``. An explicitly MCP-shaped result remains authoritative.
    """

    if "structuredContent" in envelope:
        explicit = envelope.get("structuredContent")
        return explicit if isinstance(explicit, dict) else None
    domain_result = body.get("result")
    return (
        (_image_metadata(domain_result) if screenshot else domain_result)
        if isinstance(domain_result, dict)
        else None
    )


def _image_metadata(value: Any) -> Any:
    """Keep promoted image bytes in content once, with their metadata in JSON.

    Duplicating a screenshot in structuredContent can push an otherwise valid
    image response past a client's size limit and turn it into truncated text.
    Explicit structuredContent is governed by its output schema and is preserved
    by the caller. This only projects renderer results with returns_image.
    """

    if not isinstance(value, dict):
        return value
    candidate = _screenshot_payload(value)
    if candidate is None:
        return value
    metadata = {key: item for key, item in candidate.items() if key != "data"}
    return metadata if candidate is value else {**value, "result": metadata}


def _screenshot_payload(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    candidate = value if value.get("returns_image") is True else value.get("result")
    if (
        isinstance(candidate, dict)
        and candidate.get("returns_image") is True
        and isinstance(candidate.get("data"), str)
        and candidate["data"]
    ):
        return candidate
    return None


def _project_job_meta(body: dict[str, Any]) -> dict[str, Any] | None:
    """Preserve transport/audit correlation without violating outputSchema."""

    job_meta: dict[str, str] = {}
    for source_key, target_key in (
        ("jobId", "jobId"),
        ("toolName", "toolName"),
        ("status", "status"),
        ("pool", "pool"),
    ):
        value = body.get(source_key)
        if isinstance(value, str) and value:
            job_meta[target_key] = value
    return {DNAFORGE_JOB_META_KEY: job_meta} if job_meta else None


def project_resource_contents(
    body: dict[str, Any],
) -> list[types.TextResourceContents | types.BlobResourceContents]:
    raw_contents = body.get("contents")
    if not isinstance(raw_contents, list):
        raise ValueError("DNAForge resource read did not return a contents array.")
    contents: list[types.TextResourceContents | types.BlobResourceContents] = []
    for raw in raw_contents:
        try:
            contents.append(_RESOURCE_CONTENT_ADAPTER.validate_python(raw))
        except ValidationError as exc:
            raise ValueError(
                "DNAForge resource read returned invalid content."
            ) from exc
    return contents


def tool_is_cancelable(raw: dict[str, Any]) -> bool:
    annotations = raw.get("annotations")
    return isinstance(annotations, dict) and annotations.get("cancelable") is True


def normalize_mcp_input_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Give MCP inputs an object root while preserving legacy alternatives."""

    if not any(key in schema for key in ("oneOf", "allOf", "anyOf")):
        return schema if "type" in schema else {**schema, "type": "object"}
    normalized = {
        key: value
        for key, value in schema.items()
        if key not in {"oneOf", "allOf", "anyOf"}
    }
    normalized.setdefault("type", "object")
    normalized["description"] = append_sentence(
        _optional_string(normalized.get("description")),
        INPUT_FORM_SCHEMA_SENTENCE,
    )
    return normalized


def normalize_mcp_output_schema(
    schema: dict[str, Any], *, tool_name: str
) -> dict[str, Any]:
    """Project valid object unions into MCP's required root object shape."""

    schema_type = schema.get("type")
    if schema_type is None:
        return {**schema, "type": "object"}
    if schema_type != "object":
        raise ValueError(
            f"Discovered tool {tool_name!r} must have an object outputSchema."
        )
    return schema


def append_sentence(text: str | None, sentence: str) -> str:
    if not isinstance(text, str) or not text.strip():
        return sentence
    if sentence in text:
        return text
    return f"{text.strip()} {sentence}"


def sidecar_indicates_tool_error(
    value: Any, *, transport_envelope: bool = True
) -> bool:
    if not isinstance(value, dict):
        return False
    if value.get("ok") is False:
        return True
    if value.get("isError") is True:
        return True
    if not transport_envelope:

        return False

    if "jobId" in value and value.get("status") in {"failed", "canceled"}:
        return True
    if value.get("ok") is True:
        if "jobId" in value and value.get("status") in {"failed", "canceled"}:
            return True
        if transport_envelope and (
            "jobId" in value
            or ("result" in value and value.get("status") == "completed")
        ):
            return sidecar_indicates_tool_error(
                value.get("result"), transport_envelope=False
            )
        return False
    if value.get("status") in {"failed", "canceled"}:
        return True
    if isinstance(value.get("error"), dict) and value["error"]:
        return True
    result = value.get("result")
    return isinstance(result, dict) and sidecar_indicates_tool_error(
        result, transport_envelope=False
    )


def _project_explicit_content(raw_content: Any) -> list[types.ContentBlock]:
    if not isinstance(raw_content, list):
        return []
    content: list[types.ContentBlock] = []
    for raw in raw_content:
        try:
            content.append(_CONTENT_ADAPTER.validate_python(raw))
        except ValidationError:
            content.append(types.TextContent(text=_stable_json(raw)))
    return content


def _project_screenshot_image(value: Any) -> list[types.ContentBlock]:
    content: list[types.ContentBlock] = []
    seen: set[tuple[str, str]] = set()
    for candidate in [_screenshot_payload(value)]:
        if candidate is None or candidate.get("returns_image") is not True:
            continue
        data = candidate.get("data")
        if not isinstance(data, str) or not data:
            continue
        mime_type = candidate.get("mimeType", candidate.get("mime_type", "image/png"))
        if not isinstance(mime_type, str) or not mime_type:
            mime_type = "image/png"
        key = (data, mime_type)
        if key in seen:
            continue
        seen.add(key)
        content.append(types.ImageContent(data=data, mimeType=mime_type))
    return content


def _project_embedded_resources(value: Any) -> list[types.ContentBlock]:
    content: list[types.ContentBlock] = []
    for candidate in [value] if isinstance(value, dict) else []:
        raw = candidate.get("embeddedResource", candidate.get("embedded_resource"))
        if not isinstance(raw, dict):
            continue
        if raw.get("type") == "resource":
            payload = raw
        elif isinstance(raw.get("resource"), dict):
            payload = {"type": "resource", **raw}
        elif isinstance(raw.get("uri"), str) and (
            isinstance(raw.get("text"), str) or isinstance(raw.get("blob"), str)
        ):
            payload = {"type": "resource", "resource": raw}
        else:
            continue
        try:
            projected = _CONTENT_ADAPTER.validate_python(payload)
        except ValidationError:
            continue
        if isinstance(projected, types.EmbeddedResource):
            content.append(projected)
    return content


def _project_resource_links(value: Any) -> list[types.ContentBlock]:
    content: list[types.ContentBlock] = []
    for candidate in [value] if isinstance(value, dict) else []:
        raw_links: list[dict[str, Any]] = []
        singular = candidate.get("resourceLink")
        if isinstance(singular, dict):
            raw_links.append(singular)
        plural = candidate.get("resourceLinks")
        if isinstance(plural, list):
            raw_links.extend(link for link in plural if isinstance(link, dict))
        for raw in raw_links:
            uri = raw.get("uri", raw.get("resourceUri", candidate.get("resourceUri")))
            if not isinstance(uri, str) or not uri:
                continue
            name = raw.get("name", raw.get("relationship"))
            if not isinstance(name, str) or not name:
                name = uri
            description = _optional_string(raw.get("description"))
            source_uri = raw.get("sourceUri")
            target_uri = raw.get("targetUri")
            if (
                description is None
                and isinstance(source_uri, str)
                and isinstance(target_uri, str)
            ):
                description = f"{source_uri} -> {target_uri}"
            content.append(
                types.ResourceLink(
                    name=name,
                    uri=uri,
                    description=description,
                    mimeType=_optional_string(raw.get("mimeType"))
                    or "application/json",
                )
            )
    return content


def _extend_unique_content(
    content: list[types.ContentBlock],
    additions: list[types.ContentBlock],
) -> None:
    seen = {_content_identity(item) for item in content}
    for item in additions:
        identity = _content_identity(item)
        if identity in seen:
            continue
        seen.add(identity)
        content.append(item)


def _content_identity(item: types.ContentBlock) -> str:
    return json.dumps(
        item.model_dump(by_alias=True, mode="json", exclude_none=True),
        sort_keys=True,
        separators=(",", ":"),
    )


def _find_result_envelope(body: dict[str, Any]) -> dict[str, Any]:
    if "content" not in body and "structuredContent" not in body:
        result = body.get("result")
        if (
            isinstance(result, dict)
            and isinstance(result.get("content"), list)
            and "structuredContent" in result
        ):
            return result
    return body


def _stable_json(value: Any) -> str:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str
    )


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None
