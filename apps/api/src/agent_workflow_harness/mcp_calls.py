"""MCP tool-call and resource-read helpers for harness-style clients."""

from __future__ import annotations

import json
from typing import Any

DNAFORGE_JOB_META_KEY = "com.dnaforge/job"


class MCPCallFailure(RuntimeError):
    pass


def call_renderer_tool(
    client: Any,
    name: str,
    arguments: dict[str, Any],
    *,
    failure_type: type[RuntimeError] = MCPCallFailure,
) -> dict[str, Any]:
    result, _renderer_payload, _job = call_renderer_tool_with_evidence(
        client,
        name,
        arguments,
        failure_type=failure_type,
    )
    return result


def call_renderer_tool_with_evidence(
    client: Any,
    name: str,
    arguments: dict[str, Any],
    *,
    failure_type: type[RuntimeError] = MCPCallFailure,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Call a renderer tool and retain domain, renderer, and job evidence.

    ``structuredContent`` is the renderer handler's direct output because that
    is the value governed by the tool's advertised ``outputSchema``. Sidecar
    job/action correlation is carried separately in protocol-native result
    metadata under ``com.dnaforge/job``.
    """

    response = client.request(
        "tools/call",
        {
            "name": name,
            "arguments": arguments,
        },
    )
    tool_result = response.get("result")
    renderer_payload = require_mcp_tool_success(
        tool_result,
        name=name,
        failure_type=failure_type,
    )
    _require(
        renderer_payload.get("ok") is True,
        f"{name} did not reach renderer successfully: {renderer_payload}",
        failure_type,
    )
    result = renderer_payload.get("result", {})
    _require(
        isinstance(result, dict),
        f"{name} returned invalid result shape: {renderer_payload}",
        failure_type,
    )
    job = mcp_tool_job_metadata(
        tool_result,
        name=name,
        failure_type=failure_type,
    )
    _require(
        isinstance(job.get("jobId"), str)
        and bool(job["jobId"])
        and job.get("toolName") == name
        and job.get("status") == "completed",
        f"{name} returned invalid DNAForge job metadata: {job}",
        failure_type,
    )
    return result, renderer_payload, job


def require_mcp_tool_success(
    tool_result: Any,
    *,
    name: str,
    failure_type: type[RuntimeError] = MCPCallFailure,
) -> dict[str, Any]:
    """Return direct structured output from a successful MCP tool result."""

    _require(
        isinstance(tool_result, dict),
        f"{name} returned invalid MCP result: {tool_result}",
        failure_type,
    )
    assert isinstance(tool_result, dict)
    _require(
        tool_result.get("isError") is False,
        f"{name} returned MCP error: {tool_result}",
        failure_type,
    )
    structured = tool_result.get("structuredContent")
    _require(
        isinstance(structured, dict),
        f"{name} returned no structured content: {tool_result}",
        failure_type,
    )
    assert isinstance(structured, dict)
    return structured


def mcp_tool_job_metadata(
    tool_result: Any,
    *,
    name: str,
    failure_type: type[RuntimeError] = MCPCallFailure,
) -> dict[str, Any]:
    """Return the sidecar job/action correlation metadata for a tool call."""

    _require(
        isinstance(tool_result, dict),
        f"{name} returned invalid MCP result: {tool_result}",
        failure_type,
    )
    assert isinstance(tool_result, dict)
    meta = tool_result.get("_meta")
    job = meta.get(DNAFORGE_JOB_META_KEY) if isinstance(meta, dict) else None
    _require(
        isinstance(job, dict),
        f"{name} returned no DNAForge job metadata: {tool_result}",
        failure_type,
    )
    assert isinstance(job, dict)
    return job


def mcp_tool_error(
    tool_result: Any,
    *,
    name: str,
    failure_type: type[RuntimeError] = MCPCallFailure,
) -> dict[str, Any]:
    """Extract a typed sidecar error from MCP text content.

    Pre-admission failures have no handler output and therefore correctly omit
    ``structuredContent``. The SDK still returns the sidecar JSON envelope as
    typed MCP text content; parsing that envelope preserves exact error-code
    assertions without confusing transport metadata with tool output.
    """

    _require(
        isinstance(tool_result, dict) and tool_result.get("isError") is True,
        f"{name} did not return an MCP tool error: {tool_result}",
        failure_type,
    )
    assert isinstance(tool_result, dict)
    content = tool_result.get("content")
    _require(
        isinstance(content, list) and bool(content),
        f"{name} returned no MCP error content: {tool_result}",
        failure_type,
    )
    assert isinstance(content, list)
    for item in content:
        if not isinstance(item, dict) or item.get("type") != "text":
            continue
        text = item.get("text")
        if not isinstance(text, str):
            continue
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            continue
        error = _find_error(payload)
        if error is not None:
            return error
    raise failure_type(f"{name} returned no typed JSON error: {tool_result}")


def read_mcp_json_resource(
    client: Any,
    uri: str,
    *,
    failure_type: type[RuntimeError] = MCPCallFailure,
) -> dict[str, Any]:
    response = client.request("resources/read", {"uri": uri})
    _require(
        "error" not in response,
        f"resources/read returned JSON-RPC error: {response}",
        failure_type,
    )
    result = response.get("result", {})
    contents = result.get("contents") if isinstance(result, dict) else None
    _require(
        isinstance(contents, list) and len(contents) == 1,
        f"resources/read returned invalid contents for {uri}: {response}",
        failure_type,
    )
    content = contents[0]
    _require(
        isinstance(content, dict) and content.get("uri") == uri,
        f"resources/read returned the wrong resource URI for {uri}: {response}",
        failure_type,
    )
    text = content.get("text")
    _require(
        isinstance(text, str),
        f"resources/read returned non-text content: {response}",
        failure_type,
    )
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise failure_type(f"resources/read returned invalid JSON for {uri}") from exc
    _require(
        isinstance(parsed, dict),
        f"resources/read returned non-object JSON for {uri}: {parsed}",
        failure_type,
    )
    return parsed


def _require(
    condition: bool,
    message: str,
    failure_type: type[RuntimeError],
) -> None:
    if not condition:
        raise failure_type(message)


def _find_error(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        error = value.get("error")
        if (
            isinstance(error, dict)
            and isinstance(error.get("code"), str)
            and error["code"]
        ):
            return error
        for nested in value.values():
            found = _find_error(nested)
            if found is not None:
                return found
    elif isinstance(value, list):
        for nested in value:
            found = _find_error(nested)
            if found is not None:
                return found
    return None
