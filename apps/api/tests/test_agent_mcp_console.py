"""Tests for the interactive  MCP console helpers."""

import json
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from scripts.agent_mcp_console import (
    DEFAULT_DESIGN_NAME,
    WORKFLOW_MINI_DERIVATIVE_DESIGN,
    WORKFLOW_NCBI_DERIVATIVE_DESIGN,
    WORKFLOW_NCBI_IMPORT_SMOKE,
    WorkflowFailure,
    build_action_resource_checks,
    build_command_lifecycle_entry,
    build_design_mutation_checks,
    build_failed_workflow_report,
    build_workflow_contract,
    build_workflow_run_ledger,
    design_resource_uri,
    failed_ledger_entry,
    first_feature_with_coordinates,
    format_command_lifecycle_line,
    next_actions_for_failure,
    normalize_design_resource_snapshot,
    parse_call_command,
    parse_import_command,
    parse_json_object,
    parse_single_json_resource,
    print_demo_next_steps,
    print_intro,
    read_design_resource_snapshot,
    read_resource_command,
    read_sequence_resource_snapshot,
    render_workflow_contract,
    render_workflow_ledger_summary,
    render_workflow_report,
    require_ledger_verdict,
    require_planned_design_regions,
    resolve_design_resource_uri,
    sequence_render_observer_passed,
    summarize_sequence_render_observation,
    summarize_tool_call,
    summarize_workflow_run_metrics,
)
from src.agent_workflows import (
    discover_workflow_ledger_paths,
    load_workflow_manifest,
    summarize_workflow_boundaries,
    summarize_workflow_ledger_history,
)


def test_parse_call_command_defaults_to_empty_arguments():
    assert parse_call_command("get_workspace") == ("get_workspace", {})


def test_parse_call_command_parses_json_arguments():
    assert parse_call_command(
        'find_features {"path":"plasmids/pUC19.gb","query":"AmpR promoter"}'
    ) == (
        "find_features",
        {"path": "plasmids/pUC19.gb", "query": "AmpR promoter"},
    )


def test_parse_import_command_accepts_source_and_optional_target():
    assert parse_import_command("/tmp/pUC19.gb") == ("/tmp/pUC19.gb", None)
    assert parse_import_command("/tmp/pUC19.gb imports/pUC19.gb") == (
        "/tmp/pUC19.gb",
        "imports/pUC19.gb",
    )


def test_parse_import_command_rejects_missing_or_space_ambiguous_paths():
    with pytest.raises(ValueError, match="usage: import"):
        parse_import_command("")
    with pytest.raises(ValueError, match="paths with spaces"):
        parse_import_command("/tmp/my plasmid.gb imports/pUC19.gb")


def test_parse_json_object_rejects_non_object_payload():
    with pytest.raises(ValueError, match="arguments must be a JSON object"):
        parse_json_object('["not", "object"]')


def test_parse_json_object_rejects_invalid_json():
    with pytest.raises(ValueError, match="invalid JSON arguments"):
        parse_json_object("{bad")


def test_first_feature_with_coordinates_uses_first_coordinate_match():
    feature = first_feature_with_coordinates(
        {
            "features": [
                {"name": "missing coords"},
                {"name": "AmpR promoter", "start": 2490, "end": 2594},
            ]
        },
        "AmpR promoter",
    )

    assert feature == {"name": "AmpR promoter", "start": 2490, "end": 2594}


def test_first_feature_with_coordinates_requires_coordinates():
    with pytest.raises(WorkflowFailure, match="did not return coordinates") as exc:
        first_feature_with_coordinates({"features": [{"name": "AmpR"}]}, "AmpR")

    assert exc.value.classification == "feature_not_found"
    assert exc.value.stage == "find_feature"


def test_default_design_name_is_plain_feedback_label():
    assert DEFAULT_DESIGN_NAME == "Console derivative design"


def test_demo_next_steps_explain_app_stays_open(capsys):
    print_demo_next_steps()

    output = capsys.readouterr().out
    assert "app should still be open" in output
    assert "Console derivative design" in output
    assert "Type quit" in output


def test_workflow_intro_does_not_require_visible_window(capsys, tmp_path):
    print_intro(
        tmp_path,
        tmp_path / "transcript.jsonl",
        tmp_path / "workspace",
        workflow_mode=True,
    )

    output = capsys.readouterr().out
    assert "workflow runner" in output
    assert "No visible app window is required" in output
    assert "Try: design mini" not in output


def test_resolve_design_resource_uri_uses_uri_id_or_last_design():
    assert (
        resolve_design_resource_uri("waypoint://design/design-1", last_design_id=None)
        == "waypoint://design/design-1"
    )
    assert (
        resolve_design_resource_uri("design/1", last_design_id=None)
        == "waypoint://design/design%2F1"
    )
    assert (
        resolve_design_resource_uri("", last_design_id="design-2")
        == "waypoint://design/design-2"
    )


def test_resolve_design_resource_uri_requires_available_design():
    with pytest.raises(ValueError, match="No design id"):
        resolve_design_resource_uri("", last_design_id=None)


def test_render_workflow_report_summarizes_success():
    contract = build_workflow_contract(WORKFLOW_MINI_DERIVATIVE_DESIGN)
    report = {
        "workflow": WORKFLOW_MINI_DERIVATIVE_DESIGN,
        "outcome": "passed",
        "classification": "passed",
        "failed_stage": None,
        "duration_ms": 123,
        "transcript_path": "/tmp/transcript.jsonl",
        "report_path": "/tmp/report.md",
        "workflow_ledger_path": "/tmp/workflow-ledger.json",
        "workflow_contract": contract,
        "summary": "Created a derivative design.",
        "steps": [
            {
                "stage": "create_design",
                "status": "passed",
                "summary": "Created design.",
            },
            {
                "stage": "observe_imported_sequence_render",
                "status": "passed",
                "summary": "Observed render.",
                "evidence": {
                    "rendered": True,
                    "minimap_type": "webgl",
                    "visible_canvas_count": 1,
                    "webgl_ready": True,
                    "webgl_matching_instance_count": 1,
                    "loaded_sequence": {
                        "length": 2686,
                        "annotation_count": 9,
                    },
                },
            },
            {
                "stage": "verify_action_resources",
                "status": "passed",
                "summary": "Verified command action resources.",
                "evidence": {"verified_action_count": 1},
            },
        ],
        "command_lifecycle": [
            {
                "tool": "create_design",
                "status": "completed",
                "elapsed_ms": 42,
                "action_id": "action-1",
                "renderer_audit_id": "audit-1",
                "pool": "cpu_fast",
                "cancelable": False,
                "summary": 'Created design "Console derivative design" (design-1).',
                "mutation": {
                    "resource_uri": "waypoint://design/design-1",
                },
            }
        ],
        "design": {
            "name": DEFAULT_DESIGN_NAME,
            "id": "design-1",
            "source_path": "plasmids/pUC19.gb",
            "regions_added": 2,
        },
        "next_actions": ["Keep iterating."],
    }

    markdown = render_workflow_report(report)

    assert "# MCP Workflow Report: mini-derivative-design" in markdown
    assert "Outcome: passed" in markdown
    assert "Workflow ledger: /tmp/workflow-ledger.json" in markdown
    assert "## Workflow Contract" in markdown
    assert "## Workflow Metrics" in markdown
    assert "Successful tool flows: 1" in markdown
    assert "Imported plasmid sequence to derivative plasmid design" in markdown
    assert "Created design." in markdown
    assert "## Command Timeline" in markdown
    assert "completed: create_design - 42 ms" in markdown
    assert "action=action-1" in markdown
    assert "audit=audit-1" in markdown
    assert "## Render Evidence" in markdown
    assert "rendered=True, minimap=webgl" in markdown
    assert "## Action Resource Evidence" in markdown
    assert "Verified 1 command action resources" in markdown
    assert "- Regions added: 2" in markdown


def test_workflow_manifest_tracks_external_and_hybrid_steps():
    manifest = load_workflow_manifest()
    workflows = {
        workflow["id"]: workflow
        for workflow in manifest["workflows"]
        if isinstance(workflow, dict)
    }

    assert set(workflows) >= {
        WORKFLOW_MINI_DERIVATIVE_DESIGN,
        WORKFLOW_NCBI_IMPORT_SMOKE,
        WORKFLOW_NCBI_DERIVATIVE_DESIGN,
    }
    derivative = workflows[WORKFLOW_NCBI_DERIVATIVE_DESIGN]
    step_kinds = {step["kind"] for step in derivative["steps"]}
    execution_boundaries = {step["execution_boundary"] for step in derivative["steps"]}

    assert derivative["mode"] == "hybrid"
    assert derivative["demand"]["level"] == "high"
    assert {"external_source", "mcp_tool", "app_observer", "artifact"} <= step_kinds
    assert {
        "external_provider",
        "app_service",
        "mcp_resource",
        "ui_bridge",
        "shell_native",
    } <= execution_boundaries
    assert "plan_design_regions" in derivative["required_primitives"]

    boundary_summary = summarize_workflow_boundaries(derivative)
    assert boundary_summary["missing"] == []
    assert boundary_summary["boundaries"]["app_service"]["steps"] == 5
    assert "draft_assembly" in boundary_summary["boundaries"]["app_service"]["step_ids"]


def test_workflow_run_ledger_counts_tool_flows_and_progress():
    contract = build_workflow_contract(WORKFLOW_NCBI_DERIVATIVE_DESIGN)
    report = {
        "workflow": WORKFLOW_NCBI_DERIVATIVE_DESIGN,
        "outcome": "passed",
        "classification": "passed",
        "failed_stage": None,
        "duration_ms": 321,
        "transcript_path": "/tmp/transcript.jsonl",
        "report_path": "/tmp/workflow-report.md",
        "workflow_ledger_path": "/tmp/workflow-ledger.json",
        "workflow_contract": contract,
        "summary": "Imported NCBI sequence and created a derivative design.",
        "steps": [
            {
                "stage": "observe_imported_sequence_render",
                "status": "passed",
                "summary": "Observed imported sequence render.",
            },
            {
                "stage": "verify_action_resources",
                "status": "passed",
                "summary": "Verified action resources.",
            },
        ],
        "command_lifecycle": [
            {"tool": "import_sequence", "status": "completed", "elapsed_ms": 10},
            {"tool": "plan_design_regions", "status": "completed", "elapsed_ms": 11},
            {"tool": "create_design", "status": "completed", "elapsed_ms": 12},
        ],
        "ledger": [{"verdict": "passed", "effect": "created_design"}],
        "next_actions": ["Promote the next external adapter."],
    }

    metrics = summarize_workflow_run_metrics(report)
    ledger = build_workflow_run_ledger(report)
    progress = {step["id"]: step for step in ledger["progress"]}

    assert metrics["successful_tool_flows"] == 3
    assert metrics["failed_tool_flows"] == 0
    assert metrics["observer_steps"] == 2
    assert ledger["workflow"]["demand"]["level"] == "high"
    assert ledger["metrics"]["passed_mutation_claims"] == 1
    assert progress["fetch_ncbi_record"]["execution_boundary"] == "external_provider"
    assert progress["fetch_ncbi_record"]["status"] == "passed"
    assert progress["plan_regions"]["execution_boundary"] == "app_service"
    assert progress["plan_regions"]["status"] == "passed"
    assert progress["observe_visible_state"]["execution_boundary"] == "ui_bridge"
    assert progress["observe_visible_state"]["status"] == "passed"
    assert (
        progress["handoff_to_bespoke_pipeline"]["execution_boundary"] == "shell_native"
    )
    assert progress["handoff_to_bespoke_pipeline"]["status"] == "written"


def test_workflow_ledger_summary_aggregates_runs_by_workflow_and_demand(tmp_path):
    first = tmp_path / "run-a" / "workflow-ledger.json"
    second = tmp_path / "run-b" / "workflow-ledger.json"
    first.parent.mkdir()
    second.parent.mkdir()
    first.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "workflow": {
                    "id": WORKFLOW_NCBI_DERIVATIVE_DESIGN,
                    "title": "NCBI sequence to derivative design",
                    "mode": "hybrid",
                    "maturity": "live-app-tested",
                    "demand": {"level": "high"},
                },
                "success": True,
                "outcome": "passed",
                "classification": "passed",
                "duration_ms": 100,
                "metrics": {
                    "successful_tool_flows": 6,
                    "failed_tool_flows": 0,
                },
            }
        )
    )
    second.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "workflow": {
                    "id": WORKFLOW_NCBI_DERIVATIVE_DESIGN,
                    "title": "NCBI sequence to derivative design",
                    "mode": "hybrid",
                    "maturity": "live-app-tested",
                    "demand": {"level": "high"},
                },
                "success": False,
                "outcome": "failed",
                "classification": "observer_gap",
                "failed_stage": "observe_design_state",
                "duration_ms": 200,
                "metrics": {
                    "successful_tool_flows": 5,
                    "failed_tool_flows": 1,
                },
            }
        )
    )

    summary = summarize_workflow_ledger_history(tmp_path)
    workflow = summary["workflows"][WORKFLOW_NCBI_DERIVATIVE_DESIGN]
    markdown = render_workflow_ledger_summary(tmp_path)

    assert discover_workflow_ledger_paths(tmp_path) == [first, second]
    assert summary["total_runs"] == 2
    assert summary["demand"]["high"] == {
        "runs": 2,
        "passed_runs": 1,
        "failed_runs": 1,
    }
    assert workflow["runs"] == 2
    assert workflow["passed_runs"] == 1
    assert workflow["failed_runs"] == 1
    assert workflow["successful_tool_flows"] == 11
    assert workflow["failed_tool_flows"] == 1
    assert "1/2 passed" in markdown
    assert "observer_gap at observe_design_state" in markdown


def test_command_lifecycle_entry_extracts_action_audit_and_mutation():
    result = {
        "designId": "design-1",
        "name": DEFAULT_DESIGN_NAME,
        "mutation": {
            "operationId": "op-1",
            "effect": "created_design",
            "resourceUri": "waypoint://design/design-1",
            "target": {"type": "design", "id": "design-1"},
            "beforeVersion": 0,
            "afterVersion": 1,
        },
    }
    entry = build_command_lifecycle_entry(
        tool="create_design",
        arguments={"name": DEFAULT_DESIGN_NAME, "assemblyMethod": "gibson"},
        status="completed",
        elapsed_ms=17,
        started_at="2026-04-30T20:00:00+00:00",
        result=result,
        renderer={"ok": True, "audit_id": "audit-1", "result": result},
        job={
            "jobId": "action-1",
            "toolName": "create_design",
            "status": "completed",
            "pool": "cpu_fast",
        },
        annotations={"cancelable": False, "effects": ["mutating", "ui-bound"]},
    )

    assert entry["argument_keys"] == ["assemblyMethod", "name"]
    assert entry["action_id"] == "action-1"
    assert entry["action_resource_uri"] == "waypoint://action/action-1"
    assert entry["renderer_audit_id"] == "audit-1"
    assert entry["mutation"]["operation_id"] == "op-1"
    assert entry["mutation"]["resource_uri"] == "waypoint://design/design-1"
    assert entry["summary"] == (
        'Created design "Console derivative design" (design-1).'
    )
    assert "target=waypoint://design/design-1" in format_command_lifecycle_line(entry)


def test_import_sequence_summary_handles_canonical_ncbi_source():
    assert (
        summarize_tool_call(
            "import_sequence",
            {"source": {"kind": "ncbi", "accession": "L09137"}},
            {"path": "imports/L09137.gb"},
        )
        == "Imported NCBI L09137 into imports/L09137.gb."
    )


def test_plan_design_regions_summary_reports_region_count():
    assert (
        summarize_tool_call(
            "plan_design_regions",
            {"path": "imports/L09137.gb"},
            {"regionCount": 2},
        )
        == "Planned 2 design regions from imports/L09137.gb."
    )


def test_require_planned_design_regions_accepts_valid_regions():
    regions = require_planned_design_regions(
        {
            "planned": True,
            "regions": [
                {"label": "left", "start": 1, "end": 500},
                {"label": "right", "start": 501, "end": 1000},
            ],
        },
        expected_count=2,
    )

    assert regions == [
        {"label": "left", "start": 1, "end": 500},
        {"label": "right", "start": 501, "end": 1000},
    ]


def test_require_planned_design_regions_rejects_invalid_regions():
    with pytest.raises(WorkflowFailure) as exc:
        require_planned_design_regions(
            {"planned": True, "regions": [{"label": "bad", "start": 500, "end": 1}]},
            expected_count=1,
        )

    assert exc.value.classification == "region_plan_failed"
    assert exc.value.stage == "plan_design_regions"


def test_action_resource_checks_match_command_lifecycle_entry():
    entry = {
        "tool": "create_design",
        "status": "completed",
        "action_id": "action-1",
        "action_resource_uri": "waypoint://action/action-1",
        "renderer_audit_id": "audit-1",
    }

    checks = build_action_resource_checks(
        entry,
        {
            "exists": True,
            "resourceUri": "waypoint://action/action-1",
            "action": {
                "id": "action-1",
                "toolName": "create_design",
                "completedAt": "2026-04-30T20:00:00Z",
            },
            "auditRecords": [{"id": "audit-1", "actorKind": "renderer"}],
        },
    )

    assert all(check["passed"] for check in checks)


def test_action_resource_checks_require_renderer_audit_match():
    checks = build_action_resource_checks(
        {
            "tool": "create_design",
            "status": "completed",
            "action_id": "action-1",
            "action_resource_uri": "waypoint://action/action-1",
            "renderer_audit_id": "audit-1",
        },
        {
            "exists": True,
            "resourceUri": "waypoint://action/action-1",
            "action": {
                "id": "action-1",
                "toolName": "create_design",
                "completedAt": "2026-04-30T20:00:00Z",
            },
            "auditRecords": [{"id": "audit-2", "actorKind": "agent"}],
        },
    )

    failed = [check["name"] for check in checks if not check["passed"]]
    assert failed == ["renderer_audit_matches"]


def test_workflow_contract_describes_real_user_journey():
    contract = build_workflow_contract(WORKFLOW_MINI_DERIVATIVE_DESIGN)

    assert "plasmid sequence" in contract["user_goal"]
    assert "Addgene" in contract["first_external_tooling_use_case"]
    assert "local pUC19 GenBank fixture" in contract["first_external_tooling_use_case"]
    assert "import_sequence" in contract["required_primitives"]
    assert "create_design" in contract["required_primitives"]
    assert "MCP resources/read snapshot" in contract["verification_channels"]
    assert "WebGL/canvas render observer" in contract["verification_channels"]
    assert "Addgene/NCBI adapters" in " ".join(contract["next_mcp_gaps"])


def test_ncbi_import_smoke_contract_describes_real_external_import():
    contract = build_workflow_contract(WORKFLOW_NCBI_IMPORT_SMOKE)

    assert "NCBI" in contract["user_goal"]
    assert "GenBank import" in contract["first_external_tooling_use_case"]
    assert (
        "import_sequence source={kind:ncbi, accession}"
        in contract["required_primitives"]
    )
    assert "MCP resources/read sequence snapshot" in contract["verification_channels"]
    assert "WebGL/canvas render observer" in contract["verification_channels"]


def test_ncbi_derivative_contract_describes_composed_external_design():
    contract = build_workflow_contract(WORKFLOW_NCBI_DERIVATIVE_DESIGN)

    assert "derivative DNAForge design" in contract["user_goal"]
    assert (
        "NCBI import feeds directly into design creation"
        in contract["first_external_tooling_use_case"]
    )
    assert "plan_design_regions" in contract["required_primitives"]
    assert "create_design" in contract["required_primitives"]
    assert "add_design_region" in contract["required_primitives"]
    assert "MCP resources/read design snapshot" in contract["verification_channels"]


def test_render_workflow_contract_is_human_readable():
    markdown = render_workflow_contract(WORKFLOW_MINI_DERIVATIVE_DESIGN)

    assert "# MCP Workflow Contract: mini-derivative-design" in markdown
    assert "## Expected App Changes" in markdown
    assert "## Workflow Steps" in markdown
    assert "## Next MCP Gaps" in markdown
    assert "A design tab opens" in markdown


def test_sequence_render_observer_requires_matching_loaded_sequence_and_webgl():
    observation = {
        "sequenceRender": {
            "rendered": True,
            "minimapType": "webgl",
            "visibleCanvasCount": 1,
            "loadedSequence": {
                "path": "imports/pUC19-agent-import.gb",
                "name": "pUC19",
                "length": 2686,
                "annotationCount": 9,
            },
            "webgl": {
                "ready": True,
                "matchingInstanceCount": 1,
            },
        }
    }

    assert sequence_render_observer_passed(
        observation, expected_length=2686, expected_feature_count=9
    )
    assert not sequence_render_observer_passed(
        observation, expected_length=100, expected_feature_count=9
    )


def test_sequence_render_summary_keeps_human_scale_evidence():
    summary = summarize_sequence_render_observation(
        {
            "sequenceRender": {
                "rendered": False,
                "reason": "webgl_instance_not_ready",
                "tabId": "tab-1",
                "entityId": "imports/pUC19-agent-import.gb",
                "minimapType": "webgl",
                "visibleCanvasCount": 1,
                "loadedSequence": {
                    "path": "imports/pUC19-agent-import.gb",
                    "name": "pUC19",
                    "length": 2686,
                    "annotationCount": 9,
                },
                "webgl": {
                    "ready": False,
                    "matchingInstanceCount": 0,
                },
            }
        }
    )

    assert summary == {
        "rendered": False,
        "reason": "webgl_instance_not_ready",
        "tab_id": "tab-1",
        "entity_id": "imports/pUC19-agent-import.gb",
        "loaded_sequence": {
            "path": "imports/pUC19-agent-import.gb",
            "name": "pUC19",
            "length": 2686,
            "annotation_count": 9,
        },
        "minimap_type": "webgl",
        "visible_canvas_count": 1,
        "webgl_ready": False,
        "webgl_matching_instance_count": 0,
    }


def test_failed_workflow_report_classifies_next_actions():
    report = build_failed_workflow_report(
        started=datetime.now(tz=UTC),
        steps=[],
        ledger=[],
        classification="observer_gap",
        failed_stage="observe_design_state",
        message="observer missing design state",
    )

    assert report["outcome"] == "failed"
    assert report["classification"] == "observer_gap"
    assert report["failed_stage"] == "observe_design_state"
    assert "observer" in " ".join(report["next_actions"]).lower()


def test_failed_workflow_report_preserves_workflow_name():
    report = build_failed_workflow_report(
        workflow=WORKFLOW_NCBI_IMPORT_SMOKE,
        started=datetime.now(tz=UTC),
        steps=[],
        ledger=[],
        classification="sequence_import_failed",
        failed_stage="import_sequence",
        message="NCBI import failed",
    )

    assert report["workflow"] == WORKFLOW_NCBI_IMPORT_SMOKE


def test_unknown_failure_next_action_is_classification_prompt():
    assert next_actions_for_failure("new_failure") == [
        "Open the transcript and classify the failure before changing the workflow."
    ]


def test_design_mutation_checks_compare_claim_to_snapshot():
    checks = build_design_mutation_checks(
        claim={
            "target": {"type": "design", "id": "design-1"},
            "beforeVersion": 0,
            "afterVersion": 1,
        },
        snapshot={
            "exists": True,
            "id": "design-1",
            "version": 1,
            "regionCount": 1,
            "regions": [{"id": "region-1", "length": 105}],
        },
        expected_effect="added_design_region",
        expected={"regionCount": 1, "regionId": "region-1", "length": 105},
    )

    assert all(item["passed"] for item in checks)


def test_design_resource_uri_encodes_design_id():
    assert design_resource_uri("design/1") == "waypoint://design/design%2F1"


def test_parse_single_json_resource_requires_one_matching_json_content():
    resource = parse_single_json_resource(
        {
            "contents": [
                {
                    "uri": "waypoint://design/design-1",
                    "mimeType": "application/json",
                    "text": json.dumps({"exists": True, "designId": "design-1"}),
                }
            ]
        },
        "waypoint://design/design-1",
    )

    assert resource == {"exists": True, "designId": "design-1"}


def test_parse_single_json_resource_classifies_invalid_json():
    with pytest.raises(WorkflowFailure) as exc:
        parse_single_json_resource(
            {
                "contents": [
                    {
                        "uri": "waypoint://design/design-1",
                        "mimeType": "application/json",
                        "text": "{bad",
                    }
                ]
            },
            "waypoint://design/design-1",
        )

    assert exc.value.classification == "resource_read_failed"
    assert exc.value.stage == "read_design_resource"


def test_normalize_design_resource_snapshot_keeps_canonical_fields():
    snapshot = normalize_design_resource_snapshot(
        {
            "exists": True,
            "designId": "design-1",
            "resourceUri": "waypoint://design/design-1",
            "name": "Derivative",
            "assemblyMethod": "gibson",
            "assemblyState": "ready",
            "version": 3,
            "regionCount": 2,
            "primerPairCount": 2,
            "validationErrorCount": 0,
            "regions": [{"id": "region-1", "length": 105}],
            "extraRendererDetail": "not part of the ledger snapshot",
        },
        design_id="design-1",
    )

    assert snapshot == {
        "exists": True,
        "id": "design-1",
        "resourceUri": "waypoint://design/design-1",
        "name": "Derivative",
        "assemblyMethod": "gibson",
        "assemblyState": "ready",
        "version": 3,
        "regionCount": 2,
        "primerPairCount": 2,
        "validationErrorCount": 0,
        "regions": [{"id": "region-1", "length": 105}],
    }


def test_read_design_resource_snapshot_uses_mcp_resources_read(tmp_path):
    class FakeClient:
        def __init__(self):
            self.calls = []

        def request(self, method, params=None):
            self.calls.append((method, params))
            return {
                "result": {
                    "contents": [
                        {
                            "uri": "waypoint://design/design-1",
                            "mimeType": "application/json",
                            "text": json.dumps(
                                {
                                    "exists": True,
                                    "designId": "design-1",
                                    "resourceUri": "waypoint://design/design-1",
                                    "name": "Derivative",
                                    "assemblyMethod": "gibson",
                                    "assemblyState": "ready",
                                    "version": 2,
                                    "regionCount": 2,
                                    "primerPairCount": 1,
                                    "validationErrorCount": 0,
                                    "regions": [],
                                }
                            ),
                        }
                    ]
                }
            }

    client = FakeClient()
    state = SimpleNamespace(client=client, transcript_path=tmp_path / "events.jsonl")

    snapshot = read_design_resource_snapshot(
        state, resource_uri="waypoint://design/design-1", design_id="design-1"
    )

    assert client.calls == [("resources/read", {"uri": "waypoint://design/design-1"})]
    assert snapshot["exists"] is True
    assert snapshot["assemblyState"] == "ready"


def test_read_sequence_resource_snapshot_uses_mcp_resources_read(tmp_path):
    class FakeClient:
        def __init__(self):
            self.calls = []

        def request(self, method, params=None):
            self.calls.append((method, params))
            uri = "waypoint://sequence/imports%2FpUC19-agent-import.gb"
            return {
                "result": {
                    "contents": [
                        {
                            "uri": uri,
                            "mimeType": "application/json",
                            "text": json.dumps(
                                {
                                    "exists": True,
                                    "path": "imports/pUC19-agent-import.gb",
                                    "resourceUri": uri,
                                    "name": "pUC19",
                                    "format": "genbank",
                                    "length": 2686,
                                    "featureCount": 9,
                                }
                            ),
                        }
                    ]
                }
            }

    client = FakeClient()
    state = SimpleNamespace(client=client, transcript_path=tmp_path / "events.jsonl")

    snapshot = read_sequence_resource_snapshot(
        state, resource_uri="waypoint://sequence/imports%2FpUC19-agent-import.gb"
    )

    assert client.calls == [
        (
            "resources/read",
            {"uri": "waypoint://sequence/imports%2FpUC19-agent-import.gb"},
        )
    ]
    assert snapshot["exists"] is True
    assert snapshot["path"] == "imports/pUC19-agent-import.gb"


def test_read_design_resource_snapshot_classifies_jsonrpc_error(tmp_path):
    class FakeClient:
        def request(self, _method, _params=None):
            return {"error": {"code": -32000, "message": "renderer unavailable"}}

    state = SimpleNamespace(
        client=FakeClient(), transcript_path=tmp_path / "events.jsonl"
    )

    with pytest.raises(WorkflowFailure) as exc:
        read_design_resource_snapshot(
            state, resource_uri="waypoint://design/design-1", design_id="design-1"
        )

    assert exc.value.classification == "resource_read_failed"
    assert exc.value.stage == "read_design_resource"


def test_read_resource_command_reads_sequence_resource(tmp_path, capsys):
    class FakeClient:
        def __init__(self):
            self.calls = []

        def request(self, method, params=None):
            self.calls.append((method, params))
            uri = "waypoint://sequence/plasmids%2FpUC19.gb"
            return {
                "result": {
                    "contents": [
                        {
                            "uri": uri,
                            "mimeType": "application/json",
                            "text": json.dumps(
                                {
                                    "exists": True,
                                    "path": "plasmids/pUC19.gb",
                                    "resourceUri": uri,
                                    "name": "pUC19",
                                    "format": "genbank",
                                    "length": 2686,
                                    "featureCount": 9,
                                }
                            ),
                        }
                    ]
                }
            }

    client = FakeClient()
    state = SimpleNamespace(client=client, transcript_path=tmp_path / "events.jsonl")

    resource = read_resource_command(state, "waypoint://sequence/plasmids%2FpUC19.gb")

    assert client.calls == [
        ("resources/read", {"uri": "waypoint://sequence/plasmids%2FpUC19.gb"})
    ]
    assert resource["path"] == "plasmids/pUC19.gb"
    output = capsys.readouterr().out
    assert "Sequence resource: pUC19 (plasmids/pUC19.gb)" in output
    assert "2686 bp, 9 features, format genbank" in output


def test_read_resource_command_reads_action_resource(tmp_path, capsys):
    class FakeClient:
        def __init__(self):
            self.calls = []

        def request(self, method, params=None):
            self.calls.append((method, params))
            return {
                "result": {
                    "contents": [
                        {
                            "uri": "waypoint://action/action-1",
                            "mimeType": "application/json",
                            "text": json.dumps(
                                {
                                    "exists": True,
                                    "resourceUri": "waypoint://action/action-1",
                                    "action": {
                                        "id": "action-1",
                                        "toolName": "create_design",
                                        "authorizationState": "granted",
                                        "completedAt": "2026-04-30T20:00:00Z",
                                    },
                                    "auditRecords": [
                                        {"id": "audit-1", "actorKind": "agent"},
                                        {"id": "audit-2", "actorKind": "renderer"},
                                    ],
                                }
                            ),
                        }
                    ]
                }
            }

    client = FakeClient()
    state = SimpleNamespace(client=client, transcript_path=tmp_path / "events.jsonl")

    resource = read_resource_command(state, "waypoint://action/action-1")

    assert client.calls == [("resources/read", {"uri": "waypoint://action/action-1"})]
    assert resource["action"]["toolName"] == "create_design"
    output = capsys.readouterr().out
    assert "Action resource: create_design (action-1)" in output
    assert "granted, 2 audit records" in output


def test_read_resource_command_prints_workflow_resource(tmp_path, capsys):
    class FakeClient:
        def __init__(self):
            self.calls = []

        def request(self, method, params=None):
            self.calls.append((method, params))
            return {
                "result": {
                    "contents": [
                        {
                            "uri": "waypoint://workflow/manifest",
                            "mimeType": "application/json",
                            "text": json.dumps(
                                {
                                    "exists": True,
                                    "resourceUri": "waypoint://workflow/manifest",
                                    "manifest": {
                                        "schemaVersion": 1,
                                        "workflows": [{"id": "ncbi-derivative-design"}],
                                    },
                                }
                            ),
                        }
                    ]
                }
            }

    client = FakeClient()
    state = SimpleNamespace(client=client, transcript_path=tmp_path / "events.jsonl")

    resource = read_resource_command(state, "waypoint://workflow/manifest")

    assert client.calls == [("resources/read", {"uri": "waypoint://workflow/manifest"})]
    assert resource["manifest"]["schemaVersion"] == 1
    output = capsys.readouterr().out
    assert "Workflow manifest: 1 workflows" in output


def test_ledger_verdict_failure_raises_workflow_failure():
    entry = failed_ledger_entry(
        "after_version_matches",
        "Observed design version does not match mutation claim.",
    )

    with pytest.raises(WorkflowFailure, match="Observed design version") as exc:
        require_ledger_verdict(entry, stage="add_design_region")

    assert exc.value.classification == "mutation_verification_failed"
    assert exc.value.stage == "add_design_region"
