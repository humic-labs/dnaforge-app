"""CLI plug-in contract helpers for Phase 1a."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from .schema import DNAForgeTool


class CliPluginManifest(BaseModel):
    manifest_version: int = 1
    tool: DNAForgeTool
    command: list[str] = Field(min_length=1)


class PluginRegistrationError(BaseModel):
    kind: str
    path: str
    hint: str


def load_cli_plugin_manifest(path: Path) -> CliPluginManifest:
    return CliPluginManifest.model_validate_json(path.read_text())


def validate_cli_plugin_manifest(path: Path) -> list[PluginRegistrationError]:
    try:
        manifest = load_cli_plugin_manifest(path)
    except Exception as exc:
        return [
            PluginRegistrationError(
                kind="manifest_invalid",
                path="$",
                hint=str(exc),
            )
        ]
    command = _expand_command(manifest.command, path.parent)
    executable = command[0]
    if executable != sys.executable and not Path(executable).exists():
        return [
            PluginRegistrationError(
                kind="binary_missing",
                path="$.command[0]",
                hint=f"Executable not found: {executable}",
            )
        ]
    return []


async def run_cli_plugin(
    manifest_path: Path,
    input_payload: dict[str, Any],
    *,
    job_id: str,
    idempotency_key: str | None = None,
    timeout_seconds: float = 30,
) -> dict[str, Any]:
    manifest = load_cli_plugin_manifest(manifest_path)
    command = _expand_command(manifest.command, manifest_path.parent)
    env = {
        **os.environ,
        "DNAFORGE_JOB_ID": job_id,
        "DNAFORGE_PROGRESS_FD": "3",
        "DNAFORGE_PROTOCOL_VERSION": str(manifest.manifest_version),
    }
    with tempfile.TemporaryDirectory(prefix=f"dnaforge-{job_id}-") as tmpdir:
        env["DNAFORGE_TMPDIR"] = tmpdir
        proc = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdin = json.dumps(
            {
                "jobId": job_id,
                "input": input_payload,
                "idempotencyKey": idempotency_key,
            }
        ).encode()
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(stdin), timeout=timeout_seconds
            )
        except asyncio.TimeoutError:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=10)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
            return {"error": {"kind": "timeout", "message": "Plugin timed out"}}
    if proc.returncode == 124:
        return {"error": {"kind": "canceled", "message": "Plugin canceled"}}
    if proc.returncode != 0:
        return {
            "error": {
                "kind": "process_failed",
                "message": stderr.decode(errors="replace"),
                "exit_code": proc.returncode,
            }
        }
    try:
        return json.loads(stdout.decode())
    except json.JSONDecodeError as exc:
        return {"error": {"kind": "invalid_stdout", "message": str(exc)}}


def _expand_command(command: list[str], base_dir: Path) -> list[str]:
    expanded: list[str] = []
    for idx, part in enumerate(command):
        if part == "{python}":
            expanded.append(sys.executable)
            continue
        candidate = base_dir / part
        if idx > 0 and candidate.exists():
            expanded.append(str(candidate))
        else:
            expanded.append(part)
    return expanded
