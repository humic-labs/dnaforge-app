"""Public command discovery and explicitly requested launcher installation."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from src import dnaforge_cli
from src.dnaforge_cli import main


def test_jobs_uses_the_existing_parser_and_preserves_exit_status(monkeypatch):
    from src import managed_operations_cli

    observed = []
    arguments = ["--connection", "/a path/runtime.json", "stop", "run-id", "--json"]

    def execute(args):
        observed.append(args)
        return 2

    monkeypatch.setattr(managed_operations_cli, "main", execute)
    assert main(["jobs", *arguments]) == 2
    assert observed == [arguments]


def test_mcp_uses_app_owned_connection_runner_without_environment_credentials(
    monkeypatch, tmp_path
):
    observed = []
    binary = tmp_path / "DNAForge.app" / "Contents" / "Resources" / "waypoint-api"
    binary.parent.mkdir(parents=True)
    binary.write_text("packaged fixture")

    def execute(*, packaged_executable, workspace, runtime, launch_if_needed):
        observed.append((packaged_executable, workspace, runtime, launch_if_needed))
        return 17

    monkeypatch.setattr(dnaforge_cli, "run_external_mcp", execute)
    monkeypatch.delenv("DNAFORGE_API_URL", raising=False)
    monkeypatch.delenv("DNAFORGE_MCP_SESSION_TOKEN", raising=False)
    monkeypatch.delenv("DNAFORGE_MCP_API_KEY", raising=False)

    assert (
        main(
            ["mcp", "--workspace", "/Users/scientist/project", "--runtime", "dev-a"],
            packaged_executable=binary,
        )
        == 17
    )
    assert observed == [(binary, "/Users/scientist/project", "dev-a", False)]
    assert main(["mcp", "--launch-if-needed"], packaged_executable=binary) == 17
    assert observed[-1] == (binary, None, None, True)


def test_packaged_mcp_reexecutes_the_existing_mcp_stdio_entry(monkeypatch, tmp_path):
    binary = tmp_path / "waypoint-api"
    binary.write_text("packaged fixture")
    observed = []

    def execute(path, arguments):
        observed.append((path, arguments))
        raise OSError("exec fixture")

    monkeypatch.setattr(dnaforge_cli.os, "execv", execute)
    with pytest.raises(OSError, match="exec fixture"):
        dnaforge_cli.run_external_mcp(
            packaged_executable=binary,
            workspace="/Users/scientist/project",
            runtime="dev-a",
            launch_if_needed=True,
        )

    assert observed == [
        (
            str(binary),
            [
                str(binary),
                "--mcp-stdio",
                "--app-owned",
                "--workspace",
                "/Users/scientist/project",
                "--runtime",
                "dev-a",
                "--launch-if-needed",
            ],
        )
    ]


@pytest.mark.parametrize("arguments", [[], ["--help"], ["jobs", "runtimes", "--json"]])
def test_source_entry_needs_no_app_or_registered_runtime(tmp_path, arguments):
    entry = Path(__file__).resolve().parents[1] / "run_server.py"
    registry = tmp_path / "uncreated registry"
    result = subprocess.run(
        [sys.executable, str(entry), "--cli", *arguments],
        cwd=tmp_path,
        env={
            **os.environ,
            "PYTHONPATH": str(entry.parents[2] / "packages" / "annotation" / "src"),
            "DNAFORGE_OPERATION_RUNTIME_DIR": str(registry),
        },
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    if arguments[:1] == ["jobs"]:
        assert json.loads(result.stdout) == {"runtimes": []}
    else:
        assert "dnaforge jobs" in result.stdout
    assert not registry.exists()


@pytest.mark.skipif(os.name == "nt", reason="POSIX subprocess acceptance")
def test_installed_command_preserves_arguments_status_and_owner_files(tmp_path, capsys):
    binary = tmp_path / "App with spaces ' $ &" / "waypoint-api"
    binary.parent.mkdir()
    binary.write_text("#!/bin/sh\nprintf '%s\\n' \"$@\"\nexit 7\n")
    binary.chmod(0o755)
    directory = tmp_path / "chosen bin"
    args = ["install-cli", "--bin-dir", str(directory)]
    assert main(args, packaged_executable=binary) == 0
    command = directory / "dnaforge"
    result = subprocess.run(
        [str(command), "jobs", "--connection", "a path/'$() &.json", "catalog"],
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert result.returncode == 7
    assert result.stdout.splitlines() == [
        "--cli",
        "jobs",
        "--connection",
        "a path/'$() &.json",
        "catalog",
    ]
    original = command.stat()
    assert main(args, packaged_executable=binary) == 0
    assert command.stat().st_mtime_ns == original.st_mtime_ns
    assert "PATH" in capsys.readouterr().out
    assert (
        main(["uninstall-cli", "--bin-dir", str(directory)], packaged_executable=binary)
        == 0
    )
    assert not command.exists()
    assert binary.exists()
    assert set(tmp_path.iterdir()) == {binary.parent, directory}


@pytest.mark.parametrize("foreign", ["file", "symlink"])
def test_install_and_uninstall_preserve_a_foreign_command(tmp_path, foreign):
    binary = tmp_path / "waypoint-api"
    binary.write_text("executable fixture")
    directory = tmp_path / "bin"
    directory.mkdir()
    command = directory / "dnaforge"
    if foreign == "file":
        command.write_text("another program")
    else:
        command.symlink_to(binary)
    for action in ["install-cli", "uninstall-cli"]:
        assert (
            main([action, "--bin-dir", str(directory)], packaged_executable=binary) == 1
        )
    assert (
        command.is_symlink()
        if foreign == "symlink"
        else command.read_text() == "another program"
    )
    assert binary.read_text() == "executable fixture"


def test_source_installation_does_not_create_a_launcher(tmp_path):
    assert main(["install-cli", "--bin-dir", str(tmp_path / "bin")]) == 1
    assert not (tmp_path / "bin").exists()


def test_windows_launcher_finishes_its_own_removal_after_the_binary_returns(
    tmp_path, monkeypatch
):
    binary = tmp_path / "waypoint-api.exe"
    binary.write_text("executable fixture")
    monkeypatch.setattr(dnaforge_cli.os, "name", "nt")

    _name, content = dnaforge_cli._launcher(binary)

    text = content.decode("utf-8")
    assert 'set "DNAFORGE_CLI_LAUNCHER=%~f0"' in text
    assert "DNAFORGE_WINDOWS_SELF_REMOVE" in text
    assert 'if /i not "%~1"=="uninstall-cli"' in text
    assert 'if not "%_DNAFORGE_CLI_STATUS%"=="75"' in text
    assert dnaforge_cli.WINDOWS_SELF_REMOVE_COMMAND in text
    assert '(goto) 2>nul & del /f /q "%~f0"' in text
    assert 'if exist "%~f0" exit /b 1' in text
    assert "(\r\n  endlocal\r\n" not in text


def test_windows_binary_defers_only_the_running_launchers_own_removal(
    tmp_path, monkeypatch
):
    binary = tmp_path / "waypoint-api"
    binary.write_text("executable fixture")
    directory = tmp_path / "bin"
    assert (
        main(["install-cli", "--bin-dir", str(directory)], packaged_executable=binary)
        == 0
    )
    command = directory / "dnaforge"
    monkeypatch.setattr(
        dnaforge_cli, "_is_current_windows_launcher", lambda target: target == command
    )

    status = main(
        ["uninstall-cli", "--bin-dir", str(directory)], packaged_executable=binary
    )

    assert status == dnaforge_cli.WINDOWS_SELF_REMOVE_EXIT
    assert command.exists()


@pytest.mark.skipif(os.name == "nt", reason="POSIX installed subprocess acceptance")
def test_compiled_entry_installs_the_binary_when_python_path_does_not_exist(
    tmp_path, monkeypatch
):
    import run_server

    bundle = tmp_path / "Application with spaces" / "binaries"
    bundle.mkdir(parents=True)
    executable = bundle / "waypoint-api"
    executable.write_text("#!/bin/sh\nprintf '%s\\n' \"$@\"\nexit 7\n")
    executable.chmod(0o755)
    monkeypatch.setattr(run_server, "__compiled__", object(), raising=False)
    monkeypatch.setattr(run_server, "__file__", str(bundle / "run_server.py"))
    monkeypatch.setattr(sys, "executable", str(bundle / "python"))
    command_dir = tmp_path / "chosen bin"
    monkeypatch.setattr(
        sys,
        "argv",
        ["unrelated-invocation", "--cli", "install-cli", "--bin-dir", str(command_dir)],
    )

    assert run_server.main() == 0
    result = subprocess.run(
        [str(command_dir / "dnaforge"), "jobs", "runtimes", "--json"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert result.returncode == 7
    assert result.stdout.splitlines() == ["--cli", "jobs", "runtimes", "--json"]
