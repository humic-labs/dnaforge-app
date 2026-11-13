#!/usr/bin/env python3
"""Compatibility entry point for the SDK-backed DNAForge MCP companion."""

from __future__ import annotations

import os
import sys
from collections.abc import Sequence
from pathlib import Path

API_ROOT = Path(__file__).resolve().parents[1]
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from src.mcp_companion import main as sdk_main  # noqa: E402

__all__ = ["main"]


def main(argv: Sequence[str] | None = None) -> int:
    """Preserve the retired script's env contract, then enter the SDK server.

    The old companion always sent an explicit capability header, including an
    empty list when no legacy env was configured. Keep that attenuation for
    callers of this compatibility path; the native ``run_server.py
    --mcp-stdio`` path retains the new unspecified-scope semantics.
    """

    derived_names = (
        "DNAFORGE_MCP_AGENT_IDENTITY",
        "DNAFORGE_MCP_GRANT_CAPABILITIES",
    )
    previous = {name: os.environ[name] for name in derived_names if name in os.environ}
    os.environ.setdefault(
        "DNAFORGE_MCP_AGENT_IDENTITY",
        os.environ.get("DNAFORGE_AGENT_IDENTITY", "local-agent"),
    )
    os.environ.setdefault(
        "DNAFORGE_MCP_GRANT_CAPABILITIES",
        os.environ.get("DNAFORGE_AGENT_CAPABILITIES", ""),
    )
    try:
        return sdk_main(argv)
    finally:
        for name in derived_names:
            if name in previous:
                os.environ[name] = previous[name]
            else:
                os.environ.pop(name, None)


if __name__ == "__main__":
    raise SystemExit(main())
