"""Analysis-run records that group external work and app artifacts."""

from __future__ import annotations

from typing import Any

from .control_plane import ControlPlaneStore, get_control_plane_store

ANALYSIS_RUN_STATUSES = {"planned", "running", "completed", "failed", "canceled"}


def register_agent_analysis_run(
    args: dict[str, Any],
    *,
    agent_identity_id: str,
    action_id: str,
    store: ControlPlaneStore | None = None,
) -> dict[str, Any]:
    """Persist a provenance envelope for command-line or external analysis work."""
    store = store or get_control_plane_store()
    normalized = normalize_analysis_run_args(
        args, store=store, agent_identity_id=agent_identity_id
    )
    store.ensure_agent_identity(agent_identity_id)
    analysis_run_id = store.insert_agent_analysis_run(
        agent_identity_id=agent_identity_id,
        action_id=action_id,
        **normalized,
    )
    analysis_run = store.get_agent_analysis_run(analysis_run_id)
    if analysis_run is None:
        raise RuntimeError("Analysis run registration was not persisted.")
    return {
        "ok": True,
        "analysisRunId": analysis_run_id,
        "resourceUri": analysis_run["resource_uri"],
        "analysisRun": public_analysis_run(analysis_run),
    }


def normalize_analysis_run_args(
    args: dict[str, Any],
    *,
    store: ControlPlaneStore | None = None,
    agent_identity_id: str | None = None,
) -> dict[str, Any]:
    status = _string_arg(args, "status") or "completed"
    if status not in ANALYSIS_RUN_STATUSES:
        raise ValueError(
            "status must be one of: canceled, completed, failed, planned, or running."
        )
    store = store or get_control_plane_store()

    command = _command_arg(args.get("command"))
    name = _string_arg(args, "name") or _name_from_command(command)
    if not name:
        raise ValueError("Analysis run name could not be inferred.")

    inputs = _record_list_arg(args, "inputs")
    outputs = _record_list_arg(args, "outputs")
    inputs.extend(_artifact_refs_arg(args, "inputArtifacts", store, agent_identity_id))
    inputs.extend(_artifact_refs_arg(args, "input_artifacts", store, agent_identity_id))
    outputs.extend(
        _artifact_refs_arg(args, "outputArtifacts", store, agent_identity_id)
    )
    outputs.extend(
        _artifact_refs_arg(args, "output_artifacts", store, agent_identity_id)
    )

    return {
        "name": name,
        "status": status,
        "command": command,
        "cwd": _string_arg(args, "cwd"),
        "inputs": inputs,
        "outputs": outputs,
        "metrics": _object_arg(args, "metrics"),
        "metadata": _object_arg(args, "metadata"),
        "started_at": _string_arg(args, "startedAt") or _string_arg(args, "started_at"),
        "completed_at": _string_arg(args, "completedAt")
        or _string_arg(args, "completed_at"),
    }


def build_analysis_run_resource(analysis_run: dict[str, Any]) -> dict[str, Any]:
    return {
        "exists": True,
        "resourceUri": analysis_run["resource_uri"],
        "analysisRun": public_analysis_run(analysis_run),
    }


def analysis_run_resources_from_rows(
    analysis_runs: list[dict[str, Any]],
) -> list[dict[str, str]]:
    resources: list[dict[str, str]] = []
    for analysis_run in analysis_runs:
        resource_uri = analysis_run.get("resource_uri")
        if not isinstance(resource_uri, str) or not resource_uri:
            continue
        name = analysis_run.get("name")
        status = analysis_run.get("status")
        resources.append(
            {
                "uri": resource_uri,
                "name": name if isinstance(name, str) and name else resource_uri,
                "description": f"Registered analysis run ({status or 'unknown'}).",
                "mimeType": "application/json",
            }
        )
    return resources


def public_analysis_run(analysis_run: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": analysis_run.get("id"),
        "name": analysis_run.get("name"),
        "status": analysis_run.get("status"),
        "resourceUri": analysis_run.get("resource_uri"),
        "command": analysis_run.get("command_json"),
        "cwd": analysis_run.get("cwd"),
        "inputs": analysis_run.get("inputs_json"),
        "outputs": analysis_run.get("outputs_json"),
        "metrics": analysis_run.get("metrics_json"),
        "metadata": analysis_run.get("metadata_json"),
        "agentIdentityId": analysis_run.get("agent_identity_id"),
        "actionId": analysis_run.get("action_id"),
        "startedAt": analysis_run.get("started_at"),
        "completedAt": analysis_run.get("completed_at"),
        "createdAt": analysis_run.get("created_at"),
    }


def _command_arg(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, str) and value.strip():
        return {"line": value.strip()}
    if isinstance(value, list) and all(
        isinstance(item, str) and item.strip() for item in value
    ):
        return {"argv": [item.strip() for item in value]}
    if isinstance(value, dict):
        return value
    raise ValueError("command must be a string, string array, or JSON object.")


def _object_arg(args: dict[str, Any], key: str) -> dict[str, Any]:
    value = args.get(key)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"{key} must be a JSON object.")
    return value


def _record_list_arg(args: dict[str, Any], key: str) -> list[dict[str, Any]]:
    value = args.get(key)
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"{key} must be an array.")
    records: list[dict[str, Any]] = []
    for item in value:
        if isinstance(item, dict):
            records.append(item)
        elif isinstance(item, str) and item.strip():
            records.append({"uri": item.strip()})
        else:
            raise ValueError(f"{key} entries must be objects or non-empty strings.")
    return records


def _artifact_refs_arg(
    args: dict[str, Any],
    key: str,
    store: ControlPlaneStore,
    agent_identity_id: str | None,
) -> list[dict[str, Any]]:
    value = args.get(key)
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"{key} must be an array.")
    return [_artifact_ref(item, store, agent_identity_id) for item in value]


def _artifact_ref(
    value: Any, store: ControlPlaneStore, agent_identity_id: str | None
) -> dict[str, Any]:
    artifact_id = None
    if isinstance(value, str) and value.strip():
        artifact_id = _artifact_id_from_uri_or_id(value.strip())
    elif isinstance(value, dict):
        raw = (
            value.get("artifactId")
            or value.get("artifact_id")
            or value.get("resourceUri")
        )
        if isinstance(raw, str) and raw.strip():
            artifact_id = _artifact_id_from_uri_or_id(raw.strip())
    if artifact_id is None:
        raise ValueError("artifact references must include an id or resource URI.")

    artifact = store.get_agent_artifact(artifact_id)
    if artifact is None or (
        agent_identity_id is not None
        and artifact.get("agent_identity_id") != agent_identity_id
    ):
        raise ValueError(
            "Unknown artifact reference. Use the artifactId or "
            "resourceUri returned by artifact.register; file paths are not "
            "registered artifact references."
        )
    return {
        "kind": "artifact",
        "artifactId": artifact_id,
        "resourceUri": artifact["resource_uri"],
        "name": artifact["name"],
    }


def _artifact_id_from_uri_or_id(value: str) -> str:
    prefix = "waypoint://artifact/"
    if value.startswith(prefix):
        return value.removeprefix(prefix)
    return value


def _name_from_command(command: dict[str, Any]) -> str:
    line = command.get("line")
    if isinstance(line, str) and line:
        return line.split(maxsplit=1)[0]
    argv = command.get("argv")
    if isinstance(argv, list) and argv and isinstance(argv[0], str):
        return argv[0]
    return "Analysis run"


def _string_arg(args: dict[str, Any], key: str) -> str | None:
    value = args.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None
