"""Tests for the merged DNAForgeTool schema and MCP projection."""

import pytest
from pydantic import ValidationError

from src.concurrency.builtins import echo_tool_spec
from src.concurrency.schema import DNAForgeTool, manifest_json_schema, to_mcp_format


def test_echo_tool_spec_validates():
    spec = echo_tool_spec()
    assert spec.name == "echo"
    assert spec.pool == "cpu_fast"
    assert spec.required_capabilities == ["debug.echo"]


def test_echo_tool_becomes_cancelable_only_for_packaged_contract_probe(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_CONTRACT_PROBE", "1")

    spec = echo_tool_spec()

    assert spec.category.cancelable is True
    assert spec.category.duration == "long-running"
    assert spec.expected_latency == "seconds"


def test_tool_schema_requires_explicit_capabilities():
    payload = echo_tool_spec().model_dump(mode="json")
    payload["required_capabilities"] = []
    with pytest.raises(ValidationError):
        DNAForgeTool.model_validate(payload)


def test_to_mcp_format_forwards_behavior_annotations():
    spec = echo_tool_spec()
    mcp = to_mcp_format(spec)
    assert mcp["name"] == "echo"
    assert mcp["inputSchema"] == spec.inputs
    assert mcp["outputSchema"] == spec.outputs
    assert mcp["annotations"]["duration"] == "immediate"
    assert mcp["annotations"]["effects"] == ["read-only"]
    assert mcp["annotations"]["cancelable"] is False
    assert mcp["annotations"]["approval_gated"] is False
    assert mcp["annotations"]["audited"] is False
    assert mcp["annotations"]["streams_progress"] is False
    assert mcp["annotations"]["readOnlyHint"] is True
    assert mcp["annotations"]["destructiveHint"] is False
    assert mcp["annotations"]["idempotentHint"] is True
    assert "required_capabilities" not in mcp["annotations"]
    assert "handler_ref" not in mcp["annotations"]


def test_manifest_schema_is_generated_from_pydantic_model():
    schema = manifest_json_schema()
    assert schema["title"] == "DNAForgeTool"
    assert "pool" in schema["properties"]
    assert "category" in schema["properties"]


def test_behavior_hints_do_not_confuse_approval_or_replay_with_effects():
    spec = echo_tool_spec()
    spec.category.effects = ["mutating"]
    spec.category.approval_gated = False
    spec.idempotency_keyable = True
    annotations = to_mcp_format(spec)["annotations"]
    assert annotations["readOnlyHint"] is False
    assert annotations["destructiveHint"] is True
    assert annotations["idempotentHint"] is False


def test_explicit_additive_and_open_world_hints_are_preserved():
    spec = echo_tool_spec()
    spec.category.effects = ["mutating"]
    spec.category.destructive_hint = False
    spec.category.open_world_hint = True
    assert to_mcp_format(spec)["annotations"]["destructiveHint"] is False
    assert to_mcp_format(spec)["annotations"]["openWorldHint"] is True
