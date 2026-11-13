"""Assay summary builders for the  MCP harness."""

from __future__ import annotations

from typing import Any


def build_fake_renderer_contract_assay(
    *,
    listed_tools: list[str],
    retained_renderer_tools: list[str],
    forwarded_scope: list[str],
    renderer_calls: int,
    workflow_resource: dict[str, Any],
    workflow_prepare: dict[str, Any],
    artifact_register: dict[str, Any],
    analysis_run: dict[str, Any],
    resource_link: dict[str, Any],
) -> dict[str, Any]:
    return {
        "name": "mcp_contract_smoke",
        "mode": "fake_renderer",
        "goal": (
            "Prove the stdio companion can list renderer-backed MCP tools, "
            "call through the sidecar, forward session/scope headers, and stop "
            "unauthorized calls before renderer dispatch."
        ),
        "outcome": "passed",
        "steps": [
            {
                "tool": "tools/list",
                "evidence": {
                    "listed_tools": listed_tools,
                    "retained_renderer_tools": retained_renderer_tools,
                },
            },
            {
                "tool": "resources/read",
                "resource": "waypoint://workflow/manifest",
                "evidence": workflow_resource,
            },
            {
                "tool": "workflow.prepare_run",
                "evidence": workflow_prepare,
            },
            {
                "tool": "artifact.register",
                "resource": artifact_register.get("resource_uri"),
                "evidence": artifact_register,
            },
            {
                "tool": "analysis_run.create",
                "resource": analysis_run.get("resource_uri"),
                "evidence": analysis_run,
            },
            {
                "tool": "resource_link.create",
                "resource": resource_link.get("resource_uri"),
                "evidence": resource_link,
            },
            {
                "tool": "get_workspace",
                "evidence": {
                    "forwarded_scope": forwarded_scope,
                    "renderer_calls": renderer_calls,
                },
            },
            {
                "tool": "echo",
                "negative_case": "insufficient_scope",
                "evidence": {"blocked_before_renderer": True},
            },
            {
                "tool": "get_workspace",
                "negative_case": "bad_session",
                "evidence": {"blocked_before_renderer": True},
            },
        ],
    }


def build_desktop_agent_workflow_assay(
    *,
    renderer_audit_id: str,
    git_status: dict[str, Any],
    reference_workflow: dict[str, Any],
    sequence_changes: dict[str, Any],
) -> dict[str, Any]:
    return {
        "name": "desktop_workspace_review",
        "mode": "desktop",
        "goal": (
            "Prove an agent can use MCP to inspect a real desktop workspace, "
            "find a plasmid feature, create a clickable app reference, open and "
            "close a sequence tab, and verify sequence-level git changes."
        ),
        "outcome": "passed",
        "steps": [
            {
                "tool": "get_workspace",
                "evidence": {"renderer_audit_id": renderer_audit_id},
            },
            {"tool": "workspace.gitStatus", "evidence": git_status},
            {"tool": "find_features", "evidence": reference_workflow["feature_search"]},
            {
                "tool": "create_reference",
                "evidence": reference_workflow["reference"],
            },
            {
                "tool": "reference_navigation",
                "evidence": reference_workflow["reference_navigation"],
            },
            {"tool": "open_tab/close_tab", "evidence": reference_workflow["tab"]},
            {"tool": "get_sequence_changes", "evidence": sequence_changes},
        ],
    }


def build_ui_effect_smoke_assay(tab_workflow: dict[str, Any]) -> dict[str, Any]:
    ui_observation = tab_workflow["ui_observation"]
    return {
        "name": "ui_effect_smoke",
        "mode": "desktop",
        "goal": (
            "Prove UI-bound MCP primitives change desktop app state rather than "
            "only returning successful tool responses."
        ),
        "outcome": "passed",
        "steps": [
            {
                "tool": "open_tab",
                "expected_effect": "sequence tab appears",
                "observer": "desktop_test_ui_observation + get_workspace",
                "evidence": {
                    "opened_label": tab_workflow["opened_label"],
                    "opened_tab_id": tab_workflow["opened_tab_id"],
                    "absent_before_open": tab_workflow["absent_before_open"],
                    "visible_after_open": tab_workflow["visible_after_open"],
                    "dom_absent_before_open": ui_observation["dom_absent_before_open"],
                    "dom_visible_after_open": ui_observation["dom_visible_after_open"],
                    "visible_tab_labels_after_open": ui_observation[
                        "visible_tab_labels_after_open"
                    ],
                },
            },
            {
                "tool": "close_tab",
                "expected_effect": "sequence tab disappears",
                "observer": "desktop_test_ui_observation + get_workspace",
                "evidence": {
                    "closed": tab_workflow["closed"],
                    "removed_after_close": tab_workflow["removed_after_close"],
                    "dom_removed_after_close": ui_observation[
                        "dom_removed_after_close"
                    ],
                },
            },
        ],
    }


def build_design_tool_smoke_assay(design_workflow: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": "design_tool_smoke",
        "mode": "desktop",
        "goal": (
            "Prove an agent can create an actual desktop design workspace, "
            "add source sequence regions, draft assembly, and observe the "
            "changed design store."
        ),
        "outcome": "passed",
        "steps": [
            {
                "tool": "create_design",
                "expected_effect": "new design exists in store and opens as a tab",
                "observer": "desktop_test_ui_observation + design store snapshot",
                "evidence": design_workflow,
            },
            {
                "tool": "add_design_region",
                "expected_effect": "source sequence region is appended to the design",
                "observer": "desktop_test_ui_observation + design store snapshot",
                "evidence": {
                    "feature_search": design_workflow["feature_search"],
                    "added_region": design_workflow["added_region"],
                    "region_count_after_add": design_workflow["region_count_after_add"],
                    "observed_region": design_workflow["observed_region"],
                },
            },
            {
                "tool": "draft_design_assembly",
                "expected_effect": "design has drafted primers and junctions",
                "observer": "desktop_test_ui_observation + design store snapshot",
                "evidence": {
                    "drafted_assembly": design_workflow["drafted_assembly"],
                    "observed_assembly": design_workflow["observed_assembly"],
                },
            },
            {
                "tool": "resources/read",
                "expected_effect": "canonical design resource matches app state",
                "observer": "MCP waypoint://design/{id} resource read",
                "evidence": design_workflow["mcp_resource"],
            },
        ],
    }


def build_mini_design_workflow_assay(design_workflow: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": "mini_derivative_design_workflow",
        "mode": "desktop",
        "goal": (
            "Prove a small user workflow can be composed from MCP primitives: "
            "create a design, locate source features, add two source regions, "
            "and draft assembly primers and junctions."
        ),
        "outcome": "passed",
        "steps": [
            {
                "action": "create design workspace",
                "tool": "create_design",
                "evidence": {
                    "design_id": design_workflow["design_id"],
                    "name": design_workflow["name"],
                    "opened": design_workflow["opened"],
                },
            },
            {
                "action": "add AmpR promoter source region",
                "tool": "find_features + add_design_region",
                "evidence": {
                    "feature_search": design_workflow["feature_search"],
                    "added_region": design_workflow["added_region"],
                },
            },
            {
                "action": "add lacZ-alpha source region",
                "tool": "find_features + add_design_region",
                "evidence": {
                    "feature_search": design_workflow["second_feature_search"],
                    "added_region": design_workflow["second_added_region"],
                },
            },
            {
                "action": "draft assembly",
                "tool": "draft_design_assembly",
                "evidence": {
                    "drafted_assembly": design_workflow["drafted_assembly"],
                    "observed_assembly": design_workflow["observed_assembly"],
                },
            },
        ],
    }
