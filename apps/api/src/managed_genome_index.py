"""Managed-operation executor around the existing atomic genome indexer."""

from __future__ import annotations

import threading

from fastapi import HTTPException

from .concurrency.refusals import QueueRefusal
from .genome_index_operation_contract import IndexGenomeRequest, IndexGenomeResponse
from .operations import OperationCanceled, OperationExecutionError
from .routes.genome import _run_admitted_index


def _failure(status_code: int) -> tuple[str, str]:
    if status_code == 404:
        return (
            "GENOME_INDEX_INPUT_MISSING",
            "The genome source is no longer available.",
        )
    if status_code == 400:
        return (
            "GENOME_INDEX_INPUT_INVALID",
            "The genome source or output name is invalid.",
        )
    if status_code == 422:
        return (
            "GENOME_INDEX_PATH_REFUSED",
            "The genome source or output escaped its admitted workspace.",
        )
    if status_code == 503:
        return (
            "GENOME_INDEX_UNAVAILABLE",
            "Genome indexing is unavailable in this runtime.",
        )
    return "GENOME_INDEX_FAILED", "Genome indexing failed."


async def execute_managed_genome_index(
    request: IndexGenomeRequest,
    cancel_event: threading.Event,
) -> IndexGenomeResponse:
    try:
        return await _run_admitted_index(request, cancel_event)
    except QueueRefusal as exc:
        raise OperationExecutionError(
            "GENOME_INDEX_CAPACITY_UNAVAILABLE",
            "Genome indexing capacity is temporarily unavailable.",
        ) from exc
    except HTTPException as exc:
        if exc.status_code == 499:
            raise OperationCanceled("Genome indexing was canceled") from exc
        code, message = _failure(exc.status_code)
        raise OperationExecutionError(code, message) from exc


__all__ = ["execute_managed_genome_index"]
