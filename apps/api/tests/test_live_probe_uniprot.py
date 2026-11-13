""" / L1 — exit-code contract for the UniProt live probe.

The probe script's exit codes (0 = all assays passed, 1 = any failure,
2 = sidecar boot failed) are the contract `.github/workflows/live-probe-uniprot.yml`
gates the workflow's success on. A regression that swaps the codes would
ship silently because the only existing exerciser is the nightly cron
(not in PR CI). These tests pin the contract directly.

The script boots a uvicorn subprocess in real life. We monkeypatch the
expensive bits (subprocess + health poll + assay run) and only exercise
main()'s control flow.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest


def _load_probe_module():
    """Load `apps/api/scripts/live_probe_uniprot.py` as a module without
    requiring the apps/api/scripts directory to be on sys.path. The script
    is never imported in production — the workflow runs it as `python
    scripts/live_probe_uniprot.py` — so we route around the missing
    package boundary in tests."""
    here = Path(__file__).resolve().parent
    script = here.parent / "scripts" / "live_probe_uniprot.py"
    spec = importlib.util.spec_from_file_location("live_probe_uniprot", script)
    assert spec is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["live_probe_uniprot"] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def probe(monkeypatch):
    mod = _load_probe_module()
    fake_proc = SimpleNamespace(
        terminate=lambda: None,
        wait=lambda timeout=None: 0,
        kill=lambda: None,
    )
    monkeypatch.setattr(mod, "_start_sidecar", lambda *args, **kwargs: fake_proc)
    return mod


def test_main_returns_0_when_all_assays_pass(probe, monkeypatch, capsys):
    monkeypatch.setattr(probe, "_wait_for_health", lambda url, timeout_s=30.0: True)
    fake_assays = [
        {"name": "external_fetch_smoke", "outcome": "passed", "checks": []},
        {"name": "external_xref_smoke", "outcome": "passed", "checks": []},
        {"name": "cache_invalidation_smoke", "outcome": "passed", "checks": []},
        {
            "name": "dna98_resolver_chain_via_sidecar_smoke",
            "outcome": "passed",
            "checks": [],
        },
    ]

    def stub_assays(*args, **kwargs):
        assert kwargs.get("session_token"), "live probe must thread session_token"
        return fake_assays

    monkeypatch.setattr(
        "src.agent_workflow_harness.external_resources_assays.run_external_resources_assays",
        stub_assays,
    )

    rc = probe.main()
    assert rc == 0
    out = capsys.readouterr().out
    import json

    payload = json.loads(out)
    assert payload["ok"] is True
    assert payload["assay_count"] == 4
    assert payload["failure_count"] == 0


def test_main_returns_1_when_any_assay_fails(probe, monkeypatch, capsys):
    monkeypatch.setattr(probe, "_wait_for_health", lambda url, timeout_s=30.0: True)
    monkeypatch.setattr(
        "src.agent_workflow_harness.external_resources_assays.run_external_resources_assays",
        lambda *args, **kwargs: [
            {"name": "external_fetch_smoke", "outcome": "passed", "checks": []},
            {"name": "external_xref_smoke", "outcome": "failed", "checks": []},
        ],
    )

    rc = probe.main()
    assert rc == 1
    payload = __import__("json").loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert payload["failure_count"] == 1


def test_main_returns_2_when_sidecar_does_not_become_healthy(
    probe, monkeypatch, capsys
):
    """Sidecar boot failure (port collision, env misconfiguration, etc.)
    surfaces as exit 2 — distinct from assay failures so the cron
    workflow can branch on the code if needed."""
    monkeypatch.setattr(probe, "_wait_for_health", lambda url, timeout_s=30.0: False)

    rc = probe.main()
    assert rc == 2
    err = capsys.readouterr().err
    assert "FATAL" in err
    assert "did not become healthy" in err


def test_main_returns_2_when_main_py_missing(monkeypatch, tmp_path, capsys):
    """Defensive: if `apps/api/src/main.py` is missing (script run from a
    wrong CWD or a broken checkout), exit 2 rather than crashing."""
    mod = _load_probe_module()
    monkeypatch.setattr(
        mod.Path,
        "exists",
        lambda self: False if str(self).endswith("main.py") else True,
    )
    rc = mod.main()
    assert rc == 2
    err = capsys.readouterr().err
    assert "cannot locate apps/api/src/main.py" in err


def test_probe_inherits_existing_dnaforge_session_token(probe, monkeypatch):
    """When the operator already set DNAFORGE_MCP_SESSION_TOKEN in env
    (e.g., GH Actions secrets), the probe reuses it rather than minting a
    new one. The sidecar subprocess must see the same value the assays
    will send, otherwise check_session 401s every call."""
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", "operator-supplied-token")
    monkeypatch.setattr(probe, "_wait_for_health", lambda url, timeout_s=30.0: True)

    captured: dict[str, Any] = {}

    def stub_start_sidecar(*args, **kwargs):
        captured["session_token"] = kwargs.get("session_token")
        return SimpleNamespace(
            terminate=lambda: None,
            wait=lambda timeout=None: 0,
            kill=lambda: None,
        )

    monkeypatch.setattr(probe, "_start_sidecar", stub_start_sidecar)

    captured_assay: dict[str, Any] = {}

    def stub_assays(*args, **kwargs):
        captured_assay["session_token"] = kwargs.get("session_token")
        return []

    monkeypatch.setattr(
        "src.agent_workflow_harness.external_resources_assays.run_external_resources_assays",
        stub_assays,
    )

    probe.main()
    assert captured["session_token"] == "operator-supplied-token"
    assert captured_assay["session_token"] == "operator-supplied-token"


def test_probe_grants_the_sidecar_the_scopes_the_assays_request(probe, monkeypatch):
    """The sidecar clamps every body-requested scope to its session grant.
    With `DNAFORGE_MCP_GRANT_CAPABILITIES` unset the grant is empty and
    /external/fetch answers 403 for every accession, so the probe reports
    provider drift it never reached the network to see."""
    from src.agent_workflow_harness.external_resources_assays import REQUESTED_CAPABILITIES
    from src.routes.mcp_auth import (
        effective_capabilities_for_session_request,
        parse_capabilities,
    )

    monkeypatch.setattr(probe, "_wait_for_health", lambda url, timeout_s=30.0: True)
    captured: dict[str, Any] = {}

    def stub_start_sidecar(*args, **kwargs):
        captured["grant"] = kwargs.get("grant_capabilities")
        return SimpleNamespace(
            terminate=lambda: None, wait=lambda timeout=None: 0, kill=lambda: None
        )

    monkeypatch.setattr(probe, "_start_sidecar", stub_start_sidecar)
    monkeypatch.setattr(
        "src.agent_workflow_harness.external_resources_assays.run_external_resources_assays",
        lambda *args, **kwargs: [],
    )

    probe.main()
    grant = list(captured["grant"] or [])
    assert set(REQUESTED_CAPABILITIES).issubset(set(grant))

    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", ",".join(grant))
    assert parse_capabilities(",".join(grant)) == grant
    assert set(
        effective_capabilities_for_session_request(list(REQUESTED_CAPABILITIES))
    ) == set(REQUESTED_CAPABILITIES)


def test_start_sidecar_env_carries_the_session_grant(monkeypatch, tmp_path):
    """`_start_sidecar` is where the grant reaches the subprocess. Pin the
    env var name and encoding the sidecar parses."""
    mod = _load_probe_module()
    captured: dict[str, Any] = {}

    class _FakePopen:
        def __init__(self, argv, env=None, stdout=None, stderr=None):
            captured["env"] = env
            captured["stdout"] = stdout

    monkeypatch.setattr(mod.subprocess, "Popen", _FakePopen)
    mod._start_sidecar(
        65535,
        tmp_path / "control-plane.sqlite3",
        tmp_path / "sidecar.log",
        session_token="token",
        grant_capabilities=(
            "external-fetch:annotation",
            "external-fetch:xref-resolution",
        ),
    )
    if captured["stdout"] is not None:
        captured["stdout"].close()
    assert (
        captured["env"]["DNAFORGE_MCP_GRANT_CAPABILITIES"]
        == "external-fetch:annotation,external-fetch:xref-resolution"
    )
