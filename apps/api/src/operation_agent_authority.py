"""Service-level authorization for managed operation principals."""

from __future__ import annotations

from .capability_policy import has_required_capabilities
from .control_plane import ControlPlaneStore
from .operations import ActorKind, ClientChannel, OperationPrincipal
from .routes.mcp_auth import _grant_error_for_identity


def validate_operation_principal(
    principal: OperationPrincipal,
    *,
    store: ControlPlaneStore,
    runtime_scope: str,
    owner_id: str,
) -> bool:
    if principal.scope_ids != frozenset({runtime_scope}):
        return False

    if principal.actor_kind == ActorKind.HUMAN:
        return principal.actor_id == owner_id and principal.channel in {
            ClientChannel.DESKTOP_UI,
            ClientChannel.MANAGED_CLI,
        }

    if (
        principal.actor_kind != ActorKind.AGENT
        or principal.channel != ClientChannel.AGENT
    ):
        return False

    identity = store.get_agent_identity(principal.actor_id)
    if _grant_error_for_identity(principal.actor_id, identity) is not None:
        return False
    assert identity is not None
    if identity.get("parent_human_identity_id") != owner_id:
        return False
    if identity.get("environment_id") != runtime_scope:
        return False

    granted = identity.get("scope_json")
    if not isinstance(granted, list) or not all(
        isinstance(capability, str) for capability in granted
    ):
        return False
    return has_required_capabilities(granted, sorted(principal.capabilities))
