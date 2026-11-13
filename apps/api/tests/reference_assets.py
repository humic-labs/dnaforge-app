"""Locate members of the prepared default hosted references for tests.

Genome-scale tests run against real default references (GRCh38, dm6, sacCer3)
prepared by the desktop app, never standalone single-chromosome fixtures. This
mirrors the desktop's cache-root rule: `DNAFORGE_REFERENCE_ASSET_ROOT`, else
`<app data>/DNAForge/reference-assets`. The current generation is named by the
assembly's `current-reference-assets.v1.json` pointer.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Optional


def reference_asset_root() -> Path:
    override = os.environ.get("DNAFORGE_REFERENCE_ASSET_ROOT", "").strip()
    if override:
        return Path(override)
    if sys.platform == "darwin":
        app_data = Path.home() / "Library" / "Application Support"
    elif sys.platform == "win32":
        app_data = Path(os.environ.get("APPDATA", Path.home()))
    else:
        app_data = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return app_data / "DNAForge" / "reference-assets"


def prepared_member(assembly: str, chrom: str, suffix: str) -> Optional[Path]:
    """Path to `<chrom><suffix>` inside the current prepared `assembly`, or None."""
    assembly_root = reference_asset_root() / assembly
    pointer = assembly_root / "current-reference-assets.v1.json"
    try:
        publication_id = json.loads(pointer.read_text())["publicationId"]
    except (OSError, ValueError, KeyError):
        return None
    member = (
        assembly_root
        / "generations"
        / publication_id
        / "prepared"
        / chrom
        / f"{chrom}{suffix}"
    )
    return member if member.is_file() else None
