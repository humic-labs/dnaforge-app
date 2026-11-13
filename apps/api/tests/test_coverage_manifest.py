"""L0 tests for the  MCP tool-flow coverage manifest loader."""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any

import pytest

from src.agent_workflow_harness.coverage_manifest import (
    COVERAGE_LEVELS,
    COVERAGE_TRIPLE,
    DEMAND_LEVELS,
    FLOW_TYPES,
    IMPLEMENTATION_STATUSES,
    coverage_manifest_path,
    load_coverage_manifest,
    summarize_coverage,
)

_PUBLIC_EXPORT = any(
    (parent / ".dnaforge-public-export").is_file()
    for parent in Path(__file__).resolve().parents
)


def _write_manifest(tmp_path: Path, payload: dict[str, Any]) -> Path:
    """Write a manifest payload under tmp_path with the standard filename."""
    return _write_manifest_at(tmp_path / "toolflow-coverage-manifest.json", payload)


def _write_manifest_at(target_path: Path, payload: dict[str, Any]) -> Path:
    """Write a manifest payload to an explicit path. Use when one test needs
    multiple distinct manifest files in the same tmp_path (e.g., the
    lastDesktopHarnessRun rejection cases)."""
    target_path.write_text(json.dumps(payload), encoding="utf-8")
    return target_path


def _valid_flow(flow_id: str = "demo_flow") -> dict[str, Any]:
    return {
        "id": flow_id,
        "type": "primitive",
        "tool": flow_id,
        "demand": {
            "level": "high",
            "rationale": "test rationale",
        },
        "implementationStatus": "shipped",
        "coverage": {
            "fakeRenderer": {
                "level": "full",
                "evidence": ["path/to/file.py"],
            },
            "realDesktop": {
                "level": "full",
                "evidence": ["path/to/driver.py"],
            },
            "observer": {
                "level": "full",
                "evidence": ["path/to/observer.ts"],
            },
        },
        "knownIssues": [],
        "nextAction": "no action — stable",
    }


def _valid_manifest(flows: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "flows": flows if flows is not None else [_valid_flow()],
    }


def test_real_manifest_loads_and_has_pr87_flows():
    manifest = load_coverage_manifest()

    flow_ids = {flow["id"] for flow in manifest["flows"]}
    pr87_flows = {
        "create_design",
        "import_sequence",
        "add_design_region",
        "draft_design_assembly",
    }
    assert pr87_flows.issubset(flow_ids), (
        f"Coverage requires every baseline flow; missing "
        f"{pr87_flows - flow_ids}"
    )


def test_real_manifest_has_at_least_one_new_flow_with_full_triple():
    manifest = load_coverage_manifest()

    pr87_flows = {
        "create_design",
        "import_sequence",
        "add_design_region",
        "draft_design_assembly",
    }
    new_full_triple = [
        flow
        for flow in manifest["flows"]
        if flow["id"] not in pr87_flows
        and all(flow["coverage"][col]["level"] == "full" for col in COVERAGE_TRIPLE)
    ]
    assert new_full_triple, (
        "Coverage requires an additional flow with "
        "full coverage triple — proves expansion, not just inventory"
    )


def test_real_manifest_path_resolves_to_packages_core():
    path = coverage_manifest_path()
    assert path.is_file()
    assert "agent-tools" in path.parts


def test_loader_rejects_missing_schema_version(tmp_path):
    path = _write_manifest(tmp_path, {"flows": [_valid_flow()]})
    with pytest.raises(RuntimeError, match="unsupported coverage manifest schema"):
        load_coverage_manifest(path)


def test_loader_rejects_wrong_schema_version(tmp_path):
    path = _write_manifest(tmp_path, {"schemaVersion": 2, "flows": [_valid_flow()]})
    with pytest.raises(RuntimeError, match="unsupported coverage manifest schema"):
        load_coverage_manifest(path)


def test_loader_rejects_empty_flows(tmp_path):
    path = _write_manifest(tmp_path, {"schemaVersion": 1, "flows": []})
    with pytest.raises(RuntimeError, match="has no flows"):
        load_coverage_manifest(path)


def test_loader_rejects_malformed_json(tmp_path):
    target = tmp_path / "toolflow-coverage-manifest.json"
    target.write_text("not json {{{", encoding="utf-8")
    with pytest.raises(RuntimeError, match="not valid JSON"):
        load_coverage_manifest(target)


def test_loader_rejects_duplicate_flow_id(tmp_path):
    flow_a = _valid_flow("dup")
    flow_b = _valid_flow("dup")
    path = _write_manifest(tmp_path, _valid_manifest([flow_a, flow_b]))
    with pytest.raises(RuntimeError, match="duplicate flow id: dup"):
        load_coverage_manifest(path)


def test_loader_rejects_unknown_flow_type(tmp_path):
    flow = _valid_flow()
    flow["type"] = "spaceship"
    path = _write_manifest(tmp_path, _valid_manifest([flow]))
    with pytest.raises(RuntimeError, match="invalid type"):
        load_coverage_manifest(path)


def test_loader_rejects_unknown_demand_level(tmp_path):
    flow = _valid_flow()
    flow["demand"]["level"] = "extreme"
    path = _write_manifest(tmp_path, _valid_manifest([flow]))
    with pytest.raises(RuntimeError, match="invalid demand.level"):
        load_coverage_manifest(path)


def test_loader_rejects_blank_demand_rationale(tmp_path):
    flow = _valid_flow()
    flow["demand"]["rationale"] = "   "
    path = _write_manifest(tmp_path, _valid_manifest([flow]))
    with pytest.raises(RuntimeError, match="missing demand.rationale"):
        load_coverage_manifest(path)


def test_loader_rejects_unknown_implementation_status(tmp_path):
    flow = _valid_flow()
    flow["implementationStatus"] = "wip"
    path = _write_manifest(tmp_path, _valid_manifest([flow]))
    with pytest.raises(RuntimeError, match="invalid implementationStatus"):
        load_coverage_manifest(path)


def test_loader_rejects_unknown_coverage_level(tmp_path):
    flow = _valid_flow()
    flow["coverage"]["fakeRenderer"]["level"] = "kinda"
    path = _write_manifest(tmp_path, _valid_manifest([flow]))
    with pytest.raises(RuntimeError, match=r"invalid coverage\.fakeRenderer\.level"):
        load_coverage_manifest(path)


def test_loader_rejects_missing_coverage_column(tmp_path):
    flow = _valid_flow()
    del flow["coverage"]["observer"]
    path = _write_manifest(tmp_path, _valid_manifest([flow]))
    with pytest.raises(RuntimeError, match=r"missing coverage\.observer"):
        load_coverage_manifest(path)


def test_loader_rejects_partial_coverage_without_evidence(tmp_path):
    flow = _valid_flow()
    flow["coverage"]["realDesktop"] = {"level": "partial", "evidence": []}
    path = _write_manifest(tmp_path, _valid_manifest([flow]))
    with pytest.raises(RuntimeError, match="no evidence pointers"):
        load_coverage_manifest(path)


def test_loader_allows_none_coverage_with_empty_evidence(tmp_path):
    flow = _valid_flow()
    flow["coverage"]["realDesktop"] = {"level": "none", "evidence": []}
    path = _write_manifest(tmp_path, _valid_manifest([flow]))
    manifest = load_coverage_manifest(path)
    assert manifest["flows"][0]["coverage"]["realDesktop"]["level"] == "none"


def test_loader_rejects_blank_next_action(tmp_path):
    flow = _valid_flow()
    flow["nextAction"] = ""
    path = _write_manifest(tmp_path, _valid_manifest([flow]))
    with pytest.raises(RuntimeError, match="missing nextAction"):
        load_coverage_manifest(path)


def test_loader_rejects_unknown_issue_kind(tmp_path):
    flow = _valid_flow()
    flow["knownIssues"] = [{"kind": "vibes", "summary": "feels off"}]
    path = _write_manifest(tmp_path, _valid_manifest([flow]))
    with pytest.raises(RuntimeError, match=r"knownIssues\[0\]\.kind"):
        load_coverage_manifest(path)


def test_loader_rejects_known_issue_without_summary(tmp_path):
    flow = _valid_flow()
    flow["knownIssues"] = [{"kind": "flake", "summary": ""}]
    path = _write_manifest(tmp_path, _valid_manifest([flow]))
    with pytest.raises(RuntimeError, match="missing summary"):
        load_coverage_manifest(path)


def test_summarize_counts_full_triple(tmp_path):
    manifest = _valid_manifest(
        [
            _valid_flow("a"),
            _valid_flow("b"),
        ]
    )
    summary = summarize_coverage(manifest)
    assert summary["totalFlows"] == 2
    assert summary["fullTripleCoverage"] == 2
    assert summary["partialTripleCoverage"] == 0
    assert summary["noCoverage"] == 0
    assert summary["byImplementationStatus"]["shipped"] == 2


def test_summarize_distinguishes_partial_from_none():
    flow_full = _valid_flow("full_one")
    flow_partial = _valid_flow("partial_one")
    flow_partial["coverage"]["observer"] = {
        "level": "partial",
        "evidence": ["partial.ts"],
    }
    flow_none = _valid_flow("none_one")
    flow_none["implementationStatus"] = "missing"
    flow_none["coverage"] = {
        "fakeRenderer": {"level": "none", "evidence": []},
        "realDesktop": {"level": "none", "evidence": []},
        "observer": {"level": "none", "evidence": []},
    }
    manifest = _valid_manifest([flow_full, flow_partial, flow_none])

    summary = summarize_coverage(manifest)
    assert summary["totalFlows"] == 3
    assert summary["fullTripleCoverage"] == 1
    assert summary["partialTripleCoverage"] == 1
    assert summary["noCoverage"] == 1
    assert summary["byImplementationStatus"] == {
        "missing": 1,
        "partial": 0,
        "shipped": 2,
    }


def test_summarize_counts_by_type():
    flow_workflow = _valid_flow("a_workflow")
    flow_workflow["type"] = "workflow"
    flow_harness = _valid_flow("a_harness")
    flow_harness["type"] = "harness"
    manifest = _valid_manifest([_valid_flow(), flow_workflow, flow_harness])

    summary = summarize_coverage(manifest)
    assert summary["byType"] == {
        "primitive": 1,
        "workflow": 1,
        "harness": 1,
    }


def test_coverage_levels_are_documented_set():
    assert COVERAGE_LEVELS == frozenset({"none", "partial", "full"})


def test_coverage_triple_has_three_columns_in_canonical_order():
    assert COVERAGE_TRIPLE == ("fakeRenderer", "realDesktop", "observer")


def test_demand_levels_match_spec():
    assert DEMAND_LEVELS == frozenset({"low", "medium", "high", "unknown"})


def test_implementation_statuses_match_spec():
    assert IMPLEMENTATION_STATUSES == frozenset({"missing", "partial", "shipped"})


def test_flow_types_match_spec():
    assert FLOW_TYPES == frozenset({"primitive", "workflow", "harness"})


@pytest.mark.skipif(_PUBLIC_EXPORT, reason="checks files the public export leaves out")
def test_real_manifest_evidence_pointers_exist_at_repo_paths():
    """Every coverage cell with level != none must cite at least one evidence
    pointer that we can read as a path. We don't fully resolve them — Python
    line-anchored pointers like 'apps/.../file.py:142' aren't real files —
    but the file part should resolve under the repo. This catches typos and
    moved files.
    """

    manifest = load_coverage_manifest()
    repo_root = _resolve_repo_root()
    failures: list[str] = []
    for flow in manifest["flows"]:
        for column in COVERAGE_TRIPLE:
            cell = flow["coverage"][column]
            if cell["level"] == "none":
                continue
            for pointer in cell["evidence"]:
                head = pointer.split(":", 1)[0].split(" ", 1)[0]
                if "/" not in head:
                    continue
                top = head.split("/", 1)[0]
                if top not in {
                    "apps",
                    "packages",
                    "tools",
                    "docs",
                    "e2e",
                    "scripts",
                }:
                    continue
                candidate = repo_root / head
                if not candidate.exists():
                    failures.append(
                        f"flow {flow['id']!r} coverage.{column} pointer "
                        f"{pointer!r} -> {candidate} does not exist"
                    )
    assert not failures, "\n".join(failures)


def test_real_manifest_full_triple_count_matches_summary():
    manifest = load_coverage_manifest()
    summary = summarize_coverage(manifest)
    assert (
        summary["fullTripleCoverage"] >= 5
    ), "Coverage requires the baseline flows and an additional fully covered flow"


_POINTER_HEAD = re.compile(
    r"^(?P<path>[\w./\-]+\.\w+)"
    r"(?::(?P<anchor>[\w.]+))?"
    r"(?:\s*\(line\s*(?P<line>\d+)\))?"
)
_REPO_TOP_LEVEL = {"apps", "packages", "tools", "docs", "e2e", "scripts"}
_DRIFT_LINE_WINDOW = 5
_REPO_ROOT_SENTINEL = "pnpm-workspace.yaml"


def _resolve_repo_root() -> Path:
    """Walk up from the test file until we find the repo's root sentinel."""

    for candidate in Path(__file__).resolve().parents:
        if (candidate / _REPO_ROOT_SENTINEL).is_file():
            return candidate
    raise RuntimeError(
        f"could not find {_REPO_ROOT_SENTINEL!r} in any parent of "
        f"{Path(__file__).resolve()}; repo layout may have changed"
    )


def _parse_pointer(pointer: str) -> dict[str, Any] | None:
    """Return {path, anchor?, line?} for path-form pointers; None otherwise."""

    match = _POINTER_HEAD.match(pointer)
    if match is None:
        return None
    path = match.group("path")
    if "/" not in path:
        return None
    if path.split("/", 1)[0] not in _REPO_TOP_LEVEL:
        return None
    anchor = match.group("anchor")
    line = match.group("line")
    parsed: dict[str, Any] = {"path": path}
    if anchor is not None:
        if anchor.isdigit():
            parsed["anchor_line"] = int(anchor)
        else:
            parsed["anchor_identifier"] = anchor
    if line is not None:
        parsed["explicit_line"] = int(line)
    return parsed


def test_pointer_parser_handles_each_documented_form():
    """Lock the grammar — the next test below depends on it."""

    cases = [
        ("apps/api/src/file.py", {"path": "apps/api/src/file.py"}),
        (
            "apps/api/src/file.py:42",
            {"path": "apps/api/src/file.py", "anchor_line": 42},
        ),
        (
            "apps/api/src/file.py:my_function",
            {"path": "apps/api/src/file.py", "anchor_identifier": "my_function"},
        ),
        (
            "apps/api/src/file.py:my_function (line 13)",
            {
                "path": "apps/api/src/file.py",
                "anchor_identifier": "my_function",
                "explicit_line": 13,
            },
        ),
        (
            "apps/api/src/file.py:42 (descriptive note)",
            {"path": "apps/api/src/file.py", "anchor_line": 42},
        ),
        (
            "apps/api/src/file.py (descriptive note)",
            {"path": "apps/api/src/file.py"},
        ),
        ("MCP resource: waypoint://sequence/{documentId}", None),
        ("Scorer asserts observer_matches_design_id", None),
    ]
    for pointer, expected in cases:
        assert _parse_pointer(pointer) == expected, f"failed on: {pointer!r}"


@pytest.mark.skipif(_PUBLIC_EXPORT, reason="checks files the public export leaves out")
def test_real_manifest_evidence_anchors_resolve_inside_their_files():
    """Stronger drift check: for every evidence pointer that names a function
    or line, confirm the cited file actually contains that anchor.

    Catches: someone renames `build_closed_loop_create_design_assay` and forgets
    to update the manifest. The file still exists, but the manifest is now
    lying. This test fails loudly when that happens.
    """

    manifest = load_coverage_manifest()
    repo_root = _resolve_repo_root()
    failures: list[str] = []

    for flow in manifest["flows"]:
        for column in COVERAGE_TRIPLE:
            cell = flow["coverage"][column]
            if cell["level"] == "none":
                continue
            for pointer in cell["evidence"]:
                parsed = _parse_pointer(pointer)
                if parsed is None:
                    continue

                file_path = repo_root / parsed["path"]
                if not file_path.is_file():
                    failures.append(
                        f"{flow['id']!r}.{column}: file does not exist: "
                        f"{parsed['path']} (from {pointer!r})"
                    )
                    continue

                contents = file_path.read_text(encoding="utf-8", errors="replace")
                lines = contents.splitlines()

                anchor_identifier = parsed.get("anchor_identifier")
                if anchor_identifier:
                    identifier_re = re.compile(
                        r"\b" + re.escape(anchor_identifier) + r"\b"
                    )
                    if not identifier_re.search(contents):
                        failures.append(
                            f"{flow['id']!r}.{column}: identifier "
                            f"{anchor_identifier!r} not found (word-boundary "
                            f"match) in {parsed['path']} (from {pointer!r})"
                        )

                anchor_line = parsed.get("anchor_line")
                if anchor_line is not None:
                    if not (1 <= anchor_line <= len(lines)):
                        failures.append(
                            f"{flow['id']!r}.{column}: line {anchor_line} out "
                            f"of range (file has {len(lines)} lines, from "
                            f"{pointer!r})"
                        )

                explicit_line = parsed.get("explicit_line")
                if explicit_line is not None and anchor_identifier:
                    window_lo = max(1, explicit_line - _DRIFT_LINE_WINDOW)
                    window_hi = min(len(lines), explicit_line + _DRIFT_LINE_WINDOW)
                    window = "\n".join(lines[window_lo - 1 : window_hi])
                    window_re = re.compile(r"\b" + re.escape(anchor_identifier) + r"\b")
                    if not window_re.search(window):
                        failures.append(
                            f"{flow['id']!r}.{column}: identifier "
                            f"{anchor_identifier!r} not found (word-boundary "
                            f"match) within ±{_DRIFT_LINE_WINDOW} lines of "
                            f"cited line {explicit_line} in {parsed['path']} "
                            f"(from {pointer!r})"
                        )

    assert not failures, "Evidence pointer drift detected:\n  " + "\n  ".join(failures)


def test_every_closed_loop_assay_in_code_has_a_manifest_row():
    """Completeness sibling test  hole #2 fix).

    The drift catcher above proves manifest rows point at real code. This
    test proves the inverse: every `build_closed_loop_*_assay` function in
    the harness has a corresponding manifest row whose `assayName` matches.

    Without this, someone could ship a sixth closed-loop assay next week
    (e.g., `closed_loop_create_reference`) and silently skip the manifest.
    The next maintainer would have a coverage tracker that quietly
    under-reports.
    """

    repo_root = _resolve_repo_root()
    closed_loop_py = (
        repo_root / "apps/api/src/agent_workflow_harness/closed_loop.py"
    ).read_text(encoding="utf-8")

    assay_name_pattern = re.compile(
        r"^(?:async\s+)?def\s+build_(closed_loop_[a-z_]+)_assay\s*\(",
        re.MULTILINE,
    )
    code_assay_names = set(assay_name_pattern.findall(closed_loop_py))
    assert code_assay_names, (
        "no build_closed_loop_*_assay functions found in closed_loop.py — "
        "either the convention changed (update this test) or the file is "
        "empty (much bigger problem)"
    )

    manifest = load_coverage_manifest()
    manifest_assay_names = {
        flow.get("assayName")
        for flow in manifest["flows"]
        if isinstance(flow.get("assayName"), str)
    }
    assert manifest_assay_names, (
        "no `assayName` keys found in any manifest flow — the JSON schema's "
        "key may have been renamed; this test (and the manifest) need to "
        "move together"
    )

    missing = code_assay_names - manifest_assay_names
    assert not missing, (
        f"closed-loop assays exist in code but are not tracked in the "
        f"coverage manifest: {sorted(missing)}. Add a row to "
        f"packages/core/agent-tools/toolflow-coverage-manifest.json."
    )


def test_loader_accepts_real_manifest_with_last_desktop_harness_run():
    manifest = load_coverage_manifest()
    if _PUBLIC_EXPORT:
        assert "lastDesktopHarnessRun" not in manifest
        return
    last_run = manifest.get("lastDesktopHarnessRun")
    assert isinstance(last_run, dict), "Phase 2 run record missing"
    assert last_run["outcome"] in {"passed", "failed", "partial"}
    assert "closed_loop_open_tab" in last_run["assaysVerified"]
    pr87 = {
        "closed_loop_create_design",
        "closed_loop_import_sequence",
        "closed_loop_add_design_region",
        "closed_loop_draft_design_assembly",
    }
    assert pr87.issubset(set(last_run["assaysVerified"]))


def test_loader_rejects_malformed_last_desktop_harness_run(tmp_path):
    base = _valid_manifest()

    bad_outcome = copy.deepcopy(base)
    bad_outcome["lastDesktopHarnessRun"] = {
        "date": "2026-05-02",
        "outcome": "kinda_ok",
        "assaysVerified": ["closed_loop_create_design"],
    }
    path = _write_manifest_at(tmp_path / "bad_outcome.json", bad_outcome)
    with pytest.raises(RuntimeError, match=r"lastDesktopHarnessRun\.outcome"):
        load_coverage_manifest(path)

    bad_date = copy.deepcopy(base)
    bad_date["lastDesktopHarnessRun"] = {
        "date": "yesterday",
        "outcome": "passed",
        "assaysVerified": ["closed_loop_create_design"],
    }
    path = _write_manifest_at(tmp_path / "bad_date.json", bad_date)
    with pytest.raises(RuntimeError, match=r"lastDesktopHarnessRun\.date"):
        load_coverage_manifest(path)

    empty_assays = copy.deepcopy(base)
    empty_assays["lastDesktopHarnessRun"] = {
        "date": "2026-05-02",
        "outcome": "passed",
        "assaysVerified": [],
    }
    path = _write_manifest_at(tmp_path / "empty_assays.json", empty_assays)
    with pytest.raises(RuntimeError, match=r"assaysVerified must be a non-empty list"):
        load_coverage_manifest(path)


def test_loader_rejects_calendar_invalid_date(tmp_path):
    """fromisoformat catches what string-shape checks would miss."""
    base = _valid_manifest()
    bad = copy.deepcopy(base)
    bad["lastDesktopHarnessRun"] = {
        "date": "2026-99-99",
        "outcome": "passed",
        "assaysVerified": ["closed_loop_create_design"],
    }
    path = _write_manifest_at(tmp_path / "bad_calendar.json", bad)
    with pytest.raises(RuntimeError, match=r"lastDesktopHarnessRun\.date"):
        load_coverage_manifest(path)


def test_loader_allows_manifest_without_last_desktop_harness_run(tmp_path):
    """Field is optional. A fresh manifest with no real-run yet still parses."""
    base = _valid_manifest()
    assert "lastDesktopHarnessRun" not in base
    path = _write_manifest_at(tmp_path / "no_last_run.json", base)
    manifest = load_coverage_manifest(path)
    assert manifest.get("lastDesktopHarnessRun") is None


def test_evidence_anchor_resolver_catches_simulated_drift(tmp_path):
    """Self-test for the resolver: corrupt a known-good pointer and assert
    the test above would actually catch it. If this assertion ever flips, the
    resolver above became too forgiving.
    """

    fake = _valid_flow("drift_demo")
    fake["coverage"]["fakeRenderer"]["evidence"] = [
        "apps/api/src/agent_workflow_harness/closed_loop.py:thisFunctionDoesNotExist123",
    ]
    parsed = _parse_pointer(fake["coverage"]["fakeRenderer"]["evidence"][0])
    assert parsed is not None
    assert parsed["anchor_identifier"] == "thisFunctionDoesNotExist123"

    repo_root = _resolve_repo_root()
    contents = (repo_root / parsed["path"]).read_text(encoding="utf-8")
    assert (
        parsed["anchor_identifier"] not in contents
    ), "Drift catcher would not fire — bad fixture"


def test_real_manifest_value_immutable_under_load():
    """Loader returns a fresh dict; mutating it must not affect later loads."""

    first = load_coverage_manifest()
    snapshot = copy.deepcopy(first)
    first["flows"].append({"id": "tampered"})
    second = load_coverage_manifest()
    assert second == snapshot
