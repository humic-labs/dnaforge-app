"""Register built-in capabilities (alignment, primer design, restriction analysis).

These are always available -- either Python built-in or system binaries.
"""

import shutil

from .registry import Capability, Component, toolbox_registry


def _find_mafft() -> str | None:
    """Find MAFFT binary — check bundled dir, auto-downloaded dir, then system PATH."""
    import os
    from pathlib import Path

    from .executable_paths import executable_variants

    bundled = os.environ.get("WAYPOINT_BINARIES_PATH")
    if bundled:
        for candidate in executable_variants(Path(bundled) / "mafft"):
            if candidate.exists():
                return str(candidate)

    try:
        from ..annotation.tools import TOOL_REGISTRY, get_tools_dir, validate_tools
        from .executable_paths import get_platform_suffix

        tools_status = validate_tools(get_tools_dir())
        if tools_status.get("mafft", False):
            suffix = get_platform_suffix()
            mafft_entry = TOOL_REGISTRY.get("mafft", {})
            pdata = mafft_entry.get("platforms", {}).get(suffix, {})
            mafft_archive_path = pdata.get("binaries", {}).get("mafft")
            if mafft_archive_path:
                p = get_tools_dir() / mafft_archive_path
                if p.exists():
                    return str(p)
    except Exception:
        pass

    return shutil.which("mafft")


def register_builtin_capabilities() -> None:
    """Register all non-annotation built-in capabilities."""

    mafft_path = _find_mafft()
    toolbox_registry.register(
        Capability(
            id="alignment",
            label="Sequence Alignment",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[
                Component(
                    id="mafft",
                    label="MAFFT",
                    status="ready" if mafft_path else "unavailable",
                    source=(
                        "auto-download"
                        if mafft_path and "tools" in (mafft_path or "")
                        else "system"
                    ),
                    path=mafft_path,
                ),
            ],
        )
    )

    toolbox_registry.register(
        Capability(
            id="primer_design",
            label="Primer Design",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[
                Component(
                    id="primer3",
                    label="Primer3",
                    status="ready",
                    source="builtin",
                ),
            ],
        )
    )

    toolbox_registry.register(
        Capability(
            id="restriction_analysis",
            label="Restriction Analysis",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[
                Component(
                    id="restriction-sites",
                    label="Built-in restriction engine",
                    status="ready",
                    source="builtin",
                ),
            ],
        )
    )
