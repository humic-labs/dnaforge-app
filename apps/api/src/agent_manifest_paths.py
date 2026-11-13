"""Packaged-safe lookup for shared agent tool manifests."""

from __future__ import annotations

import os
import sys
from collections.abc import Iterable
from pathlib import Path

AGENT_TOOLS_DIR_ENV = "DNAFORGE_AGENT_TOOLS_DIR"


def agent_tool_manifest_path(
    filename: str,
    *,
    candidate_dirs: Iterable[Path | str] | None = None,
) -> Path:
    """Resolve a manifest from the shared packages/core/agent-tools directory.

    Source checkouts find the repo-level package. Packaged apps should set
    DNAFORGE_AGENT_TOOLS_DIR to the copied Resources/agent-tools directory.
    """

    if Path(filename).name != filename:
        raise ValueError(
            "Agent tool manifest filename must not contain path separators."
        )

    configured_dir = os.environ.get(AGENT_TOOLS_DIR_ENV)
    if configured_dir and candidate_dirs is None:
        configured_path = Path(configured_dir).expanduser() / filename
        if configured_path.is_file():
            return configured_path
        raise RuntimeError(
            f"{AGENT_TOOLS_DIR_ENV} is configured but {filename} was not found: "
            f"{configured_path}"
        )

    checked: list[Path] = []
    for directory in _dedupe_paths(candidate_dirs or agent_tools_candidate_dirs()):
        path = directory / filename
        checked.append(path)
        if path.is_file():
            return path

    checked_paths = "\n".join(f"  - {path}" for path in checked)
    raise RuntimeError(
        f"Agent tool manifest not found: {filename}\nChecked:\n{checked_paths}"
    )


def agent_tools_candidate_dirs() -> list[Path]:
    candidates: list[Path] = []

    module_path = Path(__file__).resolve()
    for ancestor in (module_path.parent, *module_path.parents):
        candidates.append(ancestor / "packages/core/agent-tools")
        candidates.append(ancestor / "agent-tools")

    if sys.argv and sys.argv[0]:
        executable_dir = Path(sys.argv[0]).resolve().parent
        candidates.append(executable_dir / "agent-tools")
        candidates.append(executable_dir / "packages/core/agent-tools")

    cwd = Path.cwd()
    candidates.append(cwd / "agent-tools")
    candidates.append(cwd / "packages/core/agent-tools")

    return list(_dedupe_paths(candidates))


def _dedupe_paths(paths: Iterable[Path | str]) -> list[Path]:
    seen: set[str] = set()
    result: list[Path] = []
    for raw_path in paths:
        path = Path(raw_path).expanduser()
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        result.append(path)
    return result
