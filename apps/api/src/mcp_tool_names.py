"""Static tool-name projection shared by discovery and MCP transports.

Names convey no authority. Every lookup and execution still checks the current grant.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from typing import Any

from .agent_manifest_paths import agent_tool_manifest_path

DNAFORGE_TOOL_META_KEY = "com.dnaforge/tool"


@lru_cache(maxsize=1)
def _renderer_provider_names() -> dict[str, str]:
    manifest = json.loads(
        agent_tool_manifest_path("renderer-tool-manifest.json").read_text(
            encoding="utf-8"
        )
    )
    aliases = manifest.get("providerToolNames", {})
    if not isinstance(aliases, dict) or not all(
        isinstance(name, str) and isinstance(alias, str)
        for name, alias in aliases.items()
    ):
        raise ValueError("Invalid renderer provider tool-name aliases.")
    return aliases


def canonical_renderer_tool_name(name: str) -> str:
    """Shared registered aliases use one action identity in every companion mode."""
    return next(
        (
            canonical
            for canonical, alias in _renderer_provider_names().items()
            if alias == name
        ),
        name,
    )


def portable_tool_catalog(
    raw_tools: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """Reuse registered aliases and map other external names without losing tools."""

    registered_names = {
        tool.get("name") for tool in raw_tools if isinstance(tool.get("name"), str)
    }
    renderer_aliases = _renderer_provider_names()
    renderer_canonical_names = {alias: name for name, alias in renderer_aliases.items()}
    projected: list[dict[str, Any]] = []
    canonical_names: dict[str, str] = {}
    for raw in raw_tools:
        name = raw.get("name")
        if not isinstance(name, str) or not name:
            raise ValueError("Discovered tools must have a non-empty name.")
        alias = renderer_aliases.get(name, re.sub(r"[^A-Za-z0-9_-]", "_", name))
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", alias):
            raise ValueError(
                f"Tool name cannot be represented for external clients: {name}"
            )
        if alias != name and alias in registered_names:
            if renderer_aliases.get(name) == alias:

                continue
            raise ValueError(f"External tool-name collision: {name} and {alias}")
        execution_name = renderer_canonical_names.get(name, name)
        if alias in canonical_names and canonical_names[alias] != execution_name:
            raise ValueError(f"External tool-name collision for {alias}")

        canonical_names[alias] = execution_name
        wire_tool = dict(raw, name=alias)
        if alias != execution_name:
            meta = dict(raw.get("_meta") if isinstance(raw.get("_meta"), dict) else {})
            original = meta.get(DNAFORGE_TOOL_META_KEY)
            dnaforge_meta = dict(original) if isinstance(original, dict) else {}
            dnaforge_meta["canonicalName"] = execution_name
            meta[DNAFORGE_TOOL_META_KEY] = dnaforge_meta
            wire_tool["_meta"] = meta
        projected.append(wire_tool)
    return projected, canonical_names
