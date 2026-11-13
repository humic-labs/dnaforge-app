"""Thin public command entry point; Jobs owns its own command catalog."""

from __future__ import annotations

import argparse
import os
import shlex
import stat
import sys
from pathlib import Path

WINDOWS_SELF_REMOVE_EXIT = 75
_WINDOWS_LAUNCHER_ENV = "DNAFORGE_CLI_LAUNCHER"
WINDOWS_SELF_REMOVE_COMMAND = (
    'endlocal & (goto) 2>nul & del /f /q "%~f0" & if exist "%~f0" exit /b 1'
)


def run_external_mcp(
    *,
    packaged_executable: Path | None,
    workspace: str | None,
    runtime: str | None = None,
    launch_if_needed: bool = False,
) -> int:
    if packaged_executable is not None:
        arguments = [
            str(packaged_executable),
            "--mcp-stdio",
            "--app-owned",
            *(["--workspace", workspace] if workspace is not None else []),
            *(["--runtime", runtime] if runtime is not None else []),
            *(["--launch-if-needed"] if launch_if_needed else []),
        ]
        os.execv(str(packaged_executable), arguments)
        raise RuntimeError("The packaged MCP executable returned unexpectedly.")
    from .external_mcp import main as external_mcp_main

    return external_mcp_main(
        packaged_executable=packaged_executable,
        workspace=workspace,
        runtime=runtime,
        launch_if_needed=launch_if_needed,
    )


def _launcher(executable: Path) -> tuple[str, bytes]:
    if os.name == "nt":
        command = str(executable).replace("%", "%%")
        return "dnaforge.cmd", (
            "@echo off\r\nsetlocal DisableDelayedExpansion\r\n"
            'set "DNAFORGE_CLI_LAUNCHER=%~f0"\r\n'
            f'"{command}" --cli %*\r\n'
            'set "_DNAFORGE_CLI_STATUS=%errorlevel%"\r\n'
            'if /i not "%~1"=="uninstall-cli" exit /b %_DNAFORGE_CLI_STATUS%\r\n'
            'if not "%_DNAFORGE_CLI_STATUS%"=="75" exit /b %_DNAFORGE_CLI_STATUS%\r\n'
            "rem DNAFORGE_WINDOWS_SELF_REMOVE\r\n"
            f"{WINDOWS_SELF_REMOVE_COMMAND}\r\n"
        ).encode("utf-8")
    return "dnaforge", (
        "#!/bin/sh\n" + f'exec {shlex.quote(str(executable))} --cli "$@"\n'
    ).encode("utf-8")


def _is_current_windows_launcher(target: Path) -> bool:
    if os.name != "nt":
        return False
    invoked = os.environ.get(_WINDOWS_LAUNCHER_ENV)
    if not invoked:
        return False
    return os.path.normcase(os.path.abspath(invoked)) == os.path.normcase(
        os.path.abspath(target)
    )


def _manage_launcher(action: str, directory: Path, executable: Path | None) -> int:
    if executable is None:
        raise ValueError(
            "Use the bundled DNAForge command to install a launcher. "
            "A Python package installation already provides the dnaforge command."
        )
    executable = executable.resolve(strict=True)
    if not executable.is_file() or executable.name not in {
        "waypoint-api",
        "waypoint-api.exe",
    }:
        raise ValueError("The bundled DNAForge executable is unavailable.")
    if any(character in str(executable) for character in '\r\n"'):
        raise ValueError(
            "The application path cannot be represented by a shell launcher."
        )
    name, content = _launcher(executable)
    target = directory.expanduser().absolute() / name
    try:
        existing = target.lstat()
    except FileNotFoundError:
        existing = None
    if existing is not None:
        if not stat.S_ISREG(existing.st_mode) or target.read_bytes() != content:
            raise ValueError(f"Preserving another or modified command at {target}.")
        if action == "uninstall-cli":
            if _is_current_windows_launcher(target):
                print(f"Removing {target}. Your PATH settings were not changed.")
                return WINDOWS_SELF_REMOVE_EXIT
            target.unlink()
            print(f"Removed {target}. Your PATH settings were not changed.")
            return 0
    elif action == "uninstall-cli":
        print(f"No launcher at {target}. Your PATH settings were not changed.")
        return 0
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o755)
        with os.fdopen(descriptor, "wb") as output:
            output.write(content)
    print(
        f"Command: {target}\nAdd {target.parent} to PATH using your shell's own settings."
    )
    return 0


def main(
    argv: list[str] | None = None, *, packaged_executable: Path | None = None
) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments[:1] == ["jobs"]:
        from src.managed_operations_cli import main as jobs_main

        return jobs_main(arguments[1:])
    if arguments[:1] == ["mcp"]:
        mcp_parser = argparse.ArgumentParser(
            prog="dnaforge mcp",
            description="Connect this MCP stdio session to the installed DNAForge app.",
        )
        mcp_parser.add_argument("--workspace")
        mcp_parser.add_argument(
            "--runtime",
            help="Registered app session name or scope; see dnaforge jobs runtimes",
        )
        mcp_parser.add_argument(
            "--launch-if-needed",
            action="store_true",
            help="Open DNAForge when it is not running (default: fail with a message)",
        )
        mcp_args = mcp_parser.parse_args(arguments[1:])
        return run_external_mcp(
            packaged_executable=packaged_executable,
            workspace=mcp_args.workspace,
            runtime=mcp_args.runtime,
            launch_if_needed=mcp_args.launch_if_needed,
        )
    parser = argparse.ArgumentParser(
        prog="dnaforge",
        description="DNAForge command line. Use dnaforge jobs --help for tracked work.",
    )
    commands = parser.add_subparsers(dest="command")
    commands.add_parser("jobs", help="Discover and control explicitly managed work")
    commands.add_parser("mcp", help="Run the app-owned MCP server over stdio")
    for action, help_text in (
        ("install-cli", "Install this application's command in a directory you choose"),
        ("uninstall-cli", "Remove this application's unchanged installed command"),
    ):
        command = commands.add_parser(action, help=help_text)
        command.add_argument("--bin-dir", required=True, type=Path)
    args = parser.parse_args(arguments)
    if args.command is None:
        parser.print_help()
        return 0
    try:
        return _manage_launcher(args.command, args.bin_dir, packaged_executable)
    except (OSError, ValueError) as error:
        print(f"dnaforge: {error}", file=sys.stderr)
        return 1
