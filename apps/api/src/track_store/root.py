"""Where bulk DNAForge data lives on this machine.

The twin of apps/desktop/src/main/track-store/data-root.ts: the same variable,
the same defaults, byte for byte, so Electron main and the sidecar agree on
the directory without main having to send a path. Electron does send its
resolved root as DNAFORGE_DATA_ROOT anyway, which makes the override branch
the one that runs inside the app; the platform defaults are for the
standalone CLI and `dnaforge jobs serve`.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Mapping

DNAFORGE_DATA_ROOT_ENV = "DNAFORGE_DATA_ROOT"


def resolve_dnaforge_data_root(
    env: Mapping[str, str] | None = None,
    platform: str | None = None,
    home: Path | None = None,
) -> Path:
    env = os.environ if env is None else env
    platform = sys.platform if platform is None else platform
    home = Path.home() if home is None else home
    override = (env.get(DNAFORGE_DATA_ROOT_ENV) or "").strip()
    if override:
        candidate = Path(override)
        if not candidate.is_absolute():
            raise ValueError(f"{DNAFORGE_DATA_ROOT_ENV} must be an absolute path.")
        return candidate
    if platform.startswith("win"):
        local = (env.get("LOCALAPPDATA") or "").strip()
        base = Path(local) if local else home / "AppData" / "Local"
        return base / "DNAForge"
    if platform == "darwin":
        return home / "Library" / "Application Support" / "DNAForge"
    xdg = (env.get("XDG_DATA_HOME") or "").strip()
    base = Path(xdg) if xdg and Path(xdg).is_absolute() else home / ".local" / "share"
    return base / "DNAForge"


def track_store_root(
    env: Mapping[str, str] | None = None,
    platform: str | None = None,
    home: Path | None = None,
) -> Path:
    return resolve_dnaforge_data_root(env, platform, home) / "tracks"


__all__ = ["DNAFORGE_DATA_ROOT_ENV", "resolve_dnaforge_data_root", "track_store_root"]
