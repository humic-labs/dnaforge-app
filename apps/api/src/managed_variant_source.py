"""Managed-operation executor for VCF and BCF source preparation."""

from __future__ import annotations

import asyncio
import threading

from pydantic import ValidationError

from .concurrency.pools import get_pool_manager
from .concurrency.refusals import QueueRefusal
from .concurrency.schema import PoolName
from .operations import OperationExecutionError
from .variant_source_operation_contract import VariantSourceInput, VariantSourceResult


def _load_variant_service():
    from .services import variant_queries

    return variant_queries


async def execute_managed_variant_source(
    request: VariantSourceInput,
    _cancel_event: threading.Event,
) -> VariantSourceResult:
    try:
        variants = _load_variant_service()
    except ModuleNotFoundError as exc:
        if exc.name != "pysam":
            raise
        raise OperationExecutionError(
            "VARIANT_SOURCE_UNAVAILABLE",
            "Variant source preparation is unavailable in this runtime.",
        ) from exc

    try:
        pool = get_pool_manager().get(PoolName.CPU_SLOW.value)
        async with pool.slot():
            result = await asyncio.to_thread(
                variants.prepare_variant_source,
                request.variant_path,
                [reference.model_dump(mode="json") for reference in request.references],
                source_generation=request.source_generation,
            )
        return VariantSourceResult.model_validate(result)
    except QueueRefusal as exc:
        raise OperationExecutionError(
            "VARIANT_SOURCE_CAPACITY_UNAVAILABLE",
            "Variant source preparation capacity is temporarily unavailable.",
        ) from exc
    except variants.VariantSourceGenerationChangedError as exc:
        raise OperationExecutionError(
            "VARIANT_SOURCE_CHANGED",
            "The variant source changed after preparation was admitted.",
        ) from exc
    except variants.VariantSourceNotFoundError as exc:
        raise OperationExecutionError(
            "VARIANT_SOURCE_UNAVAILABLE",
            "The variant source is no longer available.",
        ) from exc
    except variants.VariantAssemblyMismatchError as exc:
        raise OperationExecutionError(
            "VARIANT_SOURCE_ASSEMBLY_MISMATCH",
            str(exc).splitlines()[0][:1024],
        ) from exc
    except variants.VariantIndexError as exc:
        raise OperationExecutionError(
            "VARIANT_SOURCE_INVALID",
            str(exc).splitlines()[0][:1024],
        ) from exc
    except variants.VariantQueryError as exc:
        raise OperationExecutionError(
            "VARIANT_SOURCE_INVALID",
            str(exc).splitlines()[0][:1024],
        ) from exc
    except OperationExecutionError:
        raise
    except (ValidationError, ValueError, TypeError) as exc:
        raise OperationExecutionError(
            "VARIANT_SOURCE_INVALID_RESULT",
            "Variant source preparation returned an invalid result.",
        ) from exc
    except Exception as exc:
        raise OperationExecutionError(
            "VARIANT_SOURCE_FAILED",
            "Variant source preparation failed.",
        ) from exc


__all__ = ["execute_managed_variant_source"]
