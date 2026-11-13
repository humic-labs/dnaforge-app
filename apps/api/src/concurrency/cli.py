"""Developer CLI for validating and running local sidecar plug-ins."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from ..control_plane import new_uuid7
from .plugin_runner import run_cli_plugin, validate_cli_plugin_manifest


def main() -> int:
    parser = argparse.ArgumentParser(prog="python -m src.concurrency.cli")
    sub = parser.add_subparsers(dest="scope", required=True)
    plugin = sub.add_parser("plugin")
    plugin_sub = plugin.add_subparsers(dest="command", required=True)
    validate = plugin_sub.add_parser("validate")
    validate.add_argument("manifest")
    run_local = plugin_sub.add_parser("run-local")
    run_local.add_argument("manifest")
    run_local.add_argument("--input", required=True)

    args = parser.parse_args()
    if args.scope == "plugin" and args.command == "validate":
        errors = validate_cli_plugin_manifest(Path(args.manifest))
        print(
            json.dumps({"ok": not errors, "errors": [e.model_dump() for e in errors]})
        )
        return 1 if errors else 0
    if args.scope == "plugin" and args.command == "run-local":
        payload = json.loads(args.input)
        result = asyncio.run(
            run_cli_plugin(Path(args.manifest), payload, job_id=new_uuid7())
        )
        print(json.dumps(result, sort_keys=True))
        return 0 if "error" not in result else 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
