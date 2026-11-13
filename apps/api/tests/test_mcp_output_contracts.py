"""The effective MCP catalog must retain concrete contracts after native overrides."""

import copy
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError

from src.agent_workflows import build_workflow_run_preparation, load_workflow_contracts
from src.concurrency import dispatcher
from src.concurrency.builtins import (
    echo_handler,
    echo_tool_spec,
    register_builtin_agent_tools,
)
from src.concurrency.renderer_bridge import load_renderer_tool_specs
from src.concurrency.schema import to_mcp_format
from src.concurrency.tool_registry import agent_tool_registry
from src.concurrency.tool_validation import (
    ToolInputValidationError,
    _validator,
    validate_tool_value,
)
from src.concurrency.workflow_output import WorkflowPreparationOutput
from src.mcp_tool_names import portable_tool_catalog


def test_molecular_save_validation_identifies_the_misplaced_scene_digest():
    tool = next(
        spec for spec in load_renderer_tool_specs() if spec["name"] == "mol_save_view"
    )
    arguments = {
        "structureViewId": "structure-view:reference",
        "title": "Read-supported protein change",
        "caption": "Reference coordinates with read evidence.",
        "evidence": [],
        "sceneDigestSha256": "a" * 64,
        "scientificReview": {
            "version": 1,
            "question": "Where does the observed allele map?",
            "steps": [
                {
                    "index": 0,
                    "screenshotReceiptId": "00000000-0000-4000-8000-000000000001",
                    "claim": "Mapped reference residue.",
                    "evidence": "Read counts and coding annotation.",
                    "limitation": "Reference prediction only.",
                    "groups": [],
                }
            ],
            "continuity": {
                "assessment": "One view.",
                "limitation": "No alternate coordinates.",
            },
            "revision": {"findings": [], "changes": [], "unresolved": []},
        },
    }
    with pytest.raises(ToolInputValidationError) as failure:
        validate_tool_value(arguments, tool["inputs"])
    assert {(issue["path"], issue["rule"]) for issue in failure.value.issues} == {
        ("/scientificReview/sceneDigestSha256", "required"),
        ("/sceneDigestSha256", "additionalProperties"),
    }
    arguments["scientificReview"]["sceneDigestSha256"] = arguments.pop(
        "sceneDigestSha256"
    )
    validate_tool_value(arguments, tool["inputs"])


def test_validation_property_paths_remain_bounded_and_do_not_echo_argument_values():
    schema = {
        "type": "object",
        "properties": {"accepted": {}, "m~n/s": {}},
        "patternProperties": {"^kept-": {"type": "string"}},
        "required": ["accepted", "m~n/s"],
        "additionalProperties": False,
    }
    with pytest.raises(ToolInputValidationError) as failure:
        validate_tool_value(
            {"kept-annotation": "valid", "forbidden/field~name": "private-value"},
            schema,
        )
    assert {(issue["path"], issue["rule"]) for issue in failure.value.issues} == {
        ("/accepted", "required"),
        ("/m~0n~1s", "required"),
        ("/forbidden~1field~0name", "additionalProperties"),
    }
    assert len(failure.value.issues) == 3
    assert "private-value" not in json.dumps(failure.value.issues)
    with pytest.raises(ToolInputValidationError) as many:
        validate_tool_value(
            {f"extra-{index}": "private-value" for index in range(20)},
            {"additionalProperties": False},
        )
    assert len(many.value.issues) == 8
    assert len({issue["path"] for issue in many.value.issues}) == 8


@pytest.mark.asyncio
@pytest.mark.parametrize("schema_field", ["inputs", "outputs"])
async def test_unused_tool_contract_does_not_block_valid_tool_admission(
    monkeypatch, schema_field
):
    agent_tool_registry.clear()
    _validator.cache_clear()
    accepted = object()
    submit = AsyncMock(return_value=accepted)
    monkeypatch.setattr(
        dispatcher, "get_job_manager", lambda: SimpleNamespace(submit=submit)
    )
    try:
        valid = echo_tool_spec()
        invalid = valid.model_copy(
            update={"name": "invalid_unused", schema_field: {"type": "invalid"}}
        )
        agent_tool_registry.register(valid, echo_handler)
        agent_tool_registry.register(invalid, echo_handler)

        assert await dispatcher.dispatch_tool(valid.name, {}) is accepted
        assert submit.await_count == 1
        with pytest.raises(SchemaError):
            await dispatcher.dispatch_tool(invalid.name, {})
        assert submit.await_count == 1
    finally:
        agent_tool_registry.clear()
        _validator.cache_clear()


def test_every_effectively_registered_tool_has_a_concrete_output_contract():
    agent_tool_registry.clear()
    try:
        register_builtin_agent_tools()
        raw = [to_mcp_format(tool.spec) for tool in agent_tool_registry.list()]
        portable, _ = portable_tool_catalog(raw)
        assert len(portable) >= 187
        for tool in raw:
            schema = tool.get("outputSchema")
            assert isinstance(schema, dict), tool["name"]
            assert schema != {"type": "object", "additionalProperties": True}, tool[
                "name"
            ]
            assert any(
                key in schema for key in ("properties", "anyOf", "oneOf", "$ref")
            ), tool["name"]
            Draft202012Validator.check_schema(schema)
        for canonical, alias in (
            ("operations.annotation.inspect", "operations_annotation_inspect"),
            ("operations.annotation.apply", "operations_annotation_apply"),
        ):
            assert (
                agent_tool_registry.require(canonical).spec.outputs
                == agent_tool_registry.require(alias).spec.outputs
            )
    finally:
        agent_tool_registry.clear()


def test_manifest_loader_refuses_a_missing_output_contract(tmp_path):
    source = (
        Path(__file__).resolve().parents[3]
        / "packages/core/agent-tools/renderer-tool-manifest.json"
    )
    manifest = json.loads(source.read_text())
    manifest = copy.deepcopy(manifest)
    del manifest["tools"][0]["outputSchema"]
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    with pytest.raises(RuntimeError, match="detailed outputSchema"):
        load_renderer_tool_specs(path)


def test_real_molstar_scene_result_matches_published_output_contract():
    tool = next(
        spec for spec in load_renderer_tool_specs() if spec["name"] == "mol_apply_scene"
    )
    fixture = Path(__file__).parent / "fixtures/mcp/mol_apply_scene_native_result.json"
    result = json.loads(fixture.read_text())
    assert {"componentRefs", "colorSelectionGuidance"} <= result["result"][
        "native"
    ].keys()
    validate_tool_value(result, tool["outputs"], output=True)


def test_real_molstar_file_list_matches_published_output_contract():
    tool = next(
        spec
        for spec in load_renderer_tool_specs()
        if spec["name"] == "mol_list_structures"
    )
    fixture = (
        Path(__file__).parent / "fixtures/mcp/mol_list_structures_file_result.json"
    )
    result = json.loads(fixture.read_text())
    assert all(
        "instanceId" in chain for chain in result["result"]["structures"][0]["chains"]
    )
    validate_tool_value(result, tool["outputs"], output=True)


@pytest.mark.parametrize("workflow_id", sorted(load_workflow_contracts()))
def test_workflow_preparation_contract_covers_empty_and_recorded_history(
    tmp_path, workflow_id
):
    empty = build_workflow_run_preparation(workflow_id, ledger_root=tmp_path)
    WorkflowPreparationOutput.model_validate(empty)
    assert empty["runHistory"]["runs"] == 0
    run = tmp_path / "example" / "workflow-ledger.json"
    run.parent.mkdir()
    run.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "workflow": {
                    "id": workflow_id,
                    "title": "Example",
                    "mode": "hybrid",
                    "maturity": "fixture",
                },
                "outcome": "failed",
                "classification": "fixture",
                "failed_stage": "read",
                "duration_ms": 42,
                "success": False,
                "metrics": {"successful_tool_flows": 1, "failed_tool_flows": 1},
                "next_actions": ["Inspect the original action."],
            }
        )
    )
    recorded = build_workflow_run_preparation(workflow_id, ledger_root=tmp_path)
    WorkflowPreparationOutput.model_validate(recorded)
    assert recorded["runHistory"]["runs"] == 1
    assert recorded["latestRun"]["nextActions"] == ["Inspect the original action."]
