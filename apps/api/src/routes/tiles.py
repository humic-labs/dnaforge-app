""" P2 — tiled-LOD genome viewer SIDECAR TILE ROUTES.

Three tile sources for the rebuilt engine, all ``async def`` behind the
``TILE_IO`` ManagedPool, running blocking pysam/htslib via ``asyncio.to_thread``
so the FastAPI event loop is NEVER blocked (a doomed CRAM decode cannot wedge
``/health`` —  class):

  - ``POST /tiles/coverage/{level}/{tileIndex}``  — coverage band (max-pool pyramid)
  - ``POST /tiles/alignment/{level}/{tileIndex}`` — read pileup, FINE levels only
  - ``POST /tiles/annotation/{level}/{tileIndex}`` — gene glyphs (KEYSTONE)

Tile geometry is the shared TS<->Python ``tile_geometry`` module (single source of
truth; off-by-one = seam misregistration). Error contract (bug #3): a missing
index / reference / tabix is a loud 404 (not empty count:0, not 500-as-pending);
a ManagedPool ``QueueRefusal`` surfaces as a defined 429 shadow state (not a hang).
"""

from __future__ import annotations

import asyncio
import json as _json
import os
import struct
from pathlib import Path
from typing import Awaitable, Callable, Literal, Mapping, NoReturn
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator

from ..alignment_coverage_operation_contract import (
    AlignedReadSourceGeneration,
    AlignmentCoverageInput,
    AlignmentCoverageResult,
    AlignmentCoverageSubmission,
    capture_aligned_read_source_generation,
    discover_local_alignment_index_path,
    prepare_alignment_coverage_submission,
)
from ..alignment_index_operation_contract import (
    AlignmentIndexRequest,
    AlignmentIndexResult,
    AlignmentIndexSubmission,
    prepare_alignment_index_submission,
)
from ..concurrency.pools import get_pool_manager
from ..concurrency.refusals import QueueRefusal
from ..concurrency.schema import PoolName
from ..external.htsget import HtsgetSourceError
from ..external.runtime_registry import get_external_runtime
from ..operations import OperationState
from ..routes.operations import human_principal, operation_errors, operation_owner
from ..sequence_variant_contract import (
    SequenceVariantCallsRequest,
    SequenceVariantCallsResult,
)
from ..services import tile_geometry as tg
from ..variant_source_operation_contract import (
    VariantPageRequest,
    VariantRegionRequest,
    VariantSourceRequest,
    VariantSourceResult,
    VariantSourceSubmission,
    prepare_variant_source_submission,
)

router = APIRouter(prefix="/tiles", tags=["Tiles"])

_GENOME_DEPENDENCY_UNAVAILABLE = (
    "Genome tiles are unavailable in this build because the optional "
    "pysam/htslib dependency is not installed."
)


def _raise_if_optional_genome_dependency_missing(
    exc: ModuleNotFoundError,
) -> NoReturn:
    """Keep the sidecar bootable in builds that intentionally omit pysam.

    Windows release sidecars do not bundle pysam today. Tile services are therefore
    loaded at request time, just like the existing genome-index route, so every
    non-genome API (including health) remains available and tile requests fail with
    an explicit 503 instead of crashing the whole process during ``src.main`` import.
    """

    if exc.name != "pysam":
        raise exc
    raise HTTPException(
        status_code=503,
        detail=_GENOME_DEPENDENCY_UNAVAILABLE,
    ) from exc


def _load_coverage_services():
    try:
        from ..services import coverage_corridor_floor, coverage_pyramid, pileup
    except ModuleNotFoundError as exc:
        _raise_if_optional_genome_dependency_missing(exc)
    return coverage_corridor_floor, coverage_pyramid, pileup


def _load_alignment_services():
    try:
        from ..services import alignment_tiles, pileup
    except ModuleNotFoundError as exc:
        _raise_if_optional_genome_dependency_missing(exc)
    return alignment_tiles, pileup


def _load_annotation_services():
    try:
        from ..services import annotation_tiles
    except ModuleNotFoundError as exc:
        _raise_if_optional_genome_dependency_missing(exc)
    return annotation_tiles


def _load_variant_services():
    try:
        from ..services import variant_queries
    except ModuleNotFoundError as exc:
        _raise_if_optional_genome_dependency_missing(exc)
    return variant_queries


class _AlignedReadFileGenerationBody(BaseModel):
    canonical_path: str = Field(..., alias="canonicalPath", min_length=1)
    size: int = Field(..., ge=0)
    mtime_ns: str = Field(..., alias="mtimeNs", pattern=r"^\d+$")
    ctime_ns: str = Field(..., alias="ctimeNs", pattern=r"^\d+$")
    device: str | None = Field(None, pattern=r"^\d+$")
    inode: str | None = Field(None, pattern=r"^\d+$")

    model_config = {"populate_by_name": True, "extra": "forbid"}


class _AlignedReadSourceGenerationBody(BaseModel):
    contract: Literal["aligned-read-source-generation.v1"]
    alignment: _AlignedReadFileGenerationBody
    index: _AlignedReadFileGenerationBody
    reference: _AlignedReadFileGenerationBody | None = None
    reference_index: _AlignedReadFileGenerationBody | None = Field(
        None, alias="referenceIndex"
    )

    model_config = {"populate_by_name": True, "extra": "forbid"}


class _AlignedReadSourceBody(BaseModel):
    bam_path: str | None = Field(None, alias="bamPath")
    index_path: str | None = Field(None, alias="indexPath")
    reference_path: str | None = Field(None, alias="referencePath")
    source_generation: _AlignedReadSourceGenerationBody | None = Field(
        None, alias="sourceGeneration"
    )
    htsget_token: str | None = Field(None, alias="htsgetToken", min_length=16)
    htsget_source_identity: str | None = Field(
        None, alias="htsgetSourceIdentity", pattern=r"^[0-9a-f]{64}$"
    )
    htsget_format: Literal["BAM", "CRAM"] | None = Field(None, alias="htsgetFormat")

    model_config = {"populate_by_name": True, "extra": "forbid"}

    @model_validator(mode="after")
    def validate_locator(self) -> _AlignedReadSourceBody:
        htsget_fields = (
            self.htsget_token,
            self.htsget_source_identity,
            self.htsget_format,
        )
        has_htsget = any(value is not None for value in htsget_fields)
        if self.bam_path is not None and has_htsget:
            raise ValueError("aligned-read request must use one source locator")
        if self.bam_path is None and not all(
            value is not None for value in htsget_fields
        ):
            raise ValueError("aligned-read request has no complete source locator")
        if has_htsget and (
            not all(value is not None for value in htsget_fields)
            or self.index_path is not None
            or self.source_generation is not None
        ):
            raise ValueError(
                "htsget aligned-read request contains incompatible file fields"
            )
        return self


def _validate_aligned_read_source_generation(
    body: _AlignedReadSourceBody,
    validator: Callable[[str, str | None, str | None, Mapping[str, object]], None],
) -> None:
    if body.source_generation is None:
        return
    if body.bam_path is None:
        raise ValueError("source generation requires a file-backed alignment")
    validator(
        body.bam_path,
        body.index_path,
        body.reference_path,
        body.source_generation.model_dump(by_alias=True, exclude_none=True),
    )


def _is_htsget_source(body: _AlignedReadSourceBody) -> bool:
    return body.htsget_token is not None


def _require_file_bam_path(body: _AlignedReadSourceBody) -> str:
    if body.bam_path is None:
        raise HTTPException(
            status_code=422,
            detail="This alignment operation is unavailable for htsget sources.",
        )
    return body.bam_path


def _htsget_session(body: _AlignedReadSourceBody):
    if (
        body.htsget_token is None
        or body.htsget_source_identity is None
        or body.htsget_format is None
    ):
        raise HTTPException(status_code=422, detail="Incomplete htsget source locator.")
    try:
        session = get_external_runtime().get_htsget_session(
            body.htsget_token, source_identity=body.htsget_source_identity
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except HtsgetSourceError as exc:
        raise _htsget_tile_error(exc) from exc
    if session.data_class != "reads" or session.format != body.htsget_format:
        raise HTTPException(status_code=409, detail="The htsget read source changed.")
    return session


def _htsget_tile_error(exc: HtsgetSourceError) -> HTTPException:
    if exc.failure_kind == "grant_expired":
        status_code = 401
    elif exc.failure_kind == "source_changed":
        status_code = 409
    elif exc.failure_kind == "region_too_large":
        status_code = 425
    elif exc.retryable:
        status_code = 503
    else:
        status_code = 422
    return HTTPException(
        status_code=status_code,
        detail={
            "code": "HTSGET_SOURCE_UNAVAILABLE",
            "failureKind": exc.failure_kind,
            "message": str(exc),
            "retryable": exc.retryable,
        },
    )


class _TileSourceBody(_AlignedReadSourceBody):
    """Identity of the data source for a tile. The tile coordinate (level,
    tileIndex) is in the path; everything that identifies the FILE is the body.

    ``chrom_global_start``  P5) is the chromosome's offset on the
    ASSEMBLY's single global bp axis. The renderer indexes tiles in GLOBAL
    coordinates (one grid across all 24 chromosomes); the per-chrom route serves
    CHROM-LOCAL bp. Subtracting the offset maps the global tile span to the
    chrom-local span. Omit (or 0) for a single-chrom = assembly-of-one (the
    identity case, where global == local)."""

    chrom: str
    chrom_global_start: int = Field(0, alias="chromGlobalStart")
    guides_only: bool = Field(False, alias="guidesOnly")

    model_config = {"populate_by_name": True, "extra": "forbid"}


class CoverageReadinessBody(_AlignedReadSourceBody):
    chroms: list[str] = Field(..., min_length=1)


class CoveragePrecomputeBody(CoverageReadinessBody):
    assembly_id: str | None = Field(None, alias="assemblyId", min_length=1)
    force: bool = False


class CoverageAssemblySegmentBody(BaseModel):
    chrom: str
    start: int
    end: int
    chrom_global_start: int = Field(..., alias="chromGlobalStart")

    model_config = {"populate_by_name": True, "extra": "forbid"}


class CoverageAssemblyTileBody(_AlignedReadSourceBody):
    segments: list[CoverageAssemblySegmentBody] = Field(..., min_length=1)


class CoverageCorridorFloorBody(_AlignedReadSourceBody):
    """Exact source identity plus the complete ordered assembly placement."""

    segments: list[CoverageAssemblySegmentBody] = Field(..., min_length=1)


class AnnotationTileBody(BaseModel):
    gff_path: str = Field(
        ...,
        alias="gffPath",
        description="Absolute path to the LOSSLESS NCBI GFF3 (.gff3.gz) for the chrom.",
    )
    chrom: str = Field(..., description="App-level chrom id, e.g. 'chr11'.")
    bank: Literal["canonical", "expanded"] = Field(
        "canonical",
        description="Isoform bank used by both exact and precomputed raster tiers.",
    )
    chrom_global_start: int = Field(0, alias="chromGlobalStart")
    visible_types: list[str] | None = Field(
        None,
        alias="visibleTypes",
        description=(
            "Restrict resolved transcripts to these SO-type strings (e.g. "
            "'mRNA'). None serves every recognized transcript-class type, "
            "matching pre-filter behavior."
        ),
    )
    lane_limit: int | None = Field(
        None,
        alias="laneLimit",
        description=(
            " Slice 2 -- COARSE only. Caps the number of vertically- "
            "stacked lanes the raster is split into. None/1 keeps Slice 1's "
            "single flat-band behavior."
        ),
    )

    model_config = {"populate_by_name": True, "extra": "forbid"}


class AnnotationPyramidSourceBody(BaseModel):
    gff_path: str = Field(..., alias="gffPath")
    chrom: str
    chrom_length: int = Field(..., alias="chromLength", gt=0)

    model_config = {"populate_by_name": True, "extra": "forbid"}


class AnnotationPyramidReadinessBody(BaseModel):
    sources: list[AnnotationPyramidSourceBody] = Field(..., min_length=1)
    verify_hashes: bool = Field(True, alias="verifyHashes")

    model_config = {"populate_by_name": True, "extra": "forbid"}


class AnnotationPyramidPrecomputeBody(AnnotationPyramidReadinessBody):
    force: bool = False


class AnnotationPyramidChromStatus(BaseModel):
    """Per-chromosome pyramid status.

    The fields the desktop and tests rely on are declared. The tile service
    adds diagnostic detail (artifact counts, manifest paths, per-artifact
    records) that stays open on purpose; it is owned by
    ``services/annotation_tiles.py`` and never read by the desktop.
    """

    status: str
    ready: bool
    available_types: list[str] = Field(..., alias="availableTypes")
    banks: list[str]
    missing_artifacts: list[str] = Field(default_factory=list, alias="missingArtifacts")
    corrupt_artifacts: list[str] = Field(default_factory=list, alias="corruptArtifacts")

    model_config = {"populate_by_name": True, "extra": "allow"}


class AnnotationPyramidInventoryResponse(BaseModel):
    """What the desktop import boundary reads from readiness and precompute."""

    ready: bool
    available_types: list[str] = Field(..., alias="availableTypes")
    chroms: dict[str, AnnotationPyramidChromStatus]

    model_config = {"populate_by_name": True}


VariantPrepareBody = VariantSourceRequest
VariantPageBody = VariantPageRequest


def _tile_bp_span(
    level: int, tile_index: int, chrom_len: int, chrom_global_start: int = 0
) -> tuple[int, int]:
    """CHROM-LOCAL [start, end) bp this GLOBAL tile owns, clamped to the chrom.

    The renderer indexes tiles on the assembly's GLOBAL axis; this route serves
    chrom-local bp. Map global → local by subtracting the chromosome's global
    offset, then clamp to ``[0, chrom_len)``. A tile that lies entirely outside
    the chromosome (e.g. a global tile for a different chrom) is empty
    (start==end). Mirrors the renderer's ``tileGlobalStart``/``tileGlobalEnd``.
    """
    g_start = tg.tile_global_start(tile_index, level)
    g_end = tg.tile_global_end(tile_index, level)
    start = max(0, g_start - chrom_global_start)
    end = min(g_end - chrom_global_start, chrom_len)
    if end < start:
        end = start
    return start, end


def _refuse_response(exc: QueueRefusal) -> JSONResponse:
    """ManagedPool refusal as a defined renderer shadow state (HTTP 429), NOT a
    hang and NOT a 500. The renderer treats this as a transient back-off chip."""
    return JSONResponse(status_code=429, content=exc.to_response())


def _guard_cram_needs_reference(bam, resolved_reference, source_label: str) -> None:
    """Bug #3's root: a CRAM opened WITHOUT a reference raises the MISLEADING
    ``OSError('truncated file')`` mid-fetch (read as empty-count:0 or 500-as-pending).

    Detect it BEFORE the doomed fetch and raise the LOUD ``ReferenceNotFoundError``
    (=> 404), so the renderer gets a clear error chip instead of a blank band on a
    region that actually has reads. ``is_cram`` is True only for CRAM inputs; BAM
    inputs are unaffected (reference is a no-op for BAM)."""
    from ..services.pileup import ReferenceNotFoundError

    if getattr(bam, "is_cram", False) and resolved_reference is None:
        raise ReferenceNotFoundError(
            f"CRAM {source_label} needs a reference FASTA to decode any slice; "
            f"none was provided (referencePath). htslib would otherwise fail with a "
            f"misleading 'truncated file' error."
        )


_TRUNCATED_ALIGNMENT_DETAIL = (
    "Alignment data could not be read completely ('truncated file'). "
    "The source may be incomplete or its stream interrupted."
)


def _compute_alignment_tile(
    bam_path: str,
    chrom: str,
    index_path: str | None,
    reference_path: str | None,
    level: int,
    tile_index: int,
    chrom_global_start: int,
    guides_only: bool,
) -> dict:
    alignment_tiles, pileup = _load_alignment_services()
    resolved = pileup._resolve_bam_path(bam_path)
    resolved_index = pileup._resolve_index_path(index_path)
    resolved_reference = pileup._resolve_reference_path(reference_path)
    with pileup._open_alignment(resolved, resolved_index, resolved_reference) as bam:
        _guard_cram_needs_reference(bam, resolved_reference, bam_path)
        if chrom not in set(bam.references):
            raise pileup.BamNotFoundError(f"chrom {chrom} not in {bam_path}")
        chrom_len = int(bam.get_reference_length(chrom))
        start, end = _tile_bp_span(level, tile_index, chrom_len, chrom_global_start)
        return alignment_tiles.alignment_tile(
            bam_path,
            chrom,
            start,
            end,
            level=level,
            tile_index=tile_index,
            index_path=index_path,
            reference_fasta=reference_path,
            guides_only=guides_only,
            opened_alignment=bam,
        )


def _compute_alignment_header(
    bam_path: str, index_path: str | None, reference_path: str | None
) -> dict:
    _, pileup = _load_alignment_services()
    return pileup.read_alignment_header(
        bam_path, index_path, reference_fasta=reference_path
    )


def _compute_alignment_read(
    bam_path: str,
    chrom: str,
    read_id: str,
    reference_start: int,
    flag: int,
    read_number: Literal[1, 2] | None,
    index_path: str | None,
    reference_path: str | None,
) -> dict:
    alignment_tiles, _ = _load_alignment_services()
    return alignment_tiles.read_single_read_metadata(
        bam_path,
        chrom,
        read_id=read_id,
        reference_start=reference_start,
        flag=flag,
        read_number=read_number,
        index_path=index_path,
        reference_fasta=reference_path,
    )


async def _run_alignment_native(
    bam_path: str, worker: Callable[..., dict], *args: object, control: bool = False
) -> dict:
    _, pileup = _load_alignment_services()
    if pileup._is_remote_bam(bam_path):
        from ..services.remote_htslib_process import run_remote_htslib

        return await run_remote_htslib(
            worker, *args, pool="control" if control else "alignment"
        )
    return await asyncio.to_thread(worker, *args)


async def _run_alignment_request(
    bam_path: str, request: Request | None, admitted_read: Callable[[], Awaitable[dict]]
) -> dict:
    _, pileup = _load_alignment_services()
    if request is None or not pileup._is_remote_bam(bam_path):
        return await admitted_read()
    if await request.is_disconnected():
        raise asyncio.CancelledError

    read = asyncio.create_task(admitted_read())
    completed = asyncio.Event()

    async def watch_disconnect() -> None:
        while not completed.is_set():
            if await request.is_disconnected():
                read.cancel()
                return
            try:
                await asyncio.wait_for(completed.wait(), timeout=0.05)
            except asyncio.TimeoutError:
                pass

    watcher = asyncio.create_task(watch_disconnect())
    try:
        return await asyncio.shield(read)
    finally:
        completed.set()
        watcher.cancel()
        if not read.done():
            read.cancel()
        cleanup = asyncio.gather(read, watcher, return_exceptions=True)
        cancelled_during_cleanup = False
        while True:
            try:
                await asyncio.shield(cleanup)
                break
            except asyncio.CancelledError:
                cancelled_during_cleanup = True
        if cancelled_during_cleanup:
            raise asyncio.CancelledError


def _is_truncated_alignment_error(exc: BaseException) -> bool:
    """A truncated read alone does not establish file format or reference failure."""
    return isinstance(exc, OSError) and "truncated file" in str(exc).lower()


@router.post("/coverage/readiness")
async def coverage_readiness_route(body: CoverageReadinessBody) -> JSONResponse:
    """Fast cache-truth probe for broad coverage LOD readiness.

    This route does not build coverage and does not scan reads. It reports which
    per-chromosome exact pyramid base layers already exist for the request's
    BAM/index/reference identity, so the renderer/harness can fail loudly before
    broad LODs devolve into 425s or slow foreground scans.
    """

    bam_path = _require_file_bam_path(body)
    _, coverage_pyramid, pileup = _load_coverage_services()
    try:
        await asyncio.to_thread(
            _validate_aligned_read_source_generation,
            body,
            pileup.require_aligned_read_source_generation,
        )
        result = await asyncio.to_thread(
            coverage_pyramid.coverage_pyramid_readiness,
            bam_path,
            body.chroms,
            index_path=body.index_path,
            reference_fasta=body.reference_path,
        )
        await asyncio.to_thread(
            _validate_aligned_read_source_generation,
            body,
            pileup.require_aligned_read_source_generation,
        )
    except pileup.SourceGenerationChangedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (
        pileup.BamNotFoundError,
        pileup.IndexNotFoundError,
        pileup.ReferenceNotFoundError,
    ) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return JSONResponse(content={"chroms": result})


@router.post("/coverage/precompute")
async def coverage_precompute_route(
    request: Request,
    body: CoveragePrecomputeBody,
) -> JSONResponse:
    """Compatibility adapter that waits on the durable managed operation."""

    bam_path = _require_file_bam_path(body)
    index_path = body.index_path
    source_generation = body.source_generation
    try:
        if index_path is None:
            index_path = await asyncio.to_thread(
                discover_local_alignment_index_path, bam_path
            )
        if source_generation is None:
            generation = await asyncio.to_thread(
                capture_aligned_read_source_generation,
                bam_path=bam_path,
                index_path=index_path,
                reference_path=body.reference_path,
            )
        else:
            generation = AlignedReadSourceGeneration.model_validate(
                source_generation.model_dump(
                    mode="json", by_alias=True, exclude_none=True
                )
            )
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "ALIGNMENT_COVERAGE_SOURCE_IDENTITY_REQUIRED",
                "message": (
                    "Coverage preparation requires a readable local alignment, "
                    "index, and reference generation."
                ),
            },
        ) from exc

    principal = human_principal(request)
    service = operation_owner(request)
    submission = AlignmentCoverageSubmission(
        submission_key=f"legacy-coverage-{uuid4()}",
        subject={"scope_id": next(iter(principal.scope_ids))},
        input=AlignmentCoverageInput(
            assemblyId=body.assembly_id or "legacy-alignment-assembly",
            bamPath=bam_path,
            indexPath=index_path,
            referencePath=body.reference_path,
            sourceGeneration=generation,
            chroms=body.chroms,
            force=body.force,
        ),
    )

    with operation_errors():
        snapshot = await service.start(
            principal,
            prepare_alignment_coverage_submission(submission),
            kind="alignment-coverage-preparation",
        )
        settled = await service.wait_for_terminal(principal, snapshot.id)
        envelope = service.get_result(principal, snapshot.id)

    if envelope.status == "available" and envelope.result is not None:
        result = AlignmentCoverageResult.model_validate(envelope.result)
        return JSONResponse(
            content=result.model_dump(mode="json", by_alias=True, exclude_none=True),
            headers={"X-DNAForge-Operation-Id": snapshot.id},
        )

    error = settled.error
    code = error.code if error is not None else "ALIGNMENT_COVERAGE_UNAVAILABLE"
    message = (
        error.message
        if error is not None
        else "Alignment coverage preparation did not produce an available result."
    )
    status_code = {
        "ALIGNMENT_COVERAGE_CAPACITY_UNAVAILABLE": 429,
        "ALIGNMENT_COVERAGE_SOURCE_CHANGED": 409,
        "ALIGNMENT_COVERAGE_SOURCE_UNAVAILABLE": 404,
    }.get(code, 503 if settled.state == OperationState.INTERRUPTED else 500)
    raise HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message},
    )


def _assembly_depth_scale(body: "CoverageAssemblyTileBody"):
    """Genome-wide p98 coverage-depth scale  Ask 1). Memoized + JSON-cached
    in the service, so this is effectively free after the first call; returns the stable
    denominator the renderer uses so histogram height stops moving with scroll/zoom."""
    try:
        from ..services.coverage_pyramid import (
            cached_reference_lengths,
            genome_wide_depth_scale,
        )
        from ..services.pileup import (
            _resolve_bam_path,
            _resolve_index_path,
            _resolve_reference_path,
        )

        resolved = str(_resolve_bam_path(body.bam_path))
        lengths = cached_reference_lengths(resolved) or {}
        if not lengths:
            return None
        scale = genome_wide_depth_scale(
            resolved,
            list(lengths.keys()),
            str(_resolve_index_path(body.index_path)) if body.index_path else None,
            (
                _resolve_reference_path(body.reference_path)
                if body.reference_path
                else None
            ),
            percentile=98.0,
        )
        return scale.get("scaleDepth") if scale else None
    except Exception:
        return None


def _assembly_depth_percentiles(body: "CoverageAssemblyTileBody"):
    """Genome-wide coverage-depth percentiles  histogram A/B). Memoized +
    JSON-cached in the service, so this is effectively free after the first call;
    returns {p50,p90,p95,p99,max} — the stable denominators the renderer can pick
    between so histogram height stops moving with scroll/zoom."""
    try:
        from ..services.coverage_pyramid import (
            cached_reference_lengths,
            genome_wide_depth_percentiles,
        )
        from ..services.pileup import (
            _resolve_bam_path,
            _resolve_index_path,
            _resolve_reference_path,
        )

        resolved = str(_resolve_bam_path(body.bam_path))
        lengths = cached_reference_lengths(resolved) or {}
        if not lengths:
            return None
        return genome_wide_depth_percentiles(
            resolved,
            list(lengths.keys()),
            str(_resolve_index_path(body.index_path)) if body.index_path else None,
            (
                _resolve_reference_path(body.reference_path)
                if body.reference_path
                else None
            ),
        )
    except Exception:
        return None


@router.post("/coverage-assembly/{level}/{tile_index}")
async def coverage_assembly_tile_route(
    level: int, tile_index: int, body: CoverageAssemblyTileBody
) -> JSONResponse:
    """A complete coverage tile for all chromosome segments in one global tile.

    Whole-genome overview cannot wait for one HTTP request per chromosome before
    it has a complete histogram. This route keeps the exact resident-pyramid
    contract, but batches the per-segment slices into one response.
    """
    if level < 0 or tile_index < 0:
        raise HTTPException(status_code=422, detail="level and tileIndex must be >= 0")

    _, coverage_pyramid, pileup = _load_coverage_services()
    pool = get_pool_manager().get(PoolName.TILE_IO.value)
    if _is_htsget_source(body):
        session = _htsget_session(body)
        lengths = dict(session.references)
        out_segments: list[dict[str, object]] = []
        max_depth = 0.0
        try:
            for segment in body.segments:
                chrom_length = lengths.get(segment.chrom)
                if chrom_length is None:
                    raise HTTPException(
                        status_code=404,
                        detail=f"chrom {segment.chrom} not in htsget source",
                    )
                start = max(0, min(chrom_length, segment.start))
                end = max(start, min(chrom_length, segment.end))
                if end <= start:
                    tile: dict[str, object] = {
                        "chrom": segment.chrom,
                        "start": start,
                        "end": start,
                        "bins": [],
                        "binSize": 0,
                        "maxDepth": 0.0,
                        "provenance": {"method": "empty-outside-chrom", "exact": True},
                    }
                else:
                    snapshot = await get_external_runtime().materialize_htsget_region(
                        body.htsget_token,
                        reference_name=segment.chrom,
                        start=start,
                        end=end,
                        source_identity=body.htsget_source_identity,
                    )
                    try:
                        async with pool.slot():
                            tile = await asyncio.to_thread(
                                coverage_pyramid.coverage_tile,
                                str(snapshot.path),
                                segment.chrom,
                                start,
                                end,
                                bins=max(1, -(-(end - start) // tg.bin_bp(level))),
                                index_path=(
                                    str(snapshot.index_path)
                                    if snapshot.index_path is not None
                                    else None
                                ),
                                reference_fasta=body.reference_path,
                                no_cache=True,
                                chrom_len=chrom_length,
                            )
                    finally:
                        snapshot.cleanup()
                max_depth = max(max_depth, float(tile.get("maxDepth", 0.0)))
                out_segments.append(
                    {
                        **tile,
                        "globalStart": segment.chrom_global_start + int(tile["start"]),
                        "globalEnd": segment.chrom_global_start + int(tile["end"]),
                    }
                )
        except QueueRefusal as exc:
            return _refuse_response(exc)
        except HtsgetSourceError as exc:
            raise _htsget_tile_error(exc) from exc
        return JSONResponse(
            content={
                "segments": out_segments,
                "maxDepth": max_depth,
                "provenance": {"method": "htsget-regional", "exact": True},
                "level": level,
                "tileIndex": tile_index,
            }
        )
    bam_path = _require_file_bam_path(body)
    try:
        async with pool.slot():
            await asyncio.to_thread(
                _validate_aligned_read_source_generation,
                body,
                pileup.require_aligned_read_source_generation,
            )
            result = await asyncio.to_thread(
                coverage_pyramid.coverage_assembly_tile,
                bam_path,
                [
                    {
                        "chrom": segment.chrom,
                        "start": segment.start,
                        "end": segment.end,
                        "globalStart": segment.chrom_global_start,
                    }
                    for segment in body.segments
                ],
                bins=tg.TILE_PX,
                bin_size_bp=tg.bin_bp(level),
                index_path=body.index_path,
                reference_fasta=body.reference_path,
            )
            result["level"] = level
            result["tileIndex"] = tile_index
            scale_val = await asyncio.to_thread(_assembly_depth_scale, body)
            if scale_val is not None:
                result["globalDepthScale"] = scale_val
            percentiles_val = await asyncio.to_thread(_assembly_depth_percentiles, body)
            if percentiles_val is not None:
                result["depthPercentiles"] = percentiles_val
            await asyncio.to_thread(
                _validate_aligned_read_source_generation,
                body,
                pileup.require_aligned_read_source_generation,
            )
    except QueueRefusal as exc:
        return _refuse_response(exc)
    except pileup.SourceGenerationChangedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except coverage_pyramid.CoveragePyramidMissingError as exc:
        raise HTTPException(status_code=425, detail=str(exc)) from exc
    except (
        pileup.BamNotFoundError,
        pileup.IndexNotFoundError,
        pileup.ReferenceNotFoundError,
    ) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return JSONResponse(content=result)


@router.post("/coverage-corridor-floor")
async def coverage_corridor_floor_route(body: CoverageCorridorFloorBody) -> Response:
    """Serve the complete source-keyed L15 floor from ready caches only.

    A foreground miss is HTTP 425.  The service does not open or scan the
    BAM/CRAM and cannot build a missing pyramid on this path.
    """

    bam_path = _require_file_bam_path(body)
    coverage_corridor_floor, _, pileup = _load_coverage_services()
    source_generation = (
        body.source_generation.model_dump(by_alias=True, exclude_none=True)
        if body.source_generation is not None
        else None
    )
    try:
        await asyncio.to_thread(
            _validate_aligned_read_source_generation,
            body,
            pileup.require_aligned_read_source_generation,
        )
        artifact = await asyncio.to_thread(
            coverage_corridor_floor.coverage_corridor_floor_artifact,
            bam_path,
            [
                {
                    "chrom": segment.chrom,
                    "start": segment.start,
                    "end": segment.end,
                    "globalStart": segment.chrom_global_start,
                }
                for segment in body.segments
            ],
            index_path=body.index_path,
            reference_fasta=body.reference_path,
            source_generation=source_generation,
        )
        await asyncio.to_thread(
            _validate_aligned_read_source_generation,
            body,
            pileup.require_aligned_read_source_generation,
        )
    except pileup.SourceGenerationChangedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except coverage_corridor_floor.CoverageCorridorFloorNotPreparedError as exc:
        raise HTTPException(status_code=425, detail=str(exc)) from exc
    except (
        pileup.BamNotFoundError,
        pileup.IndexNotFoundError,
        pileup.ReferenceNotFoundError,
    ) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return Response(
        content=artifact.payload,
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "no-store",
            "X-Waypoint-Coverage-Contract": artifact.manifest["contract"],
            "X-Waypoint-Coverage-Source": artifact.manifest["sourceIdentity"],
        },
    )


@router.post("/coverage/{level}/{tile_index}")
async def coverage_tile_route(
    level: int, tile_index: int, body: _TileSourceBody
) -> JSONResponse:
    """A (level, tileIndex) coverage tile from the bounded persisted pyramid.

    No bin clamp on the tile path: a tile has TILE_PX bins of ``binSize`` bp, except
    the last tile of a chromosome, whose span is clipped at the chromosome end and
    which returns only the bins that cover it (no padding past the end). Clients
    place bins from ``start`` and ``binSize``, never from a fixed count .
    pysam runs via ``asyncio.to_thread`` behind ``TILE_IO``.
    """
    if level < 0 or tile_index < 0:
        raise HTTPException(status_code=422, detail="level and tileIndex must be >= 0")

    _, coverage_pyramid, pileup = _load_coverage_services()
    pool = get_pool_manager().get(PoolName.TILE_IO.value)

    if _is_htsget_source(body):
        session = _htsget_session(body)
        chrom_length = dict(session.references).get(body.chrom)
        if chrom_length is None:
            raise HTTPException(
                status_code=404, detail=f"chrom {body.chrom} not in htsget source"
            )
        start, end = _tile_bp_span(
            level, tile_index, chrom_length, body.chrom_global_start
        )
        if end <= start:
            return JSONResponse(
                content={
                    "chrom": body.chrom,
                    "level": level,
                    "tileIndex": tile_index,
                    "start": start,
                    "end": start,
                    "bins": [0.0] * tg.TILE_PX,
                    "binSize": 0,
                    "maxDepth": 0.0,
                    "provenance": {"method": "empty-outside-chrom", "exact": True},
                }
            )
        try:
            snapshot = await get_external_runtime().materialize_htsget_region(
                body.htsget_token,
                reference_name=body.chrom,
                start=start,
                end=end,
                source_identity=body.htsget_source_identity,
            )
            try:
                async with pool.slot():
                    result = await asyncio.to_thread(
                        coverage_pyramid.coverage_tile,
                        str(snapshot.path),
                        body.chrom,
                        start,
                        end,
                        bins=tg.TILE_PX,
                        index_path=(
                            str(snapshot.index_path)
                            if snapshot.index_path is not None
                            else None
                        ),
                        reference_fasta=body.reference_path,
                        no_cache=True,
                        chrom_len=chrom_length,
                    )
                    result["level"] = level
                    result["tileIndex"] = tile_index
            finally:
                snapshot.cleanup()
        except QueueRefusal as exc:
            return _refuse_response(exc)
        except HtsgetSourceError as exc:
            raise _htsget_tile_error(exc) from exc
        return JSONResponse(content=result)

    bam_path = _require_file_bam_path(body)

    def _compute() -> dict:
        resolved = pileup._resolve_bam_path(bam_path)
        resolved_index = pileup._resolve_index_path(body.index_path)
        resolved_reference = pileup._resolve_reference_path(body.reference_path)
        lengths = coverage_pyramid.cached_reference_lengths(str(resolved))
        if lengths is None:
            with pileup._open_alignment(
                resolved, resolved_index, resolved_reference
            ) as bam:
                _guard_cram_needs_reference(bam, resolved_reference, bam_path)
                lengths = {
                    ref: int(bam.get_reference_length(ref)) for ref in bam.references
                }
            coverage_pyramid.store_reference_lengths(str(resolved), lengths)
        if body.chrom not in lengths:
            raise pileup.BamNotFoundError(f"chrom {body.chrom} not in {bam_path}")
        chrom_len = lengths[body.chrom]

        start, end = _tile_bp_span(
            level, tile_index, chrom_len, body.chrom_global_start
        )
        if end <= start:
            return {
                "chrom": body.chrom,
                "level": level,
                "tileIndex": tile_index,
                "start": start,
                "end": start,
                "bins": [0.0] * tg.TILE_PX,
                "binSize": 0,
                "maxDepth": 0.0,
                "provenance": {"method": "empty-outside-chrom", "exact": True},
            }

        tile = coverage_pyramid.coverage_tile(
            bam_path,
            body.chrom,
            start,
            end,
            bins=tg.TILE_PX,
            index_path=body.index_path,
            reference_fasta=body.reference_path,
            chrom_len=chrom_len,
        )
        tile["level"] = level
        tile["tileIndex"] = tile_index
        return tile

    try:
        async with pool.slot():
            await asyncio.to_thread(
                _validate_aligned_read_source_generation,
                body,
                pileup.require_aligned_read_source_generation,
            )
            result = await asyncio.to_thread(_compute)
            await asyncio.to_thread(
                _validate_aligned_read_source_generation,
                body,
                pileup.require_aligned_read_source_generation,
            )
    except QueueRefusal as exc:
        return _refuse_response(exc)
    except pileup.SourceGenerationChangedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except coverage_pyramid.CoveragePyramidMissingError as exc:
        raise HTTPException(status_code=425, detail=str(exc)) from exc
    except (
        pileup.BamNotFoundError,
        pileup.IndexNotFoundError,
        pileup.ReferenceNotFoundError,
    ) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except OSError as exc:
        if _is_truncated_alignment_error(exc):
            raise HTTPException(
                status_code=404,
                detail=_TRUNCATED_ALIGNMENT_DETAIL,
            ) from exc
        raise
    return JSONResponse(content=result)


@router.post("/coverage-resident-baselayer")
async def coverage_resident_baselayer_route() -> Response:
    """Bulk whole-genome fine (~64bp) coverage base layer for ALL chromosomes as ONE binary
    payload. Held resident by the renderer as the never-blank <=1px coverage backstop — no
    per-tile fetch, no eviction, no pool contention  ground-up).

    Wire format: 4-byte little-endian header length, then a UTF-8 JSON header
    ``{"chroms":[{"chrom","binSize","count","byteOffset","byteLength"}],"dtype":"float32"}``,
    then the concatenated little-endian float32 bins in chroms order. Binary, NOT JSON
    number[] — a 48M-bin layer as JSON would blow the memory budget several-fold.

    Source dir is ``WAYPOINT_RESIDENT_COVERAGE_DIR`` (per-chrom ``<chrom>.npy`` + ``<chrom>.json``).
    """
    _default_resident_dir = str(Path.home() / ".cache" / "dnaforge" / "resident-coverage")
    resident_dir = Path(
        os.environ.get("WAYPOINT_RESIDENT_COVERAGE_DIR", _default_resident_dir)
    ).expanduser()
    if not resident_dir.is_dir():
        raise HTTPException(
            status_code=404,
            detail=f"WAYPOINT_RESIDENT_COVERAGE_DIR not a directory: {resident_dir}",
        )

    def _build() -> bytes:
        import numpy as np

        chroms_meta: list[dict] = []
        buffers: list[bytes] = []
        byte_offset = 0
        for npy in sorted(resident_dir.glob("*.npy")):
            chrom = npy.stem
            arr = np.load(npy).astype("<f4", copy=False)
            bin_size = None
            meta_path = npy.with_suffix(".json")
            if meta_path.exists():
                try:
                    bin_size = int(_json.loads(meta_path.read_text()).get("baseBinBp"))
                except Exception:
                    bin_size = None
            raw = arr.tobytes()
            chroms_meta.append(
                {
                    "chrom": chrom,
                    "binSize": bin_size,
                    "count": int(arr.shape[0]),
                    "byteOffset": byte_offset,
                    "byteLength": len(raw),
                }
            )
            buffers.append(raw)
            byte_offset += len(raw)
        header = _json.dumps({"chroms": chroms_meta, "dtype": "float32"}).encode(
            "utf-8"
        )
        header += b" " * ((-len(header)) % 4)
        return struct.pack("<I", len(header)) + header + b"".join(buffers)

    payload = await asyncio.to_thread(_build)
    return Response(content=payload, media_type="application/octet-stream")


@router.post("/variants/prepare", response_model=VariantSourceResult)
async def variant_prepare_route(
    request: Request, body: VariantPrepareBody
) -> JSONResponse:
    """Compatibility adapter that waits on the durable managed operation."""

    principal = human_principal(request)
    service = operation_owner(request)
    submission = VariantSourceSubmission(
        submission_key=f"legacy-variant-source-{uuid4()}",
        subject={"scope_id": next(iter(principal.scope_ids))},
        input=body,
    )
    try:
        prepared = await asyncio.to_thread(
            prepare_variant_source_submission, submission
        )
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"code": "VARIANT_SOURCE_UNAVAILABLE", "message": str(exc)},
        ) from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "VARIANT_SOURCE_INVALID", "message": str(exc)},
        ) from exc

    with operation_errors():
        snapshot = await service.start(
            principal,
            prepared,
            kind="variant-source-preparation",
        )
        settled = await service.wait_for_terminal(principal, snapshot.id)
        envelope = service.get_result(principal, snapshot.id)

    if envelope.status == "available" and envelope.result is not None:
        result = VariantSourceResult.model_validate(envelope.result)
        return JSONResponse(
            content=result.model_dump(mode="json", by_alias=True),
            headers={"X-DNAForge-Operation-Id": snapshot.id},
        )

    error = settled.error
    code = error.code if error is not None else "VARIANT_SOURCE_UNAVAILABLE"
    message = (
        error.message
        if error is not None
        else "Variant source preparation did not produce an available result."
    )
    status_code = {
        "VARIANT_SOURCE_CAPACITY_UNAVAILABLE": 429,
        "VARIANT_SOURCE_CHANGED": 409,
        "VARIANT_SOURCE_UNAVAILABLE": 404,
        "VARIANT_SOURCE_ASSEMBLY_MISMATCH": 409,
        "VARIANT_SOURCE_INVALID": 422,
    }.get(code, 503 if settled.state == OperationState.INTERRUPTED else 500)
    raise HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message},
        headers={"X-DNAForge-Operation-Id": snapshot.id},
    )


@router.post("/variants/sequence-calls", response_model=SequenceVariantCallsResult)
async def sequence_variant_calls_route(
    body: SequenceVariantCallsRequest,
) -> SequenceVariantCallsResult:
    """Read bounded calls and sample depths against exact small-reference DNA."""
    variants = _load_variant_services()
    from ..services.sequence_variant_calls import query_sequence_variant_calls

    pool = get_pool_manager().get(PoolName.TILE_IO.value)
    try:
        async with pool.slot():
            return await asyncio.to_thread(query_sequence_variant_calls, body)
    except QueueRefusal as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except variants.VariantSourceGenerationChangedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (variants.VariantQueryError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/variants/page")
async def variant_page_route(body: VariantPageBody) -> JSONResponse:
    """Return at most ``limit`` call summaries in reference chromosome order."""

    variant_queries = _load_variant_services()
    pool = get_pool_manager().get(PoolName.TILE_IO.value)

    try:
        async with pool.slot():
            result = await asyncio.to_thread(
                variant_queries.query_variant_page,
                body.query_path,
                body.index_path,
                body.references,
                source_generation=body.source_generation,
                query_generation=body.query_generation,
                index_generation=body.index_generation,
                assembly_revision=body.assembly_revision,
                cursor=body.cursor,
                limit=body.limit,
            )
    except QueueRefusal as exc:
        return _refuse_response(exc)
    except variant_queries.VariantSourceGenerationChangedError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "VARIANT_SOURCE_CHANGED", "message": str(exc)},
        ) from exc
    except variant_queries.VariantSourceNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"code": "VARIANT_SOURCE_UNAVAILABLE", "message": str(exc)},
        ) from exc
    except variant_queries.VariantIndexError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "VARIANT_SOURCE_INVALID", "message": str(exc)},
        ) from exc
    except variant_queries.VariantQueryError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "VARIANT_SOURCE_INVALID", "message": str(exc)},
        ) from exc
    return JSONResponse(content=result)


@router.post("/variants/region")
async def variant_region_route(body: VariantRegionRequest) -> JSONResponse:
    """Return one bounded regional variant snapshot for a viewport tile."""

    variant_queries = _load_variant_services()
    pool = get_pool_manager().get(PoolName.TILE_IO.value)
    try:
        async with pool.slot():
            result = await asyncio.to_thread(
                variant_queries.query_variant_region,
                body.query_path,
                body.index_path,
                source_generation=body.source_generation,
                query_generation=body.query_generation,
                index_generation=body.index_generation,
                chrom=body.chrom,
                start=body.start,
                end=body.end,
                limit=body.limit,
            )
    except QueueRefusal as exc:
        return _refuse_response(exc)
    except variant_queries.VariantSourceGenerationChangedError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "VARIANT_SOURCE_CHANGED", "message": str(exc)},
        ) from exc
    except variant_queries.VariantSourceNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"code": "VARIANT_SOURCE_UNAVAILABLE", "message": str(exc)},
        ) from exc
    except variant_queries.VariantIndexError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "VARIANT_SOURCE_INVALID", "message": str(exc)},
        ) from exc
    except variant_queries.VariantQueryError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "VARIANT_SOURCE_INVALID", "message": str(exc)},
        ) from exc
    return JSONResponse(content=result)


class _AlignmentReadBody(_AlignedReadSourceBody):
    chrom: str
    read_id: str = Field(..., alias="readId")
    reference_start: int = Field(..., ge=0, alias="referenceStart")
    flag: int = Field(..., ge=0)
    read_number: Literal[1, 2] | None = Field(None, alias="readNumber")


@router.post("/alignment/read")
async def alignment_read_route(
    body: _AlignmentReadBody, request: Request = None
) -> JSONResponse:
    """Resolve one exact BAM/CRAM alignment by composite read identity."""

    alignment_tiles, pileup = _load_alignment_services()
    pool = get_pool_manager().get(PoolName.TILE_IO.value)

    if _is_htsget_source(body):
        session = _htsget_session(body)
        chrom_length = dict(session.references).get(body.chrom)
        if chrom_length is None or body.reference_start >= chrom_length:
            raise HTTPException(
                status_code=404, detail="The htsget read is outside this source."
            )
        try:
            snapshot = await get_external_runtime().materialize_htsget_region(
                body.htsget_token,
                reference_name=body.chrom,
                start=body.reference_start,
                end=min(chrom_length, body.reference_start + 1),
                source_identity=body.htsget_source_identity,
            )
            try:
                async with pool.slot():
                    result = await asyncio.to_thread(
                        alignment_tiles.read_single_read_metadata,
                        str(snapshot.path),
                        body.chrom,
                        read_id=body.read_id,
                        reference_start=body.reference_start,
                        flag=body.flag,
                        read_number=body.read_number,
                        index_path=(
                            str(snapshot.index_path)
                            if snapshot.index_path is not None
                            else None
                        ),
                        reference_fasta=body.reference_path,
                    )
            finally:
                snapshot.cleanup()
        except QueueRefusal as exc:
            return _refuse_response(exc)
        except HtsgetSourceError as exc:
            raise _htsget_tile_error(exc) from exc
        except alignment_tiles.ReadNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return JSONResponse(content=result)

    bam_path = _require_file_bam_path(body)

    async def admitted_read() -> dict:
        async with pool.slot():
            await asyncio.to_thread(
                _validate_aligned_read_source_generation,
                body,
                pileup.require_aligned_read_source_generation,
            )
            result = await _run_alignment_native(
                bam_path,
                _compute_alignment_read,
                bam_path,
                body.chrom,
                body.read_id,
                body.reference_start,
                body.flag,
                body.read_number,
                body.index_path,
                body.reference_path,
            )
            await asyncio.to_thread(
                _validate_aligned_read_source_generation,
                body,
                pileup.require_aligned_read_source_generation,
            )
            return result

    try:
        result = await _run_alignment_request(bam_path, request, admitted_read)
    except QueueRefusal as exc:
        return _refuse_response(exc)
    except pileup.SourceGenerationChangedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except alignment_tiles.ReadNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (
        pileup.BamNotFoundError,
        pileup.IndexNotFoundError,
        pileup.ReferenceNotFoundError,
    ) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except OSError as exc:
        if _is_truncated_alignment_error(exc):
            raise HTTPException(
                status_code=404,
                detail=_TRUNCATED_ALIGNMENT_DETAIL,
            ) from exc
        raise
    return JSONResponse(content=result)


@router.post("/alignment/{level}/{tile_index}")
async def alignment_tile_route(
    level: int, tile_index: int, body: _TileSourceBody, request: Request = None
) -> JSONResponse:
    """Read pileup for a FINE tile (coarse levels return empty — the coverage band
    carries zoomed-out depth). Reads overlapping the tile span, with a GLOBAL
    stable top-K lane assignment so rows do not jump across tile seams."""
    if level < 0 or tile_index < 0:
        raise HTTPException(status_code=422, detail="level and tileIndex must be >= 0")

    alignment_tiles, pileup = _load_alignment_services()
    pool = get_pool_manager().get(PoolName.TILE_IO.value)

    if _is_htsget_source(body):
        session = _htsget_session(body)
        chrom_length = dict(session.references).get(body.chrom)
        if chrom_length is None:
            raise HTTPException(
                status_code=404, detail=f"chrom {body.chrom} not in htsget source"
            )
        start, end = _tile_bp_span(
            level, tile_index, chrom_length, body.chrom_global_start
        )
        if not tg.is_fine_level(level) or end <= start:
            result = await asyncio.to_thread(
                alignment_tiles.alignment_tile,
                "unused.bam",
                body.chrom,
                start,
                end,
                level=level,
                tile_index=tile_index,
                guides_only=body.guides_only,
            )
            return JSONResponse(content=result)
        try:
            snapshot = await get_external_runtime().materialize_htsget_region(
                body.htsget_token,
                reference_name=body.chrom,
                start=start,
                end=end,
                source_identity=body.htsget_source_identity,
            )
            try:
                async with pool.slot():
                    result = await asyncio.to_thread(
                        alignment_tiles.alignment_tile,
                        str(snapshot.path),
                        body.chrom,
                        start,
                        end,
                        level=level,
                        tile_index=tile_index,
                        index_path=(
                            str(snapshot.index_path)
                            if snapshot.index_path is not None
                            else None
                        ),
                        reference_fasta=body.reference_path,
                        guides_only=body.guides_only,
                    )
            finally:
                snapshot.cleanup()
        except QueueRefusal as exc:
            return _refuse_response(exc)
        except HtsgetSourceError as exc:
            raise _htsget_tile_error(exc) from exc
        return JSONResponse(content=result)

    bam_path = _require_file_bam_path(body)

    async def admitted_read() -> dict:
        async with pool.slot():
            await asyncio.to_thread(
                _validate_aligned_read_source_generation,
                body,
                pileup.require_aligned_read_source_generation,
            )
            if (
                request is not None
                and not pileup._is_remote_bam(bam_path)
                and await request.is_disconnected()
            ):
                raise asyncio.CancelledError
            result = await _run_alignment_native(
                bam_path,
                _compute_alignment_tile,
                bam_path,
                body.chrom,
                body.index_path,
                body.reference_path,
                level,
                tile_index,
                body.chrom_global_start,
                body.guides_only,
            )
            await asyncio.to_thread(
                _validate_aligned_read_source_generation,
                body,
                pileup.require_aligned_read_source_generation,
            )
            return result

    try:
        result = await _run_alignment_request(bam_path, request, admitted_read)
    except QueueRefusal as exc:
        return _refuse_response(exc)
    except pileup.SourceGenerationChangedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (
        pileup.BamNotFoundError,
        pileup.IndexNotFoundError,
        pileup.ReferenceNotFoundError,
    ) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except OSError as exc:
        if _is_truncated_alignment_error(exc):
            raise HTTPException(
                status_code=404,
                detail=_TRUNCATED_ALIGNMENT_DETAIL,
            ) from exc
        raise
    return JSONResponse(content=result)


class _AlignmentHeaderBody(_AlignedReadSourceBody):
    pass


@router.post("/alignment/index")
async def alignment_index_route(
    request: Request, body: AlignmentIndexRequest
) -> JSONResponse:
    """Compatibility adapter that waits on the durable managed operation."""
    principal = human_principal(request)
    service = operation_owner(request)
    submission = AlignmentIndexSubmission(
        submission_key=f"legacy-alignment-index-{uuid4()}",
        subject={"scope_id": next(iter(principal.scope_ids))},
        input=body,
    )
    try:
        prepared = await asyncio.to_thread(
            prepare_alignment_index_submission, submission
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    with operation_errors():
        snapshot = await service.start(
            principal,
            prepared,
            kind="alignment-index-preparation",
        )
        settled = await service.wait_for_terminal(principal, snapshot.id)
        envelope = service.get_result(principal, snapshot.id)

    if envelope.status == "available" and envelope.result is not None:
        result = AlignmentIndexResult.model_validate(envelope.result)
        return JSONResponse(
            content=result.model_dump(mode="json", by_alias=True),
            headers={"X-DNAForge-Operation-Id": snapshot.id},
        )

    error = settled.error
    code = error.code if error is not None else "ALIGNMENT_INDEX_UNAVAILABLE"
    message = (
        error.message
        if error is not None
        else "BAM index preparation did not produce an available result."
    )
    status_code = {
        "ALIGNMENT_INDEX_CAPACITY_UNAVAILABLE": 429,
        "ALIGNMENT_INDEX_SOURCE_CHANGED": 409,
        "ALIGNMENT_INDEX_SOURCE_UNAVAILABLE": 404,
        "ALIGNMENT_INDEX_INVALID_SOURCE": 422,
    }.get(code, 503 if settled.state == OperationState.INTERRUPTED else 500)
    raise HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message},
        headers={"X-DNAForge-Operation-Id": snapshot.id},
    )


@router.post("/alignment/header")
async def alignment_header_route(body: _AlignmentHeaderBody) -> JSONResponse:
    """Read BAM/CRAM genome identity and prove its random-access index is readable."""
    if _is_htsget_source(body):
        session = _htsget_session(body)
        return JSONResponse(
            content={
                "format": session.format.casefold(),
                "isCram": session.format == "CRAM",
                "referenceRequired": session.format == "CRAM",
                "references": [
                    {"name": name, "length": length, "md5": None}
                    for name, length in session.references
                ],
                "index": {"state": "present"},
            }
        )
    _, pileup = _load_alignment_services()
    pool = get_pool_manager().get(PoolName.ALIGNMENT_CONTROL.value)
    bam_path = _require_file_bam_path(body)

    try:
        async with pool.slot():
            await asyncio.to_thread(
                _validate_aligned_read_source_generation,
                body,
                pileup.require_aligned_read_source_generation,
            )
            result = await _run_alignment_native(
                bam_path,
                _compute_alignment_header,
                bam_path,
                body.index_path,
                body.reference_path,
                control=True,
            )
            await asyncio.to_thread(
                _validate_aligned_read_source_generation,
                body,
                pileup.require_aligned_read_source_generation,
            )
    except QueueRefusal as exc:
        return _refuse_response(exc)
    except pileup.SourceGenerationChangedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (
        pileup.BamNotFoundError,
        pileup.IndexNotFoundError,
        pileup.ReferenceNotFoundError,
    ) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except OSError as exc:
        if isinstance(exc, FileNotFoundError):
            raise HTTPException(
                status_code=404, detail=f"alignment not found: {body.bam_path}"
            ) from exc
        raise
    return JSONResponse(content=result)


@router.post(
    "/annotation/pyramid/readiness",
    response_model=AnnotationPyramidInventoryResponse,
    response_model_by_alias=True,
)
async def annotation_pyramid_readiness_route(
    body: AnnotationPyramidReadinessBody,
) -> AnnotationPyramidInventoryResponse | JSONResponse:
    """Verify the sealed type×bank inventory without parsing annotation rows."""
    annotation_tiles = _load_annotation_services()
    pool = get_pool_manager().get(PoolName.CPU_SLOW.value)

    def _check() -> dict:
        chroms = {
            source.chrom: annotation_tiles.annotation_pyramid_readiness(
                source.gff_path,
                source.chrom,
                chrom_length=source.chrom_length,
                verify_hashes=body.verify_hashes,
            )
            for source in body.sources
        }
        available_types = sorted(
            {
                track_type
                for status in chroms.values()
                for track_type in status["availableTypes"]
            }
        )
        return {
            "ready": all(status["ready"] for status in chroms.values()),
            "availableTypes": available_types,
            "chroms": chroms,
        }

    try:
        async with pool.slot():
            result = await asyncio.to_thread(_check)
    except QueueRefusal as exc:
        return _refuse_response(exc)
    except annotation_tiles.AnnotationSourceNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return AnnotationPyramidInventoryResponse.model_validate(result)


@router.post(
    "/annotation/pyramid/precompute",
    response_model=AnnotationPyramidInventoryResponse,
    response_model_by_alias=True,
)
async def annotation_pyramid_precompute_route(
    body: AnnotationPyramidPrecomputeBody,
) -> AnnotationPyramidInventoryResponse | JSONResponse:
    """Build every present annotation type and both isoform banks once.

    Sources are processed sequentially inside the slow-work pool so importing a
    whole assembly cannot launch 24 simultaneous GFF parses and starve visible
    tile traffic.
    """
    annotation_tiles = _load_annotation_services()
    pool = get_pool_manager().get(PoolName.CPU_SLOW.value)

    def _build() -> dict:
        chroms: dict[str, dict] = {}
        for source in body.sources:
            chroms[source.chrom] = annotation_tiles.annotation_pyramid_precompute(
                source.gff_path,
                source.chrom,
                source.chrom_length,
                force=body.force,
            )
        available_types = sorted(
            {
                track_type
                for status in chroms.values()
                for track_type in status["availableTypes"]
            }
        )
        return {
            "ready": all(status["ready"] for status in chroms.values()),
            "availableTypes": available_types,
            "chroms": chroms,
        }

    try:
        async with pool.slot():
            result = await asyncio.to_thread(_build)
    except QueueRefusal as exc:
        return _refuse_response(exc)
    except annotation_tiles.AnnotationSourceNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except annotation_tiles.AnnotationPyramidMissingError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return AnnotationPyramidInventoryResponse.model_validate(result)


@router.post("/annotation/{level}/{tile_index}")
async def annotation_tile_route(
    level: int, tile_index: int, body: AnnotationTileBody
) -> JSONResponse:
    """Gene/transcript glyphs for a tile. FINE = vector transcripts+exons+CDS
    (droppedCount===0); COARSE = raster mark composite (alpha-OVER, no whiteout).
    Tabix over the LOSSLESS NCBI GFF3. pysam/tabix runs via ``asyncio.to_thread``."""
    if level < 0 or tile_index < 0:
        raise HTTPException(status_code=422, detail="level and tileIndex must be >= 0")

    annotation_tiles = _load_annotation_services()
    pool = get_pool_manager().get(PoolName.TILE_IO.value)

    def _compute() -> dict:
        start = tg.tile_global_start(tile_index, level) - body.chrom_global_start
        end = tg.tile_global_end(tile_index, level) - body.chrom_global_start
        return annotation_tiles.annotation_tile(
            body.gff_path,
            body.chrom,
            start,
            end,
            level=level,
            tile_index=tile_index,
            visible_types=body.visible_types,
            lane_limit=body.lane_limit,
            bank=body.bank,
        )

    try:
        async with pool.slot():
            result = await asyncio.to_thread(_compute)
    except QueueRefusal as exc:
        return _refuse_response(exc)
    except annotation_tiles.AnnotationSourceNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except annotation_tiles.AnnotationPyramidMissingError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return JSONResponse(content=result)
