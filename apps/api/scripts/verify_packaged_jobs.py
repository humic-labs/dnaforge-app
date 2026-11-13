"""Exercise the shipped Jobs entry point without an app, runtime or credentials."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path

_WINDOWS_SELF_REMOVE_MARKER = b"DNAFORGE_WINDOWS_SELF_REMOVE"
_WINDOWS_PARSER_ABANDON = b"(goto) 2>nul"
_WINDOWS_SELF_DELETE = b'del /f /q "%~f0"'


def _cmd_top_level_statements(script: bytes) -> list[bytes]:
    lines = script.replace(b"\r\n", b"\n").replace(b"\r", b"\n").split(b"\n")
    statements: list[bytes] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        stripped = line.lstrip()
        if stripped.startswith(b"("):
            block = [line]
            depth = stripped.count(b"(") - stripped.count(b")")
            index += 1
            while index < len(lines) and depth > 0:
                block.append(lines[index])
                depth += lines[index].count(b"(") - lines[index].count(b")")
                index += 1
            statements.append(b"\n".join(block))
            continue
        statements.append(line)
        index += 1
    return [statement for statement in statements if statement.strip()]


def windows_cmd_reads_after_self_delete(script: bytes) -> bool:
    """True when cmd.exe would print 'The batch file cannot be found.'"""
    if _WINDOWS_SELF_REMOVE_MARKER not in script:
        return False
    body = script.split(_WINDOWS_SELF_REMOVE_MARKER, 1)[1]
    deleted_while_reading = False
    for statement in _cmd_top_level_statements(body):
        if deleted_while_reading:
            return True
        abandons_parser = _WINDOWS_PARSER_ABANDON in statement
        deletes_self = _WINDOWS_SELF_DELETE in statement
        if deletes_self and not abandons_parser:
            deleted_while_reading = True
        elif abandons_parser:
            return False
    return deleted_while_reading


def _removal_entry_point(
    installed: Path, owner_launcher: Path, *, platform: str
) -> Path:
    if platform == "nt" and _WINDOWS_SELF_REMOVE_MARKER not in installed.read_bytes():
        return owner_launcher
    return installed


def verify(command: list[str], launcher: Path | None = None) -> dict:
    with tempfile.TemporaryDirectory(prefix="dnaforge-jobs-probe-") as temporary:
        root = Path(temporary)
        registry = root / "uncreated runtime registry"
        environment = {
            **os.environ,
            "DNAFORGE_OPERATION_RUNTIME_DIR": str(registry),
        }
        environment.pop("DNAFORGE_OPERATION_CONNECTION_FILE", None)

        def invoke(arguments: list[str]) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                [*command, "--jobs", *arguments],
                cwd=root,
                env=environment,
                capture_output=True,
                text=True,
                timeout=20,
            )

        inventory = invoke(["runtimes", "--json"])
        if inventory.returncode != 0:
            raise RuntimeError(f"Jobs inventory failed: {inventory.stderr[:2000]}")
        if json.loads(inventory.stdout) != {"runtimes": []}:
            raise RuntimeError("Jobs inventory did not use the isolated empty registry")

        missing = invoke(["--runtime", "no-such-runtime", "catalog", "--json"])
        if missing.returncode != 1 or "No matching local runtime" not in missing.stderr:
            raise RuntimeError(
                "Missing runtime did not return the explicit unavailable error"
            )
        if registry.exists():
            raise RuntimeError("Read-only Jobs commands created a runtime registry")

        serve_help = invoke(["serve", "--help"])
        if serve_help.returncode != 0 or "runtime_config" not in serve_help.stdout:
            raise RuntimeError(
                "The packaged command does not expose explicit headless startup"
            )
        installed_command = None
        if launcher is not None:

            def public_invoke(executable: Path, arguments: list[str]):
                return subprocess.run(
                    [str(executable), *arguments],
                    cwd=root,
                    env=environment,
                    capture_output=True,
                    text=True,
                    timeout=20,
                )

            public_inventory = public_invoke(launcher, ["jobs", "runtimes", "--json"])
            if public_inventory.returncode or json.loads(public_inventory.stdout) != {
                "runtimes": []
            }:
                raise RuntimeError(
                    f"Bundled public command failed: {public_inventory.stderr[:2000]}"
                )
            install_dir = root / "chosen bin"
            installation = public_invoke(
                launcher, ["install-cli", "--bin-dir", str(install_dir)]
            )
            if installation.returncode:
                raise RuntimeError(
                    f"Command installation failed: {installation.stderr[:2000]}"
                )
            installed = install_dir / (
                "dnaforge.cmd" if os.name == "nt" else "dnaforge"
            )
            installed_inventory = public_invoke(
                installed, ["jobs", "runtimes", "--json"]
            )
            if installed_inventory.returncode or json.loads(
                installed_inventory.stdout
            ) != {"runtimes": []}:
                raise RuntimeError(
                    f"Installed public command failed: {installed_inventory.stderr[:2000]}"
                )
            if os.name == "nt" and windows_cmd_reads_after_self_delete(
                installed.read_bytes()
            ):
                raise RuntimeError(
                    "Installed Windows launcher deletes itself while cmd.exe "
                    "is still reading it"
                )
            removal_entry = _removal_entry_point(installed, launcher, platform=os.name)
            uninstallation = public_invoke(
                removal_entry, ["uninstall-cli", "--bin-dir", str(install_dir)]
            )
            if uninstallation.returncode or installed.exists():
                raise RuntimeError(
                    f"Command removal failed: {uninstallation.stderr[:2000]}"
                )
            if registry.exists():
                raise RuntimeError(
                    "Command installation or discovery created a runtime"
                )
            installed_command = True
        return {
            "schema": "dnaforge.jobs-command-probe.v1",
            "command": command,
            "isolated_inventory": True,
            "missing_runtime_exit": missing.returncode,
            "implicit_runtime_created": False,
            "explicit_serve_parser": True,
            "public_launcher": str(launcher) if launcher is not None else None,
            "explicit_install_and_remove": installed_command,
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command", nargs="+", help="Frozen executable, or Python and source entry"
    )
    parser.add_argument("--launcher", type=Path)
    arguments = parser.parse_args()
    command = [os.path.abspath(value) for value in arguments.command]
    print(json.dumps(verify(command, arguments.launcher), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
