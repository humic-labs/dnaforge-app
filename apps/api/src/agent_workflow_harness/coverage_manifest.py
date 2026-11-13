""" MCP tool-flow coverage manifest loader.

Reads `packages/core/agent-tools/toolflow-coverage-manifest.json` and validates
the shape so coverage-tracking PRs cannot silently break the schema. Mirrors
the validate-on-load pattern used by `load_workflow_manifest` in
`agent_workflows.py`.

This file is intentionally documentation-shaped infrastructure: it loads the
hand-maintained tracker, checks shape, and exits. It does NOT compute coverage
from harness output — coverage classification is a human decision recorded in
the manifest. See `docs/MCP_TOOLFLOW_TRACKER.md` for how to update it.
"""

from __future__ import annotations

import datetime
import json
from pathlib import Path
from typing import Any

from ..agent_manifest_paths import agent_tool_manifest_path

COVERAGE_MANIFEST_FILENAME = "toolflow-coverage-manifest.json"
COVERAGE_LEVELS = frozenset({"none", "partial", "full"})
DEMAND_LEVELS = frozenset({"low", "medium", "high", "unknown"})
IMPLEMENTATION_STATUSES = frozenset({"missing", "partial", "shipped"})
FLOW_TYPES = frozenset({"primitive", "workflow", "harness"})
COVERAGE_TRIPLE = ("fakeRenderer", "realDesktop", "observer")
ISSUE_KINDS = frozenset({"flake", "gap", "bug", "perf"})
DESKTOP_RUN_OUTCOMES = frozenset({"passed", "failed", "partial"})


def coverage_manifest_path() -> Path:
    return agent_tool_manifest_path(COVERAGE_MANIFEST_FILENAME)


def load_coverage_manifest(path: Path | None = None) -> dict[str, Any]:
    """Load and structurally validate the coverage manifest.

    Raises RuntimeError on any shape mismatch so a malformed JSON file is loud
    at import time, never a silent partial read.
    """

    target = path or coverage_manifest_path()
    raw = target.read_text(encoding="utf-8")
    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"coverage manifest is not valid JSON: {target}") from exc

    if not isinstance(manifest, dict):
        raise RuntimeError(f"coverage manifest must be a JSON object: {target}")
    if manifest.get("schemaVersion") != 1:
        raise RuntimeError(
            f"unsupported coverage manifest schema: {target} "
            f"(got {manifest.get('schemaVersion')!r})"
        )

    flows = manifest.get("flows")
    if not isinstance(flows, list) or not flows:
        raise RuntimeError(f"coverage manifest has no flows: {target}")

    seen_ids: set[str] = set()
    known_assay_names: set[str] = set()
    for index, flow in enumerate(flows):
        _validate_flow(flow, index=index, source=target, seen_ids=seen_ids)
        assay_name = flow.get("assayName")
        if isinstance(assay_name, str) and assay_name:
            known_assay_names.add(assay_name)

    last_run = manifest.get("lastDesktopHarnessRun")
    if last_run is not None:
        _validate_last_desktop_harness_run(
            last_run, source=target, known_assay_names=known_assay_names
        )

    return manifest


def _validate_last_desktop_harness_run(
    run: Any, *, source: Path, known_assay_names: set[str]
) -> None:
    """Validate the optional Phase 2 run record.

    Optional field. If present it must have a date (YYYY-MM-DD form), an
    outcome from DESKTOP_RUN_OUTCOMES, and a non-empty assaysVerified list
    of assay name strings. Each entry in assaysVerified must correspond to
    an `assayName` declared in `flows[]` — a manifest cannot claim a run
    verified an assay that the manifest itself does not track.
    """

    where = f"{source}:lastDesktopHarnessRun"
    if not isinstance(run, dict):
        raise RuntimeError(f"lastDesktopHarnessRun must be an object ({where})")

    date = run.get("date")
    if not isinstance(date, str):
        raise RuntimeError(
            f"lastDesktopHarnessRun.date must be a YYYY-MM-DD string "
            f"({where}); got {date!r}"
        )
    try:
        datetime.date.fromisoformat(date)
    except ValueError as exc:
        raise RuntimeError(
            f"lastDesktopHarnessRun.date must be YYYY-MM-DD ({where}); "
            f"got {date!r} ({exc})"
        ) from exc

    outcome = run.get("outcome")
    if outcome not in DESKTOP_RUN_OUTCOMES:
        raise RuntimeError(
            f"lastDesktopHarnessRun.outcome {outcome!r} invalid ({where}); "
            f"expected one of {sorted(DESKTOP_RUN_OUTCOMES)}"
        )

    assays = run.get("assaysVerified")
    if not isinstance(assays, list) or not assays:
        raise RuntimeError(
            f"lastDesktopHarnessRun.assaysVerified must be a non-empty list "
            f"of assay name strings ({where})"
        )
    for index, assay in enumerate(assays):
        if not isinstance(assay, str) or not assay.strip():
            raise RuntimeError(
                f"lastDesktopHarnessRun.assaysVerified[{index}] must be a "
                f"non-empty string ({where}); got {assay!r}"
            )
        if assay not in known_assay_names:
            raise RuntimeError(
                f"lastDesktopHarnessRun.assaysVerified[{index}] {assay!r} is "
                f"not a known assayName from any flow ({where}); known names "
                f"are {sorted(known_assay_names)}"
            )


def _validate_flow(
    flow: Any,
    *,
    index: int,
    source: Path,
    seen_ids: set[str],
) -> None:
    where = f"{source}:flows[{index}]"
    if not isinstance(flow, dict):
        raise RuntimeError(f"flow entry must be an object: {where}")

    flow_id = flow.get("id")
    if not isinstance(flow_id, str) or not flow_id:
        raise RuntimeError(f"flow is missing id: {where}")
    if flow_id in seen_ids:
        raise RuntimeError(f"duplicate flow id: {flow_id} ({where})")
    seen_ids.add(flow_id)

    flow_type = flow.get("type")
    if flow_type not in FLOW_TYPES:
        raise RuntimeError(
            f"flow {flow_id!r} has invalid type {flow_type!r}; expected one of "
            f"{sorted(FLOW_TYPES)} ({where})"
        )

    status = flow.get("implementationStatus")
    if status not in IMPLEMENTATION_STATUSES:
        raise RuntimeError(
            f"flow {flow_id!r} has invalid implementationStatus {status!r}; "
            f"expected one of {sorted(IMPLEMENTATION_STATUSES)} ({where})"
        )

    demand = flow.get("demand")
    if not isinstance(demand, dict):
        raise RuntimeError(f"flow {flow_id!r} is missing demand object ({where})")
    demand_level = demand.get("level")
    if demand_level not in DEMAND_LEVELS:
        raise RuntimeError(
            f"flow {flow_id!r} has invalid demand.level {demand_level!r}; "
            f"expected one of {sorted(DEMAND_LEVELS)} ({where})"
        )
    rationale = demand.get("rationale")
    if not isinstance(rationale, str) or not rationale.strip():
        raise RuntimeError(
            f"flow {flow_id!r} is missing demand.rationale (one-line justification "
            f"is required by the tracker spec) ({where})"
        )

    coverage = flow.get("coverage")
    if not isinstance(coverage, dict):
        raise RuntimeError(f"flow {flow_id!r} is missing coverage object ({where})")
    for column in COVERAGE_TRIPLE:
        cell = coverage.get(column)
        if not isinstance(cell, dict):
            raise RuntimeError(
                f"flow {flow_id!r} is missing coverage.{column} ({where})"
            )
        level = cell.get("level")
        if level not in COVERAGE_LEVELS:
            raise RuntimeError(
                f"flow {flow_id!r} has invalid coverage.{column}.level {level!r}; "
                f"expected one of {sorted(COVERAGE_LEVELS)} ({where})"
            )
        evidence = cell.get("evidence")
        if not isinstance(evidence, list):
            raise RuntimeError(
                f"flow {flow_id!r} is missing coverage.{column}.evidence list ({where})"
            )
        if level != "none" and not evidence:
            raise RuntimeError(
                f"flow {flow_id!r} claims coverage.{column}.level={level!r} but has "
                f"no evidence pointers — partial/full coverage requires at least one "
                f"file/line citation so reviewers can verify ({where})"
            )

    next_action = flow.get("nextAction")
    if not isinstance(next_action, str) or not next_action.strip():
        raise RuntimeError(
            f"flow {flow_id!r} is missing nextAction ({where}); even 'no action — "
            f"stable' is acceptable, but the field cannot be blank"
        )

    known_issues = flow.get("knownIssues", [])
    if not isinstance(known_issues, list):
        raise RuntimeError(f"flow {flow_id!r} knownIssues must be a list ({where})")
    for issue_index, issue in enumerate(known_issues):
        if not isinstance(issue, dict):
            raise RuntimeError(
                f"flow {flow_id!r} knownIssues[{issue_index}] must be an object ({where})"
            )
        kind = issue.get("kind")
        if kind not in ISSUE_KINDS:
            raise RuntimeError(
                f"flow {flow_id!r} knownIssues[{issue_index}].kind {kind!r} invalid; "
                f"expected one of {sorted(ISSUE_KINDS)} ({where})"
            )
        summary = issue.get("summary")
        if not isinstance(summary, str) or not summary.strip():
            raise RuntimeError(
                f"flow {flow_id!r} knownIssues[{issue_index}] is missing summary "
                f"({where})"
            )


def summarize_coverage(manifest: dict[str, Any]) -> dict[str, Any]:
    """Return a coverage rollup suitable for review surfaces.

    Counts flows by implementation status and by full-triple coverage. Cheap
    enough to call on every harness run.
    """

    flows = manifest.get("flows", [])
    by_status: dict[str, int] = dict.fromkeys(IMPLEMENTATION_STATUSES, 0)
    full_triple = 0
    partial_triple = 0
    by_type: dict[str, int] = dict.fromkeys(FLOW_TYPES, 0)

    for flow in flows:
        status = flow.get("implementationStatus")
        if status in by_status:
            by_status[status] += 1
        flow_type = flow.get("type")
        if flow_type in by_type:
            by_type[flow_type] += 1
        coverage = flow.get("coverage", {})
        levels = [coverage.get(col, {}).get("level") for col in COVERAGE_TRIPLE]
        if all(level == "full" for level in levels):
            full_triple += 1
        elif any(level in {"partial", "full"} for level in levels):
            partial_triple += 1

    return {
        "totalFlows": len(flows),
        "byImplementationStatus": by_status,
        "byType": by_type,
        "fullTripleCoverage": full_triple,
        "partialTripleCoverage": partial_triple,
        "noCoverage": len(flows) - full_triple - partial_triple,
    }
