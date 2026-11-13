"""Launch-owned configuration for the local DNAForge MCP companion."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Literal

ClientSurface = Literal["external", "dnaforge-chat"]


@dataclass(frozen=True, slots=True)
class CompanionOptions:
    """Configuration inherited from the trusted desktop launch boundary."""

    api_url: str = "http://127.0.0.1:8000"
    session_token: str = ""
    session_authority_path: str = ""
    session_authority_owner: str = ""
    api_key: str = ""
    agent_identity: str = "local-agent"
    agent_capabilities: tuple[str, ...] | None = None
    turn_id: str = ""
    expose_agent_user_input: bool = False
    portable_tool_names: bool = False
    client_surface: ClientSurface = "external"
    agent_user_input_handoff_path: str = ""
    agent_user_input_handoff_token: str = ""
    request_timeout_seconds: float = 30.0
    job_poll_interval_seconds: float = 0.1
    job_timeout_seconds: float = 120.0

    @classmethod
    def from_env(cls) -> CompanionOptions:
        return cls(
            api_url=os.environ.get("DNAFORGE_API_URL", "http://127.0.0.1:8000"),
            session_token=os.environ.get("DNAFORGE_MCP_SESSION_TOKEN", ""),
            session_authority_path=os.environ.get(
                "DNAFORGE_MCP_SESSION_AUTHORITY_PATH", ""
            ),
            session_authority_owner=os.environ.get(
                "DNAFORGE_MCP_SESSION_AUTHORITY_OWNER", ""
            ),
            api_key=os.environ.get("DNAFORGE_MCP_API_KEY", ""),
            agent_identity=os.environ.get("DNAFORGE_MCP_AGENT_IDENTITY", "local-agent"),
            agent_capabilities=parse_capabilities(
                os.environ.get("DNAFORGE_MCP_GRANT_CAPABILITIES")
            ),
            turn_id=os.environ.get("DNAFORGE_MCP_TURN_ID", ""),
            expose_agent_user_input=(
                os.environ.get("DNAFORGE_MCP_EXPOSE_AGENT_USER_INPUT") == "1"
            ),
            client_surface=(
                "dnaforge-chat"
                if os.environ.get("DNAFORGE_MCP_CLIENT_SURFACE") == "dnaforge-chat"
                else "external"
            ),
            agent_user_input_handoff_path=os.environ.get(
                "DNAFORGE_MCP_AGENT_USER_INPUT_HANDOFF_PATH", ""
            ),
            agent_user_input_handoff_token=os.environ.get(
                "DNAFORGE_MCP_AGENT_USER_INPUT_HANDOFF_TOKEN", ""
            ),
        )


def parse_capabilities(raw: str | None) -> tuple[str, ...] | None:
    """Parse a JSON array or comma-separated launch scope deterministically."""

    if raw is None:
        return None
    if not raw.strip():
        return ()
    stripped = raw.strip()
    values: list[str]
    if stripped.startswith("["):
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            return ()
        if not isinstance(parsed, list):
            return ()
        values = [value.strip() for value in parsed if isinstance(value, str)]
    else:
        values = [value.strip() for value in stripped.split(",")]
    return tuple(sorted({value for value in values if value}))
