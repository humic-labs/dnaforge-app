"""Version-independent Windows launcher qualification."""

from pathlib import Path

from scripts.verify_packaged_jobs import (
    _removal_entry_point,
    windows_cmd_reads_after_self_delete,
)
from src import dnaforge_cli

_DNA593_PAREN_SELF_DELETE = (
    b"@echo off\r\n"
    b"rem DNAFORGE_WINDOWS_SELF_REMOVE\r\n"
    b"(\r\n"
    b"  endlocal\r\n"
    b'  del /f /q "%~f0"\r\n'
    b'  if exist "%~f0" exit /b 1\r\n'
    b"  exit /b 0\r\n"
    b")\r\n"
)


def test_legacy_windows_launcher_is_removed_by_the_owning_bundle(tmp_path: Path):
    installed = tmp_path / "dnaforge.cmd"
    installed.write_bytes(b"@echo off\r\nold launcher\r\n")
    owner = tmp_path / "bundle" / "dnaforge.cmd"

    assert _removal_entry_point(installed, owner, platform="nt") == owner


def test_self_removing_windows_launcher_qualifies_through_its_public_entry(
    tmp_path: Path,
):
    installed = tmp_path / "dnaforge.cmd"
    installed.write_bytes(b"@rem DNAFORGE_WINDOWS_SELF_REMOVE\r\n")
    owner = tmp_path / "bundle" / "dnaforge.cmd"

    assert _removal_entry_point(installed, owner, platform="nt") == installed


def test_posix_launcher_always_qualifies_through_its_public_entry(tmp_path: Path):
    installed = tmp_path / "dnaforge"
    installed.write_bytes(b"#!/bin/sh\n")
    owner = tmp_path / "bundle" / "dnaforge"

    assert _removal_entry_point(installed, owner, platform="posix") == installed


def test_paren_block_self_delete_is_the_windows_beta_batch_afterglow():
    """cmd.exe keeps reading after a parenthesized del of the running .cmd.

    Tip Windows Beta failed verify_packaged_jobs uninstall-cli with
    'The batch file cannot be found.' The  launcher deleted itself
    inside a still-interpreted block, then cmd.exe sought the next line.
    """
    assert windows_cmd_reads_after_self_delete(_DNA593_PAREN_SELF_DELETE)


def test_generated_windows_launcher_abandons_cmd_before_deleting_itself(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setattr(dnaforge_cli.os, "name", "nt")
    binary = tmp_path / "waypoint-api.exe"
    binary.write_text("executable fixture")
    _name, content = dnaforge_cli._launcher(binary)

    assert dnaforge_cli.WINDOWS_SELF_REMOVE_COMMAND.encode() in content
    assert b"(goto) 2>nul" in content
    assert _DNA593_PAREN_SELF_DELETE.split(b"DNAFORGE_WINDOWS_SELF_REMOVE", 1)[
        1
    ] not in (content.split(b"DNAFORGE_WINDOWS_SELF_REMOVE", 1)[1])
    assert windows_cmd_reads_after_self_delete(content) is False
