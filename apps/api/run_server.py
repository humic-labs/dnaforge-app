#!/usr/bin/env python3
"""
Entry point for the Waypoint API sidecar.

This script starts the uvicorn server with the FastAPI app.
Used by Nuitka to create a standalone executable.

Usage:
    python run_server.py [--port PORT] [--host HOST]
    ./waypoint-api [--port PORT] [--host HOST]
    ./waypoint-api --mcp-stdio
    ./waypoint-api --jobs --help
"""

import argparse
import json
import os
import secrets
import sys


def main():
    if sys.argv[1:2] == ["--cli"]:
        from pathlib import Path

        from src.dnaforge_cli import main as cli_main

        return cli_main(
            sys.argv[2:],
            packaged_executable=(
                Path(__file__).with_name(
                    "waypoint-api.exe" if os.name == "nt" else "waypoint-api"
                )
                if "__compiled__" in globals()
                else None
            ),
        )
    if sys.argv[1:2] == ["--jobs"]:
        from src.managed_operations_cli import main as jobs_main

        return jobs_main(sys.argv[2:])

    parser = argparse.ArgumentParser(
        description="Waypoint API - Bioinformatics tools service",
        epilog="For command-line Jobs access, use: waypoint-api --jobs --help",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Port to run the server on (default: 8000)",
    )
    parser.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help="Host to bind to (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable auto-reload (development only)",
    )
    parser.add_argument(
        "--dev-auth",
        action="store_true",
        help="Mint and print a temporary session for standalone local development",
    )
    parser.add_argument(
        "--mcp-stdio",
        action="store_true",
        help="Run the SDK-backed DNAForge MCP companion over stdio",
    )
    parser.add_argument("--app-owned", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--workspace", help=argparse.SUPPRESS)
    parser.add_argument("--runtime", help=argparse.SUPPRESS)
    parser.add_argument(
        "--launch-if-needed", action="store_true", help=argparse.SUPPRESS
    )
    parser.add_argument(
        "--print-native-coverage-contract",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--verify-genome-runtime",
        action="store_true",
        help=argparse.SUPPRESS,
    )

    args = parser.parse_args()

    if args.app_owned and not args.mcp_stdio:
        parser.error("--app-owned requires --mcp-stdio")
    if args.workspace and not args.app_owned:
        parser.error("--workspace requires --mcp-stdio --app-owned")
    if args.runtime and not args.app_owned:
        parser.error("--runtime requires --mcp-stdio --app-owned")
    if args.launch_if_needed and not args.app_owned:
        parser.error("--launch-if-needed requires --mcp-stdio --app-owned")

    if args.verify_genome_runtime:
        try:
            from src.runtime_capabilities import genome_runtime_status_receipt

            print(
                json.dumps(
                    genome_runtime_status_receipt(),
                    separators=(",", ":"),
                    sort_keys=True,
                )
            )
            return 0
        except Exception as error:
            print(
                f"Required BAM/CRAM runtime is unavailable: {error}",
                file=sys.stderr,
            )
            return 1

    if args.reload and (getattr(sys, "frozen", False) or "__compiled__" in globals()):
        parser.error(
            "--reload is available only from the Python source entry point, "
            "not the packaged sidecar binary"
        )

    if args.print_native_coverage_contract:

        from src.services.coverage_pyramid import _CACHE_CONTRACT_TOKEN
        from src.services.dna_coverage_shellout import coverage_engine_identity

        print(
            json.dumps(
                {
                    "schema": "dnaforge.native-coverage-contract.v1",
                    "cacheContract": _CACHE_CONTRACT_TOKEN,
                    "engineIdentity": coverage_engine_identity(),
                },
                separators=(",", ":"),
                sort_keys=True,
            )
        )
        return 0

    if args.mcp_stdio:

        if args.app_owned:
            from pathlib import Path

            from src.external_mcp import main as external_mcp_main

            return external_mcp_main(
                packaged_executable=(
                    Path(__file__).with_name(
                        "waypoint-api.exe" if os.name == "nt" else "waypoint-api"
                    )
                    if "__compiled__" in globals()
                    else None
                ),
                workspace=args.workspace,
                runtime=args.runtime,
                launch_if_needed=args.launch_if_needed,
            )
        import asyncio

        from src.mcp_companion import run_stdio_companion

        asyncio.run(run_stdio_companion())
        return 0

    if args.dev_auth:
        token = os.environ.get("DNAFORGE_MCP_SESSION_TOKEN") or secrets.token_urlsafe(
            32
        )
        os.environ["DNAFORGE_MCP_SESSION_TOKEN"] = token
        print("DNAForge standalone development authentication is enabled.")
        print(f"Use this request header: X-DNAForge-Session: {token}")
        print(
            "Example protected request: "
            f"curl -H 'X-DNAForge-Session: {token}' "
            f"http://{args.host}:{args.port}/services/"
        )

    from src.sidecar_owner_watchdog import start_owner_watchdog

    start_owner_watchdog()

    import uvicorn

    if args.reload:
        application = "src.main:app"
    else:
        from src.main import app

        application = app

    uvicorn.run(
        application,
        host=args.host,
        port=args.port,
        log_level="info",
        reload=args.reload,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
