"""Desktop workflow drivers for the  MCP harness."""

from __future__ import annotations

import json
import sqlite3
import subprocess
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote

from src.agent_workflow_harness.closed_loop import (
    score_add_design_region_closed_loop,
    score_create_design_closed_loop,
    score_draft_design_assembly_closed_loop,
    score_import_sequence_closed_loop,
    score_open_tab_closed_loop,
)
from src.agent_workflow_harness.mcp_calls import (
    call_renderer_tool,
    mcp_tool_error,
    mcp_tool_job_metadata,
    read_mcp_json_resource,
    require_mcp_tool_success,
)
from src.agent_workflow_harness.runtime import HarnessFailure, post_json, request_json, require
from src.agent_workflow_harness.stdio_client import MCPStdioClient, start_mcp_companion


def check_workspace_git_status(
    client: MCPStdioClient, *, timeout: float
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last_result: Any = None
    while time.monotonic() < deadline:
        response = client.request(
            "tools/call",
            {
                "name": "workspace.gitStatus",
                "arguments": {"includeLog": True, "includeDiff": True},
            },
        )
        tool_result = response.get("result")
        if isinstance(tool_result, dict) and tool_result.get("isError") is True:
            error = mcp_tool_error(
                tool_result,
                name="workspace.gitStatus",
                failure_type=HarnessFailure,
            )
            last_result = error
            if error.get("code") == "NO_WORKSPACE":
                time.sleep(0.25)
                continue
            break

        renderer_payload = require_mcp_tool_success(
            tool_result,
            name="workspace.gitStatus",
            failure_type=HarnessFailure,
        )
        job = mcp_tool_job_metadata(
            tool_result,
            name="workspace.gitStatus",
            failure_type=HarnessFailure,
        )
        if renderer_payload.get("ok") is True:
            git_status = renderer_payload.get("result")
            require(
                isinstance(git_status, dict),
                "workspace.gitStatus did not return an object result",
            )
            require(git_status.get("tracked") is True, "workspace is not git-tracked")
            changed_by_path = {
                entry.get("path"): entry.get("status")
                for entry in git_status.get("changedFiles", [])
                if isinstance(entry, dict)
            }
            require(
                changed_by_path.get("notes.md") == "modified",
                f"workspace.gitStatus missed modified file: {git_status}",
            )
            require(
                changed_by_path.get("scratch.txt") == "untracked",
                f"workspace.gitStatus missed untracked file: {git_status}",
            )
            recent_subjects = [
                commit.get("subject")
                for commit in git_status.get("recentCommits", [])
                if isinstance(commit, dict)
            ]
            require(
                "Initial workspace" in recent_subjects,
                f"workspace.gitStatus missed git log: {git_status}",
            )
            diff_stat = git_status.get("diffStat", {})
            require(
                isinstance(diff_stat, dict) and diff_stat.get("filesChanged", 0) >= 1,
                f"workspace.gitStatus missed diff stat: {git_status}",
            )
            return {
                "action_id": job.get("jobId"),
                "tracked": True,
                "changed_files": changed_by_path,
                "recent_commits": recent_subjects[:3],
                "diff_stat": diff_stat,
            }

        last_result = renderer_payload
        break

    raise HarnessFailure(
        f"workspace.gitStatus did not reach mounted workspace: {last_result}"
    )


def check_desktop_reference_workflow(
    *,
    api_url: str,
    renderer_port: int,
    renderer_token: str,
    mcp_token: str,
    desktop_workspace_dir: Path,
    desktop_user_data_dir: Path,
    temp_dir: Path,
    processes: list[subprocess.Popen[Any]],
    timeout: float,
) -> dict[str, Any]:
    proc = start_mcp_companion(
        api_url=api_url,
        session_token=mcp_token,
        agent_identity="harness-workflow-agent",
        capabilities=[
            "read-workspace",
            "read-sequences",
            "modify-tabs",
            "create-entity",
        ],
        stderr_log=temp_dir / "mcp-companion-reference-workflow.log",
    )
    processes.append(proc)
    client = MCPStdioClient(proc, timeout=timeout)
    client.request("initialize", {"protocolVersion": "2024-11-05"})
    client.notify("notifications/initialized", {})

    feature_result = call_renderer_tool(
        client,
        "find_features",
        {"path": "plasmids/pUC19.gb", "query": "AmpR"},
    )
    require(
        feature_result.get("path") == "plasmids/pUC19.gb",
        f"find_features returned the wrong path: {feature_result}",
    )
    require(
        feature_result.get("matchCount", 0) >= 1,
        f"find_features did not find AmpR features: {feature_result}",
    )
    feature_names = [
        feature.get("name")
        for feature in feature_result.get("features", [])
        if isinstance(feature, dict)
    ]
    require(
        any(isinstance(name, str) and "AmpR" in name for name in feature_names),
        f"find_features did not return an AmpR feature: {feature_result}",
    )
    no_match_query = "__dna82_no_such_feature__"
    no_match_feature_result = call_renderer_tool(
        client,
        "find_features",
        {"path": "plasmids/pUC19.gb", "query": no_match_query},
    )
    require(
        no_match_feature_result.get("path") == "plasmids/pUC19.gb",
        f"find_features no-match control returned the wrong path: {no_match_feature_result}",
    )
    require(
        no_match_feature_result.get("matchCount") == 0,
        f"find_features no-match control returned matches: {no_match_feature_result}",
    )
    require(
        no_match_feature_result.get("features") == [],
        f"find_features no-match control did not return an empty list: {no_match_feature_result}",
    )

    reference_result = call_renderer_tool(
        client,
        "create_reference",
        {
            "entityType": "sequence_region",
            "displayLabel": "AmpR promoter",
            "filePath": "plasmids/pUC19.gb",
            "featureName": "AmpR promoter",
        },
    )
    reference_id = reference_result.get("referenceId")
    require(
        isinstance(reference_id, str) and reference_id,
        f"create_reference did not return a reference id: {reference_result}",
    )
    stored_reference = read_desktop_entity_reference(
        desktop_user_data_dir=desktop_user_data_dir,
        reference_id=reference_id,
    )
    require(
        stored_reference is not None,
        f"create_reference returned id but no durable entity_references row: {reference_result}",
    )
    expected_locator = f"git://{desktop_workspace_dir.name}/plasmids/pUC19.gb"
    require(
        stored_reference["locator"] == expected_locator,
        f"create_reference stored wrong locator: {stored_reference}",
    )
    require(
        stored_reference["entity_type"] == "sequence_region",
        f"create_reference stored wrong entity type: {stored_reference}",
    )
    require(
        stored_reference["source"] == "ai" and stored_reference["status"] == "created",
        f"create_reference stored wrong source/status: {stored_reference}",
    )
    deep_link_params = stored_reference.get("deep_link_params")
    require(
        isinstance(deep_link_params, dict)
        and isinstance(deep_link_params.get("start"), int)
        and isinstance(deep_link_params.get("end"), int),
        f"create_reference did not store resolved feature coordinates: {stored_reference}",
    )

    initial_workspace_state = call_renderer_tool(client, "get_workspace", {})
    reference_label = stored_reference["display_label"]
    require(
        not workspace_contains_tab(initial_workspace_state, label=reference_label),
        f"workspace already contained reference tab before navigation: {initial_workspace_state}",
    )
    require(
        not workspace_contains_tab(initial_workspace_state, label="pUC19"),
        f"workspace already contained pUC19 tab before open_tab: {initial_workspace_state}",
    )
    initial_reference_ui = observe_desktop_ui(
        renderer_port=renderer_port,
        renderer_token=renderer_token,
        label=reference_label,
    )
    require(
        initial_reference_ui["target"]["domPresent"] is False,
        f"workspace DOM already contained reference tab before navigation: {initial_reference_ui}",
    )
    initial_ui = observe_desktop_ui(
        renderer_port=renderer_port,
        renderer_token=renderer_token,
        label="pUC19",
    )
    require(
        initial_ui["target"]["domPresent"] is False,
        f"workspace DOM already contained pUC19 tab before open_tab: {initial_ui}",
    )

    reference_navigation = navigate_desktop_reference(
        renderer_port=renderer_port,
        renderer_token=renderer_token,
        reference_id=reference_id,
    )
    navigation_result = reference_navigation["navigation"]
    navigation_tab = navigation_result.get("tab", {})
    require(
        navigation_result.get("created") is True,
        f"reference navigation did not open a new tab: {reference_navigation}",
    )
    require(
        navigation_result.get("tabType") == "sequence",
        f"reference navigation opened wrong tab type: {reference_navigation}",
    )
    require(
        navigation_result.get("entityId")
        == str(desktop_workspace_dir / "plasmids/pUC19.gb"),
        f"reference navigation opened wrong entity: {reference_navigation}",
    )
    pending_view_state = navigation_tab.get("pendingViewState")
    require(
        isinstance(pending_view_state, dict),
        f"reference navigation did not attach pending deep-link state: {reference_navigation}",
    )
    highlight_range = pending_view_state.get("highlightRange")
    require(
        pending_view_state.get("scrollPosition") == deep_link_params["start"]
        and isinstance(highlight_range, dict)
        and highlight_range.get("start") == deep_link_params["start"] - 1
        and highlight_range.get("end") == deep_link_params["end"] - 1,
        f"reference navigation did not preserve deep-link coordinates: {reference_navigation}",
    )
    navigated_workspace_state = call_renderer_tool(client, "get_workspace", {})
    require(
        workspace_contains_tab(navigated_workspace_state, label=reference_label),
        f"reference navigation tab was not visible in workspace state: {navigated_workspace_state}",
    )
    navigated_ui = observe_desktop_ui(
        renderer_port=renderer_port,
        renderer_token=renderer_token,
        label=reference_label,
    )
    require(
        navigated_ui["target"]["domVisible"] is True,
        f"reference navigation tab was not visible in rendered DOM: {navigated_ui}",
    )
    close_reference_result = call_renderer_tool(client, "close_tab", {})
    require(
        close_reference_result.get("closed") is True,
        f"close_tab did not close the reference navigation tab: {close_reference_result}",
    )
    after_reference_close_state = call_renderer_tool(client, "get_workspace", {})
    require(
        not workspace_contains_tab(after_reference_close_state, label=reference_label),
        f"reference navigation tab remained after close: {after_reference_close_state}",
    )

    opened_result = call_renderer_tool(
        client,
        "open_tab",
        {
            "type": "sequence",
            "entityId": "plasmids/pUC19.gb",
            "label": "pUC19",
        },
    )
    require(
        isinstance(opened_result, dict) and opened_result.get("tabId"),
        f"open_tab did not return a tab id: {opened_result}",
    )
    tab_id = opened_result["tabId"]

    workspace_state = call_renderer_tool(client, "get_workspace", {})
    require(
        workspace_contains_tab(workspace_state, label="pUC19"),
        f"opened sequence tab was not visible in workspace state: {workspace_state}",
    )
    opened_ui = observe_desktop_ui(
        renderer_port=renderer_port,
        renderer_token=renderer_token,
        label="pUC19",
    )
    require(
        opened_ui["target"]["domVisible"] is True,
        f"opened sequence tab was not visible in rendered DOM: {opened_ui}",
    )
    require(
        opened_ui["target"]["storePresent"] is True,
        f"opened sequence tab was not present in renderer store snapshot: {opened_ui}",
    )
    listed_resources = client.request("resources/list")["result"].get("resources")
    sequence_resource = first_resource_with_prefix(
        listed_resources, "waypoint://sequence/"
    )
    require(
        sequence_resource is not None,
        f"resources/list did not include an open sequence resource: {listed_resources}",
    )
    sequence_snapshot = read_mcp_json_resource(client, sequence_resource["uri"])
    require(
        sequence_snapshot.get("exists") is True
        and sequence_snapshot.get("length", 0) > 0
        and sequence_snapshot.get("featureCount", 0) > 0,
        f"resources/read returned unexpected sequence state: {sequence_snapshot}",
    )

    close_result = call_renderer_tool(client, "close_tab", {})
    require(
        close_result.get("closed") is True,
        f"close_tab did not close the opened sequence tab: {close_result}",
    )

    closed_workspace_state = call_renderer_tool(client, "get_workspace", {})
    require(
        not workspace_contains_tab(closed_workspace_state, label="pUC19"),
        f"closed sequence tab was still visible: {closed_workspace_state}",
    )
    closed_ui = observe_desktop_ui(
        renderer_port=renderer_port,
        renderer_token=renderer_token,
        label="pUC19",
    )
    require(
        closed_ui["target"]["domPresent"] is False,
        f"closed sequence tab was still visible in rendered DOM: {closed_ui}",
    )

    return {
        "feature_search": {
            "path": feature_result.get("path"),
            "query": "AmpR",
            "match_count": feature_result.get("matchCount", 0),
            "feature_names": feature_names[:5],
            "no_match_control": {
                "query": no_match_query,
                "match_count": no_match_feature_result.get("matchCount"),
                "features_empty": no_match_feature_result.get("features") == [],
            },
        },
        "reference": {
            "reference_id": reference_id,
            "requested_display_label": "AmpR promoter",
            "stored_display_label": stored_reference["display_label"],
            "entity_type": stored_reference["entity_type"],
            "locator": stored_reference["locator"],
            "deep_link_params": deep_link_params,
            "source": stored_reference["source"],
            "status": stored_reference["status"],
            "durable_db_row_found": True,
        },
        "reference_navigation": {
            "opened_via_reference": True,
            "reference_id": reference_id,
            "opened_label": reference_label,
            "opened_tab_id": navigation_result["tabId"],
            "entity_id": navigation_result["entityId"],
            "deep_link_scroll_position": pending_view_state["scrollPosition"],
            "deep_link_highlight_range": highlight_range,
            "dom_visible_after_navigation": True,
            "closed_after_navigation": True,
        },
        "tab": {
            "opened_label": "pUC19",
            "opened_tab_id": tab_id,
            "absent_before_open": True,
            "visible_after_open": True,
            "closed": True,
            "removed_after_close": True,
            "ui_observation": {
                "dom_absent_before_open": True,
                "dom_visible_after_open": True,
                "dom_removed_after_close": True,
                "visible_tab_labels_after_open": opened_ui.get("visibleTabLabels", []),
            },
            "sequence_resource": {
                "resource_uri": sequence_resource["uri"],
                "name": sequence_resource.get("name"),
                "exists": sequence_snapshot.get("exists"),
                "path": sequence_snapshot.get("path"),
                "length": sequence_snapshot.get("length"),
                "feature_count": sequence_snapshot.get("featureCount"),
                "sequence_included": sequence_snapshot.get("sequenceIncluded"),
            },
        },
    }


def read_desktop_entity_reference(
    *, desktop_user_data_dir: Path, reference_id: str
) -> dict[str, Any] | None:
    db_path = desktop_user_data_dir / "dnaforge.db"
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
    try:
        row = conn.execute(
            """
            SELECT id, entity_type, display_label, locator, deep_link_params, source, status
            FROM entity_references
            WHERE id = ?
            """,
            (reference_id,),
        ).fetchone()
    finally:
        conn.close()

    if row is None:
        return None

    deep_link_params = json.loads(row[4]) if row[4] else None
    return {
        "id": row[0],
        "entity_type": row[1],
        "display_label": row[2],
        "locator": row[3],
        "deep_link_params": deep_link_params,
        "source": row[5],
        "status": row[6],
    }


def observe_desktop_ui(
    *,
    renderer_port: int,
    renderer_token: str,
    label: str,
    design_id: str | None = None,
) -> dict[str, Any]:
    query = f"label={quote(label)}"
    if design_id:
        query = f"{query}&designId={quote(design_id)}"
    response = request_json(
        f"http://127.0.0.1:{renderer_port}/__test/ui-observation?{query}",
        method="GET",
        headers={"X-DNAForge-Session": renderer_token},
    )
    require(
        response["status_code"] == 200,
        f"desktop UI observation endpoint failed: {response}",
    )
    body = response["body"]
    require(body.get("ok") is True, f"desktop UI observation returned not-ok: {body}")
    observation = body.get("observation")
    require(
        isinstance(observation, dict),
        f"desktop UI observation returned invalid shape: {body}",
    )
    target = observation.get("target")
    require(
        isinstance(target, dict),
        f"desktop UI observation did not include target label evidence: {body}",
    )
    return observation


def navigate_desktop_reference(
    *, renderer_port: int, renderer_token: str, reference_id: str
) -> dict[str, Any]:
    response = post_json(
        f"http://127.0.0.1:{renderer_port}/__test/reference-navigation",
        {"referenceId": reference_id},
        headers={"X-DNAForge-Session": renderer_token},
    )
    require(
        response["status_code"] == 200,
        f"desktop reference navigation endpoint failed: {response}",
    )
    body = response["body"]
    require(
        body.get("ok") is True,
        f"desktop reference navigation returned not-ok: {body}",
    )
    navigation = body.get("navigation")
    require(
        isinstance(navigation, dict) and navigation.get("ok") is True,
        f"desktop reference navigation returned invalid shape: {body}",
    )
    navigation_result = navigation.get("navigation")
    require(
        isinstance(navigation_result, dict),
        f"desktop reference navigation omitted navigation result: {body}",
    )
    return navigation


def check_desktop_closed_loop_create_design_flow(
    *,
    api_url: str,
    mcp_token: str,
    temp_dir: Path,
    processes: list[subprocess.Popen[Any]],
    timeout: float,
) -> dict[str, Any]:
    proc = start_mcp_companion(
        api_url=api_url,
        session_token=mcp_token,
        agent_identity="harness-closed-loop-agent",
        capabilities=["create-entity", "modify-tabs", "read-workspace"],
        stderr_log=temp_dir / "mcp-companion-closed-loop.log",
    )
    processes.append(proc)
    client = MCPStdioClient(proc, timeout=timeout)
    client.request("initialize", {"protocolVersion": "2024-11-05"})
    client.notify("notifications/initialized", {})

    design_name = "Closed-loop design"
    before_state = call_renderer_tool(
        client,
        "observe_app_state",
        {"targetLabel": design_name},
    )
    create_result = call_renderer_tool(
        client,
        "create_design",
        {"name": design_name, "assemblyMethod": "gibson"},
    )
    design_id = create_result.get("designId")
    require(
        isinstance(design_id, str) and design_id,
        f"create_design did not return a design id: {create_result}",
    )
    after_state = call_renderer_tool(
        client,
        "observe_app_state",
        {"targetLabel": design_name, "targetDesignId": design_id},
    )
    flow_result = score_create_design_closed_loop(
        design_name=design_name,
        create_result=create_result,
        before_state=before_state,
        after_state=after_state,
    )
    failed_checks = [
        check["name"] for check in flow_result["checks"] if check["passed"] is False
    ]
    require(
        not failed_checks,
        f"closed-loop create_design state delta failed {failed_checks}: {flow_result}",
    )

    close_result = call_renderer_tool(client, "close_tab", {})
    require(
        close_result.get("closed") is True,
        f"close_tab did not clean up closed-loop design tab: {close_result}",
    )
    flow_result["cleanup"] = {"closed_after_observation": True}
    return flow_result


def check_desktop_closed_loop_open_tab_flow(
    *,
    api_url: str,
    mcp_token: str,
    desktop_workspace_dir: Path,
    temp_dir: Path,
    processes: list[subprocess.Popen[Any]],
    timeout: float,
) -> dict[str, Any]:
    """: closed-loop assay for the open_tab UI primitive.

    Mirrors the shape of `check_desktop_closed_loop_create_design_flow`:
    observe-before → mutate → observe-after → score → cleanup. Proves the
    UI tab the agent requested is the same tab the renderer's canvas store
    surfaces back through `observe_app_state`, including type, entity, and
    active state.

    Note on entityId normalization: the agent passes a workspace-relative
    path to `open_tab`, but the renderer canonicalizes to an absolute path
    when storing in the canvas store. `observe_app_state` reports the
    canonical form. The scorer must be told both forms — the request the
    agent made AND what the renderer will canonicalize it to — so it can
    cross-check both. (The first real-Electron run of this assay caught
    this divergence on its own; without `desktop_workspace_dir` in the
    driver signature, the L0 fixture-based test silently agreed with the
    request form and the L3 disagreed.)
    """

    proc = start_mcp_companion(
        api_url=api_url,
        session_token=mcp_token,
        agent_identity="harness-open-tab-agent",
        capabilities=["modify-tabs", "read-workspace"],
        stderr_log=temp_dir / "mcp-companion-open-tab.log",
    )
    processes.append(proc)
    client = MCPStdioClient(proc, timeout=timeout)
    client.request("initialize", {"protocolVersion": "2024-11-05"})
    client.notify("notifications/initialized", {})

    target_label = "Closed-loop open_tab"
    target_entity_id_request = "plasmids/pUC19.gb"
    target_entity_id_canonical = str(desktop_workspace_dir / target_entity_id_request)
    target_tab_type = "sequence"

    before_state = call_renderer_tool(
        client,
        "observe_app_state",
        {"targetLabel": target_label},
    )
    open_result = call_renderer_tool(
        client,
        "open_tab",
        {
            "type": target_tab_type,
            "entityId": target_entity_id_request,
            "label": target_label,
        },
    )
    require(
        isinstance(open_result, dict) and open_result.get("tabId"),
        f"open_tab did not return a tab id: {open_result}",
    )
    after_state = call_renderer_tool(
        client,
        "observe_app_state",
        {"targetLabel": target_label},
    )
    flow_result = score_open_tab_closed_loop(
        target_label=target_label,
        target_entity_id_request=target_entity_id_request,
        target_entity_id_canonical=target_entity_id_canonical,
        target_tab_type=target_tab_type,
        open_tab_result=open_result,
        before_state=before_state,
        after_state=after_state,
    )
    failed_checks = [
        check["name"] for check in flow_result["checks"] if check["passed"] is False
    ]
    require(
        not failed_checks,
        f"closed-loop open_tab state delta failed {failed_checks}: {flow_result}",
    )

    close_result = call_renderer_tool(client, "close_tab", {})
    require(
        close_result.get("closed") is True,
        f"close_tab did not clean up closed-loop open_tab: {close_result}",
    )
    flow_result["cleanup"] = {"closed_after_observation": True}
    return flow_result


def check_desktop_closed_loop_import_sequence_flow(
    *,
    api_url: str,
    mcp_token: str,
    desktop_workspace_dir: Path,
    temp_dir: Path,
    processes: list[subprocess.Popen[Any]],
    timeout: float,
) -> dict[str, Any]:
    proc = start_mcp_companion(
        api_url=api_url,
        session_token=mcp_token,
        agent_identity="harness-import-sequence-agent",
        capabilities=[
            "create-entity",
            "modify-tabs",
            "read-sequences",
            "read-workspace",
        ],
        stderr_log=temp_dir / "mcp-companion-import-sequence.log",
    )
    processes.append(proc)
    client = MCPStdioClient(proc, timeout=timeout)
    client.request("initialize", {"protocolVersion": "2024-11-05"})
    client.notify("notifications/initialized", {})

    target_label = "Imported pUC19"
    target_path = "imports/imported-pUC19.gb"
    target_absolute_path = str(desktop_workspace_dir / target_path)
    before_state = call_renderer_tool(
        client,
        "observe_app_state",
        {"targetLabel": target_label, "targetSequencePath": target_absolute_path},
    )
    import_result = call_renderer_tool(
        client,
        "import_sequence",
        {
            "source": {"kind": "local_file", "path": "plasmids/pUC19-clean.gb"},
            "targetPath": target_path,
            "label": target_label,
            "open": True,
        },
    )
    require(
        import_result.get("imported") is True,
        f"import_sequence did not import the target sequence: {import_result}",
    )
    require(
        import_result.get("path") == target_path
        and import_result.get("absolutePath") == target_absolute_path,
        f"import_sequence returned unexpected target metadata: {import_result}",
    )
    resource_uri = import_result.get("resourceUri")
    require(
        isinstance(resource_uri, str)
        and resource_uri.startswith("waypoint://sequence/"),
        f"import_sequence did not return a sequence resource URI: {import_result}",
    )

    after_state = call_renderer_tool(
        client,
        "observe_app_state",
        {"targetLabel": target_label, "targetSequencePath": target_absolute_path},
    )
    resource_snapshot = read_mcp_json_resource(client, resource_uri)
    flow_result = score_import_sequence_closed_loop(
        target_label=target_label,
        target_path=target_path,
        target_absolute_path=target_absolute_path,
        import_result=import_result,
        before_state=before_state,
        after_state=after_state,
        resource_snapshot=resource_snapshot,
    )
    failed_checks = [
        check["name"] for check in flow_result["checks"] if check["passed"] is False
    ]
    require(
        not failed_checks,
        f"closed-loop import_sequence state delta failed {failed_checks}: {flow_result}",
    )

    close_result = call_renderer_tool(client, "close_tab", {})
    require(
        close_result.get("closed") is True,
        f"close_tab did not clean up imported sequence tab: {close_result}",
    )
    flow_result["cleanup"] = {"closed_after_observation": True}
    return flow_result


def check_desktop_design_tool_workflow(
    *,
    api_url: str,
    renderer_port: int,
    renderer_token: str,
    mcp_token: str,
    temp_dir: Path,
    processes: list[subprocess.Popen[Any]],
    timeout: float,
) -> dict[str, Any]:
    proc = start_mcp_companion(
        api_url=api_url,
        session_token=mcp_token,
        agent_identity="harness-design-agent",
        capabilities=[
            "create-entity",
            "modify-tabs",
            "read-workspace",
            "read-sequences",
        ],
        stderr_log=temp_dir / "mcp-companion-design-tool.log",
    )
    processes.append(proc)
    client = MCPStdioClient(proc, timeout=timeout)
    client.request("initialize", {"protocolVersion": "2024-11-05"})
    client.notify("notifications/initialized", {})

    design_name = "Derivative design"
    create_result = call_renderer_tool(
        client,
        "create_design",
        {"name": design_name, "assemblyMethod": "gibson"},
    )
    design_id = create_result.get("designId")
    tab_id = create_result.get("tabId")
    require(
        isinstance(design_id, str) and design_id,
        f"create_design did not return a design id: {create_result}",
    )
    require(
        isinstance(tab_id, str) and tab_id,
        f"create_design did not return a tab id: {create_result}",
    )
    require(
        create_result.get("opened") is True
        and create_result.get("assemblyMethod") == "gibson",
        f"create_design returned unexpected metadata: {create_result}",
    )

    workspace_state = call_renderer_tool(client, "get_workspace", {})
    require(
        workspace_contains_tab(workspace_state, label=design_name),
        f"created design tab was not visible in workspace state: {workspace_state}",
    )
    observation = observe_desktop_ui(
        renderer_port=renderer_port,
        renderer_token=renderer_token,
        label=design_name,
        design_id=design_id,
    )
    require(
        observation["target"]["domVisible"] is True,
        f"created design tab was not visible in rendered DOM: {observation}",
    )
    design_state = observation.get("designState")
    require(
        isinstance(design_state, dict),
        f"created design was not visible in design store: {observation}",
    )
    require(
        design_state.get("id") == design_id
        and design_state.get("name") == design_name
        and design_state.get("assemblyMethod") == "gibson"
        and design_state.get("assemblyState") == "preflight"
        and design_state.get("regionCount") == 0,
        f"created design store state was unexpected: {observation}",
    )

    def find_design_source_feature(query: str) -> tuple[dict[str, Any], dict[str, Any]]:
        search_result = call_renderer_tool(
            client,
            "find_features",
            {"path": "plasmids/pUC19.gb", "query": query},
        )
        matching_features = [
            feature
            for feature in search_result.get("features", [])
            if isinstance(feature, dict)
        ]
        require(
            matching_features,
            f"find_features did not locate design source region {query}: {search_result}",
        )
        feature = matching_features[0]
        require(
            isinstance(feature.get("start"), int)
            and isinstance(feature.get("end"), int),
            f"find_features returned a feature without coordinates: {search_result}",
        )
        return search_result, feature

    feature_search, source_feature = find_design_source_feature("AmpR promoter")
    add_region_before_state = call_renderer_tool(
        client,
        "observe_app_state",
        {"targetDesignId": design_id},
    )

    add_region_result = call_renderer_tool(
        client,
        "add_design_region",
        {
            "designId": design_id,
            "path": "plasmids/pUC19.gb",
            "start": source_feature["start"],
            "end": source_feature["end"],
            "label": source_feature.get("name", "AmpR promoter"),
        },
    )
    require(
        not add_region_result.get("error"),
        f"add_design_region returned an error: {add_region_result}",
    )
    expected_region_length = source_feature["end"] - source_feature["start"] + 1
    require(
        add_region_result.get("designId") == design_id
        and isinstance(add_region_result.get("regionId"), str)
        and add_region_result.get("length") == expected_region_length
        and add_region_result.get("regionCount") == 1,
        f"add_design_region returned unexpected metadata: {add_region_result}",
    )
    add_region_after_state = call_renderer_tool(
        client,
        "observe_app_state",
        {"targetDesignId": design_id},
    )
    closed_loop_add_region = score_add_design_region_closed_loop(
        design_id=design_id,
        expected_region_length=expected_region_length,
        add_region_result=add_region_result,
        before_state=add_region_before_state,
        after_state=add_region_after_state,
    )
    failed_add_region_checks = [
        check["name"]
        for check in closed_loop_add_region["checks"]
        if check["passed"] is False
    ]
    require(
        not failed_add_region_checks,
        "closed-loop add_design_region state delta failed "
        f"{failed_add_region_checks}: {closed_loop_add_region}",
    )

    region_observation = observe_desktop_ui(
        renderer_port=renderer_port,
        renderer_token=renderer_token,
        label=design_name,
        design_id=design_id,
    )
    region_design_state = region_observation.get("designState")
    require(
        isinstance(region_design_state, dict),
        f"design store was not observable after add_design_region: {region_observation}",
    )
    regions = region_design_state.get("regions")
    require(
        isinstance(regions, list) and len(regions) == 1,
        f"design store did not contain one region after add_design_region: {region_observation}",
    )
    observed_region = regions[0]
    require(
        isinstance(observed_region, dict)
        and observed_region.get("id") == add_region_result.get("regionId")
        and observed_region.get("length") == expected_region_length
        and observed_region.get("sourceSequenceName")
        == add_region_result.get("sourceSequenceName"),
        f"observed design region did not match add_design_region result: {region_observation}",
    )

    second_feature_search, second_source_feature = find_design_source_feature(
        "lacZ-alpha"
    )
    second_region_result = call_renderer_tool(
        client,
        "add_design_region",
        {
            "designId": design_id,
            "path": "plasmids/pUC19.gb",
            "start": second_source_feature["start"],
            "end": second_source_feature["end"],
            "label": second_source_feature.get("name", "lacZ-alpha"),
        },
    )
    second_expected_length = (
        second_source_feature["end"] - second_source_feature["start"] + 1
    )
    require(
        second_region_result.get("designId") == design_id
        and isinstance(second_region_result.get("regionId"), str)
        and second_region_result.get("length") == second_expected_length
        and second_region_result.get("regionCount") == 2,
        f"second add_design_region returned unexpected metadata: {second_region_result}",
    )

    draft_before_state = call_renderer_tool(
        client,
        "observe_app_state",
        {"targetDesignId": design_id},
    )
    draft_result = call_renderer_tool(
        client,
        "draft_design_assembly",
        {"designId": design_id},
    )
    require(
        draft_result.get("drafted") is True
        and draft_result.get("assemblyState") == "ready"
        and draft_result.get("regionCount") == 2
        and draft_result.get("primerPairCount", 0) > 0
        and draft_result.get("homologyRegionCount", 0) > 0
        and draft_result.get("validationErrorCount") == 0,
        f"draft_design_assembly returned unexpected metadata: {draft_result}",
    )
    draft_after_state = call_renderer_tool(
        client,
        "observe_app_state",
        {"targetDesignId": design_id},
    )
    closed_loop_draft_assembly = score_draft_design_assembly_closed_loop(
        design_id=design_id,
        draft_result=draft_result,
        before_state=draft_before_state,
        after_state=draft_after_state,
    )
    failed_draft_checks = [
        check["name"]
        for check in closed_loop_draft_assembly["checks"]
        if check["passed"] is False
    ]
    require(
        not failed_draft_checks,
        "closed-loop draft_design_assembly state delta failed "
        f"{failed_draft_checks}: {closed_loop_draft_assembly}",
    )

    draft_observation = observe_desktop_ui(
        renderer_port=renderer_port,
        renderer_token=renderer_token,
        label=design_name,
        design_id=design_id,
    )
    draft_design_state = draft_observation.get("designState")
    require(
        isinstance(draft_design_state, dict),
        f"design store was not observable after draft_design_assembly: {draft_observation}",
    )
    require(
        draft_design_state.get("assemblyState") == "ready"
        and draft_design_state.get("regionCount") == 2
        and draft_design_state.get("primerPairCount", 0) > 0
        and draft_design_state.get("homologyRegionCount", 0) > 0
        and draft_design_state.get("validationErrorCount") == 0,
        f"observed design assembly state was unexpected: {draft_observation}",
    )

    resource_uri = draft_result.get("mutation", {}).get("resourceUri")
    require(
        isinstance(resource_uri, str) and resource_uri,
        f"draft_design_assembly did not return a design resource URI: {draft_result}",
    )
    listed_resources = client.request("resources/list")["result"].get("resources")
    require(
        isinstance(listed_resources, list)
        and any(
            isinstance(resource, dict) and resource.get("uri") == resource_uri
            for resource in listed_resources
        ),
        f"resources/list did not include the open design resource: {listed_resources}",
    )
    resource_snapshot = read_mcp_json_resource(client, resource_uri)
    require(
        resource_snapshot.get("exists") is True
        and resource_snapshot.get("designId") == design_id
        and resource_snapshot.get("assemblyState") == "ready"
        and resource_snapshot.get("regionCount") == 2
        and resource_snapshot.get("primerPairCount", 0) > 0
        and resource_snapshot.get("validationErrorCount") == 0,
        f"resources/read returned unexpected design state: {resource_snapshot}",
    )

    close_result = call_renderer_tool(client, "close_tab", {})
    require(
        close_result.get("closed") is True,
        f"close_tab did not close the created design tab: {close_result}",
    )

    return {
        "design_id": design_id,
        "name": design_name,
        "assembly_method": create_result.get("assemblyMethod"),
        "opened": True,
        "opened_tab_id": tab_id,
        "dom_visible_after_open": True,
        "store_visible_after_create": True,
        "assembly_state": design_state.get("assemblyState"),
        "region_count_after_create": design_state.get("regionCount"),
        "feature_search": feature_search,
        "added_region": add_region_result,
        "closed_loop_add_region": closed_loop_add_region,
        "region_count_after_add": region_design_state.get("regionCount"),
        "observed_region": observed_region,
        "second_feature_search": second_feature_search,
        "second_added_region": second_region_result,
        "drafted_assembly": draft_result,
        "closed_loop_draft_assembly": closed_loop_draft_assembly,
        "observed_assembly": {
            "assembly_state": draft_design_state.get("assemblyState"),
            "region_count": draft_design_state.get("regionCount"),
            "homology_region_count": draft_design_state.get("homologyRegionCount"),
            "primer_pair_count": draft_design_state.get("primerPairCount"),
            "validation_error_count": draft_design_state.get("validationErrorCount"),
        },
        "mcp_resource": {
            "resource_uri": resource_uri,
            "listed": True,
            "listed_resource_count": len(listed_resources),
            "exists": resource_snapshot.get("exists"),
            "design_id": resource_snapshot.get("designId"),
            "assembly_state": resource_snapshot.get("assemblyState"),
            "region_count": resource_snapshot.get("regionCount"),
            "primer_pair_count": resource_snapshot.get("primerPairCount"),
            "validation_error_count": resource_snapshot.get("validationErrorCount"),
        },
        "closed_after_observation": True,
    }


def check_desktop_sequence_changes(
    *,
    api_url: str,
    mcp_token: str,
    temp_dir: Path,
    processes: list[subprocess.Popen[Any]],
    timeout: float,
) -> dict[str, Any]:
    proc = start_mcp_companion(
        api_url=api_url,
        session_token=mcp_token,
        agent_identity="harness-sequence-diff-agent",
        capabilities=["read-sequences"],
        stderr_log=temp_dir / "mcp-companion-sequence-changes.log",
    )
    processes.append(proc)
    client = MCPStdioClient(proc, timeout=timeout)
    client.request("initialize", {"protocolVersion": "2024-11-05"})
    client.notify("notifications/initialized", {})

    changes_result = call_renderer_tool(
        client,
        "get_sequence_changes",
        {"path": "plasmids/pUC19.gb"},
    )
    require(
        changes_result.get("file") == "plasmids/pUC19.gb",
        f"get_sequence_changes returned the wrong file: {changes_result}",
    )
    sequence_changes = changes_result.get("sequenceChanges", {})
    require(
        isinstance(sequence_changes, dict),
        f"get_sequence_changes returned invalid sequenceChanges: {changes_result}",
    )
    require(
        sequence_changes.get("mutations", 0) >= 1,
        f"get_sequence_changes missed the harness mutation: {changes_result}",
    )
    clean_changes_result = call_renderer_tool(
        client,
        "get_sequence_changes",
        {"path": "plasmids/pUC19-clean.gb"},
    )
    require(
        clean_changes_result.get("file") == "plasmids/pUC19-clean.gb",
        f"get_sequence_changes no-change control returned the wrong file: {clean_changes_result}",
    )
    clean_sequence_changes = clean_changes_result.get("sequenceChanges", {})
    require(
        isinstance(clean_sequence_changes, dict),
        f"get_sequence_changes no-change control returned invalid sequenceChanges: {clean_changes_result}",
    )
    require(
        clean_sequence_changes.get("mutations", 0) == 0
        and clean_sequence_changes.get("insertions", 0) == 0
        and clean_sequence_changes.get("deletions", 0) == 0,
        f"get_sequence_changes no-change control reported sequence changes: {clean_changes_result}",
    )
    require(
        clean_changes_result.get("details", []) == [],
        f"get_sequence_changes no-change control returned detail rows: {clean_changes_result}",
    )
    return {
        "file": changes_result.get("file"),
        "mutations": sequence_changes.get("mutations", 0),
        "insertions": sequence_changes.get("insertions", 0),
        "deletions": sequence_changes.get("deletions", 0),
        "detail_count": len(changes_result.get("details", [])),
        "no_change_control": {
            "file": clean_changes_result.get("file"),
            "mutations": clean_sequence_changes.get("mutations", 0),
            "insertions": clean_sequence_changes.get("insertions", 0),
            "deletions": clean_sequence_changes.get("deletions", 0),
            "detail_count": len(clean_changes_result.get("details", [])),
        },
    }


def first_resource_with_prefix(
    resources: Any, uri_prefix: str
) -> dict[str, Any] | None:
    if not isinstance(resources, list):
        return None
    for resource in resources:
        if (
            isinstance(resource, dict)
            and isinstance(resource.get("uri"), str)
            and resource["uri"].startswith(uri_prefix)
        ):
            return resource
    return None


def workspace_contains_tab(workspace_state: Any, *, label: str) -> bool:
    if not isinstance(workspace_state, dict):
        return False
    for panel in workspace_state.get("panels", []):
        if not isinstance(panel, dict):
            continue
        for tab in panel.get("tabs", []):
            if isinstance(tab, dict) and tab.get("label") == label:
                return True
    return False
