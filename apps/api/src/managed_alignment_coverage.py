"""Managed-operation executor for aligned-read coverage preparation."""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Mapping
from typing import Any

from pydantic import ValidationError

from .alignment_coverage_operation_contract import (
    AlignmentCoverageChromResult,
    AlignmentCoverageInput,
    AlignmentCoverageResult,
)
from .concurrency.pools import get_pool_manager
from .concurrency.refusals import QueueRefusal
from .concurrency.schema import PoolName
from .operations import OperationExecutionError


def _load_coverage_services():
    from .services import coverage_pyramid, pileup

    return coverage_pyramid, pileup


def _validate_source(request: AlignmentCoverageInput, pileup: Any) -> None:
    pileup.require_aligned_read_source_generation(
        request.bam_path,
        request.index_path,
        request.reference_path,
        request.source_generation.model_dump(
            mode="json", by_alias=True, exclude_none=True
        ),
    )


def _project_result_rows(
    value: object,
    *,
    expected_chroms: list[str],
) -> list[AlignmentCoverageChromResult]:
    if not isinstance(value, list) or len(value) != len(expected_chroms):
        raise ValueError("coverage engine returned the wrong number of rows")

    projected: list[AlignmentCoverageChromResult] = []
    for row in value:
        if not isinstance(row, Mapping):
            raise ValueError("coverage engine returned a non-object row")
        projected.append(
            AlignmentCoverageChromResult.model_validate(
                {
                    key: row[key]
                    for key in (
                        "chrom",
                        "present",
                        "built",
                        "chromLength",
                        "baseBinBp",
                        "sizeBytes",
                        "maxDepth",
                        "durationMs",
                    )
                    if key in row
                }
            )
        )

    if [row.chrom for row in projected] != expected_chroms:
        raise ValueError("coverage engine returned different chromosomes")
    if not all(row.present for row in projected):
        raise OperationExecutionError(
            "ALIGNMENT_COVERAGE_UNAVAILABLE",
            "Coverage could not be prepared for every requested chromosome.",
        )
    return projected


def _require_ready(value: object, *, expected_chroms: list[str]) -> None:
    if not isinstance(value, list) or len(value) != len(expected_chroms):
        raise ValueError("coverage readiness returned the wrong number of rows")
    names: list[str] = []
    for row in value:
        if not isinstance(row, Mapping):
            raise ValueError("coverage readiness returned a non-object row")
        chrom = row.get("chrom")
        if not isinstance(chrom, str):
            raise ValueError("coverage readiness omitted a chromosome")
        names.append(chrom)
        if row.get("present") is not True:
            raise OperationExecutionError(
                "ALIGNMENT_COVERAGE_UNAVAILABLE",
                "Coverage is not ready for every requested chromosome.",
            )
    if names != expected_chroms:
        raise ValueError("coverage readiness returned different chromosomes")


async def execute_managed_alignment_coverage(
    request: AlignmentCoverageInput,
    _cancel_event: threading.Event,
) -> AlignmentCoverageResult:
    try:
        coverage_pyramid, pileup = _load_coverage_services()
    except ModuleNotFoundError as exc:
        if exc.name != "pysam":
            raise
        raise OperationExecutionError(
            "ALIGNMENT_COVERAGE_UNAVAILABLE",
            "Aligned-read coverage is unavailable in this runtime.",
        ) from exc

    try:
        pool = get_pool_manager().get(PoolName.CPU_SLOW.value)
        async with pool.slot():
            await asyncio.to_thread(_validate_source, request, pileup)
            raw_result = await asyncio.to_thread(
                coverage_pyramid.coverage_pyramid_precompute,
                request.bam_path,
                request.chroms,
                index_path=request.index_path,
                reference_fasta=request.reference_path,
                force=request.force,
            )
            await asyncio.to_thread(_validate_source, request, pileup)
            rows = _project_result_rows(
                raw_result,
                expected_chroms=request.chroms,
            )
            readiness = await asyncio.to_thread(
                coverage_pyramid.coverage_pyramid_readiness,
                request.bam_path,
                request.chroms,
                index_path=request.index_path,
                reference_fasta=request.reference_path,
            )
            await asyncio.to_thread(_validate_source, request, pileup)
            _require_ready(readiness, expected_chroms=request.chroms)
            return AlignmentCoverageResult(chroms=rows)
    except QueueRefusal as exc:
        raise OperationExecutionError(
            "ALIGNMENT_COVERAGE_CAPACITY_UNAVAILABLE",
            "Alignment coverage preparation capacity is temporarily unavailable.",
        ) from exc
    except pileup.SourceGenerationChangedError as exc:
        raise OperationExecutionError(
            "ALIGNMENT_COVERAGE_SOURCE_CHANGED",
            "The aligned-read source changed after this operation was admitted.",
        ) from exc
    except (
        pileup.BamNotFoundError,
        pileup.IndexNotFoundError,
        pileup.ReferenceNotFoundError,
    ) as exc:
        raise OperationExecutionError(
            "ALIGNMENT_COVERAGE_SOURCE_UNAVAILABLE",
            "The aligned-read source or one of its required companion files is unavailable.",
        ) from exc
    except OperationExecutionError:
        raise
    except (ValidationError, ValueError, TypeError) as exc:
        raise OperationExecutionError(
            "ALIGNMENT_COVERAGE_INVALID_RESULT",
            "The coverage engine returned an invalid preparation result.",
        ) from exc
    except Exception as exc:
        raise OperationExecutionError(
            "ALIGNMENT_COVERAGE_FAILED",
            "Alignment coverage preparation failed.",
        ) from exc


__all__ = ["execute_managed_alignment_coverage"]
