"""Tests for  harness evidence summaries."""

from src.agent_workflow_harness.assay_summaries import (
    build_design_tool_smoke_assay,
    build_desktop_agent_workflow_assay,
    build_fake_renderer_contract_assay,
    build_mini_design_workflow_assay,
    build_ui_effect_smoke_assay,
)
from src.agent_workflow_harness.closed_loop import (
    build_closed_loop_add_design_region_assay,
    build_closed_loop_create_design_assay,
    build_closed_loop_draft_design_assembly_assay,
    build_closed_loop_import_sequence_assay,
    build_closed_loop_open_tab_assay,
    score_add_design_region_closed_loop,
    score_create_design_closed_loop,
    score_draft_design_assembly_closed_loop,
    score_import_sequence_closed_loop,
    score_open_tab_closed_loop,
)


def test_fake_renderer_contract_assay_summarizes_security_boundary():
    assay = build_fake_renderer_contract_assay(
        listed_tools=["echo", "get_workspace", "workspace.gitStatus"],
        retained_renderer_tools=["get_workspace", "workspace.gitStatus"],
        forwarded_scope=["read-workspace"],
        renderer_calls=1,
        workflow_resource={
            "workflow_ids": ["mini-derivative-design", "ncbi-derivative-design"],
            "manifest_workflow_count": 2,
            "ledger_summary_total_runs": 0,
        },
        workflow_prepare={
            "workflow_id": "ncbi-derivative-design",
            "contract_resource": "waypoint://workflow/ncbi-derivative-design",
            "latest_run_resource": (
                "waypoint://workflow-runs/latest/ncbi-derivative-design"
            ),
            "command_argv": [
                "uv",
                "run",
                "python",
                "scripts/agent_mcp_console.py",
                "--workflow",
                "ncbi-derivative-design",
            ],
        },
        artifact_register={
            "resource_uri": "waypoint://artifact/artifact-1",
            "name": "Harness output table",
            "sha256": "abc123",
            "size_bytes": 20,
            "metadata": {"assay": "mcp_contract_smoke"},
            "provenance_command": "printf gene/count",
        },
        analysis_run={
            "resource_uri": "waypoint://analysis-run/run-1",
            "name": "Harness analysis run",
            "status": "completed",
            "output_resource_uri": "waypoint://artifact/artifact-1",
            "metrics": {"outputFiles": 1},
        },
        resource_link={
            "resource_uri": "waypoint://resource-link/link-1",
            "source_uri": "waypoint://analysis-run/run-1",
            "target_uri": "waypoint://workflow/ncbi-derivative-design",
            "relationship": "implements_workflow",
        },
    )

    assert assay["name"] == "mcp_contract_smoke"
    assert assay["outcome"] == "passed"
    assert assay["steps"][0]["evidence"]["listed_tools"] == [
        "echo",
        "get_workspace",
        "workspace.gitStatus",
    ]
    assert assay["steps"][0]["evidence"]["retained_renderer_tools"] == [
        "get_workspace",
        "workspace.gitStatus",
    ]
    assert assay["steps"][1]["tool"] == "resources/read"
    assert assay["steps"][1]["resource"] == "waypoint://workflow/manifest"
    assert assay["steps"][1]["evidence"]["manifest_workflow_count"] == 2
    assert "ncbi-derivative-design" in assay["steps"][1]["evidence"]["workflow_ids"]
    assert assay["steps"][2]["tool"] == "workflow.prepare_run"
    assert assay["steps"][2]["evidence"]["workflow_id"] == "ncbi-derivative-design"
    assert assay["steps"][2]["evidence"]["contract_resource"] == (
        "waypoint://workflow/ncbi-derivative-design"
    )
    assert assay["steps"][3]["tool"] == "artifact.register"
    assert assay["steps"][3]["resource"] == "waypoint://artifact/artifact-1"
    assert assay["steps"][3]["evidence"]["metadata"] == {"assay": "mcp_contract_smoke"}
    assert assay["steps"][4]["tool"] == "analysis_run.create"
    assert assay["steps"][4]["resource"] == "waypoint://analysis-run/run-1"
    assert assay["steps"][4]["evidence"]["output_resource_uri"] == (
        "waypoint://artifact/artifact-1"
    )
    assert assay["steps"][5]["tool"] == "resource_link.create"
    assert assay["steps"][5]["resource"] == "waypoint://resource-link/link-1"
    assert assay["steps"][5]["evidence"]["target_uri"] == (
        "waypoint://workflow/ncbi-derivative-design"
    )
    assert assay["steps"][6]["evidence"] == {
        "forwarded_scope": ["read-workspace"],
        "renderer_calls": 1,
    }
    assert assay["steps"][7]["tool"] == "echo"
    assert assay["steps"][7]["negative_case"] == "insufficient_scope"
    assert assay["steps"][7]["evidence"]["blocked_before_renderer"] is True
    assert assay["steps"][8]["negative_case"] == "bad_session"


def test_desktop_agent_workflow_assay_summarizes_useful_agent_work():
    assay = build_desktop_agent_workflow_assay(
        renderer_audit_id="audit-1",
        git_status={
            "tracked": True,
            "changed_files": {"notes.md": "modified"},
            "recent_commits": ["Initial workspace"],
            "diff_stat": {"filesChanged": 1},
        },
        reference_workflow={
            "feature_search": {
                "path": "plasmids/pUC19.gb",
                "query": "AmpR",
                "match_count": 1,
                "feature_names": ["AmpR promoter"],
                "no_match_control": {
                    "query": "__dna82_no_such_feature__",
                    "match_count": 0,
                    "features_empty": True,
                },
            },
            "reference": {
                "reference_id": "ref_1",
                "requested_display_label": "AmpR promoter",
                "stored_display_label": "pUC19.gb",
                "entity_type": "sequence_region",
                "locator": "git://workspace/plasmids/pUC19.gb",
                "deep_link_params": {"start": 100, "end": 200},
                "source": "ai",
                "status": "created",
                "durable_db_row_found": True,
            },
            "reference_navigation": {
                "opened_via_reference": True,
                "reference_id": "ref_1",
                "opened_label": "pUC19.gb",
                "opened_tab_id": "tab-ref",
                "entity_id": "/workspace/plasmids/pUC19.gb",
                "deep_link_scroll_position": 100,
                "deep_link_highlight_range": {"start": 99, "end": 199},
                "dom_visible_after_navigation": True,
                "closed_after_navigation": True,
            },
            "tab": {
                "opened_label": "pUC19",
                "opened_tab_id": "tab-1",
                "absent_before_open": True,
                "visible_after_open": True,
                "closed": True,
                "removed_after_close": True,
                "ui_observation": {
                    "dom_absent_before_open": True,
                    "dom_visible_after_open": True,
                    "dom_removed_after_close": True,
                    "visible_tab_labels_after_open": ["pUC19"],
                },
                "sequence_resource": {
                    "resource_uri": "waypoint://sequence/plasmids%2FpUC19.gb",
                    "name": "pUC19",
                    "exists": True,
                    "path": "plasmids/pUC19.gb",
                    "length": 2686,
                    "feature_count": 12,
                    "sequence_included": True,
                },
            },
        },
        sequence_changes={
            "file": "plasmids/pUC19.gb",
            "mutations": 1,
            "insertions": 0,
            "deletions": 0,
            "detail_count": 1,
            "no_change_control": {
                "file": "plasmids/pUC19-clean.gb",
                "mutations": 0,
                "insertions": 0,
                "deletions": 0,
                "detail_count": 0,
            },
        },
    )

    assert assay["name"] == "desktop_workspace_review"
    assert assay["outcome"] == "passed"
    assert [step["tool"] for step in assay["steps"]] == [
        "get_workspace",
        "workspace.gitStatus",
        "find_features",
        "create_reference",
        "reference_navigation",
        "open_tab/close_tab",
        "get_sequence_changes",
    ]
    assert assay["steps"][0]["evidence"]["renderer_audit_id"] == "audit-1"
    assert assay["steps"][2]["evidence"]["no_match_control"] == {
        "query": "__dna82_no_such_feature__",
        "match_count": 0,
        "features_empty": True,
    }
    assert assay["steps"][3]["evidence"]["reference_id"] == "ref_1"
    assert assay["steps"][3]["evidence"]["durable_db_row_found"] is True
    assert assay["steps"][4]["evidence"]["opened_via_reference"] is True
    assert assay["steps"][4]["evidence"]["deep_link_highlight_range"] == {
        "start": 99,
        "end": 199,
    }
    assert assay["steps"][5]["evidence"]["closed"] is True
    assert assay["steps"][6]["evidence"]["mutations"] == 1
    assert assay["steps"][6]["evidence"]["no_change_control"]["mutations"] == 0


def test_ui_effect_smoke_assay_summarizes_app_state_observation():
    assay = build_ui_effect_smoke_assay(
        {
            "opened_label": "pUC19",
            "opened_tab_id": "tab-1",
            "absent_before_open": True,
            "visible_after_open": True,
            "closed": True,
            "removed_after_close": True,
            "ui_observation": {
                "dom_absent_before_open": True,
                "dom_visible_after_open": True,
                "dom_removed_after_close": True,
                "visible_tab_labels_after_open": ["pUC19"],
            },
        }
    )

    assert assay["name"] == "ui_effect_smoke"
    assert assay["outcome"] == "passed"
    assert [step["tool"] for step in assay["steps"]] == ["open_tab", "close_tab"]
    assert (
        assay["steps"][0]["observer"] == "desktop_test_ui_observation + get_workspace"
    )
    assert assay["steps"][0]["evidence"]["visible_after_open"] is True
    assert assay["steps"][0]["evidence"]["dom_visible_after_open"] is True
    assert assay["steps"][1]["evidence"]["removed_after_close"] is True
    assert assay["steps"][1]["evidence"]["dom_removed_after_close"] is True


def test_closed_loop_create_design_assay_scores_observed_app_state_delta():
    before_state = {
        "schemaVersion": 1,
        "workspace": {"panelCount": 1, "tabCount": 0, "focusedPanelId": "main"},
        "designs": {"count": 0},
        "sequences": {"count": 0},
        "targets": {
            "label": {
                "label": "Closed-loop design",
                "present": False,
                "count": 0,
                "active": False,
                "tabs": [],
            }
        },
    }
    after_state = {
        "schemaVersion": 1,
        "workspace": {"panelCount": 1, "tabCount": 1, "focusedPanelId": "main"},
        "designs": {"count": 1},
        "sequences": {"count": 0},
        "targets": {
            "label": {
                "label": "Closed-loop design",
                "present": True,
                "count": 1,
                "active": True,
                "tabs": [{"id": "tab-1", "entityId": "design-1"}],
            },
            "design": {
                "designId": "design-1",
                "present": True,
                "design": {
                    "id": "design-1",
                    "name": "Closed-loop design",
                    "assemblyMethod": "gibson",
                    "assemblyState": "preflight",
                    "regionCount": 0,
                },
                "openTabs": [{"id": "tab-1", "active": True}],
            },
        },
    }

    flow_result = score_create_design_closed_loop(
        design_name="Closed-loop design",
        create_result={
            "designId": "design-1",
            "tabId": "tab-1",
            "opened": True,
            "assemblyMethod": "gibson",
        },
        before_state=before_state,
        after_state=after_state,
    )
    flow_result["cleanup"] = {"closed_after_observation": True}

    assert flow_result["outcome"] == "passed"
    assert all(check["passed"] for check in flow_result["checks"])

    assay = build_closed_loop_create_design_assay(flow_result)

    assert assay["name"] == "closed_loop_create_design"
    assert assay["outcome"] == "passed"
    assert [step["tool"] for step in assay["steps"]] == [
        "observe_app_state",
        "create_design",
        "observe_app_state",
        "closed_loop.score",
    ]
    assert assay["steps"][0]["evidence"]["targets"]["label"]["present"] is False
    assert assay["steps"][2]["evidence"]["targets"]["design"]["present"] is True
    assert assay["steps"][3]["evidence"]["cleanup"] == {
        "closed_after_observation": True
    }


def test_closed_loop_create_design_score_fails_when_observer_does_not_change():
    unchanged_state = {
        "schemaVersion": 1,
        "workspace": {"panelCount": 1, "tabCount": 0, "focusedPanelId": "main"},
        "designs": {"count": 0},
        "sequences": {"count": 0},
        "targets": {
            "label": {"present": False, "active": False, "tabs": []},
            "design": {"present": False, "design": None, "openTabs": []},
        },
    }

    flow_result = score_create_design_closed_loop(
        design_name="Closed-loop design",
        create_result={
            "designId": "design-1",
            "tabId": "tab-1",
            "opened": True,
            "assemblyMethod": "gibson",
        },
        before_state=unchanged_state,
        after_state=unchanged_state,
    )

    failed_checks = {
        check["name"] for check in flow_result["checks"] if check["passed"] is False
    }
    assert flow_result["outcome"] == "failed"
    assert "target_label_present_after" in failed_checks
    assert "target_design_present_after" in failed_checks
    assert "observer_reports_new_open_tab" in failed_checks


def test_closed_loop_open_tab_assay_scores_observed_app_state_delta():
    """: happy-path scorer + assay builder for closed_loop_open_tab.

    Fixture mirrors what real Electron actually emits: agent passes a
    workspace-relative entityId, observer reports the canonical absolute
    form. The scorer asserts the canonicalization is correct, not that the
    two strings match. (This shape was discovered by the first real-Electron
    Phase 2 run, which caught a fixture/reality drift my first L0 missed.)
    """

    target_label = "Closed-loop open_tab"
    target_entity_id_request = "plasmids/pUC19.gb"
    target_entity_id_canonical = (
        "/Users/test/.waypoint-test/agent-mcp-workspace/plasmids/pUC19.gb"
    )
    target_tab_type = "sequence"
    tool_tab_id = "tab-open-1"

    before_state = {
        "schemaVersion": 1,
        "workspace": {"panelCount": 1, "tabCount": 0, "focusedPanelId": "main"},
        "designs": {"count": 0},
        "sequences": {"count": 0},
        "targets": {
            "label": {
                "label": target_label,
                "present": False,
                "count": 0,
                "active": False,
                "tabs": [],
            }
        },
    }
    after_state = {
        "schemaVersion": 1,
        "workspace": {"panelCount": 1, "tabCount": 1, "focusedPanelId": "main"},
        "designs": {"count": 0},
        "sequences": {"count": 1},
        "targets": {
            "label": {
                "label": target_label,
                "present": True,
                "count": 1,
                "active": True,
                "tabs": [
                    {
                        "id": tool_tab_id,
                        "type": target_tab_type,
                        "entityId": target_entity_id_canonical,
                        "panelId": "main",
                        "active": True,
                    }
                ],
            }
        },
    }

    flow_result = score_open_tab_closed_loop(
        target_label=target_label,
        target_entity_id_request=target_entity_id_request,
        target_entity_id_canonical=target_entity_id_canonical,
        target_tab_type=target_tab_type,
        open_tab_result={"tabId": tool_tab_id},
        before_state=before_state,
        after_state=after_state,
    )
    flow_result["cleanup"] = {"closed_after_observation": True}

    assert flow_result["outcome"] == "passed"
    assert all(check["passed"] for check in flow_result["checks"])
    check_names = [check["name"] for check in flow_result["checks"]]
    assert check_names == [
        "target_label_absent_before",
        "tool_returned_tab_id",
        "target_label_present_after",
        "target_label_active_after",
        "observer_reports_matching_tab",
        "observer_reports_exactly_one_matching_tab",
        "observer_tab_type_matches_request",
        "observer_tab_entity_canonicalized_correctly",
        "observer_tab_is_active",
        "workspace_tab_count_increased",
    ]

    assay = build_closed_loop_open_tab_assay(flow_result)
    assert assay["name"] == "closed_loop_open_tab"
    assert assay["mode"] == "desktop"
    assert assay["outcome"] == "passed"
    assert [step["tool"] for step in assay["steps"]] == [
        "observe_app_state",
        "open_tab",
        "observe_app_state",
        "closed_loop.score",
    ]
    assert assay["steps"][0]["evidence"]["targets"]["label"]["present"] is False
    assert assay["steps"][2]["evidence"]["targets"]["label"]["present"] is True
    assert assay["steps"][3]["evidence"]["cleanup"] == {
        "closed_after_observation": True
    }


def test_closed_loop_open_tab_score_fails_when_observer_does_not_change():
    """: failure shape when MCP returns ok but app state did not move.

    This is the exact failure that the closed-loop pattern exists to catch:
    open_tab returns a tabId, but the renderer's canvas store never updated.
    Without the observer-side check, this would silently pass on a broken
    bridge. The scorer must classify this as failed and name which checks
    fired.
    """

    target_label = "Closed-loop open_tab"
    target_entity_id_request = "plasmids/pUC19.gb"
    target_entity_id_canonical = "/Users/test/workspace/plasmids/pUC19.gb"
    target_tab_type = "sequence"
    unchanged_state = {
        "schemaVersion": 1,
        "workspace": {"panelCount": 1, "tabCount": 0, "focusedPanelId": "main"},
        "designs": {"count": 0},
        "sequences": {"count": 0},
        "targets": {
            "label": {
                "label": target_label,
                "present": False,
                "count": 0,
                "active": False,
                "tabs": [],
            }
        },
    }

    flow_result = score_open_tab_closed_loop(
        target_label=target_label,
        target_entity_id_request=target_entity_id_request,
        target_entity_id_canonical=target_entity_id_canonical,
        target_tab_type=target_tab_type,
        open_tab_result={"tabId": "tab-open-2"},
        before_state=unchanged_state,
        after_state=unchanged_state,
    )

    failed_checks = {
        check["name"] for check in flow_result["checks"] if check["passed"] is False
    }
    assert flow_result["outcome"] == "failed"
    assert "target_label_present_after" in failed_checks
    assert "observer_reports_matching_tab" in failed_checks
    assert "observer_tab_entity_canonicalized_correctly" in failed_checks
    assert "observer_tab_is_active" in failed_checks
    assert "workspace_tab_count_increased" in failed_checks
    passed_checks = {
        check["name"] for check in flow_result["checks"] if check["passed"] is True
    }
    assert "tool_returned_tab_id" in passed_checks


def test_closed_loop_import_sequence_assay_scores_observed_app_state_delta():
    target_absolute_path = "/workspace/imports/imported-pUC19.gb"
    before_state = {
        "schemaVersion": 1,
        "workspace": {"panelCount": 1, "tabCount": 0, "focusedPanelId": "main"},
        "designs": {"count": 0},
        "sequences": {"count": 0},
        "targets": {
            "label": {
                "label": "Imported pUC19",
                "present": False,
                "count": 0,
                "active": False,
                "tabs": [],
            },
            "sequence": {
                "path": target_absolute_path,
                "present": False,
                "sequence": None,
                "openTabs": [],
            },
        },
    }
    after_state = {
        "schemaVersion": 1,
        "workspace": {"panelCount": 1, "tabCount": 1, "focusedPanelId": "main"},
        "designs": {"count": 0},
        "sequences": {"count": 1},
        "targets": {
            "label": {
                "label": "Imported pUC19",
                "present": True,
                "count": 1,
                "active": True,
                "tabs": [{"id": "tab-1", "entityId": target_absolute_path}],
            },
            "sequence": {
                "path": target_absolute_path,
                "present": True,
                "sequence": {
                    "path": target_absolute_path,
                    "name": "pUC19",
                    "length": 2686,
                    "annotationCount": 9,
                    "version": 1,
                },
                "openTabs": [{"id": "tab-1", "label": "Imported pUC19"}],
            },
        },
    }

    flow_result = score_import_sequence_closed_loop(
        target_label="Imported pUC19",
        target_path="imports/imported-pUC19.gb",
        target_absolute_path=target_absolute_path,
        import_result={
            "imported": True,
            "path": "imports/imported-pUC19.gb",
            "absolutePath": target_absolute_path,
            "resourceUri": "waypoint://sequence/imports%2Fimported-pUC19.gb",
            "name": "pUC19",
            "format": "genbank",
            "length": 2686,
            "featureCount": 9,
            "opened": True,
            "tabId": "tab-1",
            "source": {"kind": "local_file", "path": "plasmids/pUC19-clean.gb"},
        },
        before_state=before_state,
        after_state=after_state,
        resource_snapshot={
            "exists": True,
            "path": "imports/imported-pUC19.gb",
            "resourceUri": "waypoint://sequence/imports%2Fimported-pUC19.gb",
            "name": "pUC19",
            "length": 2686,
            "featureCount": 9,
            "sequenceIncluded": True,
        },
    )

    assert flow_result["outcome"] == "passed"
    assert all(check["passed"] for check in flow_result["checks"])

    assay = build_closed_loop_import_sequence_assay(flow_result)

    assert assay["name"] == "closed_loop_import_sequence"
    assert assay["outcome"] == "passed"
    assert [step["tool"] for step in assay["steps"]] == [
        "observe_app_state",
        "import_sequence",
        "observe_app_state",
        "resources/read",
        "closed_loop.score",
    ]
    assert assay["steps"][0]["evidence"]["targets"]["sequence"]["present"] is False
    assert assay["steps"][2]["evidence"]["targets"]["sequence"]["present"] is True
    assert assay["steps"][3]["evidence"]["path"] == "imports/imported-pUC19.gb"


def test_closed_loop_import_sequence_score_fails_when_observer_does_not_change():
    target_absolute_path = "/workspace/imports/imported-pUC19.gb"
    unchanged_state = {
        "schemaVersion": 1,
        "workspace": {"panelCount": 1, "tabCount": 0, "focusedPanelId": "main"},
        "designs": {"count": 0},
        "sequences": {"count": 0},
        "targets": {
            "label": {"present": False, "active": False, "tabs": []},
            "sequence": {
                "path": target_absolute_path,
                "present": False,
                "sequence": None,
                "openTabs": [],
            },
        },
    }

    flow_result = score_import_sequence_closed_loop(
        target_label="Imported pUC19",
        target_path="imports/imported-pUC19.gb",
        target_absolute_path=target_absolute_path,
        import_result={
            "imported": True,
            "path": "imports/imported-pUC19.gb",
            "absolutePath": target_absolute_path,
            "resourceUri": "waypoint://sequence/imports%2Fimported-pUC19.gb",
            "length": 2686,
            "featureCount": 9,
            "opened": True,
            "tabId": "tab-1",
        },
        before_state=unchanged_state,
        after_state=unchanged_state,
        resource_snapshot={
            "exists": True,
            "path": "imports/imported-pUC19.gb",
            "resourceUri": "waypoint://sequence/imports%2Fimported-pUC19.gb",
            "length": 2686,
            "featureCount": 9,
        },
    )

    failed_checks = {
        check["name"] for check in flow_result["checks"] if check["passed"] is False
    }
    assert flow_result["outcome"] == "failed"
    assert "target_label_present_after" in failed_checks
    assert "target_sequence_present_after" in failed_checks
    assert "observer_reports_open_sequence_tab" in failed_checks


def test_closed_loop_add_design_region_assay_scores_observed_app_state_delta():
    before_state = {
        "schemaVersion": 1,
        "workspace": {"panelCount": 1, "tabCount": 1, "focusedPanelId": "main"},
        "designs": {"count": 1},
        "sequences": {"count": 1},
        "targets": {
            "design": {
                "designId": "design-1",
                "present": True,
                "design": {
                    "id": "design-1",
                    "name": "Derivative design",
                    "assemblyMethod": "gibson",
                    "assemblyState": "preflight",
                    "regionCount": 0,
                    "version": 1,
                },
                "openTabs": [{"id": "tab-1", "active": True}],
            }
        },
    }
    after_state = {
        "schemaVersion": 1,
        "workspace": {"panelCount": 1, "tabCount": 1, "focusedPanelId": "main"},
        "designs": {"count": 1},
        "sequences": {"count": 1},
        "targets": {
            "design": {
                "designId": "design-1",
                "present": True,
                "design": {
                    "id": "design-1",
                    "name": "Derivative design",
                    "assemblyMethod": "gibson",
                    "assemblyState": "preflight",
                    "regionCount": 1,
                    "version": 2,
                },
                "openTabs": [{"id": "tab-1", "active": True}],
            }
        },
    }

    flow_result = score_add_design_region_closed_loop(
        design_id="design-1",
        expected_region_length=105,
        add_region_result={
            "designId": "design-1",
            "regionId": "region-1",
            "regionCount": 1,
            "length": 105,
            "sourceSequenceName": "AmpR promoter",
        },
        before_state=before_state,
        after_state=after_state,
    )

    assert flow_result["outcome"] == "passed"
    assert all(check["passed"] for check in flow_result["checks"])

    assay = build_closed_loop_add_design_region_assay(flow_result)

    assert assay["name"] == "closed_loop_add_design_region"
    assert assay["outcome"] == "passed"
    assert [step["tool"] for step in assay["steps"]] == [
        "observe_app_state",
        "add_design_region",
        "observe_app_state",
        "closed_loop.score",
    ]
    assert assay["steps"][0]["evidence"]["targets"]["design"]["present"] is True
    assert (
        assay["steps"][2]["evidence"]["targets"]["design"]["design"]["regionCount"] == 1
    )
    assert assay["steps"][3]["evidence"]["expected_region_length"] == 105


def test_closed_loop_add_design_region_score_fails_when_observer_does_not_change():
    unchanged_state = {
        "schemaVersion": 1,
        "workspace": {"panelCount": 1, "tabCount": 1, "focusedPanelId": "main"},
        "designs": {"count": 1},
        "sequences": {"count": 1},
        "targets": {
            "design": {
                "designId": "design-1",
                "present": True,
                "design": {
                    "id": "design-1",
                    "name": "Derivative design",
                    "regionCount": 0,
                    "version": 1,
                },
                "openTabs": [{"id": "tab-1", "active": True}],
            }
        },
    }

    flow_result = score_add_design_region_closed_loop(
        design_id="design-1",
        expected_region_length=105,
        add_region_result={
            "designId": "design-1",
            "regionId": "region-1",
            "regionCount": 1,
            "length": 105,
        },
        before_state=unchanged_state,
        after_state=unchanged_state,
    )

    failed_checks = {
        check["name"] for check in flow_result["checks"] if check["passed"] is False
    }
    assert flow_result["outcome"] == "failed"
    assert "observer_region_count_incremented" in failed_checks
    assert "observer_matches_tool_region_count" in failed_checks


def test_closed_loop_draft_design_assembly_assay_scores_observed_app_state_delta():
    before_state = {
        "schemaVersion": 1,
        "workspace": {"panelCount": 1, "tabCount": 1, "focusedPanelId": "main"},
        "designs": {"count": 1},
        "sequences": {"count": 1},
        "targets": {
            "design": {
                "designId": "design-1",
                "present": True,
                "design": {
                    "id": "design-1",
                    "name": "Derivative design",
                    "assemblyState": "drafting",
                    "regionCount": 2,
                    "homologyRegionCount": 0,
                    "primerPairCount": 0,
                    "validationErrorCount": 0,
                    "version": 2,
                },
                "openTabs": [{"id": "tab-1", "active": True}],
            }
        },
    }
    after_state = {
        "schemaVersion": 1,
        "workspace": {"panelCount": 1, "tabCount": 1, "focusedPanelId": "main"},
        "designs": {"count": 1},
        "sequences": {"count": 1},
        "targets": {
            "design": {
                "designId": "design-1",
                "present": True,
                "design": {
                    "id": "design-1",
                    "name": "Derivative design",
                    "assemblyState": "ready",
                    "regionCount": 2,
                    "homologyRegionCount": 2,
                    "primerPairCount": 2,
                    "validationErrorCount": 0,
                    "version": 3,
                },
                "openTabs": [{"id": "tab-1", "active": True}],
            }
        },
    }

    flow_result = score_draft_design_assembly_closed_loop(
        design_id="design-1",
        draft_result={
            "designId": "design-1",
            "drafted": True,
            "assemblyState": "ready",
            "regionCount": 2,
            "homologyRegionCount": 2,
            "primerPairCount": 2,
            "validationErrorCount": 0,
        },
        before_state=before_state,
        after_state=after_state,
    )

    assert flow_result["outcome"] == "passed"
    assert all(check["passed"] for check in flow_result["checks"])

    assay = build_closed_loop_draft_design_assembly_assay(flow_result)

    assert assay["name"] == "closed_loop_draft_design_assembly"
    assert assay["outcome"] == "passed"
    assert [step["tool"] for step in assay["steps"]] == [
        "observe_app_state",
        "draft_design_assembly",
        "observe_app_state",
        "closed_loop.score",
    ]
    assert (
        assay["steps"][2]["evidence"]["targets"]["design"]["design"]["assemblyState"]
        == "ready"
    )
    assert assay["steps"][3]["evidence"]["flow_id"] == (
        "draft_design_assembly_state_delta"
    )


def test_closed_loop_draft_design_assembly_score_fails_when_observer_does_not_change():
    unchanged_state = {
        "schemaVersion": 1,
        "workspace": {"panelCount": 1, "tabCount": 1, "focusedPanelId": "main"},
        "designs": {"count": 1},
        "sequences": {"count": 1},
        "targets": {
            "design": {
                "designId": "design-1",
                "present": True,
                "design": {
                    "id": "design-1",
                    "name": "Derivative design",
                    "assemblyState": "drafting",
                    "regionCount": 2,
                    "homologyRegionCount": 0,
                    "primerPairCount": 0,
                    "validationErrorCount": 0,
                    "version": 2,
                },
                "openTabs": [{"id": "tab-1", "active": True}],
            }
        },
    }

    flow_result = score_draft_design_assembly_closed_loop(
        design_id="design-1",
        draft_result={
            "designId": "design-1",
            "drafted": True,
            "assemblyState": "ready",
            "regionCount": 2,
            "homologyRegionCount": 2,
            "primerPairCount": 2,
            "validationErrorCount": 0,
        },
        before_state=unchanged_state,
        after_state=unchanged_state,
    )

    failed_checks = {
        check["name"] for check in flow_result["checks"] if check["passed"] is False
    }
    assert flow_result["outcome"] == "failed"
    assert "observer_matches_ready_assembly" in failed_checks
    assert "observer_matches_primer_pair_count" in failed_checks
    assert "observer_matches_homology_region_count" in failed_checks


def test_design_tool_smoke_assay_summarizes_design_store_observation():
    assay = build_design_tool_smoke_assay(
        {
            "design_id": "design-1",
            "name": "Derivative design",
            "assembly_method": "gibson",
            "opened": True,
            "opened_tab_id": "tab-design",
            "dom_visible_after_open": True,
            "store_visible_after_create": True,
            "assembly_state": "preflight",
            "region_count_after_create": 0,
            "feature_search": {
                "matchCount": 1,
                "features": [
                    {
                        "name": "AmpR promoter",
                        "start": 2490,
                        "end": 2594,
                    }
                ],
            },
            "added_region": {
                "regionId": "region-1",
                "length": 105,
                "regionCount": 1,
            },
            "region_count_after_add": 1,
            "observed_region": {
                "id": "region-1",
                "sourceSequenceName": "AmpR promoter",
                "length": 105,
            },
            "drafted_assembly": {
                "drafted": True,
                "assemblyState": "ready",
                "regionCount": 2,
                "homologyRegionCount": 2,
                "primerPairCount": 2,
                "validationErrorCount": 0,
            },
            "observed_assembly": {
                "assembly_state": "ready",
                "region_count": 2,
                "homology_region_count": 2,
                "primer_pair_count": 2,
                "validation_error_count": 0,
            },
            "mcp_resource": {
                "resource_uri": "waypoint://design/design-1",
                "listed": True,
                "exists": True,
                "design_id": "design-1",
                "assembly_state": "ready",
                "region_count": 2,
                "primer_pair_count": 2,
                "validation_error_count": 0,
            },
            "closed_after_observation": True,
        }
    )

    assert assay["name"] == "design_tool_smoke"
    assert assay["outcome"] == "passed"
    assert assay["steps"][0]["tool"] == "create_design"
    assert assay["steps"][0]["evidence"]["assembly_state"] == "preflight"
    assert assay["steps"][0]["evidence"]["store_visible_after_create"] is True
    assert assay["steps"][1]["tool"] == "add_design_region"
    assert assay["steps"][1]["evidence"]["region_count_after_add"] == 1
    assert assay["steps"][1]["evidence"]["added_region"]["length"] == 105
    assert assay["steps"][2]["tool"] == "draft_design_assembly"
    assert assay["steps"][2]["evidence"]["drafted_assembly"]["drafted"] is True
    assert (
        assay["steps"][2]["evidence"]["observed_assembly"]["assembly_state"] == "ready"
    )
    assert assay["steps"][3]["tool"] == "resources/read"
    assert assay["steps"][3]["evidence"]["listed"] is True


def test_mini_design_workflow_assay_summarizes_composed_workflow():
    assay = build_mini_design_workflow_assay(
        {
            "design_id": "design-1",
            "name": "Derivative design",
            "opened": True,
            "feature_search": {"features": [{"name": "AmpR promoter"}]},
            "added_region": {"regionId": "region-1", "length": 105},
            "second_feature_search": {"features": [{"name": "lacZ-alpha"}]},
            "second_added_region": {"regionId": "region-2", "length": 324},
            "drafted_assembly": {
                "drafted": True,
                "assemblyState": "ready",
                "primerPairCount": 2,
            },
            "observed_assembly": {
                "assembly_state": "ready",
                "primer_pair_count": 2,
            },
        }
    )

    assert assay["name"] == "mini_derivative_design_workflow"
    assert assay["outcome"] == "passed"
    assert [step["tool"] for step in assay["steps"]] == [
        "create_design",
        "find_features + add_design_region",
        "find_features + add_design_region",
        "draft_design_assembly",
    ]
    assert assay["steps"][3]["evidence"]["drafted_assembly"]["drafted"] is True


def _load_harness_module():
    """Import `apps/api/scripts/agent_mcp_harness.py` as a module via spec."""
    import importlib.util
    import sys
    from pathlib import Path

    here = Path(__file__).resolve().parent
    script = here.parent / "scripts" / "agent_mcp_harness.py"
    spec = importlib.util.spec_from_file_location("agent_mcp_harness", script)
    assert spec is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["agent_mcp_harness"] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _stub_run_mcp_checks_dependencies(monkeypatch, harness):
    """Stub the heavy parts of run_mcp_checks so the test exercises only
    the flag's conditional on external_resources_assays. Patches at the
    bound names inside the harness module (which imports them at startup)."""
    from src.agent_workflow_harness.contract_smoke import ContractSmokeResult

    def fake_run_mcp_contract_smoke(**kwargs):
        return ContractSmokeResult(
            client=None,
            checks=[],
            tool_names=set(),
            workflow_resource={},
            workflow_prepare={},
            artifact_register={"ok": True, "artifact": {"id": "art-stub"}},
            analysis_run={"ok": True, "analysis_run": {"id": "ar-stub"}},
            resource_link={"ok": True, "id": "rl-stub"},
            forwarded_scope=[],
            renderer_audit_id=None,
        )

    def fake_run_mcp_security_rejection_checks(**kwargs):
        return []

    def fake_read_renderer_calls(*args, **kwargs):
        return []

    def fake_read_audit_summary(_db_path):
        return {
            "agent_actions": 2,
            "audit_records": 2,
            "capability_reasons": ["granted", "insufficient_scope"],
            "actor_counts": {"agent": 2},
        }

    monkeypatch.setattr(harness, "run_mcp_contract_smoke", fake_run_mcp_contract_smoke)
    monkeypatch.setattr(
        harness,
        "run_mcp_security_rejection_checks",
        fake_run_mcp_security_rejection_checks,
    )
    monkeypatch.setattr(harness, "read_audit_summary", fake_read_audit_summary)
    monkeypatch.setattr(harness, "read_renderer_calls", fake_read_renderer_calls)


def test_run_mcp_checks_skips_external_assays_by_default(tmp_path, monkeypatch):
    """Default invocation MUST NOT run the external_resources assays.
    Hermetic by default — the live-probe nightly cron explicitly opts in."""
    harness = _load_harness_module()
    _stub_run_mcp_checks_dependencies(monkeypatch, harness)

    called = {"external": False}

    def stub_external(*args, **kwargs):
        called["external"] = True
        return []

    monkeypatch.setattr(
        "src.agent_workflow_harness.external_resources_assays.run_external_resources_assays",
        stub_external,
    )

    checks, _audit, _renderer_calls, assays = harness.run_mcp_checks(
        api_url="http://127.0.0.1:9999",
        renderer_port=9998,
        mcp_token="t-stub",
        renderer_token="r-stub",
        renderer_call_log=tmp_path / "renderer.jsonl",
        db_path=tmp_path / "db.sqlite3",
        desktop_workspace_dir=None,
        desktop_user_data_dir=None,
        temp_dir=tmp_path,
        processes=[],
        timeout=1.0,
        include_external_assays=False,
    )
    assert called["external"] is False
    assay_names = {a["name"] for a in assays}
    assert "external_fetch_smoke" not in assay_names


def test_run_mcp_checks_runs_external_assays_when_flag_on(tmp_path, monkeypatch):
    """`--include-external-assays` flag enables the 4 assays + threads
    the harness's mcp_token as the session token."""
    harness = _load_harness_module()
    _stub_run_mcp_checks_dependencies(monkeypatch, harness)

    captured_token: dict = {}

    def stub_external(*args, **kwargs):
        captured_token["session_token"] = kwargs.get("session_token")
        return [
            {"name": "external_fetch_smoke", "outcome": "passed", "checks": []},
            {"name": "external_xref_smoke", "outcome": "passed", "checks": []},
            {"name": "cache_invalidation_smoke", "outcome": "passed", "checks": []},
            {
                "name": "dna98_resolver_chain_via_sidecar_smoke",
                "outcome": "passed",
                "checks": [],
            },
        ]

    monkeypatch.setattr(
        "src.agent_workflow_harness.external_resources_assays.run_external_resources_assays",
        stub_external,
    )

    checks, _audit, _renderer_calls, assays = harness.run_mcp_checks(
        api_url="http://127.0.0.1:9999",
        renderer_port=9998,
        mcp_token="harness-mcp-session",
        renderer_token="r-stub",
        renderer_call_log=tmp_path / "renderer.jsonl",
        db_path=tmp_path / "db.sqlite3",
        desktop_workspace_dir=None,
        desktop_user_data_dir=None,
        temp_dir=tmp_path,
        processes=[],
        timeout=1.0,
        include_external_assays=True,
    )
    assay_names = {a["name"] for a in assays}
    for name in (
        "external_fetch_smoke",
        "external_xref_smoke",
        "cache_invalidation_smoke",
        "dna98_resolver_chain_via_sidecar_smoke",
    ):
        assert name in assay_names
    assert any("external_resources assay external_fetch_smoke" in c for c in checks)
    assert captured_token["session_token"] == "harness-mcp-session"
