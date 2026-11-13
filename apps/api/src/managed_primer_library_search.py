"""Managed-operation executor for primer-library binding searches."""

from __future__ import annotations

import asyncio
import os
import threading
import time
import uuid
from pathlib import Path

from pydantic import ValidationError

from .operations import OperationExecutionError
from .primer_library_search_operation_contract import (
    PrimerLibrarySearchInput,
    PrimerLibrarySearchPrimerResult,
    PrimerLibrarySearchResult,
)
from .tools.primer_bind import (
    BatchBindRequest,
    BatchBindResponse,
    BindingHit,
    _bind_primers_batch_sync,
)


def _overlaps_region(hit: BindingHit, start: int, end: int) -> bool:
    if hit.start < hit.end:
        return hit.start < end and hit.end > start
    return hit.start < end or hit.end > start


def _absolute_hit(hit: BindingHit, offset: int) -> BindingHit:
    if offset == 0:
        return hit
    return hit.model_copy(update={"start": hit.start + offset, "end": hit.end + offset})


def _batch_request(value: PrimerLibrarySearchInput) -> tuple[BatchBindRequest, int]:
    sequence = value.reference_sequence
    circular = value.circular
    offset = 0
    if value.region_start is not None and value.region_end is not None:
        max_primer_length = max(len(primer.sequence) for primer in value.primers)
        offset = max(0, value.region_start - max_primer_length)
        slice_end = min(len(sequence), value.region_end + max_primer_length)
        sequence = sequence[offset:slice_end]
        circular = False
    return (
        BatchBindRequest(
            primers=[primer.sequence for primer in value.primers],
            sequence=sequence,
            max_edit_distance=value.max_edit_distance,
            circular=circular,
            min_match_length=value.min_match_length,
            min_effective_tm=value.min_effective_tm,
            max_mismatches=value.max_mismatches,
        ),
        offset,
    )


def _run_matcher(request: BatchBindRequest) -> BatchBindResponse:
    """Run the matcher, honoring the explicit non-production E2E barrier."""
    barrier_root = os.environ.get("WAYPOINT_PRIMER_SEARCH_E2E_BARRIER")
    if os.environ.get("WAYPOINT_TEST") == "1" and barrier_root:
        root = Path(barrier_root).resolve()
        if not root.is_dir():
            raise RuntimeError("primer-search E2E barrier directory does not exist")
        marker = root / f"entered-{uuid.uuid4().hex}"
        marker.write_text(str(threading.get_ident()), encoding="utf-8")
        deadline = time.monotonic() + 120
        release = root / "release"
        while not release.exists():
            if time.monotonic() >= deadline:
                raise RuntimeError("primer-search E2E barrier timed out")
            time.sleep(0.02)
    return _bind_primers_batch_sync(request)


async def execute_managed_primer_library_search(
    request: PrimerLibrarySearchInput,
    _cancel_event: threading.Event,
) -> PrimerLibrarySearchResult:
    try:
        batch_request, offset = _batch_request(request)
        response = await asyncio.to_thread(_run_matcher, batch_request)
        if len(response.results) != len(request.primers):
            raise ValueError("primer matcher returned the wrong number of rows")

        projected: list[PrimerLibrarySearchPrimerResult] = []
        for primer, row in zip(request.primers, response.results, strict=True):
            if row.primer.strip().upper() != primer.sequence:
                raise ValueError("primer matcher returned rows out of order")
            hits = [_absolute_hit(hit, offset) for hit in row.hits]
            if request.region_start is not None and request.region_end is not None:
                hits = [
                    hit
                    for hit in hits
                    if _overlaps_region(hit, request.region_start, request.region_end)
                ]
            projected.append(
                PrimerLibrarySearchPrimerResult(primerId=primer.id, hits=hits)
            )

        return PrimerLibrarySearchResult(
            targetRevision=request.target_revision,
            libraryRevision=request.library_revision,
            results=projected,
        )
    except OperationExecutionError:
        raise
    except (ValidationError, ValueError, TypeError) as exc:
        raise OperationExecutionError(
            "PRIMER_LIBRARY_SEARCH_INVALID_RESULT",
            "The primer matcher returned an invalid search result.",
        ) from exc
    except Exception as exc:
        raise OperationExecutionError(
            "PRIMER_LIBRARY_SEARCH_FAILED",
            "Primer library search failed.",
        ) from exc


__all__ = ["execute_managed_primer_library_search"]
