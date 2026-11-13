""" P2 — annotation TILE source (the KEYSTONE).

Two formats by LOD:

  FINE (binBp <= ~256): VECTOR glyphs. Every touching transcript is resolved
  (Parent=/orphan-CDS/legacy/bacterial via the ported ``resolve_transcripts``) and
  emitted with its exons + CDS. ``droppedCount === 0`` — no feature is silently lost
  (the  "no dropped CDS/exon children" contract).

  COARSE: a fixed-1024-bin RASTER derived from a sealed, checksummed base layer
  precomputed for every source annotation type and canonical/expanded bank.
  Interactive requests perform array slicing/reduction only and fail closed when
  an artifact is missing; they never parse GFF or rasterize source features.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Callable, Literal, Optional, TypedDict

import numpy as np

from .gff_tabix import (
    AnnotationSourceNotFoundError,  # noqa: F401
    fetch_features,
)
from .spliced_resolver import (
    TRANSCRIPT_CHILD_COMPONENT_TYPES,
    TRANSCRIPT_CLASS_TYPES,
    BpInterval,
    GenomeFeature,
    ResolvedGene,
    ResolvedTranscript,
    resolve_transcripts,
)
from .tile_geometry import TILE_PX, bin_bp, is_fine_level

AnnotationBank = Literal["canonical", "expanded"]
ALL_ANNOTATION_BANKS: tuple[AnnotationBank, ...] = ("canonical", "expanded")


class VectorTranscript(TypedDict):
    transcriptId: str
    type: str
    strand: str
    start: int
    end: int
    geneId: str | None
    exons: list[dict]
    cds: list[dict]


class AnnotationTile(TypedDict):
    chrom: str
    level: int
    tileIndex: int
    start: int
    end: int
    fine: bool
    format: str
    transcripts: list[VectorTranscript]
    droppedCount: int
    exonRaster: list[float]
    cdsRaster: list[float]
    exonRasters: list[list[float]]
    cdsRasters: list[list[float]]
    laneCount: int
    laneDroppedCount: int
    markCount: int
    availableTypes: list[str]


_TILE_CACHE_GUARD = threading.Lock()
_TILE_CACHE: "OrderedDict[str, AnnotationTile]" = OrderedDict()
_TILE_CACHE_MAX = 512


def _gff_path_signature(gff_path: str) -> str:
    """Regression (found running the full suite while adding Slice 2's
    lane_limit to the cache key): a bare os.stat() raises FileNotFoundError
    for a missing source, which the route's exception handler doesn't
    recognize (it only catches AnnotationSourceNotFoundError) -- surfacing
    as an unhandled 500 instead of the documented 404 contract
    (test_missing_gff_tabix_source_is_404). Re-raise as the expected type
    so a missing source fails the SAME way whether the miss is caught here
    (before any fetch_features call) or inside fetch_features itself."""
    try:
        st = os.stat(gff_path)
    except OSError as exc:
        raise AnnotationSourceNotFoundError(
            f"GFF source not found: {gff_path}"
        ) from exc
    return f"{os.path.abspath(gff_path)}:{st.st_size}:{st.st_mtime_ns}"


def _tile_cache_key(
    gff_path: str,
    chrom: str,
    start: int,
    end: int,
    level: int,
    tile_index: int,
    visible_types: list[str] | None,
    lane_limit: int | None,
    bank: AnnotationBank,
) -> str:
    types_key = "all" if visible_types is None else ",".join(sorted(set(visible_types)))
    lane_key = "1" if lane_limit is None else str(lane_limit)
    return "|".join(
        [
            _gff_path_signature(gff_path),
            chrom,
            str(start),
            str(end),
            str(level),
            str(tile_index),
            types_key,
            lane_key,
            bank,
        ]
    )


def _tile_cache_get(key: str) -> AnnotationTile | None:
    with _TILE_CACHE_GUARD:
        tile = _TILE_CACHE.get(key)
        if tile is not None:
            _TILE_CACHE.move_to_end(key)
        return tile


def _tile_cache_put(key: str, tile: AnnotationTile) -> None:
    with _TILE_CACHE_GUARD:
        _TILE_CACHE[key] = tile
        _TILE_CACHE.move_to_end(key)
        while len(_TILE_CACHE) > _TILE_CACHE_MAX:
            _TILE_CACHE.popitem(last=False)


def clear_annotation_tile_cache() -> None:
    """Test hook: drop every cached tile result."""
    with _TILE_CACHE_GUARD:
        _TILE_CACHE.clear()


def _intervals_to_dicts(intervals: list[BpInterval]) -> list[dict]:
    return [{"start": i.start, "end": i.end} for i in intervals]


def _gene_marker(gene: ResolvedGene) -> ResolvedTranscript:
    """A gene entity as a renderable span marker -- not a spliced feature, so
    it carries no exons/cds. 'gene' is one of the 7 broad annotation
    categories and must survive to the tile response as its own entity, not
    only as the parent of its (already-emitted) child transcripts."""
    return ResolvedTranscript(
        transcriptId=gene.geneId,
        chrom=gene.chrom,
        source=gene.source,
        type=gene.type,
        strand=gene.strand,
        start=gene.start,
        end=gene.end,
        exons=[],
        cds=[],
        translation=None,
        attributes=gene.attributes,
        geneId=gene.geneId,
        score=gene.score,
        phase=gene.phase,
        raw=gene.raw,
    )


def _feature_marker(feature: GenomeFeature) -> ResolvedTranscript:
    """Losslessly adapt a non-transcript GFF row to the render-carrier shape.

    The sidecar's type catalog is the source catalog, not merely the handful of
    transcript classes understood by ``resolve_transcripts``. Regulatory sites,
    repeats, match rows, UTRs, and other passthrough types therefore need an
    independently rasterizable carrier. Their exact GFF bbox is the mark; no
    exon/CDS biology is invented.
    """
    feature_id = (feature.attributes.get("ID") or [None])[0]
    marker_id = feature_id or f"{feature.type}:{feature.start}:{feature.end}"
    return ResolvedTranscript(
        transcriptId=marker_id,
        chrom=feature.chrom,
        source=feature.source,
        type=feature.type,
        strand=feature.strand,
        start=feature.start,
        end=feature.end,
        exons=[],
        cds=[],
        translation=None,
        attributes=feature.attributes,
        geneId=None,
        score=feature.score,
        phase=feature.phase,
        raw=feature.raw,
    )


def _flatten_resolved(resolved: list) -> list[ResolvedTranscript]:
    """Flatten genes -> [gene marker, *transcripts] so the raster/vector emit
    sees the gene itself (one of the 7 broad annotation categories) AND every
    child transcript exactly once."""
    out: list[ResolvedTranscript] = []
    for f in resolved:
        if isinstance(f, ResolvedGene):
            out.append(_gene_marker(f))
            out.extend(f.transcripts)
        elif isinstance(f, ResolvedTranscript):
            out.append(f)
        elif isinstance(f, GenomeFeature):
            out.append(_feature_marker(f))
    return out


def _annotation_carriers(features: list[GenomeFeature]) -> list[ResolvedTranscript]:
    """Return one renderable carrier family for every source annotation type.

    ``resolve_transcripts`` intentionally consumes exon/CDS/UTR child rows into
    their parent transcript. Those components are still user-selectable logical
    annotation tracks, so add their raw rows back as bbox carriers. Every other
    unconsumed source row is already preserved by ``_flatten_resolved``.
    """
    carriers = _flatten_resolved(resolve_transcripts(features))
    carriers.extend(
        _feature_marker(feature)
        for feature in features
        if feature.type in TRANSCRIPT_CHILD_COMPONENT_TYPES
    )
    return carriers


def _interval_coverage(intervals: list[BpInterval]) -> int:
    return sum(max(0, interval.end - interval.start + 1) for interval in intervals)


def pick_canonical_isoform(
    transcripts: list[ResolvedTranscript],
) -> ResolvedTranscript | None:
    """Match the desktop's deterministic canonical-isoform selection."""
    if not transcripts:
        return None
    if len(transcripts) == 1:
        return transcripts[0]
    for transcript in transcripts:
        tags = (
            transcript.attributes.get("tag") or transcript.attributes.get("Tag") or []
        )
        if "MANE_Select" in tags or "MANE Select" in tags:
            return transcript
    return min(
        transcripts,
        key=lambda transcript: (
            -_interval_coverage(transcript.cds),
            -_interval_coverage(transcript.exons),
            transcript.start,
            transcript.transcriptId,
        ),
    )


def _apply_bank(
    transcripts: list[ResolvedTranscript], *, bank: AnnotationBank
) -> list[ResolvedTranscript]:
    """Apply canonical/expanded policy only to genuine gene-linked isoforms."""
    if bank == "expanded":
        return transcripts
    by_gene: dict[str, list[ResolvedTranscript]] = {}
    first_index_by_gene: dict[str, int] = {}
    out: list[ResolvedTranscript | None] = []
    for transcript in transcripts:
        if transcript.geneId is None or transcript.type not in TRANSCRIPT_CLASS_TYPES:
            out.append(transcript)
            continue
        if transcript.geneId not in by_gene:
            by_gene[transcript.geneId] = []
            first_index_by_gene[transcript.geneId] = len(out)
            out.append(None)
        by_gene[transcript.geneId].append(transcript)
    for gene_id, group in by_gene.items():
        out[first_index_by_gene[gene_id]] = pick_canonical_isoform(group)
    return [transcript for transcript in out if transcript is not None]


def _vector_transcripts(
    transcripts: list[ResolvedTranscript],
) -> list[VectorTranscript]:
    out: list[VectorTranscript] = []
    for t in transcripts:
        out.append(
            {
                "transcriptId": t.transcriptId,
                "type": t.type,
                "strand": t.strand,
                "start": t.start,
                "end": t.end,
                "geneId": t.geneId,
                "exons": _intervals_to_dicts(_exon_like_marks(t)),
                "cds": _intervals_to_dicts(t.cds),
            }
        )
    return out


def _exon_like_marks(transcript: ResolvedTranscript) -> list[BpInterval]:
    """Return renderable thin marks without inventing CDS geometry.

    Resolved transcript carriers normally own biological exons. Gene markers
    deliberately do not, so their exact feature bbox is the only truthful
    broad/fine mark. Without this fallback the catalog advertises ``gene`` but
    both its vector and raster payloads are completely transparent.
    """
    return transcript.exons or [BpInterval(transcript.start + 1, transcript.end)]


def annotation_tile(
    gff_path: str,
    chrom: str,
    start: int,
    end: int,
    *,
    level: int,
    tile_index: int,
    visible_types: list[str] | None = None,
    lane_limit: int | None = None,
    bank: AnnotationBank = "canonical",
) -> AnnotationTile:
    """A vector (fine) or raster (coarse) annotation tile over ``[start, end)``.

    ``visible_types``, when given, restricts the resolved transcript set to
    those whose ``type`` (the real per-feature SO term) is in the set,
    BEFORE either the vector emit or the raster rasterization -- so a
    filtered coarse tile has strictly less-or-equal ink at every bin than
    the unfiltered one, never more. ``None`` serves every transcript-class
    type ``resolve_transcripts`` recognizes, matching pre-filter behavior.

    ``lane_limit`` remains part of request identity for compatibility with the
    exact tier. Broad LODs are one precomputed density row per logical type;
    fine/vector LODs own exact isoform lane layout.

    Result-cached (see the cache block above this function's neighbors) --
    a repeat call with the same inputs and unchanged GFF file identity is
    O(1) instead of re-running fetch_features/resolve_transcripts.
    """
    if bank not in ALL_ANNOTATION_BANKS:
        raise ValueError(f"unsupported annotation bank: {bank!r}")
    key = _tile_cache_key(
        gff_path, chrom, start, end, level, tile_index, visible_types, lane_limit, bank
    )
    cached = _tile_cache_get(key)
    if cached is not None:
        return cached
    tile = _annotation_tile_uncached(
        gff_path,
        chrom,
        start,
        end,
        level=level,
        tile_index=tile_index,
        visible_types=visible_types,
        lane_limit=lane_limit,
        bank=bank,
    )
    _tile_cache_put(key, tile)
    return tile


def _annotation_tile_uncached(
    gff_path: str,
    chrom: str,
    start: int,
    end: int,
    *,
    level: int,
    tile_index: int,
    visible_types: list[str] | None = None,
    lane_limit: int | None = None,
    bank: AnnotationBank = "canonical",
) -> AnnotationTile:
    if not is_fine_level(level):
        served = _serve_coarse_tile_from_pyramid(
            gff_path,
            chrom,
            start,
            end,
            level=level,
            visible_types=visible_types,
            bank=bank,
        )
        if served is None:
            raise AnnotationPyramidMissingError(
                "annotation raster pyramid is not ready for "
                f"{chrom} bank={bank} types={visible_types or 'all'}"
            )
        exon_raster, cds_raster, mark_count, available_types = served
        return {
            "chrom": chrom,
            "level": level,
            "tileIndex": tile_index,
            "start": start,
            "end": end,
            "fine": False,
            "format": "raster",
            "transcripts": [],
            "droppedCount": 0,
            "exonRaster": exon_raster,
            "cdsRaster": cds_raster,
            "exonRasters": [exon_raster],
            "cdsRasters": [cds_raster],
            "laneCount": 1,
            "availableTypes": available_types,
            "laneDroppedCount": 0,
            "markCount": mark_count,
        }

    query_start = max(0, start)
    query_end = max(query_start, end)
    features = fetch_features(gff_path, chrom, query_start, query_end)
    transcripts = _annotation_carriers(features)
    available_types = sorted({t.type for t in transcripts})
    if visible_types is not None:
        allowed = set(visible_types)
        transcripts = [t for t in transcripts if t.type in allowed]
    transcripts = _apply_bank(transcripts, bank=bank)

    base: AnnotationTile = {
        "chrom": chrom,
        "level": level,
        "tileIndex": tile_index,
        "start": start,
        "end": end,
        "fine": is_fine_level(level),
        "format": "vector",
        "transcripts": [],
        "droppedCount": 0,
        "exonRaster": [],
        "cdsRaster": [],
        "exonRasters": [],
        "cdsRasters": [],
        "laneCount": 0,
        "availableTypes": available_types,
        "laneDroppedCount": 0,
        "markCount": 0,
    }

    base["format"] = "vector"
    base["transcripts"] = _vector_transcripts(transcripts)
    base["droppedCount"] = 0
    return base


_ANNOTATION_CACHE_DIR_ENV = "WAYPOINT_ANNOTATION_PYRAMID_CACHE_DIR"
_ANNOTATION_DEFAULT_CACHE_SUBDIR = "waypoint-annotation-pyramid"
_ANNOTATION_PYRAMID_VERSION = 2
_ANNOTATION_CACHE_CONTRACT_TOKEN = (
    "annotation-pyramid-v2-per-type-per-bank-alphaover-covered-bp"
)
BASE_LEVEL = 9
_MANIFEST_NAME = "manifest.json"
_VERIFIED_ARTIFACTS_GUARD = threading.Lock()
_VERIFIED_ARTIFACTS_MAX = 2048
_VERIFIED_ARTIFACTS: "OrderedDict[str, None]" = OrderedDict()


def _clear_verified_artifacts() -> None:
    with _VERIFIED_ARTIFACTS_GUARD:
        _VERIFIED_ARTIFACTS.clear()


def _is_verified_artifact(verification_key: str) -> bool:
    with _VERIFIED_ARTIFACTS_GUARD:
        if verification_key not in _VERIFIED_ARTIFACTS:
            return False
        _VERIFIED_ARTIFACTS.move_to_end(verification_key)
        return True


def _remember_verified_artifact(verification_key: str) -> None:
    with _VERIFIED_ARTIFACTS_GUARD:
        _VERIFIED_ARTIFACTS[verification_key] = None
        _VERIFIED_ARTIFACTS.move_to_end(verification_key)
        while len(_VERIFIED_ARTIFACTS) > _VERIFIED_ARTIFACTS_MAX:
            _VERIFIED_ARTIFACTS.popitem(last=False)


class AnnotationPyramidMissingError(Exception):
    """The required sealed coarse-raster product is absent or invalid."""


class AnnotationPyramidCancelledError(Exception):
    """The last owner released an in-progress pyramid build."""


def _pyramid_cache_dir() -> Path:
    override = os.environ.get(_ANNOTATION_CACHE_DIR_ENV)
    base = (
        Path(override)
        if override
        else Path.home() / ".dnaforge" / _ANNOTATION_DEFAULT_CACHE_SUBDIR
    )
    base.mkdir(parents=True, exist_ok=True)
    return base


def _source_product_key(gff_path: str, chrom: str) -> str:
    identity = "\x00".join(
        [
            _ANNOTATION_CACHE_CONTRACT_TOKEN,
            _gff_path_signature(gff_path),
            chrom,
            str(BASE_LEVEL),
        ]
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def annotation_product_dir(gff_path: str, chrom: str) -> Path:
    return _pyramid_cache_dir() / _source_product_key(gff_path, chrom)


def annotation_manifest_path(gff_path: str, chrom: str) -> Path:
    return annotation_product_dir(gff_path, chrom) / _MANIFEST_NAME


def _artifact_filename(track_type: str, bank: AnnotationBank) -> str:
    digest = hashlib.sha256(f"{bank}\x00{track_type}".encode("utf-8")).hexdigest()
    return f"{bank}-{digest}.npz"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=path.name, suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    finally:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass


def _atomic_write_npz(path: Path, **arrays: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=path.name, suffix=".tmp"
    )
    os.close(fd)
    npz_name = f"{tmp_name}.npz"
    try:
        np.savez_compressed(tmp_name, **arrays)
        os.replace(npz_name, path)
    finally:
        for candidate in (tmp_name, npz_name):
            try:
                os.unlink(candidate)
            except OSError:
                pass


def _rasterize_covered_bp_and_touches(
    marks: list[BpInterval], tile_start: int, tile_end: int, bins: int
) -> tuple[np.ndarray, np.ndarray]:
    """Persist additive covered-bp and diagnostic mark-touch counts."""
    span = max(1, tile_end - tile_start)
    bp_per_bin = span / bins
    alpha = np.zeros(bins, dtype=np.float32)
    touches = np.zeros(bins, dtype=np.int32)
    for mark in marks:
        mark_lo = (mark.start - 1) - tile_start
        mark_hi = mark.end - tile_start
        if mark_hi <= 0 or mark_lo >= span:
            continue
        mark_lo = max(0, mark_lo)
        mark_hi = min(span, mark_hi)
        if mark_hi <= mark_lo:
            continue
        first_bin = int(mark_lo / bp_per_bin)
        last_bin = min(bins - 1, int((mark_hi - 1) / bp_per_bin))
        for index in range(first_bin, last_bin + 1):
            bin_lo = index * bp_per_bin
            overlap = min(mark_hi, bin_lo + bp_per_bin) - max(mark_lo, bin_lo)
            if overlap <= 0:
                continue
            source_alpha = min(1.0, overlap / bp_per_bin)
            alpha[index] = source_alpha + alpha[index] * (1.0 - source_alpha)
            touches[index] += 1
    return alpha * bp_per_bin, touches


def _artifact_arrays(
    carriers: list[ResolvedTranscript], chrom_length: int
) -> dict[str, np.ndarray]:
    exon_marks: list[BpInterval] = []
    cds_marks: list[BpInterval] = []
    for carrier in carriers:
        exon_marks.extend(_exon_like_marks(carrier))
        cds_marks.extend(carrier.cds)
    base_bin_bp = bin_bp(BASE_LEVEL)
    bins = max(1, -(-chrom_length // base_bin_bp))
    span = bins * base_bin_bp
    exon_covered_bp, exon_touches = _rasterize_covered_bp_and_touches(
        exon_marks, 0, span, bins
    )
    cds_covered_bp, cds_touches = _rasterize_covered_bp_and_touches(
        cds_marks, 0, span, bins
    )
    return {
        "exon_covered_bp": exon_covered_bp.astype(np.float32, copy=False),
        "cds_covered_bp": cds_covered_bp.astype(np.float32, copy=False),
        "mark_touch_count": (exon_touches + cds_touches).astype(np.int32, copy=False),
        "chrom_length": np.asarray(chrom_length, dtype=np.int64),
    }


def _read_manifest(gff_path: str, chrom: str) -> tuple[Path, dict] | None:
    path = annotation_manifest_path(gff_path, chrom)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(raw, dict):
        return None
    return path, raw


def _expected_artifact_keys(types: list[str]) -> set[tuple[str, str]]:
    return {(track_type, bank) for track_type in types for bank in ALL_ANNOTATION_BANKS}


def annotation_pyramid_readiness(
    gff_path: str,
    chrom: str,
    *,
    chrom_length: int | None = None,
    verify_hashes: bool = True,
) -> dict:
    """Return the complete product inventory and any missing/corrupt members.

    The manifest is the commit record and is written last. A directory of
    partial artifacts without a valid manifest is therefore never considered
    ready. Full verification checks both byte hashes and loadable array shapes.
    """
    manifest_pair = _read_manifest(gff_path, chrom)
    if manifest_pair is None:
        return {
            "status": "missing",
            "ready": False,
            "availableTypes": [],
            "banks": list(ALL_ANNOTATION_BANKS),
            "missingArtifacts": ["manifest"],
            "corruptArtifacts": [],
        }
    manifest_path, manifest = manifest_pair
    types = manifest.get("availableTypes")
    artifacts = manifest.get("artifacts")
    structural_error = (
        manifest.get("version") != _ANNOTATION_PYRAMID_VERSION
        or manifest.get("contract") != _ANNOTATION_CACHE_CONTRACT_TOKEN
        or manifest.get("sourceSignature") != _gff_path_signature(gff_path)
        or manifest.get("chrom") != chrom
        or manifest.get("baseLevel") != BASE_LEVEL
        or not isinstance(types, list)
        or not all(isinstance(value, str) and value for value in types)
        or not isinstance(artifacts, list)
        or (chrom_length is not None and manifest.get("chromLength") != chrom_length)
    )
    if structural_error:
        return {
            "status": "corrupt",
            "ready": False,
            "availableTypes": types if isinstance(types, list) else [],
            "banks": list(ALL_ANNOTATION_BANKS),
            "missingArtifacts": [],
            "corruptArtifacts": ["manifest"],
        }

    expected = _expected_artifact_keys(types)
    seen: set[tuple[str, str]] = set()
    missing: list[str] = []
    corrupt: list[str] = []
    for entry in artifacts:
        if not isinstance(entry, dict):
            corrupt.append("manifest:artifact-entry")
            continue
        track_type = entry.get("trackType")
        bank = entry.get("bank")
        filename = entry.get("file")
        key = (track_type, bank)
        label = f"{bank}:{track_type}"
        if key not in expected or key in seen or not isinstance(filename, str):
            corrupt.append(label)
            continue
        seen.add(key)
        path = manifest_path.parent / filename
        if not path.is_file():
            missing.append(label)
            continue
        try:
            stat = path.stat()
            if stat.st_size != entry.get("sizeBytes"):
                raise ValueError("size mismatch")
            if verify_hashes and _sha256_file(path) != entry.get("sha256"):
                raise ValueError("hash mismatch")
            if verify_hashes:
                with np.load(path, allow_pickle=False) as data:
                    exon = np.asarray(data["exon_covered_bp"])
                    cds = np.asarray(data["cds_covered_bp"])
                    touches = np.asarray(data["mark_touch_count"])
                    if (
                        exon.ndim != 1
                        or exon.shape != cds.shape
                        or exon.shape != touches.shape
                    ):
                        raise ValueError("array shape mismatch")
                    if int(data["chrom_length"]) != manifest["chromLength"]:
                        raise ValueError("chrom length mismatch")
        except (OSError, ValueError, KeyError):
            corrupt.append(label)
    for track_type, bank in sorted(expected - seen):
        missing.append(f"{bank}:{track_type}")
    ready = not missing and not corrupt and bool(types)
    return {
        "status": "ready" if ready else ("corrupt" if corrupt else "missing"),
        "ready": ready,
        "availableTypes": sorted(types),
        "banks": list(ALL_ANNOTATION_BANKS),
        "missingArtifacts": sorted(missing),
        "corruptArtifacts": sorted(corrupt),
        "artifactCount": len(artifacts),
        "manifestPath": str(manifest_path),
    }


def annotation_pyramid_precompute(
    gff_path: str,
    chrom: str,
    chrom_length: int,
    *,
    force: bool = False,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> dict:
    """Build every source type for canonical and expanded banks in one scan."""
    if cancel_check is not None and cancel_check():
        raise AnnotationPyramidCancelledError("annotation pyramid build was cancelled")
    if chrom_length <= 0:
        raise ValueError("chrom_length must be positive")
    readiness = annotation_pyramid_readiness(
        gff_path, chrom, chrom_length=chrom_length, verify_hashes=True
    )
    if readiness["ready"] and not force:
        return readiness

    features = fetch_features(gff_path, chrom, 0, chrom_length)
    if cancel_check is not None and cancel_check():
        raise AnnotationPyramidCancelledError("annotation pyramid build was cancelled")
    carriers = _annotation_carriers(features)
    available_types = sorted({carrier.type for carrier in carriers if carrier.type})
    if not available_types:
        raise AnnotationPyramidMissingError(
            f"annotation source {gff_path} has no renderable types for {chrom}"
        )
    product_dir = annotation_product_dir(gff_path, chrom)
    product_dir.mkdir(parents=True, exist_ok=True)
    artifacts: list[dict] = []
    for bank in ALL_ANNOTATION_BANKS:
        if cancel_check is not None and cancel_check():
            raise AnnotationPyramidCancelledError(
                "annotation pyramid build was cancelled"
            )
        banked = _apply_bank(carriers, bank=bank)
        by_type: dict[str, list[ResolvedTranscript]] = {
            track_type: [] for track_type in available_types
        }
        for carrier in banked:
            by_type[carrier.type].append(carrier)
        for track_type in available_types:
            if cancel_check is not None and cancel_check():
                raise AnnotationPyramidCancelledError(
                    "annotation pyramid build was cancelled"
                )
            filename = _artifact_filename(track_type, bank)
            artifact_path = product_dir / filename
            _atomic_write_npz(
                artifact_path,
                **_artifact_arrays(by_type[track_type], chrom_length),
            )
            artifacts.append(
                {
                    "trackType": track_type,
                    "bank": bank,
                    "file": filename,
                    "sizeBytes": artifact_path.stat().st_size,
                    "sha256": _sha256_file(artifact_path),
                }
            )
    manifest = {
        "version": _ANNOTATION_PYRAMID_VERSION,
        "contract": _ANNOTATION_CACHE_CONTRACT_TOKEN,
        "sourceSignature": _gff_path_signature(gff_path),
        "chrom": chrom,
        "chromLength": chrom_length,
        "baseLevel": BASE_LEVEL,
        "availableTypes": available_types,
        "banks": list(ALL_ANNOTATION_BANKS),
        "artifacts": artifacts,
    }
    if cancel_check is not None and cancel_check():
        raise AnnotationPyramidCancelledError("annotation pyramid build was cancelled")
    _atomic_write_json(product_dir / _MANIFEST_NAME, manifest)
    _clear_verified_artifacts()
    clear_annotation_tile_cache()
    return annotation_pyramid_readiness(
        gff_path, chrom, chrom_length=chrom_length, verify_hashes=True
    )


def _artifact_entry(
    manifest: dict, track_type: str, bank: AnnotationBank
) -> dict | None:
    for entry in manifest.get("artifacts", []):
        if entry.get("trackType") == track_type and entry.get("bank") == bank:
            return entry
    return None


def _load_verified_artifact(
    path: Path, entry: dict
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    stat = path.stat()
    verification_key = f"{path}:{stat.st_size}:{stat.st_mtime_ns}:{entry.get('sha256')}"
    verified = _is_verified_artifact(verification_key)
    if not verified:
        if stat.st_size != entry.get("sizeBytes") or _sha256_file(path) != entry.get(
            "sha256"
        ):
            raise AnnotationPyramidMissingError(
                f"annotation artifact checksum failed: {path}"
            )
        _remember_verified_artifact(verification_key)
    try:
        with np.load(path, allow_pickle=False) as data:
            return (
                np.asarray(data["exon_covered_bp"], dtype=np.float64),
                np.asarray(data["cds_covered_bp"], dtype=np.float64),
                np.asarray(data["mark_touch_count"], dtype=np.int64),
            )
    except (OSError, ValueError, KeyError) as exc:
        raise AnnotationPyramidMissingError(
            f"annotation artifact cannot be decoded: {path}"
        ) from exc


def _covered_bp_integral_at(
    covered_bp: np.ndarray,
    positions: np.ndarray,
    *,
    base_bin_bp: int,
    chrom_length: int,
) -> np.ndarray:
    """Piecewise-linear integral of a sealed local-axis coverage array.

    Assembly tiles live on one global power-of-two grid, so subtracting a
    chromosome placement almost never lands on a local base-bin boundary. The
    sealed arrays store covered-bp totals per chromosome-local base bin. Treat
    each bin as uniform density and sample its cumulative integral at arbitrary
    local bp boundaries; this preserves total ink without parsing source rows.
    """
    clipped = np.clip(positions.astype(np.float64), 0.0, float(chrom_length))
    prefix = np.concatenate(([0.0], np.cumsum(covered_bp, dtype=np.float64)))
    indices = np.floor_divide(clipped.astype(np.int64), base_bin_bp)
    indices = np.minimum(indices, len(covered_bp))
    integral = prefix[indices].astype(np.float64, copy=True)
    inside = indices < len(covered_bp)
    if np.any(inside):
        active_indices = indices[inside]
        bin_starts = active_indices * base_bin_bp
        bin_widths = np.minimum(base_bin_bp, chrom_length - bin_starts)
        offsets = clipped[inside] - bin_starts
        fractions = np.divide(
            offsets,
            bin_widths,
            out=np.zeros_like(offsets, dtype=np.float64),
            where=bin_widths > 0,
        )
        integral[inside] += covered_bp[active_indices] * fractions
    return integral


def _reduce_covered_bp_to_alpha(
    exon_covered_bp: np.ndarray,
    cds_covered_bp: np.ndarray,
    mark_touch_count: np.ndarray,
    start_bp: int,
    chrom_length: int,
    base_bin_bp: int,
    target_bin_bp: int,
) -> tuple[np.ndarray, np.ndarray, int]:
    boundaries = start_bp + np.arange(TILE_PX + 1, dtype=np.int64) * target_bin_bp
    exon_integral = _covered_bp_integral_at(
        exon_covered_bp,
        boundaries,
        base_bin_bp=base_bin_bp,
        chrom_length=chrom_length,
    )
    cds_integral = _covered_bp_integral_at(
        cds_covered_bp,
        boundaries,
        base_bin_bp=base_bin_bp,
        chrom_length=chrom_length,
    )
    exon_alpha = np.clip(np.diff(exon_integral) / target_bin_bp, 0.0, 1.0)
    cds_alpha = np.clip(np.diff(cds_integral) / target_bin_bp, 0.0, 1.0)
    clamped_start = max(0, start_bp)
    clamped_end = min(chrom_length, start_bp + TILE_PX * target_bin_bp)
    if clamped_end <= clamped_start:
        mark_count = 0
    else:
        first_touch_bin = clamped_start // base_bin_bp
        last_touch_bin = min(
            len(mark_touch_count),
            (clamped_end + base_bin_bp - 1) // base_bin_bp,
        )
        mark_count = int(mark_touch_count[first_touch_bin:last_touch_bin].sum())
    return exon_alpha, cds_alpha, mark_count


def _serve_coarse_tile_from_pyramid(
    gff_path: str,
    chrom: str,
    start: int,
    end: int,
    *,
    level: int,
    visible_types: list[str] | None,
    bank: AnnotationBank,
) -> tuple[list[float], list[float], int, list[str]] | None:
    if level < BASE_LEVEL:
        return None
    manifest_pair = _read_manifest(gff_path, chrom)
    if manifest_pair is None:
        return None
    manifest_path, manifest = manifest_pair
    available_types = manifest.get("availableTypes")
    if (
        manifest.get("version") != _ANNOTATION_PYRAMID_VERSION
        or manifest.get("sourceSignature") != _gff_path_signature(gff_path)
        or not isinstance(available_types, list)
    ):
        return None
    requested_types = (
        available_types if visible_types is None else sorted(set(visible_types))
    )
    if any(track_type not in available_types for track_type in requested_types):
        return None
    target_bin_bp = bin_bp(level)
    base_bin_bp = bin_bp(BASE_LEVEL)
    if end - start != TILE_PX * target_bin_bp or target_bin_bp % base_bin_bp != 0:
        return None
    chrom_length = manifest.get("chromLength")
    if not isinstance(chrom_length, int) or chrom_length <= 0:
        return None
    combined_exon = np.zeros(TILE_PX, dtype=np.float64)
    combined_cds = np.zeros(TILE_PX, dtype=np.float64)
    mark_count = 0
    for track_type in requested_types:
        entry = _artifact_entry(manifest, track_type, bank)
        if entry is None:
            return None
        path = manifest_path.parent / entry["file"]
        exon_bp, cds_bp, touches = _load_verified_artifact(path, entry)
        exon, cds, touches_count = _reduce_covered_bp_to_alpha(
            exon_bp,
            cds_bp,
            touches,
            start,
            chrom_length,
            base_bin_bp,
            target_bin_bp,
        )
        combined_exon = exon + combined_exon * (1.0 - exon)
        combined_cds = cds + combined_cds * (1.0 - cds)
        mark_count += touches_count
    return (
        combined_exon.tolist(),
        combined_cds.tolist(),
        mark_count,
        sorted(available_types),
    )
