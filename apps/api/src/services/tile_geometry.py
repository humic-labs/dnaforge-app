""" P2 — Python mirror of the shared tiled-LOD engine geometry.

The renderer-side source of truth is
``packages/core/genome-renderer/src/engine/constants.ts``. The sidecar tile
routes MUST compute the SAME ``tileSpanBp(level)`` / tile index math, or a tile
the renderer asks for and the tile the sidecar serves cover different bp ranges
— an off-by-one here is seam misregistration on screen.

These constants are duplicated here ON PURPOSE (Python cannot import the .ts) and
pinned against the TS file by ``test_tile_geometry_no_drift.py``, which parses the
TS constants and asserts equality with these values across the whole level range.
If anyone edits one side and not the other, that test goes RED.
"""

from __future__ import annotations

TILE_PX = 1024
BASE_BIN_BP = 1
LEVEL_FACTOR = 2


def bin_bp(level: int) -> int:
    """bp per bin at ``level`` — mirrors TS ``binBp``."""
    if level < 0:
        raise ValueError("level must be >= 0")
    return BASE_BIN_BP * (LEVEL_FACTOR**level)


def tile_span_bp(level: int) -> int:
    """bp spanned by one whole tile at ``level`` — mirrors TS ``tileSpanBp``."""
    return TILE_PX * bin_bp(level)


def tile_index(global_bp: int, level: int) -> int:
    """End-exclusive tile index owning ``global_bp`` at ``level``.

    Tile ``i`` owns ``[i*tile_span_bp(L), (i+1)*tile_span_bp(L))`` — mirrors TS
    ``tileIndex`` (floor division).
    """
    if global_bp < 0:
        raise ValueError("global_bp must be >= 0")
    return global_bp // tile_span_bp(level)


def tile_global_start(index: int, level: int) -> int:
    """Inclusive global-bp start of tile ``index`` at ``level``."""
    return index * tile_span_bp(level)


def tile_global_end(index: int, level: int) -> int:
    """Exclusive global-bp end of tile ``index`` at ``level``."""
    return (index + 1) * tile_span_bp(level)


FINE_BIN_BP_MAX = 256


def is_fine_level(level: int) -> bool:
    """True when a tile at ``level`` is fine enough for vector glyphs / reads."""
    return bin_bp(level) <= FINE_BIN_BP_MAX
