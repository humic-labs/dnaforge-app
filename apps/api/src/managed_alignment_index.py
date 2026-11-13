"""Managed-operation executor for BAM index preparation."""

from __future__ import annotations

import asyncio
import threading

from pydantic import ValidationError

from .alignment_index_operation_contract import (
    AlignmentIndexInput,
    AlignmentIndexResult,
)
from .concurrency.pools import get_pool_manager
from .concurrency.refusals import QueueRefusal
from .concurrency.schema import PoolName
from .operations import OperationExecutionError


def _load_pileup_service():
    from .services import pileup

    return pileup


async def execute_managed_alignment_index(
    request: AlignmentIndexInput,
    _cancel_event: threading.Event,
) -> AlignmentIndexResult:
    try:
        pileup = _load_pileup_service()
    except ModuleNotFoundError as exc:
        if exc.name != "pysam":
            raise
        raise OperationExecutionError(
            "ALIGNMENT_INDEX_UNAVAILABLE",
            "BAM index preparation is unavailable in this runtime.",
        ) from exc

    try:
        pool = get_pool_manager().get(PoolName.CPU_SLOW.value)
        async with pool.slot():
            result = await asyncio.to_thread(
                pileup.ensure_alignment_index,
                request.bam_path,
                source_generation=request.source_generation,
            )
        return AlignmentIndexResult.model_validate(result)
    except QueueRefusal as exc:
        raise OperationExecutionError(
            "ALIGNMENT_INDEX_CAPACITY_UNAVAILABLE",
            "BAM index preparation capacity is temporarily unavailable.",
        ) from exc
    except pileup.SourceGenerationChangedError as exc:
        raise OperationExecutionError(
            "ALIGNMENT_INDEX_SOURCE_CHANGED",
            "The BAM changed after index preparation was admitted.",
        ) from exc
    except pileup.BamNotFoundError as exc:
        raise OperationExecutionError(
            "ALIGNMENT_INDEX_SOURCE_UNAVAILABLE",
            "The BAM is no longer available.",
        ) from exc
    except pileup.AlignmentIndexError as exc:
        raise OperationExecutionError(
            "ALIGNMENT_INDEX_INVALID_SOURCE",
            str(exc).splitlines()[0][:1024],
        ) from exc
    except OperationExecutionError:
        raise
    except (ValidationError, ValueError, TypeError) as exc:
        raise OperationExecutionError(
            "ALIGNMENT_INDEX_INVALID_RESULT",
            "BAM index preparation returned an invalid result.",
        ) from exc
    except Exception as exc:
        raise OperationExecutionError(
            "ALIGNMENT_INDEX_FAILED",
            "BAM index preparation failed.",
        ) from exc


__all__ = ["execute_managed_alignment_index"]
