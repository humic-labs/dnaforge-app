"""Artifact/provenance records for agent-produced external work."""

from __future__ import annotations

import hashlib
import mimetypes
from pathlib import Path
from typing import Any

from .agent_workspace_authority import artifact_workspace_roots
from .control_plane import ControlPlaneStore, get_control_plane_store

ARTIFACT_KINDS = {"file", "directory", "url", "external"}


def register_agent_artifact(
    args: dict[str, Any],
    *,
    agent_identity_id: str,
    action_id: str,
    store: ControlPlaneStore | None = None,
) -> dict[str, Any]:
    """Normalize, validate, and persist an agent artifact registration."""
    store = store or get_control_plane_store()
    normalized = normalize_artifact_args(
        args,
        workspace_roots=artifact_workspace_roots(
            store.get_agent_identity(agent_identity_id)
        ),
    )
    store.ensure_agent_identity(agent_identity_id)
    artifact_id = store.insert_agent_artifact(
        agent_identity_id=agent_identity_id,
        action_id=action_id,
        **normalized,
    )
    artifact = store.get_agent_artifact(artifact_id)
    if artifact is None:
        raise RuntimeError("Artifact registration was not persisted.")
    return {
        "ok": True,
        "artifactId": artifact_id,
        "resourceUri": artifact["resource_uri"],
        "artifact": public_artifact(artifact),
    }


def normalize_artifact_args(
    args: dict[str, Any], *, workspace_roots: list[Path] | None = None
) -> dict[str, Any]:
    kind = args.get("kind")
    if kind not in ARTIFACT_KINDS:
        raise ValueError("kind must be one of: directory, external, file, or url.")

    metadata = _object_arg(args, "metadata")
    provenance = _object_arg(args, "provenance")
    tags = _tags_arg(args)
    description = _string_arg(args, "description")
    source_uri = _string_arg(args, "sourceUri") or _string_arg(args, "source_uri")
    path = None
    size_bytes = None
    sha256 = None
    mime_type = _string_arg(args, "mimeType") or _string_arg(args, "mime_type")

    if kind in {"file", "directory"}:
        path_obj = _resolved_path(args, provenance)
        if workspace_roots is not None and not any(
            path_obj.is_relative_to(root) for root in workspace_roots
        ):
            raise ValueError(
                "Artifact path is outside the grant's approved workspace roots."
            )
        if not path_obj.exists():
            raise FileNotFoundError(f"Artifact path does not exist: {path_obj}")
        if kind == "file" and not path_obj.is_file():
            raise ValueError("file artifacts must point at a regular file.")
        if kind == "directory" and not path_obj.is_dir():
            raise ValueError("directory artifacts must point at a directory.")
        path = str(path_obj)
        if kind == "file":
            size_bytes = path_obj.stat().st_size
            sha256 = _sha256(path_obj)
            if mime_type is None:
                mime_type = mimetypes.guess_type(path_obj.name)[0]
    elif kind == "url":
        if source_uri is None:
            raise ValueError("url artifacts require sourceUri.")
    elif kind == "external" and source_uri is None and not metadata:
        raise ValueError("external artifacts require sourceUri or metadata.")

    name = _string_arg(args, "name") or _default_name(kind, path, source_uri)
    if not name:
        raise ValueError("Artifact name could not be inferred.")

    return {
        "kind": kind,
        "name": name,
        "description": description,
        "path": path,
        "source_uri": source_uri,
        "mime_type": mime_type,
        "size_bytes": size_bytes,
        "sha256": sha256,
        "metadata": metadata,
        "provenance": provenance,
        "tags": tags,
    }


def build_artifact_resource(artifact: dict[str, Any]) -> dict[str, Any]:
    return {
        "exists": True,
        "resourceUri": artifact["resource_uri"],
        "artifact": public_artifact(artifact),
    }


def artifact_resources_from_rows(
    artifacts: list[dict[str, Any]],
) -> list[dict[str, str]]:
    resources: list[dict[str, str]] = []
    for artifact in artifacts:
        resource_uri = artifact.get("resource_uri")
        if not isinstance(resource_uri, str) or not resource_uri:
            continue
        name = artifact.get("name")
        kind = artifact.get("kind")
        description = artifact.get("description")
        resources.append(
            {
                "uri": resource_uri,
                "name": name if isinstance(name, str) and name else resource_uri,
                "description": (
                    description
                    if isinstance(description, str) and description
                    else f"Registered {kind or 'agent'} artifact."
                ),
                "mimeType": "application/json",
            }
        )
    return resources


def public_artifact(artifact: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": artifact.get("id"),
        "kind": artifact.get("kind"),
        "name": artifact.get("name"),
        "description": artifact.get("description"),
        "path": artifact.get("path"),
        "sourceUri": artifact.get("source_uri"),
        "resourceUri": artifact.get("resource_uri"),
        "mimeType": artifact.get("mime_type"),
        "sizeBytes": artifact.get("size_bytes"),
        "sha256": artifact.get("sha256"),
        "metadata": artifact.get("metadata_json"),
        "provenance": artifact.get("provenance_json"),
        "tags": artifact.get("tags_json"),
        "agentIdentityId": artifact.get("agent_identity_id"),
        "actionId": artifact.get("action_id"),
        "createdAt": artifact.get("created_at"),
    }


def _object_arg(args: dict[str, Any], key: str) -> dict[str, Any]:
    value = args.get(key)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"{key} must be a JSON object.")
    return value


def _string_arg(args: dict[str, Any], key: str) -> str | None:
    value = args.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _tags_arg(args: dict[str, Any]) -> list[str]:
    value = args.get("tags")
    if value is None:
        return []
    if not isinstance(value, list) or not all(
        isinstance(item, str) and item.strip() for item in value
    ):
        raise ValueError("tags must be an array of non-empty strings.")
    return [item.strip() for item in value]


def _resolved_path(args: dict[str, Any], provenance: dict[str, Any]) -> Path:
    raw_path = _string_arg(args, "path")
    if raw_path is None:
        raise ValueError("file and directory artifacts require path.")
    path = Path(raw_path).expanduser()
    if path.is_absolute():
        return path.resolve()
    cwd = provenance.get("cwd")
    if isinstance(cwd, str) and cwd.strip():
        base = Path(cwd.strip()).expanduser()
        if base.is_absolute():
            return (base / path).resolve()
    raise ValueError(
        "Use an absolute artifact path or supply an absolute provenance.cwd "
        "for a relative path. The service directory is not the workspace."
    )


def _default_name(kind: str, path: str | None, source_uri: str | None) -> str | None:
    if path:
        return Path(path).name
    if source_uri:
        return source_uri.rstrip("/").rsplit("/", maxsplit=1)[-1] or source_uri
    return kind


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
