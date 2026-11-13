"""Managed-operation executor for Alignment Manager pairwise session runs."""

from __future__ import annotations

import asyncio
import os
import subprocess
import threading
import time
import uuid
from pathlib import Path

from fastapi import HTTPException
from pydantic import ValidationError

from .operations import OperationCanceled, OperationExecutionError
from .pairwise_session_alignment_operation_contract import (
    PairwiseSessionAlignmentInput,
    PairwiseSessionAlignmentResult,
    PairwiseSessionAlignmentToolIdentity,
    PairwiseSessionQueryResult,
    pairwise_session_alignment_input_revision,
)
from .tools.alignment import (
    AlignmentAlgorithm,
    AlignmentCanceled,
    PairwiseAlignmentRequest,
    _execute_pairwise_alignment,
    read_mafft_version,
    resolve_mafft_runtime,
)


def _failure(exc: HTTPException) -> OperationExecutionError:
    if exc.status_code == 504:
        return OperationExecutionError(
            "PAIRWISE_ALIGNMENT_TIMEOUT",
            "Pairwise session alignment timed out.",
        )
    if exc.detail == "MAFFT not installed. Please install MAFFT.":
        return OperationExecutionError("PAIRWISE_ALIGNMENT_UNAVAILABLE", exc.detail)
    return OperationExecutionError(
        "PAIRWISE_ALIGNMENT_FAILED",
        "Pairwise session alignment failed.",
    )


async def _await_test_barrier(cancel_event: threading.Event) -> None:
    """Hold one executor after admission in explicit test builds only."""
    barrier_root = os.environ.get("WAYPOINT_PAIRWISE_SESSION_E2E_BARRIER")
    if os.environ.get("WAYPOINT_TEST") != "1" or not barrier_root:
        return
    root = Path(barrier_root).resolve()
    if not root.is_dir():
        raise RuntimeError("pairwise-session E2E barrier directory does not exist")
    (root / f"entered-{uuid.uuid4().hex}").write_text(
        str(threading.get_ident()), encoding="utf-8"
    )
    deadline = time.monotonic() + 120
    release = root / "release"
    while not release.exists():
        if cancel_event.is_set():
            raise OperationCanceled("Pairwise session alignment was canceled")
        if time.monotonic() >= deadline:
            raise RuntimeError("pairwise-session E2E barrier timed out")
        await asyncio.sleep(0.02)


async def execute_managed_pairwise_session_alignment(
    request: PairwiseSessionAlignmentInput,
    cancel_event: threading.Event,
) -> PairwiseSessionAlignmentResult:
    await _await_test_barrier(cancel_event)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + request.timeout_seconds
    try:
        runtime = resolve_mafft_runtime()
        tool = PairwiseSessionAlignmentToolIdentity(
            name="MAFFT",
            version=await read_mafft_version(
                runtime, deadline=deadline, cancel_event=cancel_event
            ),
        )
    except AlignmentCanceled as exc:
        raise OperationCanceled("Pairwise session alignment was canceled") from exc
    except asyncio.TimeoutError as exc:
        raise OperationExecutionError(
            "PAIRWISE_ALIGNMENT_TIMEOUT", "Pairwise session alignment timed out."
        ) from exc
    except (FileNotFoundError, subprocess.CalledProcessError, ValueError) as exc:
        raise OperationExecutionError(
            "PAIRWISE_ALIGNMENT_TOOL_IDENTITY_UNAVAILABLE",
            "MAFFT did not report a valid execution version.",
        ) from exc

    async def align(query) -> PairwiseSessionQueryResult:
        try:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise OperationExecutionError(
                    "PAIRWISE_ALIGNMENT_TIMEOUT",
                    "Pairwise session alignment timed out.",
                )
            alignment = await _execute_pairwise_alignment(
                PairwiseAlignmentRequest(
                    query=query.sequence,
                    reference=request.reference_sequence,
                    algorithm=AlignmentAlgorithm(request.algorithm.value),
                    threads=request.threads,
                    use_cache=False,
                    is_circular=request.is_circular,
                ),
                timeout_seconds=remaining,
                cancel_event=cancel_event,
                runtime=runtime,
                deadline=deadline,
            )
        except AlignmentCanceled as exc:
            raise OperationCanceled("Pairwise session alignment was canceled") from exc
        except HTTPException as exc:
            raise _failure(exc) from exc
        except FileNotFoundError as exc:
            raise OperationExecutionError(
                "PAIRWISE_ALIGNMENT_UNAVAILABLE",
                "MAFFT not installed. Please install MAFFT.",
            ) from exc
        return PairwiseSessionQueryResult(
            queryId=query.id,
            queryRevision=query.revision,
            alignment=alignment,
        )

    if cancel_event.is_set():
        raise OperationCanceled("Pairwise session alignment was canceled")
    if loop.time() >= deadline:
        raise OperationExecutionError(
            "PAIRWISE_ALIGNMENT_TIMEOUT", "Pairwise session alignment timed out."
        )
    tasks = [asyncio.create_task(align(query)) for query in request.queries]
    try:
        rows = await asyncio.gather(*tasks)
    except (Exception, asyncio.CancelledError):
        cancel_event.set()
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise

    try:
        result = PairwiseSessionAlignmentResult(
            inputRevision=pairwise_session_alignment_input_revision(request),
            referenceRevision=request.reference_revision,
            results=rows,
            tool=tool,
        )
    except ValidationError as exc:
        raise OperationExecutionError(
            "PAIRWISE_ALIGNMENT_INVALID_RESULT",
            "MAFFT returned an invalid pairwise session result.",
        ) from exc

    expected = [(query.id, query.revision) for query in request.queries]
    returned = [(row.query_id, row.query_revision) for row in result.results]
    if returned != expected:
        raise OperationExecutionError(
            "PAIRWISE_ALIGNMENT_INVALID_RESULT",
            "MAFFT returned different query identities from the submitted input.",
        )
    return result


__all__ = ["execute_managed_pairwise_session_alignment"]
