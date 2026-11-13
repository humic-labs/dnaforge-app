"""Resource links that connect agent outputs to app/project objects."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from .control_plane import ControlPlaneStore, get_control_plane_store


def register_agent_resource_link(
    args: dict[str, Any],
    *,
    agent_identity_id: str,
    action_id: str,
    store: ControlPlaneStore | None = None,
) -> dict[str, Any]:
    """Persist a typed edge between two DNAForge resources."""
    store = store or get_control_plane_store()
    normalized = normalize_resource_link_args(
        args, store=store, agent_identity_id=agent_identity_id
    )
    store.ensure_agent_identity(agent_identity_id)
    resource_link_id = store.insert_agent_resource_link(
        agent_identity_id=agent_identity_id,
        action_id=action_id,
        **normalized,
    )
    resource_link = store.get_agent_resource_link(resource_link_id)
    if resource_link is None:
        raise RuntimeError("Resource link registration was not persisted.")
    return {
        "ok": True,
        "resourceLinkId": resource_link_id,
        "resourceUri": resource_link["resource_uri"],
        "resourceLink": public_resource_link(resource_link),
    }


def normalize_resource_link_args(
    args: dict[str, Any],
    *,
    store: ControlPlaneStore | None = None,
    agent_identity_id: str | None = None,
) -> dict[str, Any]:
    source_uri = _resource_uri_arg(args, "sourceUri") or _resource_uri_arg(
        args, "source_uri"
    )
    target_uri = _resource_uri_arg(args, "targetUri") or _resource_uri_arg(
        args, "target_uri"
    )
    relationship = _string_arg(args, "relationship")
    if source_uri is None:
        raise ValueError("sourceUri must be a waypoint:// resource URI.")
    if target_uri is None:
        raise ValueError("targetUri must be a waypoint:// resource URI.")
    if relationship is None:
        raise ValueError("relationship must be a non-empty string.")

    store = store or get_control_plane_store()
    _validate_sidecar_resource(source_uri, store, agent_identity_id)
    _validate_sidecar_resource(target_uri, store, agent_identity_id)

    return {
        "source_uri": source_uri,
        "target_uri": target_uri,
        "relationship": relationship,
        "metadata": _object_arg(args, "metadata"),
    }


def build_resource_link_resource(resource_link: dict[str, Any]) -> dict[str, Any]:
    return {
        "exists": True,
        "resourceUri": resource_link["resource_uri"],
        "resourceLink": public_resource_link(resource_link),
    }


def resource_link_resources_from_rows(
    resource_links: list[dict[str, Any]],
) -> list[dict[str, str]]:
    resources: list[dict[str, str]] = []
    for resource_link in resource_links:
        resource_uri = resource_link.get("resource_uri")
        if not isinstance(resource_uri, str) or not resource_uri:
            continue
        relationship = resource_link.get("relationship")
        source_uri = resource_link.get("source_uri")
        target_uri = resource_link.get("target_uri")
        resources.append(
            {
                "uri": resource_uri,
                "name": (
                    relationship
                    if isinstance(relationship, str) and relationship
                    else resource_uri
                ),
                "description": f"{source_uri} -> {target_uri}",
                "mimeType": "application/json",
            }
        )
    return resources


def public_resource_link(resource_link: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": resource_link.get("id"),
        "sourceUri": resource_link.get("source_uri"),
        "targetUri": resource_link.get("target_uri"),
        "relationship": resource_link.get("relationship"),
        "resourceUri": resource_link.get("resource_uri"),
        "metadata": resource_link.get("metadata_json"),
        "agentIdentityId": resource_link.get("agent_identity_id"),
        "actionId": resource_link.get("action_id"),
        "createdAt": resource_link.get("created_at"),
    }


def _validate_sidecar_resource(
    uri: str, store: ControlPlaneStore, agent_identity_id: str | None
) -> None:
    parsed = urlsplit(uri)
    resource_id = parsed.path.lstrip("/")
    if parsed.netloc == "artifact":
        resource = store.get_agent_artifact(resource_id)
    elif parsed.netloc == "analysis-run":
        resource = store.get_agent_analysis_run(resource_id)
    else:
        return
    if resource is None or (
        agent_identity_id is not None
        and resource.get("agent_identity_id") != agent_identity_id
    ):
        raise ValueError(f"Unknown {parsed.netloc} resource.")


def _object_arg(args: dict[str, Any], key: str) -> dict[str, Any]:
    value = args.get(key)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"{key} must be a JSON object.")
    return value


def _resource_uri_arg(args: dict[str, Any], key: str) -> str | None:
    value = _string_arg(args, key)
    if value is None:
        return None
    parsed = urlsplit(value)
    if parsed.scheme == "waypoint" and parsed.netloc and parsed.path:
        return value
    return None


def _string_arg(args: dict[str, Any], key: str) -> str | None:
    value = args.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None
