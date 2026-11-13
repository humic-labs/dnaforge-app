"""stdio entry point that delegates all protocol transport to MCP SDK v2."""

from __future__ import annotations

import argparse
import asyncio
import json
from collections.abc import Sequence

from mcp.server.stdio import stdio_server

from .options import CompanionOptions, parse_capabilities
from .server import create_mcp_server
from .sidecar import SidecarClient, SidecarClientProtocol


async def run_stdio_server(
    sidecar: SidecarClientProtocol,
    options: CompanionOptions,
) -> None:
    """Run SDK-owned MCP stdio framing over an authenticated sidecar client."""

    server = create_mcp_server(sidecar, options)
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


async def run_stdio_companion(options: CompanionOptions | None = None) -> None:
    """Run the dual-era MCP server with SDK-owned newline stdio framing."""

    resolved = options or CompanionOptions.from_env()
    async with SidecarClient(resolved) as sidecar:
        await run_stdio_server(sidecar, resolved)


def main(argv: Sequence[str] | None = None) -> int:
    options = _parse_options(argv)
    asyncio.run(run_stdio_companion(options))
    return 0


def _parse_options(argv: Sequence[str] | None) -> CompanionOptions:
    defaults = CompanionOptions.from_env()
    parser = argparse.ArgumentParser(
        description="Run the SDK-backed DNAForge MCP stdio companion."
    )
    parser.add_argument("--api-url", default=defaults.api_url)
    parser.add_argument("--session-token", default=defaults.session_token)
    parser.add_argument("--api-key", default=defaults.api_key)
    parser.add_argument("--agent-identity", default=defaults.agent_identity)
    parser.add_argument(
        "--agent-capabilities",
        default=(
            json.dumps(list(defaults.agent_capabilities))
            if defaults.agent_capabilities is not None
            else None
        ),
    )
    parser.add_argument("--turn-id", default=defaults.turn_id)
    args = parser.parse_args(argv)
    return CompanionOptions(
        api_url=args.api_url,
        session_token=args.session_token,
        session_authority_path=defaults.session_authority_path,
        session_authority_owner=defaults.session_authority_owner,
        api_key=args.api_key,
        agent_identity=args.agent_identity,
        agent_capabilities=parse_capabilities(args.agent_capabilities),
        turn_id=args.turn_id,
        expose_agent_user_input=defaults.expose_agent_user_input,
        client_surface=defaults.client_surface,
        agent_user_input_handoff_path=defaults.agent_user_input_handoff_path,
        agent_user_input_handoff_token=defaults.agent_user_input_handoff_token,
        request_timeout_seconds=defaults.request_timeout_seconds,
        job_poll_interval_seconds=defaults.job_poll_interval_seconds,
        job_timeout_seconds=defaults.job_timeout_seconds,
    )
