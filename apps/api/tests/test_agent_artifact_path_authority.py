"""Path context uses unchanged repository source bytes, no scientific fixtures."""

import asyncio
import hashlib
from pathlib import Path

import pytest

from src.agent_artifacts import normalize_artifact_args, register_agent_artifact
from src.concurrency.builtins import (
    create_analysis_run_handler,
    create_analysis_run_tool_spec,
)
from src.concurrency.tool_errors import ToolExecutionFailure
from src.concurrency.tool_registry import ToolContext
from src.control_plane import ControlPlaneStore

SOURCE = Path(__file__).resolve().parents[1] / "src" / "agent_artifacts.py"


@pytest.mark.parametrize("cwd", [None, "src"])
def test_relative_path_requires_explicit_absolute_context(monkeypatch, cwd):
    monkeypatch.chdir(SOURCE.parent.parent)
    args = {"kind": "file", "path": "agent_artifacts.py"}
    if cwd is not None:
        args["provenance"] = {"cwd": cwd}
    with pytest.raises(ValueError, match="absolute.*provenance.cwd"):
        normalize_artifact_args(args)


@pytest.mark.parametrize("relative", [False, True])
def test_explicit_context_retains_original_source_bytes(
    monkeypatch, tmp_path, relative
):
    monkeypatch.chdir(tmp_path)
    args = {"kind": "file", "path": str(SOURCE)}
    if relative:
        args.update(path=SOURCE.name, provenance={"cwd": str(SOURCE.parent)})
    result = normalize_artifact_args(args)
    assert result["path"] == str(SOURCE)
    assert result["sha256"] == hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    assert result["size_bytes"] == len(SOURCE.read_bytes())


def test_analysis_artifact_fields_explain_registration_identity():
    fields = create_analysis_run_tool_spec().inputs["properties"]
    for key in ("inputArtifacts", "outputArtifacts"):
        assert "artifact.register" in fields[key]["description"]
        assert "file paths" in fields[key]["description"]


@pytest.mark.parametrize("reference_kind", ["artifactId", "resourceUri"])
def test_analysis_refuses_paths_then_links_actual_registered_bytes(
    monkeypatch, tmp_path, reference_kind
):
    store = ControlPlaneStore(tmp_path / "control.sqlite3")
    store.initialize()
    store.ensure_agent_identity("source-byte-check")
    action_id = store.insert_agent_action(
        agent_identity_id="source-byte-check",
        tool_name="analysis_run.create",
        parameters={},
    )
    monkeypatch.setattr(
        "src.agent_analysis_runs.get_control_plane_store", lambda: store
    )
    context = ToolContext(
        job_id=action_id,
        agent_identity_id="source-byte-check",
        agent_capabilities=[],
        cancel_event=asyncio.Event(),
    )
    try:
        before = store.list_agent_analysis_runs()
        with pytest.raises(ToolExecutionFailure) as refused:
            asyncio.run(
                create_analysis_run_handler({"inputArtifacts": [str(SOURCE)]}, context)
            )
        assert refused.value.code == "INVALID_ANALYSIS_INPUT"
        assert refused.value.retriable is False
        assert refused.value.details == {"stateChanged": False}
        assert "artifact.register" in refused.value.message
        assert store.list_agent_analysis_runs() == before

        registered = register_agent_artifact(
            {"kind": "file", "path": str(SOURCE)},
            agent_identity_id=context.agent_identity_id,
            action_id=action_id,
            store=store,
        )
        assert (
            registered["artifact"]["sha256"]
            == hashlib.sha256(SOURCE.read_bytes()).hexdigest()
        )
        result = asyncio.run(
            create_analysis_run_handler(
                {"inputArtifacts": [registered[reference_kind]], "status": "planned"},
                context,
            )
        )
        assert result["ok"] is True
        assert (
            result["analysisRun"]["inputs"][0]["artifactId"] == registered["artifactId"]
        )
        assert len(store.list_agent_analysis_runs()) == len(before) + 1
    finally:
        store.close()
