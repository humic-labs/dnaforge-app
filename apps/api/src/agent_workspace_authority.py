from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .security.native_document_authority import NativeDocumentAuthority

APP_FOLLOWING_PROJECT_BINDING = "app-following"


def agent_project_scope(identity: dict[str, Any] | None) -> dict[str, Any]:
    if identity is None or identity.get("bound_workspace_id") is None:
        return {"kind": "app-following"}
    if identity.get("bound_workspace_id") == APP_FOLLOWING_PROJECT_BINDING:
        return {"kind": "app-following"}
    roots = artifact_workspace_roots(identity)
    return {"kind": "project-roots", "roots": [str(root) for root in roots or []]}


def snapshot_workspace_roots(workspace_id: str) -> list[str]:
    try:
        if workspace_id.startswith("folder:"):
            roots = [json.loads(workspace_id.removeprefix("folder:"))]
        elif workspace_id.startswith("folders:"):
            roots = json.loads(workspace_id.removeprefix("folders:"))
        elif workspace_id.startswith("file:"):
            workspace_file = Path(workspace_id.removeprefix("file:")).expanduser()
            if not workspace_file.is_absolute():
                return []
            config = json.loads(workspace_file.read_text(encoding="utf-8"))
            roots = [folder["path"] for folder in config["folders"]]
        else:
            return []
        paths = _absolute_roots(roots)
        return [str(path.resolve()) for path in paths]
    except (OSError, ValueError, TypeError, KeyError, RuntimeError):
        return []


def artifact_workspace_roots(identity: dict[str, Any] | None) -> list[Path] | None:
    if identity is None or identity.get("bound_workspace_id") is None:
        return None
    binding = identity["bound_workspace_id"]
    if binding == APP_FOLLOWING_PROJECT_BINDING:
        return []
    if not isinstance(binding, str) or not binding:
        return []
    snapshot = identity.get("bound_workspace_roots_json")
    if snapshot is None:
        if binding.startswith(("folder:", "folders:")):
            return [Path(root) for root in snapshot_workspace_roots(binding)]
        return []
    try:
        return _absolute_roots(snapshot)
    except (ValueError, TypeError):
        return []


def _absolute_roots(value: Any) -> list[Path]:
    if not isinstance(value, list) or not value:
        raise ValueError("Workspace roots must be a non-empty array.")
    paths = []
    for root in value:
        if not isinstance(root, str) or not root.strip():
            raise ValueError("Workspace roots must be absolute paths.")
        path = Path(root).expanduser()
        if not path.is_absolute():
            raise ValueError("Workspace roots must be absolute paths.")
        paths.append(path)
    return paths


async def resolve_artifact_workspace_roots(
    identity: dict[str, Any] | None, authority: NativeDocumentAuthority | None
) -> list[Path] | None:
    if (
        identity is None
        or identity.get("bound_workspace_id") != APP_FOLLOWING_PROJECT_BINDING
    ):
        return artifact_workspace_roots(identity)
    if authority is None:
        raise ValueError("Registered project authority is unavailable.")
    from .native_document_dispatch import dispatch_native_document_command

    outcome = await dispatch_native_document_command(
        authority,
        {
            "command": "project-scope.inspect",
            "projectScope": agent_project_scope(identity),
        },
    )
    if outcome.disposition != "completed" or outcome.result is None:
        raise ValueError("Registered project authority is unavailable.")
    roots = outcome.result.get("roots")
    if roots == []:
        return []
    return _absolute_roots(roots)
