"""Closed-loop MCP assay summaries and deterministic scorers.

These helpers are intentionally independent from process management. The CLI
harness can launch Electron, call MCP tools, and collect observations; this
module only answers whether the tool result and app-owned observations agree.

Naming convention (three roles, one flow):
  * `score_<flow>_closed_loop`            -- pure scorer (this module)
  * `build_closed_loop_<flow>_assay`      -- assay summary builder (this module)
  * `check_desktop_closed_loop_<flow>_flow` -- desktop driver
                                              (in `desktop_workflows.py`)

The completeness sibling test in tests/test_coverage_manifest.py greps for
`def build_closed_loop_*_assay` to ensure every shipped builder has a
manifest row. If you rename the convention, update both that test and the
manifest documentation in `docs/MCP_TOOLFLOW_TRACKER.md`.
"""

from __future__ import annotations

from typing import Any


def build_closed_loop_open_tab_assay(
    flow_result: dict[str, Any],
) -> dict[str, Any]:
    return {
        "name": "closed_loop_open_tab",
        "mode": "desktop",
        "goal": (
            "Prove an agent can open a UI tab through MCP, then use the "
            "app-owned observer to verify the tab actually appears in the "
            "renderer's canvas store and is the active tab."
        ),
        "outcome": flow_result["outcome"],
        "steps": [
            {
                "tool": "observe_app_state",
                "expected_effect": "target tab label is absent before mutation",
                "observer": "MCP observe_app_state",
                "evidence": flow_result["before"],
            },
            {
                "tool": "open_tab",
                "expected_effect": "tool returns a tab id for the requested entity",
                "observer": "tool structured result",
                "evidence": flow_result["tool_result"],
            },
            {
                "tool": "observe_app_state",
                "expected_effect": "target tab is present, active, and matches requested type/entity after mutation",
                "observer": "MCP observe_app_state",
                "evidence": flow_result["after"],
            },
            {
                "tool": "closed_loop.score",
                "expected_effect": "tool result and app-owned observer agree",
                "observer": "harness deterministic scorer",
                "evidence": {
                    "flow_id": flow_result["flow_id"],
                    "checks": flow_result["checks"],
                    "cleanup": flow_result.get("cleanup"),
                },
            },
        ],
    }


def build_closed_loop_create_design_assay(
    flow_result: dict[str, Any],
) -> dict[str, Any]:
    return {
        "name": "closed_loop_create_design",
        "mode": "desktop",
        "goal": (
            "Prove an agent can run a mutating MCP tool, then use an "
            "app-owned observer tool to verify the desktop app actually changed state."
        ),
        "outcome": flow_result["outcome"],
        "steps": [
            {
                "tool": "observe_app_state",
                "expected_effect": "target design label is absent before mutation",
                "observer": "MCP observe_app_state",
                "evidence": flow_result["before"],
            },
            {
                "tool": "create_design",
                "expected_effect": "tool returns a design id and opened design tab",
                "observer": "tool structured result",
                "evidence": flow_result["tool_result"],
            },
            {
                "tool": "observe_app_state",
                "expected_effect": "target design and tab are present after mutation",
                "observer": "MCP observe_app_state",
                "evidence": flow_result["after"],
            },
            {
                "tool": "closed_loop.score",
                "expected_effect": "tool result and app-owned observer agree",
                "observer": "harness deterministic scorer",
                "evidence": {
                    "flow_id": flow_result["flow_id"],
                    "checks": flow_result["checks"],
                    "cleanup": flow_result.get("cleanup"),
                },
            },
        ],
    }


def build_closed_loop_add_design_region_assay(
    flow_result: dict[str, Any],
) -> dict[str, Any]:
    return {
        "name": "closed_loop_add_design_region",
        "mode": "desktop",
        "goal": (
            "Prove an agent can mutate an existing design through MCP, then use "
            "the app-owned observer to verify the design state changed."
        ),
        "outcome": flow_result["outcome"],
        "steps": [
            {
                "tool": "observe_app_state",
                "expected_effect": "target design is present before mutation",
                "observer": "MCP observe_app_state",
                "evidence": flow_result["before"],
            },
            {
                "tool": "add_design_region",
                "expected_effect": "tool returns a region id and incremented region count",
                "observer": "tool structured result",
                "evidence": flow_result["tool_result"],
            },
            {
                "tool": "observe_app_state",
                "expected_effect": "target design region count increased after mutation",
                "observer": "MCP observe_app_state",
                "evidence": flow_result["after"],
            },
            {
                "tool": "closed_loop.score",
                "expected_effect": "tool result and app-owned observer agree",
                "observer": "harness deterministic scorer",
                "evidence": {
                    "flow_id": flow_result["flow_id"],
                    "checks": flow_result["checks"],
                    "expected_region_length": flow_result["expected_region_length"],
                },
            },
        ],
    }


def build_closed_loop_draft_design_assembly_assay(
    flow_result: dict[str, Any],
) -> dict[str, Any]:
    return {
        "name": "closed_loop_draft_design_assembly",
        "mode": "desktop",
        "goal": (
            "Prove an agent can draft an existing design assembly through MCP, "
            "then use the app-owned observer to verify computed assembly state."
        ),
        "outcome": flow_result["outcome"],
        "steps": [
            {
                "tool": "observe_app_state",
                "expected_effect": "target design is draftable before mutation",
                "observer": "MCP observe_app_state",
                "evidence": flow_result["before"],
            },
            {
                "tool": "draft_design_assembly",
                "expected_effect": "tool reports ready assembly with primers and junctions",
                "observer": "tool structured result",
                "evidence": flow_result["tool_result"],
            },
            {
                "tool": "observe_app_state",
                "expected_effect": "target design reports ready assembly after mutation",
                "observer": "MCP observe_app_state",
                "evidence": flow_result["after"],
            },
            {
                "tool": "closed_loop.score",
                "expected_effect": "tool result and app-owned observer agree",
                "observer": "harness deterministic scorer",
                "evidence": {
                    "flow_id": flow_result["flow_id"],
                    "checks": flow_result["checks"],
                },
            },
        ],
    }


def build_closed_loop_import_sequence_assay(
    flow_result: dict[str, Any],
) -> dict[str, Any]:
    return {
        "name": "closed_loop_import_sequence",
        "mode": "desktop",
        "goal": (
            "Prove an agent can import a local sequence through MCP, then use "
            "the app-owned observer to verify the sequence resource and tab appeared."
        ),
        "outcome": flow_result["outcome"],
        "steps": [
            {
                "tool": "observe_app_state",
                "expected_effect": "target sequence is absent before import",
                "observer": "MCP observe_app_state",
                "evidence": flow_result["before"],
            },
            {
                "tool": "import_sequence",
                "expected_effect": "tool imports a sequence file and opens a tab",
                "observer": "tool structured result",
                "evidence": flow_result["tool_result"],
            },
            {
                "tool": "observe_app_state",
                "expected_effect": "target sequence and tab are present after import",
                "observer": "MCP observe_app_state",
                "evidence": flow_result["after"],
            },
            {
                "tool": "resources/read",
                "expected_effect": "canonical sequence resource matches imported file",
                "observer": "MCP waypoint://sequence/{documentId} resource read",
                "evidence": flow_result["resource"],
            },
            {
                "tool": "closed_loop.score",
                "expected_effect": "tool result, observer, and resource read agree",
                "observer": "harness deterministic scorer",
                "evidence": {
                    "flow_id": flow_result["flow_id"],
                    "checks": flow_result["checks"],
                },
            },
        ],
    }


def score_create_design_closed_loop(
    *,
    design_name: str,
    create_result: dict[str, Any],
    before_state: dict[str, Any],
    after_state: dict[str, Any],
) -> dict[str, Any]:
    design_id = create_result.get("designId")
    tab_id = create_result.get("tabId")
    assembly_method = create_result.get("assemblyMethod")

    before_targets = _dict_value(before_state, "targets")
    after_targets = _dict_value(after_state, "targets")
    before_label = _dict_value(before_targets, "label")
    after_label = _dict_value(after_targets, "label")
    after_design_target = _dict_value(after_targets, "design")
    observed_design = _dict_value(after_design_target, "design")
    open_tabs = _list_value(after_design_target, "openTabs")
    matching_open_tab = next(
        (tab for tab in open_tabs if isinstance(tab, dict) and tab.get("id") == tab_id),
        None,
    )
    before_tab_count = _workspace_tab_count(before_state)
    after_tab_count = _workspace_tab_count(after_state)

    checks = [
        _closed_loop_check(
            "target_label_absent_before",
            before_label.get("present") is False,
            {"before_present": before_label.get("present")},
        ),
        _closed_loop_check(
            "tool_returned_design_id",
            isinstance(design_id, str) and bool(design_id),
            {"design_id": design_id},
        ),
        _closed_loop_check(
            "tool_returned_open_tab",
            isinstance(tab_id, str)
            and bool(tab_id)
            and create_result.get("opened") is True,
            {"tab_id": tab_id, "opened": create_result.get("opened")},
        ),
        _closed_loop_check(
            "target_label_present_after",
            after_label.get("present") is True and after_label.get("active") is True,
            {
                "after_present": after_label.get("present"),
                "after_active": after_label.get("active"),
            },
        ),
        _closed_loop_check(
            "target_design_present_after",
            after_design_target.get("present") is True,
            {"after_present": after_design_target.get("present")},
        ),
        _closed_loop_check(
            "observer_matches_design_id",
            observed_design.get("id") == design_id,
            {
                "tool_design_id": design_id,
                "observed_design_id": observed_design.get("id"),
            },
        ),
        _closed_loop_check(
            "observer_matches_design_name",
            observed_design.get("name") == design_name,
            {
                "expected_name": design_name,
                "observed_name": observed_design.get("name"),
            },
        ),
        _closed_loop_check(
            "observer_matches_assembly_method",
            observed_design.get("assemblyMethod") == assembly_method,
            {
                "tool_assembly_method": assembly_method,
                "observed_assembly_method": observed_design.get("assemblyMethod"),
            },
        ),
        _closed_loop_check(
            "observer_reports_new_open_tab",
            matching_open_tab is not None,
            {"tool_tab_id": tab_id, "open_tab_count": len(open_tabs)},
        ),
        _closed_loop_check(
            "workspace_tab_count_increased",
            before_tab_count is not None
            and after_tab_count is not None
            and after_tab_count >= before_tab_count + 1,
            {"before_tab_count": before_tab_count, "after_tab_count": after_tab_count},
        ),
    ]

    return {
        "flow_id": "create_design_state_delta",
        "tool": "create_design",
        "observer": "observe_app_state",
        "target_label": design_name,
        "design_id": design_id,
        "tab_id": tab_id,
        "outcome": _checks_outcome(checks),
        "checks": checks,
        "tool_result": {
            "design_id": design_id,
            "tab_id": tab_id,
            "opened": create_result.get("opened"),
            "assembly_method": assembly_method,
        },
        "before": compact_app_state_observation(before_state),
        "after": compact_app_state_observation(after_state),
    }


def score_import_sequence_closed_loop(
    *,
    target_label: str,
    target_path: str,
    target_absolute_path: str,
    import_result: dict[str, Any],
    before_state: dict[str, Any],
    after_state: dict[str, Any],
    resource_snapshot: dict[str, Any],
) -> dict[str, Any]:
    tab_id = import_result.get("tabId")
    resource_uri = import_result.get("resourceUri")
    before_targets = _dict_value(before_state, "targets")
    after_targets = _dict_value(after_state, "targets")
    before_label = _dict_value(before_targets, "label")
    before_sequence_target = _dict_value(before_targets, "sequence")
    after_label = _dict_value(after_targets, "label")
    after_sequence_target = _dict_value(after_targets, "sequence")
    observed_sequence = _dict_value(after_sequence_target, "sequence")
    open_tabs = _list_value(after_sequence_target, "openTabs")
    matching_open_tab = next(
        (tab for tab in open_tabs if isinstance(tab, dict) and tab.get("id") == tab_id),
        None,
    )
    before_tab_count = _workspace_tab_count(before_state)
    after_tab_count = _workspace_tab_count(after_state)

    checks = [
        _closed_loop_check(
            "target_label_absent_before",
            before_label.get("present") is False,
            {"before_present": before_label.get("present")},
        ),
        _closed_loop_check(
            "target_sequence_absent_before",
            before_sequence_target.get("present") is False,
            {"before_present": before_sequence_target.get("present")},
        ),
        _closed_loop_check(
            "tool_imported_sequence",
            import_result.get("imported") is True,
            {
                "imported": import_result.get("imported"),
                "error": import_result.get("error"),
            },
        ),
        _closed_loop_check(
            "tool_matches_target_path",
            import_result.get("path") == target_path
            and import_result.get("absolutePath") == target_absolute_path,
            {
                "tool_path": import_result.get("path"),
                "target_path": target_path,
                "tool_absolute_path": import_result.get("absolutePath"),
                "target_absolute_path": target_absolute_path,
            },
        ),
        _closed_loop_check(
            "tool_returned_resource_uri",
            isinstance(resource_uri, str)
            and resource_uri.startswith("waypoint://sequence/"),
            {"resource_uri": resource_uri},
        ),
        _closed_loop_check(
            "tool_opened_sequence_tab",
            isinstance(tab_id, str)
            and bool(tab_id)
            and import_result.get("opened") is True,
            {"tab_id": tab_id, "opened": import_result.get("opened")},
        ),
        _closed_loop_check(
            "tool_reported_sequence_content",
            isinstance(import_result.get("length"), int)
            and import_result.get("length") > 0
            and isinstance(import_result.get("featureCount"), int),
            {
                "length": import_result.get("length"),
                "feature_count": import_result.get("featureCount"),
            },
        ),
        _closed_loop_check(
            "target_label_present_after",
            after_label.get("present") is True and after_label.get("active") is True,
            {
                "after_present": after_label.get("present"),
                "after_active": after_label.get("active"),
            },
        ),
        _closed_loop_check(
            "target_sequence_present_after",
            after_sequence_target.get("present") is True,
            {"after_present": after_sequence_target.get("present")},
        ),
        _closed_loop_check(
            "observer_matches_sequence_path",
            observed_sequence.get("path") == target_absolute_path,
            {
                "observed_path": observed_sequence.get("path"),
                "target_absolute_path": target_absolute_path,
            },
        ),
        _closed_loop_check(
            "observer_matches_tool_length",
            observed_sequence.get("length") == import_result.get("length"),
            {
                "tool_length": import_result.get("length"),
                "observed_length": observed_sequence.get("length"),
            },
        ),
        _closed_loop_check(
            "observer_matches_tool_feature_count",
            observed_sequence.get("annotationCount")
            == import_result.get("featureCount"),
            {
                "tool_feature_count": import_result.get("featureCount"),
                "observed_annotation_count": observed_sequence.get("annotationCount"),
            },
        ),
        _closed_loop_check(
            "observer_reports_open_sequence_tab",
            matching_open_tab is not None,
            {"tool_tab_id": tab_id, "open_tab_count": len(open_tabs)},
        ),
        _closed_loop_check(
            "workspace_tab_count_increased",
            before_tab_count is not None
            and after_tab_count is not None
            and after_tab_count >= before_tab_count + 1,
            {"before_tab_count": before_tab_count, "after_tab_count": after_tab_count},
        ),
        _closed_loop_check(
            "resource_read_matches_import",
            resource_snapshot.get("exists") is True
            and resource_snapshot.get("resourceUri") == resource_uri
            and resource_snapshot.get("path") == target_path
            and resource_snapshot.get("length") == import_result.get("length")
            and resource_snapshot.get("featureCount")
            == import_result.get("featureCount"),
            {
                "exists": resource_snapshot.get("exists"),
                "resource_uri": resource_snapshot.get("resourceUri"),
                "path": resource_snapshot.get("path"),
                "length": resource_snapshot.get("length"),
                "feature_count": resource_snapshot.get("featureCount"),
            },
        ),
    ]

    return {
        "flow_id": "import_sequence_state_delta",
        "tool": "import_sequence",
        "observer": "observe_app_state",
        "target_label": target_label,
        "target_path": target_path,
        "target_absolute_path": target_absolute_path,
        "tab_id": tab_id,
        "resource_uri": resource_uri,
        "outcome": _checks_outcome(checks),
        "checks": checks,
        "tool_result": {
            "imported": import_result.get("imported"),
            "path": import_result.get("path"),
            "absolute_path": import_result.get("absolutePath"),
            "resource_uri": resource_uri,
            "name": import_result.get("name"),
            "format": import_result.get("format"),
            "length": import_result.get("length"),
            "feature_count": import_result.get("featureCount"),
            "opened": import_result.get("opened"),
            "tab_id": tab_id,
            "source": import_result.get("source"),
        },
        "before": compact_app_state_observation(before_state),
        "after": compact_app_state_observation(after_state),
        "resource": {
            "resource_uri": resource_snapshot.get("resourceUri"),
            "exists": resource_snapshot.get("exists"),
            "path": resource_snapshot.get("path"),
            "name": resource_snapshot.get("name"),
            "length": resource_snapshot.get("length"),
            "feature_count": resource_snapshot.get("featureCount"),
            "sequence_included": resource_snapshot.get("sequenceIncluded"),
        },
    }


def score_add_design_region_closed_loop(
    *,
    design_id: str,
    expected_region_length: int,
    add_region_result: dict[str, Any],
    before_state: dict[str, Any],
    after_state: dict[str, Any],
) -> dict[str, Any]:
    region_id = add_region_result.get("regionId")
    tool_design_id = add_region_result.get("designId")
    tool_region_count = add_region_result.get("regionCount")
    tool_length = add_region_result.get("length")

    before_design_target = _dict_value(_dict_value(before_state, "targets"), "design")
    after_design_target = _dict_value(_dict_value(after_state, "targets"), "design")
    before_design = _dict_value(before_design_target, "design")
    after_design = _dict_value(after_design_target, "design")
    before_region_count = before_design.get("regionCount")
    after_region_count = after_design.get("regionCount")
    before_version = before_design.get("version")
    after_version = after_design.get("version")
    after_open_tabs = _list_value(after_design_target, "openTabs")

    expected_after_count = (
        before_region_count + 1 if isinstance(before_region_count, int) else None
    )
    checks = [
        _closed_loop_check(
            "target_design_present_before",
            before_design_target.get("present") is True,
            {"before_present": before_design_target.get("present")},
        ),
        _closed_loop_check(
            "observer_has_before_region_count",
            isinstance(before_region_count, int),
            {"before_region_count": before_region_count},
        ),
        _closed_loop_check(
            "tool_returned_region_id",
            isinstance(region_id, str) and bool(region_id),
            {"region_id": region_id},
        ),
        _closed_loop_check(
            "tool_matches_design_id",
            tool_design_id == design_id,
            {"tool_design_id": tool_design_id, "expected_design_id": design_id},
        ),
        _closed_loop_check(
            "tool_region_count_incremented",
            isinstance(tool_region_count, int)
            and tool_region_count == expected_after_count,
            {
                "before_region_count": before_region_count,
                "tool_region_count": tool_region_count,
            },
        ),
        _closed_loop_check(
            "tool_length_matches_expected",
            tool_length == expected_region_length,
            {
                "tool_length": tool_length,
                "expected_region_length": expected_region_length,
            },
        ),
        _closed_loop_check(
            "target_design_present_after",
            after_design_target.get("present") is True,
            {"after_present": after_design_target.get("present")},
        ),
        _closed_loop_check(
            "observer_region_count_incremented",
            isinstance(after_region_count, int)
            and after_region_count == expected_after_count,
            {
                "before_region_count": before_region_count,
                "after_region_count": after_region_count,
            },
        ),
        _closed_loop_check(
            "observer_matches_tool_region_count",
            after_region_count == tool_region_count,
            {
                "tool_region_count": tool_region_count,
                "after_region_count": after_region_count,
            },
        ),
        _closed_loop_check(
            "observer_reports_open_design_tab",
            len(after_open_tabs) > 0,
            {"open_tab_count": len(after_open_tabs)},
        ),
        _closed_loop_check(
            "observer_version_did_not_go_backwards",
            not (isinstance(before_version, int) and isinstance(after_version, int))
            or after_version >= before_version,
            {"before_version": before_version, "after_version": after_version},
        ),
    ]

    return {
        "flow_id": "add_design_region_state_delta",
        "tool": "add_design_region",
        "observer": "observe_app_state",
        "design_id": design_id,
        "region_id": region_id,
        "expected_region_length": expected_region_length,
        "outcome": _checks_outcome(checks),
        "checks": checks,
        "tool_result": {
            "design_id": tool_design_id,
            "region_id": region_id,
            "region_count": tool_region_count,
            "length": tool_length,
            "source_sequence_name": add_region_result.get("sourceSequenceName"),
        },
        "before": compact_app_state_observation(before_state),
        "after": compact_app_state_observation(after_state),
    }


def score_draft_design_assembly_closed_loop(
    *,
    design_id: str,
    draft_result: dict[str, Any],
    before_state: dict[str, Any],
    after_state: dict[str, Any],
) -> dict[str, Any]:
    tool_design_id = draft_result.get("designId")
    tool_region_count = draft_result.get("regionCount")
    tool_assembly_state = draft_result.get("assemblyState")
    tool_primer_pair_count = draft_result.get("primerPairCount")
    tool_homology_region_count = draft_result.get("homologyRegionCount")
    tool_validation_error_count = draft_result.get("validationErrorCount")

    before_design_target = _dict_value(_dict_value(before_state, "targets"), "design")
    after_design_target = _dict_value(_dict_value(after_state, "targets"), "design")
    before_design = _dict_value(before_design_target, "design")
    after_design = _dict_value(after_design_target, "design")
    before_region_count = before_design.get("regionCount")
    before_version = before_design.get("version")
    after_version = after_design.get("version")
    after_open_tabs = _list_value(after_design_target, "openTabs")

    checks = [
        _closed_loop_check(
            "target_design_present_before",
            before_design_target.get("present") is True,
            {"before_present": before_design_target.get("present")},
        ),
        _closed_loop_check(
            "observer_has_draftable_region_count",
            isinstance(before_region_count, int) and before_region_count >= 2,
            {"before_region_count": before_region_count},
        ),
        _closed_loop_check(
            "tool_matches_design_id",
            tool_design_id == design_id,
            {"tool_design_id": tool_design_id, "expected_design_id": design_id},
        ),
        _closed_loop_check(
            "tool_reported_ready_assembly",
            draft_result.get("drafted") is True and tool_assembly_state == "ready",
            {
                "drafted": draft_result.get("drafted"),
                "assembly_state": tool_assembly_state,
            },
        ),
        _closed_loop_check(
            "tool_reported_primers_and_homology",
            isinstance(tool_primer_pair_count, int)
            and tool_primer_pair_count > 0
            and isinstance(tool_homology_region_count, int)
            and tool_homology_region_count > 0,
            {
                "primer_pair_count": tool_primer_pair_count,
                "homology_region_count": tool_homology_region_count,
            },
        ),
        _closed_loop_check(
            "tool_reported_no_validation_errors",
            tool_validation_error_count == 0,
            {"validation_error_count": tool_validation_error_count},
        ),
        _closed_loop_check(
            "target_design_present_after",
            after_design_target.get("present") is True,
            {"after_present": after_design_target.get("present")},
        ),
        _closed_loop_check(
            "observer_matches_ready_assembly",
            after_design.get("assemblyState") == tool_assembly_state == "ready",
            {
                "tool_assembly_state": tool_assembly_state,
                "observed_assembly_state": after_design.get("assemblyState"),
            },
        ),
        _closed_loop_check(
            "observer_matches_region_count",
            after_design.get("regionCount") == tool_region_count == before_region_count,
            {
                "before_region_count": before_region_count,
                "tool_region_count": tool_region_count,
                "observed_region_count": after_design.get("regionCount"),
            },
        ),
        _closed_loop_check(
            "observer_matches_primer_pair_count",
            after_design.get("primerPairCount") == tool_primer_pair_count,
            {
                "tool_primer_pair_count": tool_primer_pair_count,
                "observed_primer_pair_count": after_design.get("primerPairCount"),
            },
        ),
        _closed_loop_check(
            "observer_matches_homology_region_count",
            after_design.get("homologyRegionCount") == tool_homology_region_count,
            {
                "tool_homology_region_count": tool_homology_region_count,
                "observed_homology_region_count": after_design.get(
                    "homologyRegionCount"
                ),
            },
        ),
        _closed_loop_check(
            "observer_matches_validation_error_count",
            after_design.get("validationErrorCount") == tool_validation_error_count,
            {
                "tool_validation_error_count": tool_validation_error_count,
                "observed_validation_error_count": after_design.get(
                    "validationErrorCount"
                ),
            },
        ),
        _closed_loop_check(
            "observer_reports_open_design_tab",
            len(after_open_tabs) > 0,
            {"open_tab_count": len(after_open_tabs)},
        ),
        _closed_loop_check(
            "observer_version_did_not_go_backwards",
            not (isinstance(before_version, int) and isinstance(after_version, int))
            or after_version >= before_version,
            {"before_version": before_version, "after_version": after_version},
        ),
    ]

    return {
        "flow_id": "draft_design_assembly_state_delta",
        "tool": "draft_design_assembly",
        "observer": "observe_app_state",
        "design_id": design_id,
        "outcome": _checks_outcome(checks),
        "checks": checks,
        "tool_result": {
            "design_id": tool_design_id,
            "drafted": draft_result.get("drafted"),
            "assembly_state": tool_assembly_state,
            "region_count": tool_region_count,
            "homology_region_count": tool_homology_region_count,
            "primer_pair_count": tool_primer_pair_count,
            "validation_error_count": tool_validation_error_count,
        },
        "before": compact_app_state_observation(before_state),
        "after": compact_app_state_observation(after_state),
    }


def score_open_tab_closed_loop(
    *,
    target_label: str,
    target_entity_id_request: str,
    target_entity_id_canonical: str,
    target_tab_type: str,
    open_tab_result: dict[str, Any],
    before_state: dict[str, Any],
    after_state: dict[str, Any],
) -> dict[str, Any]:
    """Score the open_tab closed-loop assay.

    `target_entity_id_request` is the workspace-relative path the agent passed
    to `open_tab`. `target_entity_id_canonical` is the absolute form the
    renderer normalizes to when storing the tab in its canvas store. Both
    are required because `observe_app_state` reports the canonical form
    while the agent's request used the relative form. Accepting either as
    a match would hide real bugs (e.g., the renderer storing a wrong
    absolute path); requiring only the relative form would fail every
    real-Electron run because the renderer always canonicalizes.
    """

    tab_id = open_tab_result.get("tabId")

    before_targets = _dict_value(before_state, "targets")
    after_targets = _dict_value(after_state, "targets")
    before_label = _dict_value(before_targets, "label")
    after_label = _dict_value(after_targets, "label")
    after_label_tabs = _list_value(after_label, "tabs")
    matching_after_tab = next(
        (
            tab
            for tab in after_label_tabs
            if isinstance(tab, dict) and tab.get("id") == tab_id
        ),
        None,
    )
    observed_entity_id = (
        matching_after_tab.get("entityId")
        if isinstance(matching_after_tab, dict)
        else None
    )
    before_tab_count = _workspace_tab_count(before_state)
    after_tab_count = _workspace_tab_count(after_state)

    matching_tab_count = sum(
        1
        for tab in after_label_tabs
        if isinstance(tab, dict) and tab.get("id") == tab_id
    )

    checks = [
        _closed_loop_check(
            "target_label_absent_before",
            before_label.get("present") is False,
            {"before_present": before_label.get("present")},
        ),
        _closed_loop_check(
            "tool_returned_tab_id",
            isinstance(tab_id, str) and bool(tab_id),
            {"tab_id": tab_id},
        ),
        _closed_loop_check(
            "target_label_present_after",
            after_label.get("present") is True,
            {"after_present": after_label.get("present")},
        ),
        _closed_loop_check(
            "target_label_active_after",
            after_label.get("active") is True,
            {"after_active": after_label.get("active")},
        ),
        _closed_loop_check(
            "observer_reports_matching_tab",
            matching_after_tab is not None,
            {
                "tool_tab_id": tab_id,
                "after_label_tabs": [
                    tab.get("id") for tab in after_label_tabs if isinstance(tab, dict)
                ],
            },
        ),
        _closed_loop_check(
            "observer_reports_exactly_one_matching_tab",
            matching_tab_count == 1,
            {
                "tool_tab_id": tab_id,
                "matching_tab_count": matching_tab_count,
            },
        ),
        _closed_loop_check(
            "observer_tab_type_matches_request",
            isinstance(matching_after_tab, dict)
            and matching_after_tab.get("type") == target_tab_type,
            {
                "expected_type": target_tab_type,
                "observed_type": (matching_after_tab or {}).get("type"),
            },
        ),
        _closed_loop_check(
            "observer_tab_entity_canonicalized_correctly",
            isinstance(matching_after_tab, dict)
            and matching_after_tab.get("entityId") == target_entity_id_canonical,
            {
                "agent_request_entity_id": target_entity_id_request,
                "expected_canonical_entity_id": target_entity_id_canonical,
                "observed_entity_id": observed_entity_id,
                "matching_after_tab_present": isinstance(matching_after_tab, dict),
            },
        ),
        _closed_loop_check(
            "observer_tab_is_active",
            isinstance(matching_after_tab, dict)
            and matching_after_tab.get("active") is True,
            {"observed_active": (matching_after_tab or {}).get("active")},
        ),
        _closed_loop_check(
            "workspace_tab_count_increased",
            before_tab_count is not None
            and after_tab_count is not None
            and after_tab_count == before_tab_count + 1,
            {"before_tab_count": before_tab_count, "after_tab_count": after_tab_count},
        ),
    ]

    return {
        "flow_id": "open_tab_state_delta",
        "tool": "open_tab",
        "observer": "observe_app_state",
        "target_label": target_label,
        "target_entity_id_request": target_entity_id_request,
        "target_entity_id_canonical": target_entity_id_canonical,
        "target_tab_type": target_tab_type,
        "tab_id": tab_id,
        "outcome": _checks_outcome(checks),
        "checks": checks,
        "tool_result": {
            "tab_id": tab_id,
            "type": target_tab_type,
            "entity_id_request": target_entity_id_request,
        },
        "before": compact_app_state_observation(before_state),
        "after": compact_app_state_observation(after_state),
    }


def compact_app_state_observation(state: dict[str, Any]) -> dict[str, Any]:
    workspace = _dict_value(state, "workspace")
    designs = _dict_value(state, "designs")
    sequences = _dict_value(state, "sequences")
    return {
        "schema_version": state.get("schemaVersion"),
        "workspace": {
            "panel_count": workspace.get("panelCount"),
            "tab_count": workspace.get("tabCount"),
            "focused_panel_id": workspace.get("focusedPanelId"),
        },
        "design_count": designs.get("count"),
        "sequence_count": sequences.get("count"),
        "targets": state.get("targets", {}),
    }


def _checks_outcome(checks: list[dict[str, Any]]) -> str:
    return "passed" if all(check["passed"] for check in checks) else "failed"


def _closed_loop_check(
    name: str, passed: bool, evidence: dict[str, Any]
) -> dict[str, Any]:
    return {"name": name, "passed": bool(passed), "evidence": evidence}


def _dict_value(source: Any, key: str) -> dict[str, Any]:
    if not isinstance(source, dict):
        return {}
    value = source.get(key)
    return value if isinstance(value, dict) else {}


def _list_value(source: Any, key: str) -> list[Any]:
    if not isinstance(source, dict):
        return []
    value = source.get(key)
    return value if isinstance(value, list) else []


def _workspace_tab_count(state: dict[str, Any]) -> int | None:
    workspace = _dict_value(state, "workspace")
    tab_count = workspace.get("tabCount")
    return tab_count if isinstance(tab_count, int) else None
