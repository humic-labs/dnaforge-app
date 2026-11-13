import json
import os
import subprocess
import sys

import pytest

from src.capability_policy import has_required_capabilities


def test_write_workspace_implies_edit_primers_for_legacy_grants():
    assert has_required_capabilities(["write-workspace"], ["edit-primers"])
    assert has_required_capabilities(["write-workspace"], ["edit-protocols"])


def test_edit_primers_does_not_imply_general_workspace_writes():
    assert not has_required_capabilities(["edit-primers"], ["write-workspace"])


def test_unrelated_capability_does_not_authorize_primer_edits():
    assert not has_required_capabilities(["read-workspace"], ["edit-primers"])


def test_edit_protocols_does_not_imply_general_workspace_writes():
    assert not has_required_capabilities(["edit-protocols"], ["write-workspace"])


def test_configured_packaged_policy_is_authoritative(tmp_path):
    policy = {
        "schemaVersion": 1,
        "wildcardCapability": "*",
        "implications": {"write-workspace": ["edit-protocols"]},
    }
    (tmp_path / "capability-policy.json").write_text(json.dumps(policy))
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            'from src.capability_policy import has_required_capabilities as check; print(check(["write-workspace"], ["edit-primers"]), check(["write-workspace"], ["edit-protocols"]))',
        ],
        env={**os.environ, "DNAFORGE_AGENT_TOOLS_DIR": str(tmp_path)},
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.strip() == "False True"


@pytest.mark.parametrize(
    "policy",
    [
        None,
        {"schemaVersion": 2, "wildcardCapability": "*", "implications": {}},
        {"schemaVersion": True, "wildcardCapability": "*", "implications": {}},
        {"schemaVersion": 1, "wildcardCapability": "all", "implications": {}},
        {"schemaVersion": 1, "wildcardCapability": "*", "implications": []},
        {
            "schemaVersion": 1,
            "wildcardCapability": "*",
            "implications": {"edit-primers": ["*"]},
        },
        {
            "schemaVersion": 1,
            "wildcardCapability": "*",
            "implications": {"edit-primers": "write-workspace"},
        },
    ],
)
def test_missing_or_invalid_packaged_policy_cannot_fall_back_to_source(
    tmp_path, policy
):
    if policy is not None:
        (tmp_path / "capability-policy.json").write_text(json.dumps(policy))
    result = subprocess.run(
        [sys.executable, "-c", "import src.capability_policy"],
        env={**os.environ, "DNAFORGE_AGENT_TOOLS_DIR": str(tmp_path)},
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "RuntimeError" in result.stderr
