"""POST /genome/index — sidecar route for the genome indexer (DNA-G1).

Plan: tools/devops/plans/2026-05-03-indexed-genome-backend.md.
"""

from __future__ import annotations

import asyncio
import contextlib
import threading
from pathlib import Path
from typing import Callable

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from ..concurrency.pools import get_pool_manager
from ..concurrency.refusals import QueueRefusal
from ..concurrency.schema import PoolName
from ..genome_index_operation_contract import (
    GenomeMetadataResponse,
    IndexGenomeRequest,
    IndexGenomeResponse,
)

router = APIRouter(prefix="/genome", tags=["Genome"])


def _managed_operation_runtime_present(request: Request) -> bool:
    app = getattr(request, "app", None)
    state = getattr(app, "state", None)
    return (
        getattr(state, "managed_operations", None) is not None
        or getattr(state, "managed_annotation_operations", None) is not None
    )


def _load_genome_indexer():
    """Load the genome indexer only when the route is used."""
    from ..services.genome_indexer import (
        GenomeIndexCancelledError,
        GenomeIndexerError,
        MissingInputError,
        NameValidationError,
        UnsupportedFormatError,
        WorkspaceContainmentError,
        index_genome,
    )

    return (
        GenomeIndexCancelledError,
        GenomeIndexerError,
        MissingInputError,
        NameValidationError,
        UnsupportedFormatError,
        WorkspaceContainmentError,
        index_genome,
    )


@router.post(
    "/index",
    response_model=IndexGenomeResponse,
    response_model_by_alias=True,
)
async def index_genome_route(
    req: IndexGenomeRequest, request: Request
) -> IndexGenomeResponse | JSONResponse:
    if _managed_operation_runtime_present(request):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "MANAGED_GENOME_INDEX_REQUIRED",
                "message": "Use /operations/genome-indexing in this runtime.",
            },
        )
    cancellation = threading.Event()
    completed = asyncio.Event()

    async def watch_disconnect() -> None:
        while not completed.is_set():
            if await request.is_disconnected():
                cancellation.set()
                return
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(completed.wait(), timeout=0.05)

    watcher = asyncio.create_task(watch_disconnect())
    admitted_task = asyncio.create_task(_run_admitted_index(req, cancellation))
    admitted_task.add_done_callback(_consume_detached_index_outcome)
    try:
        return await asyncio.shield(admitted_task)
    except QueueRefusal as exc:
        return JSONResponse(
            status_code=429,
            content=exc.to_response(),
            headers={"Retry-After": str(exc.retry_after_seconds)},
        )
    except asyncio.CancelledError:
        cancellation.set()
        raise
    finally:
        completed.set()
        watcher.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await watcher


async def _run_admitted_index(
    req: IndexGenomeRequest, cancellation: threading.Event
) -> IndexGenomeResponse:
    """Keep capacity owned until the blocking worker physically settles.

    The route awaits this task through ``asyncio.shield``. If the HTTP request is
    cancelled, the cooperative cancellation flag is set while this task remains
    alive inside the bounded pool until the worker thread really exits.
    """
    pool = get_pool_manager().get(PoolName.CPU_SLOW.value)
    async with pool.slot():
        return await asyncio.to_thread(
            _index_genome_route_sync, req, cancellation.is_set
        )


def _consume_detached_index_outcome(task: asyncio.Task[IndexGenomeResponse]) -> None:
    """Retrieve an outcome after its cancelled HTTP caller has detached."""
    with contextlib.suppress(asyncio.CancelledError, Exception):
        task.exception()


def _index_genome_route_sync(
    req: IndexGenomeRequest, cancel_check: Callable[[], bool]
) -> IndexGenomeResponse:
    (
        GenomeIndexCancelledError,
        GenomeIndexerError,
        MissingInputError,
        NameValidationError,
        UnsupportedFormatError,
        WorkspaceContainmentError,
        index_genome,
    ) = _load_genome_indexer()

    try:
        result = index_genome(
            input_path=Path(req.input),
            output_dir=Path(req.output_dir),
            name=req.name,
            workspace_root=Path(req.workspace_root),
            cancel_check=cancel_check,
        )
    except GenomeIndexCancelledError as exc:
        raise HTTPException(status_code=499, detail=str(exc)) from exc
    except MissingInputError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except UnsupportedFormatError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except NameValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except WorkspaceContainmentError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except GenomeIndexerError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    annotation_types: list[str] = []
    annotation_raster_ready = True
    if result.gff_path is not None and result.metadata.feature_count > 0:
        from ..services.annotation_tiles import (
            AnnotationPyramidCancelledError,
            AnnotationPyramidMissingError,
            annotation_pyramid_precompute,
        )

        try:
            fai_line = result.fai_path.read_text(encoding="utf-8").splitlines()[0]
            indexed_chrom = fai_line.split("\t", 1)[0]
            raster_status = annotation_pyramid_precompute(
                str(result.gff_path),
                indexed_chrom,
                result.metadata.length,
                cancel_check=cancel_check,
            )
        except AnnotationPyramidCancelledError as exc:
            raise HTTPException(status_code=499, detail=str(exc)) from exc
        except (OSError, IndexError, ValueError, AnnotationPyramidMissingError) as exc:
            raise HTTPException(
                status_code=500,
                detail=f"genome indexed but annotation raster product failed: {exc}",
            ) from exc
        annotation_types = raster_status["availableTypes"]
        annotation_raster_ready = bool(raster_status["ready"])

    return IndexGenomeResponse(
        fasta_path=str(result.fasta_path),
        fai_path=str(result.fai_path),
        gff_path=str(result.gff_path) if result.gff_path else None,
        tbi_path=str(result.tbi_path) if result.tbi_path else None,
        metadata=GenomeMetadataResponse(
            length=result.metadata.length,
            circular=result.metadata.circular,
            feature_count=result.metadata.feature_count,
            annotation_types=annotation_types,
            annotation_raster_ready=annotation_raster_ready,
        ),
    )
