"""Shared session, capability, and audit helpers for agent tool routes."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
from datetime import datetime, timezone
from typing import Annotated, Any, Literal, TypeAlias, TypedDict

from fastapi import Header

from ..capability_policy import has_required_capabilities
from ..control_plane import get_control_plane_store

MCP_GRANT_CAPABILITIES_ENV = "DNAFORGE_MCP_GRANT_CAPABILITIES"
MCP_GRANT_IDENTITY_ENV = "DNAFORGE_MCP_AGENT_IDENTITY"
GRANT_ENVIRONMENT_ENV = "DNAFORGE_GRANT_ENVIRONMENT_ID"
GRANT_CREATED_BY_ENV = "DNAFORGE_GRANT_CREATED_BY"
API_KEY_PREFIX = "dna_key_"


class MCPClientInfo(TypedDict):
    """Non-authoritative MCP client identity supplied for audit context."""

    name: str
    version: str


class AgentCallerContext(TypedDict):
    """Authenticated, attenuated authority for one sidecar request."""

    agent_identity_id: str
    agent_label: str | None
    auth_method: Literal["session", "api-key"]
    client_info: MCPClientInfo | None
    requested_capabilities: list[str]
    requested_capabilities_supplied: bool
    granted_capabilities: list[str] | None
    effective_capabilities: list[str]


PersistentAgentAuthResult: TypeAlias = tuple[
    AgentCallerContext | None,
    dict[str, Any] | None,
]


def check_sidecar_session(session_token: str | None) -> dict[str, Any] | None:
    """Validate only the renderer/sidecar session token.

    Settings uses this path to manage grants as first-party UI. Tool execution
    still calls `check_session`, which additionally checks the env-bound agent
    grant row for revocation and expiry.
    """

    expected = os.environ.get("DNAFORGE_MCP_SESSION_TOKEN")
    if not expected:
        return error_response(
            "MCP_SESSION_NOT_CONFIGURED",
            "MCP session token is not configured.",
            retriable=False,
        )
    if not hmac.compare_digest(session_token or "", expected):
        return error_response(
            "BAD_SESSION",
            "MCP session token is missing or invalid.",
            retriable=True,
        )
    return None


def check_session(session_token: str | None) -> dict[str, Any] | None:
    """Validate the bearer token AND the persistent agent grant in one pass.

    : the agent_identity table (control_plane/store.py) has carried
    expires_at + revoked since  but nothing consulted it. Every
    /mcp/call, /external/*, /api/tools/*/execute hits this single funnel,
    so wiring the grant check here picks up all callers without touching
    each route. When MCP_GRANT_IDENTITY_ENV is unset the grant check is a
    no-op — preserves legacy harnesses (test_agent_workflow_harness_*, direct
    pytest fixtures) that boot the sidecar with a session token but no
    persistent identity row.
    """
    session_error = check_sidecar_session(session_token)
    if session_error is not None:
        return session_error
    return check_grant_from_env()


def check_grant(agent_identity_id: str) -> dict[str, Any] | None:
    """Enforce that the persistent agent_identity row backs this session.

    Returns an `error_response` dict on failure (GRANT_MISSING when no row
    exists; GRANT_REVOKED when revoked=1; GRANT_EXPIRED when expires_at is
    in the past), or None on success.

    Not retriable: the user must re-mint the grant via the Manage Agents UI
    (A3) — a client backoff would just re-issue against the same dead row.
    """
    identity = get_control_plane_store().get_agent_identity(agent_identity_id)
    return _grant_error_for_identity(agent_identity_id, identity)


def _grant_error_for_identity(
    agent_identity_id: str,
    identity: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Validate a grant row already loaded for the current request."""

    if identity is None:
        return error_response(
            "GRANT_MISSING",
            "Agent identity has no persistent grant row in the control plane.",
            retriable=False,
            details={"agent_identity_id": agent_identity_id},
        )
    if identity.get("revoked"):
        return error_response(
            "GRANT_REVOKED",
            "Agent identity grant has been revoked.",
            retriable=False,
            details={"agent_identity_id": agent_identity_id},
        )
    expires_at = identity.get("expires_at")
    if expires_at is not None and _is_past(expires_at):
        return error_response(
            "GRANT_EXPIRED",
            "Agent identity grant has expired.",
            retriable=False,
            details={
                "agent_identity_id": agent_identity_id,
                "expires_at": expires_at,
            },
        )
    return None


def _is_past(iso_timestamp: str) -> bool:
    """Compare an ISO-8601 timestamp against now.

    Originally a lexical string compare against `utc_now()`, which is correct
    ONLY for the canonical `...Z` form `utc_now()` produces. The future
    Manage Agents UI (A3) may pass timestamps via different libraries
    (`datetime.isoformat()` produces `...+00:00`; `'+'` < `'Z'` lexically,
    so a `+00:00` row at the same instant compared lexically would falsely
    appear expired). Parse to a real datetime to compare by time, not by
    string ordering.

    An unparseable value fails closed as expired.
    """
    normalized = (
        iso_timestamp.replace("Z", "+00:00")
        if iso_timestamp.endswith("Z")
        else iso_timestamp
    )
    try:
        expires = datetime.fromisoformat(normalized)
    except (TypeError, ValueError):
        return True
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    return expires < datetime.now(timezone.utc)


def _clean_env_value(name: str) -> str | None:
    value = os.environ.get(name)
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def check_grant_from_env() -> dict[str, Any] | None:
    """Run check_grant against the env-bound persistent identity.

    The desktop main process (`agent-grants.ts` + `main/index.ts`) sets
    `DNAFORGE_MCP_AGENT_IDENTITY` to the persistent grant id before
    spawning the sidecar. Legacy test harnesses that don't set the var
    skip the check entirely (returns None) so existing pytest fixtures
    keep working without seeding a row.
    """
    identity_id = os.environ.get(MCP_GRANT_IDENTITY_ENV)
    if not identity_id:
        return None
    return check_grant(identity_id)


MANAGED_IN_APP_AGENT_IDENTITY = "local-in-app-chat"


def bootstrap_session_grant() -> None:
    """Idempotently materialize the env-bound agent_identity row.

    Called from `main.py`'s FastAPI lifespan on sidecar startup. Reads
    `DNAFORGE_MCP_AGENT_IDENTITY` (identity id) + `DNAFORGE_MCP_GRANT_CAPABILITIES`
    (initial scope) and inserts the row if absent. The stable product-owned
    in-app identity is widened when the shipped catalog grows. Revoked rows
    and user-created external grants remain untouched.

    Without this call, the first /mcp/call after a clean install would
    fail with GRANT_MISSING because nothing else writes to agent_identity
    during normal startup.
    """
    identity_id = os.environ.get(MCP_GRANT_IDENTITY_ENV)
    if not identity_id:
        return
    scope = session_grant_capabilities() or []
    store = get_control_plane_store()
    store.ensure_agent_identity(
        identity_id,
        scope=scope,
        label="In-app Strider",
        kind="in-app",
        origin="app",
        environment_id=grant_environment_id(),
        created_by=grant_created_by("app-launch"),
    )
    if identity_id == MANAGED_IN_APP_AGENT_IDENTITY:
        store.widen_managed_agent_identity_scope(
            identity_id,
            capabilities=scope,
            environment_id=grant_environment_id(),
        )


def grant_environment_id() -> str | None:
    return _clean_env_value(GRANT_ENVIRONMENT_ENV) or _clean_env_value(
        "DNAFORGE_SIDECAR_ENVIRONMENT_ID"
    )


def grant_created_by(default: str | None = None) -> str | None:
    return _clean_env_value(GRANT_CREATED_BY_ENV) or default


def parse_capabilities(raw: str | None) -> list[str]:
    if raw is None or not raw.strip():
        return []
    stripped = raw.strip()
    if stripped.startswith("["):
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            return []
        if isinstance(parsed, list):
            return [item for item in parsed if isinstance(item, str)]
        return []
    return [item.strip() for item in stripped.split(",") if item.strip()]


def resolve_agent_context(
    agent_identity_id: str,
    raw_capabilities: str | None,
    *,
    client_info: MCPClientInfo | None = None,
) -> AgentCallerContext:
    """Resolve caller headers against the server-side session grant.

    Older dev harnesses send the desired scope in a request header. When
    DNAFORGE_MCP_GRANT_CAPABILITIES is configured, that header becomes only a
    request for a subset of the grant; it cannot self-upgrade the session.
    """

    requested = _dedupe_capabilities(parse_capabilities(raw_capabilities))
    grant = session_grant_capabilities()
    if grant is None:
        return {
            "agent_identity_id": agent_identity_id,
            "agent_label": None,
            "auth_method": "session",
            "client_info": _copy_client_info(client_info),
            "requested_capabilities": requested,
            "requested_capabilities_supplied": raw_capabilities is not None,
            "granted_capabilities": None,
            "effective_capabilities": [],
        }

    return {
        "agent_identity_id": os.environ.get(MCP_GRANT_IDENTITY_ENV)
        or agent_identity_id,
        "agent_label": None,
        "auth_method": "session",
        "client_info": _copy_client_info(client_info),
        "requested_capabilities": requested,
        "requested_capabilities_supplied": raw_capabilities is not None,
        "granted_capabilities": grant,
        "effective_capabilities": _capabilities_within_grant(
            requested,
            grant,
            use_grant_when_unrequested=raw_capabilities is None,
        ),
    }


def resolve_identity_context(
    identity: dict[str, Any],
    raw_capabilities: str | None,
    *,
    auth_method: Literal["session", "api-key"],
    client_info: MCPClientInfo | None = None,
) -> AgentCallerContext:
    """Resolve a persisted agent_identity row into an execution context."""

    requested = _dedupe_capabilities(parse_capabilities(raw_capabilities))
    raw_scope = identity.get("scope_json")
    grant = _dedupe_capabilities(raw_scope if isinstance(raw_scope, list) else [])
    raw_label = identity.get("label")
    agent_label = (
        raw_label.strip() if isinstance(raw_label, str) and raw_label.strip() else None
    )
    return {
        "agent_identity_id": identity["id"],
        "agent_label": agent_label,
        "auth_method": auth_method,
        "client_info": _copy_client_info(client_info),
        "requested_capabilities": requested,
        "requested_capabilities_supplied": raw_capabilities is not None,
        "granted_capabilities": grant,
        "effective_capabilities": _capabilities_within_grant(
            requested,
            grant,
            use_grant_when_unrequested=raw_capabilities is None,
        ),
    }


def generate_api_key() -> str:
    return f"{API_KEY_PREFIX}{secrets.token_urlsafe(32)}"


def hash_api_key(api_key: str) -> str:
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()


def get_identity_for_api_key(
    api_key: str | None,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    if api_key is None or not api_key.strip():
        return None, error_response(
            "BAD_API_KEY",
            "API key is missing or invalid.",
            retriable=False,
        )
    identity = get_control_plane_store().get_agent_identity_by_api_key_hash(
        hash_api_key(api_key.strip())
    )
    if identity is None:
        return None, error_response(
            "BAD_API_KEY",
            "API key is missing or invalid.",
            retriable=False,
        )
    grant_error = _grant_error_for_identity(identity["id"], identity)
    if grant_error is not None:
        return None, grant_error
    return identity, None


def resolve_authenticated_agent_context(
    *,
    session_token: str | None,
    api_key: str | None,
    agent_identity_id: str,
    raw_capabilities: str | None,
    require_persistent_grant: bool = False,
    client_info: MCPClientInfo | None = None,
) -> tuple[AgentCallerContext | None, dict[str, Any] | None]:
    """Authenticate either an API key grant or the renderer sidecar session."""

    if api_key is not None and api_key.strip() == "":
        api_key = None

    if api_key is not None:
        identity, api_key_error = get_identity_for_api_key(api_key)
        if api_key_error is not None:
            return None, api_key_error
        assert identity is not None
        return (
            resolve_identity_context(
                identity,
                raw_capabilities,
                auth_method="api-key",
                client_info=client_info,
            ),
            None,
        )

    session_error = check_sidecar_session(session_token)
    if session_error is not None:
        return None, session_error

    bound_identity_id = _clean_env_value(MCP_GRANT_IDENTITY_ENV)
    if bound_identity_id is not None:
        identity = get_control_plane_store().get_agent_identity(bound_identity_id)
        grant_error = _grant_error_for_identity(bound_identity_id, identity)
        if grant_error is not None:
            return None, grant_error
        assert identity is not None
        return (
            resolve_identity_context(
                identity,
                raw_capabilities,
                auth_method="session",
                client_info=client_info,
            ),
            None,
        )

    if require_persistent_grant:
        return None, error_response(
            "GRANT_MISSING",
            "This MCP request requires a persistent agent grant.",
            retriable=False,
            details={"agent_identity_id": agent_identity_id},
        )
    return (
        resolve_agent_context(
            agent_identity_id,
            raw_capabilities,
            client_info=client_info,
        ),
        None,
    )


def resolve_persistent_agent_request(
    agent_identity_id: Annotated[
        str,
        Header(alias="X-DNAForge-Agent-Identity"),
    ] = "local-agent",
    agent_capabilities: Annotated[
        str | None,
        Header(alias="X-DNAForge-Agent-Capabilities"),
    ] = None,
    session_token: Annotated[
        str | None,
        Header(alias="X-DNAForge-Session"),
    ] = None,
    api_key: Annotated[
        str | None,
        Header(alias="X-DNAForge-API-Key"),
    ] = None,
) -> PersistentAgentAuthResult:
    """FastAPI dependency for grant-owned read and lifecycle routes.

    Keeping the header parsing here prevents legacy routes from drifting back
    to token-only authentication while preserving both supported local auth
    methods and the existing error envelope at each route boundary.
    """

    return resolve_authenticated_agent_context(
        session_token=session_token,
        api_key=api_key,
        agent_identity_id=agent_identity_id,
        raw_capabilities=agent_capabilities,
        require_persistent_grant=True,
    )


def _copy_client_info(client_info: MCPClientInfo | None) -> MCPClientInfo | None:
    if client_info is None:
        return None
    return {"name": client_info["name"], "version": client_info["version"]}


def effective_capabilities_for_session_request(
    requested_capabilities: list[str],
) -> list[str]:
    """Clamp body/header-requested scopes to the server-side session grant.

    `/mcp/call` gets capabilities from headers; direct `/external/*` routes get
    them in JSON bodies. Both paths must use the same rule: client-supplied
    scope is only a request for a subset of the configured session grant, never
    authority to self-upgrade.
    """

    requested = _dedupe_capabilities(
        [capability for capability in requested_capabilities if capability != "*"]
    )
    grant = session_grant_capabilities()
    if grant is None:
        return []
    return _capabilities_within_grant(requested, grant)


def session_grant_capabilities() -> list[str] | None:
    if MCP_GRANT_CAPABILITIES_ENV not in os.environ:
        return None
    return _dedupe_capabilities(
        parse_capabilities(os.environ.get(MCP_GRANT_CAPABILITIES_ENV))
    )


def _capabilities_within_grant(
    requested: list[str],
    grant: list[str],
    *,
    use_grant_when_unrequested: bool = True,
) -> list[str]:
    if not requested:
        return grant if use_grant_when_unrequested else []
    if "*" in grant:
        return requested
    if "*" in requested:
        return grant
    return [
        capability
        for capability in requested
        if has_required_capabilities(grant, [capability])
    ]


def _dedupe_capabilities(capabilities: list[str]) -> list[str]:
    seen: set[str] = set()
    deduped: list[str] = []
    for capability in capabilities:
        if capability in seen:
            continue
        seen.add(capability)
        deduped.append(capability)
    return deduped


def check_parent_action(parent_action_id: str | None) -> dict[str, Any] | None:
    if parent_action_id is None:
        return None
    if get_control_plane_store().get_agent_action(parent_action_id) is not None:
        return None
    return error_response(
        "UNKNOWN_PARENT_ACTION",
        "parent_action_id must reference an existing agent action.",
        retriable=False,
        details={"parent_action_id": parent_action_id},
    )


def write_rejection_audit(
    *,
    agent_identity_id: str,
    tool_name: str,
    args: dict[str, Any],
    actor_scope: list[str],
    required_capabilities: list[str],
    parent_action_id: str | None,
) -> tuple[str, str]:
    store = get_control_plane_store()
    store.ensure_agent_identity(agent_identity_id, scope=actor_scope)
    parent_action = (
        store.get_agent_action(parent_action_id) if parent_action_id else None
    )
    action_id = store.insert_agent_action(
        agent_identity_id=agent_identity_id,
        tool_name=tool_name,
        parameters=args,
        authorized_scope=actor_scope,
        authorization_state="denied",
        parent_action_id=parent_action_id,
        root_action_id=(parent_action or {}).get("root_action_id"),
    )
    error = {
        "code": "INSUFFICIENT_SCOPE",
        "message": "Agent identity does not have the capabilities required for this tool.",
    }
    store.complete_agent_action(action_id, error=error)
    audit_id = store.insert_audit_record(
        action_id=action_id,
        actor_kind="agent",
        actor_identity=agent_identity_id,
        actor_scope=actor_scope,
        side_effects=[],
        capability_check={
            "required": required_capabilities,
            "satisfied": False,
            "reason": "insufficient_scope",
        },
    )
    return action_id, audit_id


def error_response(
    code: str,
    message: str,
    *,
    retriable: bool,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    error: dict[str, Any] = {
        "code": code,
        "message": message,
        "retriable": retriable,
    }
    if details is not None:
        error["details"] = details
    return {"ok": False, "error": error}
