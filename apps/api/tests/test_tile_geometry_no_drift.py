""" P2 — TS<->Python tile-geometry NO-DRIFT gate.

The renderer (``packages/core/genome-renderer/src/engine/constants.ts``) and the
sidecar (``src/services/tile_geometry.py``) each own a copy of the LOD constants
(``TILE_PX``, ``BASE_BIN_BP``, ``LEVEL_FACTOR``) and the ``tileSpanBp`` / tile-index
math. They CANNOT share a module across the TS/Python boundary, so this test is
the single mechanism that prevents them from drifting: it PARSES the constants out
of the TS file and asserts the Python values + derived functions match across the
whole GRCh38 level range.

If anyone edits one side and not the other, this test goes RED — an off-by-one or
factor change is seam misregistration on screen (a tile the renderer requests and
the tile the sidecar serves would cover different bp).

FAIL-LOUD distinction: if the TS file is missing or the constants can't be parsed,
the test fails as ``INVALID RUN`` (the harness is broken), NOT as a drift RED.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from src.services import tile_geometry as tg

_TS_CONSTANTS_REL = "packages/core/genome-renderer/src/engine/constants.ts"


def _repo_root() -> Path:
    """Nearest ancestor of this test that contains ``pnpm-workspace.yaml`` (the monorepo root)."""
    for parent in Path(__file__).resolve().parents:
        if (parent / "pnpm-workspace.yaml").is_file():
            return parent
    pytest.fail(
        "INVALID RUN: could not locate monorepo root (no pnpm-workspace.yaml ancestor)"
    )


def _parse_ts_int_const(text: str, name: str) -> int:
    """Pull ``export const NAME = <int>;`` out of the TS source."""
    m = re.search(rf"export\s+const\s+{re.escape(name)}\s*=\s*(\d+)\s*;", text)
    if not m:
        pytest.fail(
            f"INVALID RUN: could not parse TS constant {name} from {_TS_CONSTANTS_REL}"
        )
    return int(m.group(1))


@pytest.fixture(scope="module")
def ts_constants() -> dict[str, int]:
    path = _repo_root() / _TS_CONSTANTS_REL
    if not path.is_file():
        pytest.fail(f"INVALID RUN: TS constants file missing -- {path}")
    text = path.read_text(encoding="utf-8")
    return {
        "TILE_PX": _parse_ts_int_const(text, "TILE_PX"),
        "BASE_BIN_BP": _parse_ts_int_const(text, "BASE_BIN_BP"),
        "LEVEL_FACTOR": _parse_ts_int_const(text, "LEVEL_FACTOR"),
    }


def test_scalar_constants_match_ts(ts_constants):
    assert tg.TILE_PX == ts_constants["TILE_PX"]
    assert tg.BASE_BIN_BP == ts_constants["BASE_BIN_BP"]
    assert tg.LEVEL_FACTOR == ts_constants["LEVEL_FACTOR"]


def test_tile_span_bp_matches_ts_formula_across_levels(ts_constants):
    """``tileSpanBp(L) = TILE_PX * BASE_BIN_BP * LEVEL_FACTOR**L`` — computed from
    the PARSED TS constants — equals the Python ``tile_span_bp`` for every level
    GRCh38 uses (~22 levels for chr1; test a generous 0..30)."""
    tile_px = ts_constants["TILE_PX"]
    base = ts_constants["BASE_BIN_BP"]
    factor = ts_constants["LEVEL_FACTOR"]
    for level in range(0, 31):
        expected_bin = base * (factor**level)
        expected_span = tile_px * expected_bin
        assert tg.bin_bp(level) == expected_bin, f"bin_bp drift at level {level}"
        assert (
            tg.tile_span_bp(level) == expected_span
        ), f"tile_span_bp drift at level {level}"


def test_tile_index_is_end_exclusive(ts_constants):
    """Tile ``i`` owns ``[i*span, (i+1)*span)``: the span boundary belongs to the
    NEXT tile (floor division). A ``>`` vs ``>=`` flip on either side desyncs the
    seam — this pins the exclusive end."""
    for level in (0, 5, 10):
        span = tg.tile_span_bp(level)
        assert tg.tile_index(3 * span, level) == 3
        assert tg.tile_index(4 * span - 1, level) == 3
        assert tg.tile_index(4 * span, level) == 4
        assert tg.tile_global_start(3, level) == 3 * span
        assert tg.tile_global_end(3, level) == 4 * span
