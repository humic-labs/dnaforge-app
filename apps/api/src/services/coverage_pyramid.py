""" SPIKE 1 GREEN — bounded-memory coverage peak-base pyramid.

Kills keystone risk #1: a COARSE coverage tile spanning all of chr1 (248,956,422
bp) must NOT allocate ``np.zeros(span+1)`` (the ~3.7 GB OOM ``coverage_region``
commits today). The fix, per
docs/plans/2026-06-24-genome-engine-VALIDATED-BUILD-PLAN.md §3.1:

  1. Compute a base per-bin PEAK layer ONCE per
     (source, explicit reference, exact engine, cache contract, chrom) at a
     fixed, bounded bin granularity (``BASE_BINS`` bins for the whole
     chromosome) and PERSIST it to disk.
  2. Derive ANY coarser tile by mean-pooling that stored finer layer. The
     regional mean stays on the same vertical scale when the requested level
     changes, avoiding the systematic cross-LOD step introduced by max-pooling.

Bounded memory, two ways:
  - The persisted base layer is ``BASE_BINS`` float32 values (128 MiB for
    33,554,432 bins), never the span, and cached reads are memory-mapped.
  - The base layer is BUILT by streaming the chromosome in fixed ``WINDOW_BP``
    windows; the only per-base array ever allocated is one window's difference
    array (~``WINDOW_BP`` int32 = 4 MiB for a 1 Mb window), reused across windows.
    The full-span per-base array is NEVER materialized.

The Python heap for a coarse whole-chromosome tile stays bounded to the window
and tile arrays; the 128 MiB persisted base layer is mapped instead of heap-copied.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterator, Literal, Optional, TypedDict

try:
    import fcntl
except ImportError:  # pragma: no cover - dna-coverage is not packaged on Windows yet
    fcntl = None

import numpy as np

from ..compute_scheduling import prefer_current_thread
from .dna_coverage_shellout import (
    DnaCoverageError,
    coverage_engine_identity,
    run_build_base_layer,
    run_coverage_tile,
    use_rust_coverage,
)
from .pileup import (
    BamNotFoundError,
    _is_remote_bam,
    _open_alignment,
    _resolve_bam_path,
    _resolve_index_path,
    _resolve_reference_path,
    accumulate_alignment_depth,
)

BASE_BINS = 33_554_432


WINDOW_BP = 1_000_000


LOCAL_TILE_COVERAGE_MAX_BP = 1_100_000

_CACHE_DIR_ENV = "WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR"
_LEGACY_CACHE_DIRS_ENV = "WAYPOINT_COVERAGE_PYRAMID_LEGACY_DIRS"
_DEFAULT_CACHE_SUBDIR = "waypoint-coverage-pyramid"
_LEGACY_CACHE_CONTRACT_TOKEN = (
    "coverage-pyramid-v5-fine8bp-bam-index-reference-contract"
)
_CACHE_CONTRACT_TOKEN = "coverage-pyramid-v7-aligned-query-bases"
_MANIFEST_VERSION = 1
_BASE_LAYER_LOCKS_GUARD = threading.Lock()


class _BaseLayerLockOwner:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.users = 0


_BASE_LAYER_LOCKS: dict[str, _BaseLayerLockOwner] = {}
_PRECOMPUTE_WORKERS_ENV = "WAYPOINT_COVERAGE_PRECOMPUTE_WORKERS"
_HTSLIB_THREADS_ENV = "WAYPOINT_COVERAGE_HTSLIB_THREADS"
_BASE_LAYER_MEMORY_CACHE_BYTES_ENV = "WAYPOINT_COVERAGE_BASE_LAYER_MEMORY_CACHE_BYTES"
_BASE_LAYER_MEMORY_CACHE_DEFAULT_BYTES = 128 * 1024 * 1024
_BASE_LAYER_MEMORY_CACHE_GUARD = threading.Lock()
_BASE_LAYER_MEMORY_CACHE: "OrderedDict[str, tuple[int, int, int, np.ndarray]]" = (
    OrderedDict()
)
_BASE_LAYER_MEMORY_CACHE_TOTAL_BYTES = 0


_REFERENCE_LENGTHS_GUARD = threading.Lock()
_REFERENCE_LENGTHS_CACHE: "OrderedDict[str, dict[str, int]]" = OrderedDict()
_REFERENCE_LENGTHS_CACHE_MAX = 16


class CoverageProvenance(TypedDict):
    method: Literal[
        "local-window-peak",
        "rust-htslib-window-peak",
        "rust-htslib-base-layer",
        "python-window-base-layer",
        "pyramid-maxpool",
        "empty-outside-chrom",
    ]
    exact: bool


class CoverageTile(TypedDict):
    chrom: str
    start: int
    end: int
    bins: list[float]
    binSize: int
    maxDepth: float
    provenance: CoverageProvenance


class CoverageAssemblySegmentRequest(TypedDict):
    chrom: str
    start: int
    end: int
    globalStart: int


class CoverageAssemblySegmentTile(CoverageTile):
    globalStart: int
    globalEnd: int


class CoverageAssemblyTile(TypedDict):
    segments: list[CoverageAssemblySegmentTile]
    maxDepth: float
    provenance: CoverageProvenance


class CoveragePyramidReadiness(TypedDict, total=False):
    alignedBaseCount: int
    meanDepth: float
    chrom: str
    present: bool
    chromLength: int
    baseBinBp: int
    cachePath: str
    sizeBytes: int
    reason: str


class CoveragePyramidPrecomputeResult(TypedDict, total=False):
    chrom: str
    present: bool
    built: bool
    chromLength: int
    baseBinBp: int
    cachePath: str
    sizeBytes: int
    maxDepth: float
    alignedBaseCount: int
    meanDepth: float
    durationMs: float
    reason: str
    provenance: CoverageProvenance


class CoveragePyramidMissingError(RuntimeError):
    """Raised when a coarse exact tile needs a prebuilt pyramid that is absent."""


def _cache_dir() -> Path:
    override = os.environ.get(_CACHE_DIR_ENV)
    base = (
        Path(override)
        if override
        else Path.home() / ".dnaforge" / _DEFAULT_CACHE_SUBDIR
    )
    base.mkdir(parents=True, exist_ok=True)
    return base


@contextmanager
def _base_layer_lock(cache_path: Path) -> Iterator[None]:
    """One cold-build lock per immutable artifact path, across app processes."""
    key = str(cache_path)
    with _BASE_LAYER_LOCKS_GUARD:
        owner = _BASE_LAYER_LOCKS.get(key)
        if owner is None:
            owner = _BaseLayerLockOwner()
            _BASE_LAYER_LOCKS[key] = owner
        owner.users += 1
    try:
        with owner.lock:
            lock_path = cache_path.with_suffix(cache_path.suffix + ".lock")
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            with lock_path.open("a+b") as handle:
                if fcntl is not None:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    if fcntl is not None:
                        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        with _BASE_LAYER_LOCKS_GUARD:
            owner.users -= 1
            if owner.users == 0 and _BASE_LAYER_LOCKS.get(key) is owner:
                _BASE_LAYER_LOCKS.pop(key, None)


def _coverage_precompute_workers(chrom_count: int) -> int:
    if chrom_count <= 1:
        return 1
    raw = os.environ.get(_PRECOMPUTE_WORKERS_ENV)
    if raw is not None:
        try:
            return max(1, min(chrom_count, int(raw)))
        except ValueError:
            return 1
    if not use_rust_coverage():
        return 1
    cpu_count = os.cpu_count() or 2
    return max(1, min(chrom_count, 4, cpu_count))


def _coverage_htslib_threads() -> int:
    raw = os.environ.get(_HTSLIB_THREADS_ENV)
    if raw is not None:
        try:
            return max(1, int(raw))
        except ValueError:
            return 1
    cpu_count = os.cpu_count() or 2
    chromosome_workers = _coverage_precompute_workers(24)
    return max(1, min(4, cpu_count // chromosome_workers))


def _base_layer_memory_cache_max_bytes() -> int:
    raw = os.environ.get(_BASE_LAYER_MEMORY_CACHE_BYTES_ENV)
    if raw is None:
        return _BASE_LAYER_MEMORY_CACHE_DEFAULT_BYTES
    try:
        return max(0, int(raw))
    except ValueError:
        return _BASE_LAYER_MEMORY_CACHE_DEFAULT_BYTES


def _clear_base_layer_memory_cache() -> None:
    """Test hook: drop retained coverage base mappings."""
    global _BASE_LAYER_MEMORY_CACHE_TOTAL_BYTES
    with _BASE_LAYER_MEMORY_CACHE_GUARD:
        _BASE_LAYER_MEMORY_CACHE.clear()
        _BASE_LAYER_MEMORY_CACHE_TOTAL_BYTES = 0


def _legacy_local_path_signature(path: Optional[str], label: str) -> str:
    if path is None:
        return f"{label}:none"
    if _is_remote_bam(path):
        return f"{label}:remote:{path}"
    st = os.stat(path)
    return f"{label}:{os.path.abspath(path)}:{st.st_size}:{st.st_mtime_ns}"


def _local_path_signature(path: Optional[str], label: str) -> str:
    if path is None:
        return f"{label}:none"
    if _is_remote_bam(path):
        return f"{label}:remote:{path}"
    st = os.stat(path)
    return f"{label}:local-v1:{st.st_dev}:{st.st_ino}:" f"{st.st_size}:{st.st_mtime_ns}"


def cached_reference_lengths(bam_path: str) -> Optional[dict[str, int]]:
    """Return the cached ``{chrom: length}`` map for ``bam_path``, or ``None``.

    : callers use this to avoid re-opening a multi-GB alignment header on
    the cached-tile hot path. On a miss the caller opens the header ONCE (running
    any CRAM-reference guard), then calls :func:`store_reference_lengths`.
    """
    key = _local_path_signature(bam_path, "reflen")
    with _REFERENCE_LENGTHS_GUARD:
        lengths = _REFERENCE_LENGTHS_CACHE.get(key)
        if lengths is not None:
            _REFERENCE_LENGTHS_CACHE.move_to_end(key)
        return lengths


def store_reference_lengths(bam_path: str, lengths: dict[str, int]) -> None:
    """Cache the ``{chrom: length}`` map for ``bam_path`` (bounded LRU)."""
    key = _local_path_signature(bam_path, "reflen")
    with _REFERENCE_LENGTHS_GUARD:
        _REFERENCE_LENGTHS_CACHE[key] = dict(lengths)
        _REFERENCE_LENGTHS_CACHE.move_to_end(key)
        while len(_REFERENCE_LENGTHS_CACHE) > _REFERENCE_LENGTHS_CACHE_MAX:
            _REFERENCE_LENGTHS_CACHE.popitem(last=False)


def _base_layer_key(
    bam_signature: str,
    reference_signature: str,
    chrom: str,
) -> str:
    """Stable sha1 over semantic data, engine, contract, and chromosome.

    The BAI/CSI is validated access metadata, not scientific output identity.
    Swapping an equivalent index must not force a 122 GiB BAM rebuild.
    """
    if use_rust_coverage():
        try:
            engine_identity = coverage_engine_identity()
        except (DnaCoverageError, OSError, RuntimeError):

            engine_identity = "dna-coverage:unavailable"
    else:
        engine_identity = "python-window-base-layer"
    parts = "\x00".join(
        [
            _CACHE_CONTRACT_TOKEN,
            engine_identity,
            bam_signature,
            reference_signature,
            chrom,
            str(BASE_BINS),
            str(WINDOW_BP),
        ]
    )
    return hashlib.sha1(parts.encode("utf-8")).hexdigest()


def _legacy_base_layer_key(
    bam_signature: str,
    index_signature: str,
    reference_signature: str,
    chrom: str,
) -> str:
    parts = "\x00".join(
        [
            _LEGACY_CACHE_CONTRACT_TOKEN,
            bam_signature,
            index_signature,
            reference_signature,
            chrom,
            str(BASE_BINS),
            str(WINDOW_BP),
        ]
    )
    return hashlib.sha1(parts.encode("utf-8")).hexdigest()


def _base_layer_cache_path(
    resolved: str,
    chrom: str,
    resolved_index: Optional[str] = None,
    resolved_reference: Optional[str] = None,
) -> Path | None:
    if _is_remote_bam(resolved):
        return None
    try:
        bam_signature = _local_path_signature(resolved, "bam")
        reference_signature = _local_path_signature(resolved_reference, "reference")
        key = _base_layer_key(bam_signature, reference_signature, chrom)
    except (OSError, RuntimeError, DnaCoverageError):
        return None
    return _cache_dir() / f"{key}.npy"


def _legacy_cache_dirs() -> list[Path]:
    raw = os.environ.get(_LEGACY_CACHE_DIRS_ENV, "")
    return [
        Path(value)
        for value in raw.split(os.pathsep)
        if value.strip() and Path(value) != _cache_dir()
    ]


def _legacy_base_layer_paths(
    resolved: str,
    chrom: str,
    resolved_index: Optional[str],
    resolved_reference: Optional[str],
) -> list[Path]:
    try:
        key = _legacy_base_layer_key(
            _legacy_local_path_signature(resolved, "bam"),
            _legacy_local_path_signature(resolved_index, "index"),
            _legacy_local_path_signature(resolved_reference, "reference"),
            chrom,
        )
    except OSError:
        return []
    return [directory / f"{key}.npy" for directory in _legacy_cache_dirs()]


def _base_layer_manifest_path(cache_path: Path) -> Path:
    return cache_path.with_suffix(".json")


def _atomic_write_json(path: Path, value: object) -> None:
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=path.name, suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, separators=(",", ":"), sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _write_base_layer_manifest(
    cache_path: Path,
    *,
    chrom: str,
    chrom_len: int,
    max_depth: Optional[float],
    provenance: Optional[CoverageProvenance],
    adopted_from: Optional[str] = None,
    aligned_base_count: Optional[int] = None,
) -> None:
    stat = cache_path.stat()
    _atomic_write_json(
        _base_layer_manifest_path(cache_path),
        {
            "version": _MANIFEST_VERSION,
            "cacheContract": _CACHE_CONTRACT_TOKEN,
            "chrom": chrom,
            "chromLength": chrom_len,
            "baseBins": BASE_BINS,
            "baseBinBp": max(1, -(-chrom_len // BASE_BINS)),
            "sizeBytes": int(stat.st_size),
            "maxDepth": max_depth,
            "provenance": provenance,
            "adoptedFrom": adopted_from,
            **(
                {
                    "alignedBaseCount": aligned_base_count,
                    "meanDepth": aligned_base_count / chrom_len,
                }
                if aligned_base_count is not None
                else {}
            ),
        },
    )


def _read_base_layer_manifest(
    cache_path: Path, *, chrom: str, chrom_len: int
) -> dict | None:
    path = _base_layer_manifest_path(cache_path)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        stat = cache_path.stat()
    except (OSError, ValueError, TypeError):
        return None
    if (
        not isinstance(value, dict)
        or value.get("version") != _MANIFEST_VERSION
        or value.get("cacheContract") != _CACHE_CONTRACT_TOKEN
        or value.get("chrom") != chrom
        or value.get("chromLength") != chrom_len
        or value.get("baseBins") != BASE_BINS
        or value.get("sizeBytes") != int(stat.st_size)
    ):
        return None
    return value


def _adopt_legacy_base_layer(
    cache_path: Path,
    *,
    resolved: str,
    resolved_index: Optional[str],
    resolved_reference: Optional[str],
    chrom: str,
    chrom_len: int,
) -> Optional[str]:
    if cache_path.is_file():
        return None
    for legacy_path in _legacy_base_layer_paths(
        resolved, chrom, resolved_index, resolved_reference
    ):
        if not legacy_path.is_file():
            continue
        if (
            _read_base_layer_manifest(legacy_path, chrom=chrom, chrom_len=chrom_len)
            is None
        ):
            continue
        try:
            _load_cached_base_layer(legacy_path)
        except (OSError, ValueError):
            continue
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = cache_path.with_name(
            f".{cache_path.name}.adopt-{os.getpid()}-{threading.get_ident()}"
        )
        try:
            try:
                os.link(legacy_path, tmp_path)
            except OSError:
                shutil.copy2(legacy_path, tmp_path)
            os.replace(tmp_path, cache_path)
            _write_base_layer_manifest(
                cache_path,
                chrom=chrom,
                chrom_len=chrom_len,
                max_depth=None,
                provenance=None,
                adopted_from=str(legacy_path),
            )
            return str(legacy_path)
        finally:
            try:
                tmp_path.unlink()
            except OSError:
                pass
    return None


def _depth_scale_cache_path(
    resolved: str,
    resolved_index: Optional[str],
    resolved_reference: Optional[str],
    percentile: float,
) -> Path | None:
    if _is_remote_bam(resolved):
        return None
    try:
        bam_signature = _local_path_signature(resolved, "bam")
        index_signature = _local_path_signature(resolved_index, "index")
        reference_signature = _local_path_signature(resolved_reference, "reference")
    except OSError:
        return None
    key = hashlib.sha1(
        ":".join(
            [
                _CACHE_CONTRACT_TOKEN,
                bam_signature,
                index_signature,
                reference_signature,
                "genome-depth-scale",
                str(percentile),
                str(BASE_BINS),
            ]
        ).encode("utf-8")
    ).hexdigest()
    return _cache_dir() / f"{key}.scale.json"


def _depth_percentiles_cache_path(
    resolved: str,
    resolved_index: Optional[str],
    resolved_reference: Optional[str],
) -> Path | None:
    if _is_remote_bam(resolved):
        return None
    try:
        bam_signature = _local_path_signature(resolved, "bam")
        index_signature = _local_path_signature(resolved_index, "index")
        reference_signature = _local_path_signature(resolved_reference, "reference")
    except OSError:
        return None
    key = hashlib.sha1(
        ":".join(
            [
                _CACHE_CONTRACT_TOKEN,
                bam_signature,
                index_signature,
                reference_signature,
                "genome-depth-percentiles",
                str(BASE_BINS),
            ]
        ).encode("utf-8")
    ).hexdigest()
    return _cache_dir() / f"{key}.percentiles.json"


_DEPTH_SUMMARY_MEMO_GUARD = threading.Lock()
_DEPTH_SUMMARY_MEMO_MAX = 16
_DEPTH_SCALE_MEMO: "OrderedDict[str, dict]" = OrderedDict()
_DEPTH_PERCENTILES_MEMO: "OrderedDict[str, dict]" = OrderedDict()


def _read_depth_summary_memo(memo: "OrderedDict[str, dict]", key: str) -> dict | None:
    with _DEPTH_SUMMARY_MEMO_GUARD:
        value = memo.get(key)
        if value is not None:
            memo.move_to_end(key)
        return value


def _store_depth_summary_memo(
    memo: "OrderedDict[str, dict]", key: str, value: dict
) -> None:
    with _DEPTH_SUMMARY_MEMO_GUARD:
        memo[key] = value
        memo.move_to_end(key)
        while len(memo) > _DEPTH_SUMMARY_MEMO_MAX:
            memo.popitem(last=False)


def _clear_depth_summary_memos() -> None:
    with _DEPTH_SUMMARY_MEMO_GUARD:
        _DEPTH_SCALE_MEMO.clear()
        _DEPTH_PERCENTILES_MEMO.clear()


def genome_wide_depth_scale(
    resolved: str,
    chroms: list[str],
    resolved_index: Optional[str] = None,
    resolved_reference: Optional[str] = None,
    percentile: float = 98.0,
    check_cancelled: Callable[[], None] | None = None,
) -> Optional[dict]:
    """Genome-wide coverage-depth scale reference  Ask 1).

    A STABLE vertical-scale denominator so the histogram height stops moving with
    scroll position and LOD. We accumulate a depth histogram across every chromosome's
    cached base layer and return the ``percentile`` depth (outlier-robust, unlike max)
    plus the true max. Computed once and cached to JSON keyed like the pyramid, so it is
    free after the first call. Only counts real in-chromosome bins (base layers are
    zero-padded to BASE_BINS). Note: the base layer is already 8bp-binned, so this is the
    percentile of 8bp-bin maxes — negligibly higher than per-base and, crucially, the
    SAME everywhere, which is the whole point.
    """
    if check_cancelled is not None:
        check_cancelled()
    cache_path = _depth_scale_cache_path(
        resolved, resolved_index, resolved_reference, percentile
    )
    memo_key = str(cache_path) if cache_path is not None else None
    if memo_key is not None:
        memoized = _read_depth_summary_memo(_DEPTH_SCALE_MEMO, memo_key)
        if memoized is not None:
            return memoized
    if cache_path is not None and cache_path.exists():
        try:
            data = json.loads(cache_path.read_text())
            if memo_key is not None:
                _store_depth_summary_memo(_DEPTH_SCALE_MEMO, memo_key, data)
            return data
        except Exception:
            pass

    lengths = cached_reference_lengths(resolved) or {}
    hist: Optional[np.ndarray] = None
    for chrom in chroms:
        if check_cancelled is not None:
            check_cancelled()
        path = _base_layer_cache_path(
            resolved, chrom, resolved_index, resolved_reference
        )
        if path is None or not path.exists():
            continue
        try:
            base = _load_cached_base_layer(path)
        except Exception:
            continue
        chrom_len = lengths.get(chrom)
        if chrom_len:
            base_bin_bp = max(1, -(-chrom_len // BASE_BINS))
            real_bins = min(len(base), -(-chrom_len // base_bin_bp))
            base = base[:real_bins]
        vals = np.rint(base).astype(np.int64)
        vals = vals[vals >= 0]
        if vals.size == 0:
            continue
        h = np.bincount(vals)
        if hist is None:
            hist = h
        else:
            n = max(len(hist), len(h))
            if len(hist) < n:
                hist = np.pad(hist, (0, n - len(hist)))
            if len(h) < n:
                h = np.pad(h, (0, n - len(h)))
            hist = hist + h

    if check_cancelled is not None:
        check_cancelled()
    if hist is None or int(hist.sum()) == 0:
        return None
    total = int(hist.sum())
    cum = np.cumsum(hist)
    target = total * (percentile / 100.0)
    scale_depth = int(np.searchsorted(cum, target))
    result = {
        "percentile": percentile,
        "scaleDepth": max(1, scale_depth),
        "maxDepth": int(len(hist) - 1),
        "totalBins": total,
    }
    if check_cancelled is not None:
        check_cancelled()
    if cache_path is not None:
        try:
            cache_path.write_text(json.dumps(result))
        except Exception:
            pass
    if memo_key is not None:
        _store_depth_summary_memo(_DEPTH_SCALE_MEMO, memo_key, result)
    return result


def genome_wide_depth_percentiles(
    resolved: str,
    chroms: list[str],
    resolved_index: Optional[str] = None,
    resolved_reference: Optional[str] = None,
    check_cancelled: Callable[[], None] | None = None,
) -> Optional[dict]:
    """Genome-wide coverage-depth percentiles  histogram A/B).

    A STABLE set of vertical-scale denominators so the histogram height stops
    moving with scroll position and LOD. We accumulate a depth histogram across
    every chromosome's cached base layer — identical accumulation to
    ``genome_wide_depth_scale`` — and derive p50/p90/p95/p99 plus the true max
    from ONE cumulative sum. Computed once and cached to JSON keyed like the
    pyramid, so it is free after the first call. Only counts real in-chromosome
    bins (base layers are zero-padded to BASE_BINS). Note: the base layer is
    already 8bp-binned, so these are percentiles of 8bp-bin maxes — negligibly
    higher than per-base and, crucially, the SAME everywhere, which is the point.
    """
    if check_cancelled is not None:
        check_cancelled()
    cache_path = _depth_percentiles_cache_path(
        resolved, resolved_index, resolved_reference
    )
    memo_key = str(cache_path) if cache_path is not None else None
    if memo_key is not None:
        memoized = _read_depth_summary_memo(_DEPTH_PERCENTILES_MEMO, memo_key)
        if memoized is not None:
            return memoized
    if cache_path is not None and cache_path.exists():
        try:
            data = json.loads(cache_path.read_text())
            if memo_key is not None:
                _store_depth_summary_memo(_DEPTH_PERCENTILES_MEMO, memo_key, data)
            return data
        except Exception:
            pass

    lengths = cached_reference_lengths(resolved) or {}
    hist: Optional[np.ndarray] = None
    for chrom in chroms:
        if check_cancelled is not None:
            check_cancelled()
        path = _base_layer_cache_path(
            resolved, chrom, resolved_index, resolved_reference
        )
        if path is None or not path.exists():
            continue
        try:
            base = _load_cached_base_layer(path)
        except Exception:
            continue
        chrom_len = lengths.get(chrom)
        if chrom_len:
            base_bin_bp = max(1, -(-chrom_len // BASE_BINS))
            real_bins = min(len(base), -(-chrom_len // base_bin_bp))
            base = base[:real_bins]
        vals = np.rint(base).astype(np.int64)
        vals = vals[vals >= 0]
        if vals.size == 0:
            continue
        h = np.bincount(vals)
        if hist is None:
            hist = h
        else:
            n = max(len(hist), len(h))
            if len(hist) < n:
                hist = np.pad(hist, (0, n - len(hist)))
            if len(h) < n:
                h = np.pad(h, (0, n - len(h)))
            hist = hist + h

    if check_cancelled is not None:
        check_cancelled()
    if hist is None or int(hist.sum()) == 0:
        return None
    total = int(hist.sum())
    cum = np.cumsum(hist)

    def _q(p: float) -> int:
        return max(1, int(np.searchsorted(cum, total * (p / 100.0))))

    result = {
        "p50": _q(50.0),
        "p90": _q(90.0),
        "p95": _q(95.0),
        "p99": _q(99.0),
        "max": int(len(hist) - 1),
    }
    if check_cancelled is not None:
        check_cancelled()
    if cache_path is not None:
        try:
            cache_path.write_text(json.dumps(result))
        except Exception:
            pass
    if memo_key is not None:
        _store_depth_summary_memo(_DEPTH_PERCENTILES_MEMO, memo_key, result)
    return result


def _atomic_write_npy(path: Path, arr: np.ndarray) -> None:
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=path.name, suffix=".tmp"
    )
    os.close(fd)
    try:
        np.save(tmp_name, arr, allow_pickle=False)

        os.replace(tmp_name + ".npy", path)
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
    except BaseException:
        for candidate in (tmp_name, tmp_name + ".npy"):
            try:
                os.unlink(candidate)
            except OSError:
                pass
        raise


def _load_cached_base_layer(path: Path) -> np.ndarray:
    global _BASE_LAYER_MEMORY_CACHE_TOTAL_BYTES
    stat = path.stat()
    key = str(path)
    max_bytes = _base_layer_memory_cache_max_bytes()
    if max_bytes > 0:
        with _BASE_LAYER_MEMORY_CACHE_GUARD:
            cached = _BASE_LAYER_MEMORY_CACHE.get(key)
            if (
                cached is not None
                and cached[0] == stat.st_size
                and cached[1] == stat.st_mtime_ns
            ):
                _BASE_LAYER_MEMORY_CACHE.move_to_end(key)
                return cached[3]

    base = np.load(path, mmap_mode="r", allow_pickle=False)
    if base.ndim != 1 or int(base.shape[0]) != BASE_BINS:
        raise ValueError(
            f"coverage pyramid cache shape mismatch: expected ({BASE_BINS},), got {base.shape}"
        )
    base = np.asarray(base)
    base.setflags(write=False)
    item_bytes = int(base.nbytes)
    if max_bytes > 0 and item_bytes <= max_bytes:
        with _BASE_LAYER_MEMORY_CACHE_GUARD:
            old = _BASE_LAYER_MEMORY_CACHE.pop(key, None)
            if old is not None:
                _BASE_LAYER_MEMORY_CACHE_TOTAL_BYTES -= old[2]
            _BASE_LAYER_MEMORY_CACHE[key] = (
                int(stat.st_size),
                int(stat.st_mtime_ns),
                item_bytes,
                base,
            )
            _BASE_LAYER_MEMORY_CACHE_TOTAL_BYTES += item_bytes
            while (
                _BASE_LAYER_MEMORY_CACHE_TOTAL_BYTES > max_bytes
                and len(_BASE_LAYER_MEMORY_CACHE) > 1
            ):
                _, evicted = _BASE_LAYER_MEMORY_CACHE.popitem(last=False)
                _BASE_LAYER_MEMORY_CACHE_TOTAL_BYTES -= evicted[2]
    return base


def _build_base_layer(
    resolved: str,
    resolved_index: Optional[str],
    resolved_reference: Optional[str],
    chrom: str,
    chrom_len: int,
) -> tuple[np.ndarray, Optional[int]]:
    """Stream the whole chromosome and return a length-BASE_BINS float32 array of
    PEAK per-base depth per base-bin. Never allocates a full-span array.

    Per base-bin peak is computed by, for each WINDOW_BP window, building a local
    per-base depth (difference array over the window only), then max-pooling each
    base-bin slice that falls in the window. Reads spanning the window edge are
    clipped to the window — correct for PEAK because a read contributes the same
    +1 depth on both sides of the cut, and the per-base-bin max is taken over the
    union of windows the bin touches (a base-bin never straddles a window edge:
    WINDOW_BP is chosen as a multiple of the base-bin size below).
    """
    if (
        use_rust_coverage()
        and not _is_remote_bam(resolved)
        and not (resolved_index is not None and _is_remote_bam(resolved_index))
    ):
        fd, tmp_name = tempfile.mkstemp(suffix=".npy")
        os.close(fd)
        try:
            summary = run_build_base_layer(
                bam_path=Path(resolved),
                chrom=chrom,
                out_path=Path(tmp_name),
                base_bins=BASE_BINS,
                window_bp=WINDOW_BP,
                index_path=Path(resolved_index) if resolved_index is not None else None,
                reference_fasta=(
                    Path(resolved_reference) if resolved_reference is not None else None
                ),
            )
            return np.load(tmp_name, allow_pickle=False).astype(
                np.float32, copy=False
            ), summary.get("alignedBaseCount")
        finally:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass

    base = np.zeros(BASE_BINS, dtype=np.float32)
    aligned_base_count = 0

    base_bin_bp = max(1, -(-chrom_len // BASE_BINS))

    window = max(base_bin_bp, (WINDOW_BP // base_bin_bp) * base_bin_bp)

    with _open_alignment(resolved, resolved_index, resolved_reference) as bam:
        win_start = 0
        while win_start < chrom_len:
            win_end = min(win_start + window, chrom_len)
            wlen = win_end - win_start

            delta = np.zeros(wlen + 1, dtype=np.int32)
            for r in bam.fetch(chrom, win_start, win_end):
                if (
                    r.is_unmapped
                    or r.is_secondary
                    or r.is_supplementary
                    or r.reference_end is None
                ):
                    continue
                accumulate_alignment_depth(delta, r, win_start, win_end)

            per_base = np.cumsum(delta[:wlen], dtype=np.int32)
            aligned_base_count += int(per_base.sum(dtype=np.int64))

            first_bin = win_start // base_bin_bp
            last_bin = (win_end - 1) // base_bin_bp
            for b in range(first_bin, last_bin + 1):
                bin_lo = b * base_bin_bp
                bin_hi = min(bin_lo + base_bin_bp, chrom_len)
                lo = max(bin_lo, win_start) - win_start
                hi = min(bin_hi, win_end) - win_start
                if hi > lo:
                    peak = float(per_base[lo:hi].max())
                    if peak > base[b]:
                        base[b] = peak
            win_start = win_end
            del delta, per_base
    return base, aligned_base_count


def _build_base_layer_to_path(
    resolved: str,
    resolved_index: Optional[str],
    resolved_reference: Optional[str],
    chrom: str,
    chrom_len: int,
    out_path: Path,
) -> tuple[CoverageProvenance, float, Optional[int]]:
    """Build a resident base layer directly at its cache path.

    The hot path is the Rust/HTSlib helper writing `.npy` atomically. The Python
    implementation remains only as an explicit fallback for remote inputs or when
    the Rust helper is disabled; it must not be the default for local BAMs.
    """
    if (
        use_rust_coverage()
        and not _is_remote_bam(resolved)
        and not (resolved_index is not None and _is_remote_bam(resolved_index))
    ):
        summary = run_build_base_layer(
            bam_path=Path(resolved),
            chrom=chrom,
            out_path=out_path,
            base_bins=BASE_BINS,
            window_bp=WINDOW_BP,
            threads=_coverage_htslib_threads(),
            index_path=Path(resolved_index) if resolved_index is not None else None,
            reference_fasta=(
                Path(resolved_reference) if resolved_reference is not None else None
            ),
        )
        return (
            summary["provenance"],
            summary["maxDepth"],
            summary.get("alignedBaseCount"),
        )

    base, aligned_base_count = _build_base_layer(
        resolved,
        resolved_index,
        resolved_reference,
        chrom,
        chrom_len,
    )
    _atomic_write_npy(out_path, base)
    _load_cached_base_layer(out_path)
    return (
        {"method": "python-window-base-layer", "exact": True},
        float(np.max(base)),
        aligned_base_count,
    )


def _local_coverage_tile(
    bam_path: str,
    chrom: str,
    start: int,
    end: int,
    *,
    bins: int,
    bin_size_bp: Optional[int] = None,
    index_path: Optional[str],
    reference_fasta: Optional[str],
    check_cancelled: Callable[[], None] | None = None,
) -> CoverageTile:
    """Bounded local PEAK coverage for an interactive tile span.

    This is the critical-path path for read-level and mid-level tiles. It streams
    only ``[start, end)`` in WINDOW_BP chunks and max-pools directly into the
    requested output bins, so it never allocates either a full chromosome layer or
    a full tile-span per-base array.
    """
    if check_cancelled is not None:
        check_cancelled()
    resolved = _resolve_bam_path(bam_path)
    if not _is_remote_bam(resolved) and not Path(resolved).is_file():
        raise BamNotFoundError(f"BAM not found: {bam_path}")
    resolved_index = _resolve_index_path(index_path)
    resolved_reference = _resolve_reference_path(reference_fasta)

    span = end - start
    if bin_size_bp is not None and bin_size_bp <= 0:
        raise ValueError("bin_size_bp must be positive")
    actual_bin = (
        int(bin_size_bp) if bin_size_bp is not None else max(1, -(-span // bins))
    )
    actual_bins = max(1, -(-span // actual_bin))

    if (
        use_rust_coverage()
        and not _is_remote_bam(resolved)
        and not (resolved_index is not None and _is_remote_bam(resolved_index))
    ):
        result = _coverage_tile_from_rust(
            bam_path=resolved,
            chrom=chrom,
            start=start,
            end=end,
            bins=actual_bins,
            bin_size_bp=bin_size_bp,
            index_path=resolved_index,
            reference_fasta=resolved_reference,
        )

        if check_cancelled is not None:
            check_cancelled()
        return result

    bin_size = actual_bin
    out = np.zeros(actual_bins, dtype=np.float32)

    with _open_alignment(resolved, resolved_index, resolved_reference) as bam:
        if chrom not in set(bam.references):
            raise BamNotFoundError(f"chrom {chrom} not in {bam_path}")
        win_start = start
        while win_start < end:
            if check_cancelled is not None:
                check_cancelled()
            win_end = min(win_start + WINDOW_BP, end)
            wlen = win_end - win_start
            delta = np.zeros(wlen + 1, dtype=np.int32)
            for index, r in enumerate(bam.fetch(chrom, win_start, win_end)):
                if index % 1024 == 0 and check_cancelled is not None:
                    check_cancelled()
                if (
                    r.is_unmapped
                    or r.is_secondary
                    or r.is_supplementary
                    or r.reference_end is None
                ):
                    continue
                accumulate_alignment_depth(delta, r, win_start, win_end)
            per_base = np.cumsum(delta[:wlen], dtype=np.int32)

            first_bin = max(0, (win_start - start) // bin_size)
            last_bin = min(actual_bins - 1, (win_end - 1 - start) // bin_size)
            for b in range(first_bin, last_bin + 1):
                bin_lo = start + b * bin_size
                bin_hi = min(bin_lo + bin_size, end)
                lo = max(bin_lo, win_start) - win_start
                hi = min(bin_hi, win_end) - win_start
                if hi <= lo:
                    continue
                peak = float(per_base[lo:hi].max())
                if peak > out[b]:
                    out[b] = peak
            win_start = win_end
            del delta, per_base

    if check_cancelled is not None:
        check_cancelled()
    bin_values = [float(v) for v in out]
    return {
        "chrom": chrom,
        "start": start,
        "end": end,
        "bins": bin_values,
        "binSize": bin_size,
        "maxDepth": max(bin_values) if bin_values else 0.0,
        "provenance": {"method": "local-window-peak", "exact": True},
    }


def _coverage_tile_from_rust(
    *,
    bam_path: str,
    chrom: str,
    start: int,
    end: int,
    bins: int,
    bin_size_bp: Optional[int] = None,
    index_path: Optional[str],
    reference_fasta: Optional[str],
) -> CoverageTile:
    return run_coverage_tile(
        bam_path=Path(bam_path),
        chrom=chrom,
        start=start,
        end=end,
        bins=bins,
        bin_size_bp=bin_size_bp,
        index_path=Path(index_path) if index_path is not None else None,
        reference_fasta=Path(reference_fasta) if reference_fasta is not None else None,
    )


def _coverage_tile_from_base_layer(
    *,
    chrom: str,
    start: int,
    end: int,
    bins: int,
    bin_size_bp: Optional[int] = None,
    base: np.ndarray,
    chrom_len: int,
    check_cancelled: Callable[[], None] | None = None,
) -> CoverageTile:
    if check_cancelled is not None:
        check_cancelled()
    base_len = int(len(base))
    if base_len <= 0:
        raise CoveragePyramidMissingError(
            f"coverage pyramid resolution too coarse for {chrom} {start}-{end}; "
            "base layer is empty"
        )
    base_bin_bp = max(1, -(-chrom_len // base_len))

    span = end - start
    if bin_size_bp is not None and bin_size_bp <= 0:
        raise ValueError("bin_size_bp must be positive")
    bin_size = int(bin_size_bp) if bin_size_bp is not None else max(1, -(-span // bins))
    actual_bins = max(1, -(-span // bin_size))
    if bin_size < base_bin_bp:
        raise CoveragePyramidMissingError(
            f"coverage pyramid resolution too coarse for {chrom} {start}-{end}; "
            f"requested binSize {bin_size}bp is finer than base bin {base_bin_bp}bp"
        )

    out = np.zeros(actual_bins, dtype=np.float32)
    for i in range(actual_bins):
        if i % 64 == 0 and check_cancelled is not None:
            check_cancelled()
        lo_bp = start + i * bin_size
        hi_bp = min(lo_bp + bin_size, end)
        if hi_bp <= lo_bp:
            continue
        b_lo = lo_bp // base_bin_bp
        b_hi = (hi_bp - 1) // base_bin_bp
        b_lo = max(0, min(base_len - 1, b_lo))
        b_hi = max(0, min(base_len - 1, b_hi))

        out[i] = float(base[b_lo : b_hi + 1].mean())

    if check_cancelled is not None:
        check_cancelled()
    bin_values = [float(v) for v in out]
    return {
        "chrom": chrom,
        "start": start,
        "end": end,
        "bins": bin_values,
        "binSize": bin_size,
        "maxDepth": max(bin_values) if bin_values else 0.0,
        "provenance": {"method": "pyramid-maxpool", "exact": True},
    }


def _coverage_tile_from_cached_base_layer(
    *,
    resolved: str,
    resolved_index: Optional[str],
    resolved_reference: Optional[str],
    chrom: str,
    chrom_len: int,
    start: int,
    end: int,
    bins: int,
    bin_size_bp: Optional[int] = None,
    check_cancelled: Callable[[], None] | None = None,
) -> CoverageTile:
    if check_cancelled is not None:
        check_cancelled()
    cache_path = _base_layer_cache_path(
        resolved, chrom, resolved_index, resolved_reference
    )
    if cache_path is None or not cache_path.is_file():
        raise CoveragePyramidMissingError(
            f"coverage pyramid missing for {chrom} {start}-{end}; "
            "coarse /tiles/coverage cannot return estimated bins"
        )
    try:
        base = _load_cached_base_layer(cache_path)
    except (OSError, ValueError) as exc:
        raise CoveragePyramidMissingError(
            f"coverage pyramid missing for {chrom} {start}-{end}; "
            f"cached base layer is invalid: {exc}"
        ) from exc
    return _coverage_tile_from_base_layer(
        chrom=chrom,
        start=start,
        end=end,
        bins=bins,
        bin_size_bp=bin_size_bp,
        base=base,
        chrom_len=chrom_len,
        **({"check_cancelled": check_cancelled} if check_cancelled is not None else {}),
    )


def _load_or_build_base_layer(
    bam_path: str,
    chrom: str,
    *,
    index_path: Optional[str],
    reference_fasta: Optional[str],
    no_cache: bool,
) -> tuple[np.ndarray, int]:
    """Return (base_layer, chrom_len). Persisted per (file, chrom); computed once."""
    resolved = _resolve_bam_path(bam_path)
    if not _is_remote_bam(resolved) and not Path(resolved).is_file():
        raise BamNotFoundError(f"BAM not found: {bam_path}")
    resolved_index = _resolve_index_path(index_path)
    resolved_reference = _resolve_reference_path(reference_fasta)

    with _open_alignment(resolved, resolved_index, resolved_reference) as bam:
        if chrom not in set(bam.references):
            raise BamNotFoundError(f"chrom {chrom} not in {bam_path}")
        chrom_len = int(bam.get_reference_length(chrom))

    cache_path: Optional[Path] = None
    if not no_cache and not _is_remote_bam(resolved):
        try:
            cache_path = _base_layer_cache_path(
                resolved, chrom, resolved_index, resolved_reference
            )
            if cache_path.is_file():
                try:
                    return _load_cached_base_layer(cache_path), chrom_len
                except (OSError, ValueError):
                    pass
        except (AttributeError, OSError):
            cache_path = None

    if cache_path is not None:

        with _base_layer_lock(cache_path):
            _adopt_legacy_base_layer(
                cache_path,
                resolved=resolved,
                resolved_index=resolved_index,
                resolved_reference=resolved_reference,
                chrom=chrom,
                chrom_len=chrom_len,
            )
            if cache_path.is_file():
                try:
                    return _load_cached_base_layer(cache_path), chrom_len
                except (OSError, ValueError):
                    pass
            base, aligned_base_count = _build_base_layer(
                resolved, resolved_index, resolved_reference, chrom, chrom_len
            )
            try:
                _atomic_write_npy(cache_path, base)
                _write_base_layer_manifest(
                    cache_path,
                    chrom=chrom,
                    chrom_len=chrom_len,
                    max_depth=float(np.max(base)),
                    provenance={"method": "python-window-base-layer", "exact": True},
                    aligned_base_count=aligned_base_count,
                )
            except OSError:
                pass
            return base, chrom_len

    base, _aligned_base_count = _build_base_layer(
        resolved, resolved_index, resolved_reference, chrom, chrom_len
    )
    if cache_path is not None:
        try:
            _atomic_write_npy(cache_path, base)
        except OSError:
            pass
    return base, chrom_len


def coverage_pyramid_readiness(
    bam_path: str,
    chroms: list[str],
    *,
    index_path: Optional[str] = None,
    reference_fasta: Optional[str] = None,
) -> list[CoveragePyramidReadiness]:
    """Report whether exact coarse coverage pyramids already exist.

    This is a cache truth oracle, not a builder. It opens the alignment header to
    validate chromosome lengths and then stats the expected cache files. It must
    not call ``fetch``, scan reads, adopt legacy artifacts, or wait on a producer
    lock; broad LOD readiness cannot be hidden inside an interactive request.
    """
    resolved = _resolve_bam_path(bam_path)
    if not _is_remote_bam(resolved) and not Path(resolved).is_file():
        raise BamNotFoundError(f"BAM not found: {bam_path}")
    resolved_index = _resolve_index_path(index_path)
    resolved_reference = _resolve_reference_path(reference_fasta)

    with _open_alignment(resolved, resolved_index, resolved_reference) as bam:
        refs = set(bam.references)
        out: list[CoveragePyramidReadiness] = []
        for chrom in chroms:
            if chrom not in refs:
                out.append(
                    {"chrom": chrom, "present": False, "reason": "chrom not in BAM"}
                )
                continue
            chrom_len = int(bam.get_reference_length(chrom))
            cache_path = _base_layer_cache_path(
                resolved, chrom, resolved_index, resolved_reference
            )
            base_bin_bp = max(1, -(-chrom_len // BASE_BINS))
            if cache_path is None:
                out.append(
                    {
                        "chrom": chrom,
                        "present": False,
                        "chromLength": chrom_len,
                        "baseBinBp": base_bin_bp,
                        "sizeBytes": 0,
                        "reason": "cache unavailable",
                    }
                )
                continue
            try:
                stat = cache_path.stat()
                try:
                    _load_cached_base_layer(cache_path)
                except (OSError, ValueError) as exc:
                    out.append(
                        {
                            "chrom": chrom,
                            "present": False,
                            "chromLength": chrom_len,
                            "baseBinBp": base_bin_bp,
                            "cachePath": str(cache_path),
                            "sizeBytes": int(stat.st_size),
                            "reason": str(exc),
                        }
                    )
                    continue
                manifest = _read_base_layer_manifest(
                    cache_path, chrom=chrom, chrom_len=chrom_len
                )
                count = (
                    manifest.get("alignedBaseCount") if manifest is not None else None
                )
                summary = (
                    {"alignedBaseCount": count, "meanDepth": count / chrom_len}
                    if isinstance(count, int)
                    and not isinstance(count, bool)
                    and count >= 0
                    else {}
                )
                out.append(
                    {
                        **summary,
                        "chrom": chrom,
                        "present": True,
                        "chromLength": chrom_len,
                        "baseBinBp": base_bin_bp,
                        "cachePath": str(cache_path),
                        "sizeBytes": int(stat.st_size),
                    }
                )
            except OSError:
                out.append(
                    {
                        "chrom": chrom,
                        "present": False,
                        "chromLength": chrom_len,
                        "baseBinBp": base_bin_bp,
                        "cachePath": str(cache_path),
                        "sizeBytes": 0,
                    }
                )
        return out


def coverage_pyramid_precompute(
    bam_path: str,
    chroms: list[str],
    *,
    index_path: Optional[str] = None,
    reference_fasta: Optional[str] = None,
    force: bool = False,
) -> list[CoveragePyramidPrecomputeResult]:
    """Build exact resident coverage pyramids for the requested chromosomes.

    This is intentionally separate from ``coverage_tile``. A broad tile request
    must not hide cold BAM scans behind an apparently successful tile response;
    the app or harness has to precompute the resident artifacts first, then use
    readiness and rendered-pixel gates to prove the viewer is actually usable.
    """
    resolved = _resolve_bam_path(bam_path)
    if not _is_remote_bam(resolved) and not Path(resolved).is_file():
        raise BamNotFoundError(f"BAM not found: {bam_path}")
    resolved_index = _resolve_index_path(index_path)
    resolved_reference = _resolve_reference_path(reference_fasta)

    with _open_alignment(resolved, resolved_index, resolved_reference) as bam:
        refs = set(bam.references)
        chrom_lengths = {
            chrom: int(bam.get_reference_length(chrom))
            for chrom in chroms
            if chrom in refs
        }

    def precompute_one(chrom: str) -> CoveragePyramidPrecomputeResult:
        if chrom not in refs:
            return {
                "chrom": chrom,
                "present": False,
                "built": False,
                "reason": "chrom not in BAM",
            }

        chrom_len = chrom_lengths[chrom]
        base_bin_bp = max(1, -(-chrom_len // BASE_BINS))
        cache_path = _base_layer_cache_path(
            resolved, chrom, resolved_index, resolved_reference
        )
        if cache_path is None:
            return {
                "chrom": chrom,
                "present": False,
                "built": False,
                "chromLength": chrom_len,
                "baseBinBp": base_bin_bp,
                "sizeBytes": 0,
                "reason": "cache unavailable",
            }

        with _base_layer_lock(cache_path):
            stale_reason: str | None = None
            adopted_from: str | None = None
            if not force and not cache_path.is_file():
                adopted_from = _adopt_legacy_base_layer(
                    cache_path,
                    resolved=resolved,
                    resolved_index=resolved_index,
                    resolved_reference=resolved_reference,
                    chrom=chrom,
                    chrom_len=chrom_len,
                )
            if not force and cache_path.is_file():
                try:

                    _load_cached_base_layer(cache_path)
                    stat = cache_path.stat()
                    manifest = _read_base_layer_manifest(
                        cache_path, chrom=chrom, chrom_len=chrom_len
                    )
                    if manifest is None:
                        _write_base_layer_manifest(
                            cache_path,
                            chrom=chrom,
                            chrom_len=chrom_len,
                            max_depth=None,
                            provenance=None,
                            adopted_from=adopted_from,
                        )
                        manifest = _read_base_layer_manifest(
                            cache_path, chrom=chrom, chrom_len=chrom_len
                        )
                    result: CoveragePyramidPrecomputeResult = {
                        "chrom": chrom,
                        "present": True,
                        "built": False,
                        "chromLength": chrom_len,
                        "baseBinBp": base_bin_bp,
                        "cachePath": str(cache_path),
                        "sizeBytes": int(stat.st_size),
                    }
                    if manifest is not None:
                        count = manifest.get("alignedBaseCount")
                        if (
                            isinstance(count, int)
                            and not isinstance(count, bool)
                            and count >= 0
                        ):
                            result["alignedBaseCount"] = count
                            result["meanDepth"] = count / chrom_len
                        max_depth = manifest.get("maxDepth")
                        if isinstance(max_depth, (int, float)):
                            result["maxDepth"] = float(max_depth)
                        manifest_provenance = manifest.get("provenance")
                        if isinstance(manifest_provenance, dict):
                            result["provenance"] = manifest_provenance
                    if adopted_from is not None:
                        result["reason"] = (
                            f"adopted existing coverage artifact from {adopted_from}"
                        )
                    return result
                except (OSError, ValueError) as exc:
                    stale_reason = str(exc)

            started = time.perf_counter()
            provenance, max_depth, aligned_base_count = _build_base_layer_to_path(
                resolved,
                resolved_index,
                resolved_reference,
                chrom,
                chrom_len,
                cache_path,
            )
            _write_base_layer_manifest(
                cache_path,
                chrom=chrom,
                chrom_len=chrom_len,
                max_depth=max_depth,
                provenance=provenance,
                aligned_base_count=aligned_base_count,
            )
            stat = cache_path.stat()
            result: CoveragePyramidPrecomputeResult = {
                "chrom": chrom,
                "present": True,
                "built": True,
                "chromLength": chrom_len,
                "baseBinBp": base_bin_bp,
                "cachePath": str(cache_path),
                "sizeBytes": int(stat.st_size),
                "maxDepth": max_depth,
                **(
                    {
                        "alignedBaseCount": aligned_base_count,
                        "meanDepth": aligned_base_count / chrom_len,
                    }
                    if aligned_base_count is not None
                    else {}
                ),
                "durationMs": round((time.perf_counter() - started) * 1000, 3),
                "provenance": provenance,
            }
            if stale_reason is not None:
                result["reason"] = f"rebuilt invalid cache: {stale_reason}"
            return result

    out: list[CoveragePyramidPrecomputeResult | None] = [None] * len(chroms)
    workers = _coverage_precompute_workers(len(chroms))
    if workers <= 1:
        for index, chrom in enumerate(chroms):
            out[index] = precompute_one(chrom)
    else:
        with ThreadPoolExecutor(
            max_workers=workers,
            thread_name_prefix="coverage-precompute",
            initializer=prefer_current_thread,
        ) as executor:
            futures = {
                executor.submit(precompute_one, chrom): index
                for index, chrom in enumerate(chroms)
            }
            for future in as_completed(futures):
                out[futures[future]] = future.result()

    return [row for row in out if row is not None]


def coverage_tile(
    bam_path: str,
    chrom: str,
    start: int,
    end: int,
    *,
    bins: int,
    index_path: Optional[str] = None,
    reference_fasta: Optional[str] = None,
    no_cache: bool = False,
    chrom_len: Optional[int] = None,
    check_cancelled: Callable[[], None] | None = None,
) -> CoverageTile:
    """A coarse coverage tile of ``bins`` values over ``[start, end)``.

    Broad cached tiles mean-pool the persisted fixed-base peak layer so adjacent
    levels stay on the same vertical scale. ``bins`` must be <= BASE_BINS (the
    base layer's resolution); a coarse whole-chrom tile (bins=1024) is always a
    downsample of the base layer.
    """
    if check_cancelled is not None:
        check_cancelled()
    if end <= start:
        raise ValueError("end must be greater than start")
    if bins <= 0:
        raise ValueError("bins must be positive")

    span = end - start
    if not no_cache:
        resolved = _resolve_bam_path(bam_path)
        resolved_index = _resolve_index_path(index_path)
        resolved_reference = _resolve_reference_path(reference_fasta)
        cache_path = _base_layer_cache_path(
            resolved, chrom, resolved_index, resolved_reference
        )
        if cache_path is not None and cache_path.is_file():

            if chrom_len is None:
                with _open_alignment(
                    resolved, resolved_index, resolved_reference
                ) as bam:
                    if chrom not in set(bam.references):
                        raise BamNotFoundError(f"chrom {chrom} not in {bam_path}")
                    chrom_len = int(bam.get_reference_length(chrom))
            try:
                return _coverage_tile_from_cached_base_layer(
                    resolved=resolved,
                    resolved_index=resolved_index,
                    resolved_reference=resolved_reference,
                    chrom=chrom,
                    chrom_len=chrom_len,
                    **({"check_cancelled": check_cancelled} if check_cancelled is not None else {}),
                    start=start,
                    end=end,
                    bins=bins,
                )
            except CoveragePyramidMissingError:
                if span > LOCAL_TILE_COVERAGE_MAX_BP:
                    raise
        elif span > LOCAL_TILE_COVERAGE_MAX_BP:
            raise CoveragePyramidMissingError(
                f"coverage pyramid missing for {chrom} {start}-{end}; "
                "coarse /tiles/coverage cannot return estimated bins"
            )

    if span <= LOCAL_TILE_COVERAGE_MAX_BP:
        return _local_coverage_tile(
            bam_path,
            chrom,
            start,
            end,
            bins=bins,
            index_path=index_path,
            reference_fasta=reference_fasta,
            **({"check_cancelled": check_cancelled} if check_cancelled is not None else {}),
        )

    base, chrom_len = _load_or_build_base_layer(
        bam_path,
        chrom,
        index_path=index_path,
        reference_fasta=reference_fasta,
        no_cache=no_cache,
    )
    return _coverage_tile_from_base_layer(
        chrom=chrom,
        start=start,
        end=end,
        bins=bins,
        base=base,
        chrom_len=chrom_len,
        **({"check_cancelled": check_cancelled} if check_cancelled is not None else {}),
    )


def coverage_assembly_tile(
    bam_path: str,
    segments: list[CoverageAssemblySegmentRequest],
    *,
    bins: int,
    bin_size_bp: Optional[int] = None,
    index_path: Optional[str] = None,
    reference_fasta: Optional[str] = None,
    check_cancelled: Callable[[], None] | None = None,
) -> CoverageAssemblyTile:
    """One coverage tile over a global assembly tile.

    The renderer's broad view needs all overlapping chromosomes before it can
    present a complete histogram. Serving those per-chrom resident slices in one
    response avoids the 24-request first-paint queue while preserving the same
    exact persisted-pyramid data contract as ``coverage_tile``.
    """
    if check_cancelled is not None:
        check_cancelled()
    if bins <= 0:
        raise ValueError("bins must be positive")
    if bin_size_bp is not None and bin_size_bp <= 0:
        raise ValueError("bin_size_bp must be positive")

    resolved = _resolve_bam_path(bam_path)
    if not _is_remote_bam(resolved) and not Path(resolved).is_file():
        raise BamNotFoundError(f"BAM not found: {bam_path}")
    resolved_index = _resolve_index_path(index_path)
    resolved_reference = _resolve_reference_path(reference_fasta)

    lengths = cached_reference_lengths(str(resolved))
    if lengths is None:
        with _open_alignment(resolved, resolved_index, resolved_reference) as bam:
            lengths = {
                ref: int(bam.get_reference_length(ref)) for ref in bam.references
            }
        store_reference_lengths(str(resolved), lengths)
    chrom_lengths = {
        segment["chrom"]: lengths[segment["chrom"]]
        for segment in segments
        if segment["chrom"] in lengths
    }

    out_segments: list[CoverageAssemblySegmentTile] = []
    max_depth = 0.0
    for segment in segments:
        if check_cancelled is not None:
            check_cancelled()
        chrom = segment["chrom"]
        if chrom not in chrom_lengths:
            raise BamNotFoundError(f"chrom {chrom} not in {bam_path}")
        chrom_len = chrom_lengths[chrom]
        start = max(0, min(chrom_len, int(segment["start"])))
        end = max(start, min(chrom_len, int(segment["end"])))
        global_offset = int(segment["globalStart"])
        if end <= start:
            empty_bins = bins if bin_size_bp is None else 0
            tile: CoverageTile = {
                "chrom": chrom,
                "start": start,
                "end": start,
                "bins": [0.0] * empty_bins,
                "binSize": 0,
                "maxDepth": 0.0,
                "provenance": {"method": "empty-outside-chrom", "exact": True},
            }
        else:
            segment_bins = (
                max(1, -(-(end - start) // int(bin_size_bp)))
                if bin_size_bp is not None
                else bins
            )
            try:
                tile = _coverage_tile_from_cached_base_layer(
                    resolved=resolved,
                    resolved_index=resolved_index,
                    resolved_reference=resolved_reference,
                    chrom=chrom,
                    chrom_len=chrom_len,
                    start=start,
                    end=end,
                    bins=segment_bins,
                    bin_size_bp=bin_size_bp,
                    **({"check_cancelled": check_cancelled} if check_cancelled is not None else {}),
                )
            except CoveragePyramidMissingError:
                if end - start > LOCAL_TILE_COVERAGE_MAX_BP:
                    raise
                tile = _local_coverage_tile(
                    bam_path,
                    chrom,
                    start,
                    end,
                    bins=segment_bins,
                    bin_size_bp=bin_size_bp,
                    **({"check_cancelled": check_cancelled} if check_cancelled is not None else {}),
                    index_path=index_path,
                    reference_fasta=reference_fasta,
                )
        if tile["maxDepth"] > max_depth:
            max_depth = tile["maxDepth"]
        out_segments.append(
            {
                **tile,
                "globalStart": global_offset + tile["start"],
                "globalEnd": global_offset + tile["end"],
            }
        )

    if check_cancelled is not None:
        check_cancelled()
    return {
        "segments": out_segments,
        "maxDepth": max_depth,
        "provenance": {"method": "pyramid-maxpool", "exact": True},
    }
