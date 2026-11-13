"""Process-isolated native htslib access for remote indexed variants.

``pysam.VariantFile`` can hold the Python GIL while libcurl waits on a remote
URL. A remote URL that points back at the sidecar therefore deadlocks when it
is opened in a thread: the event loop cannot run the loopback range-proxy
request. Keep the existing async capacity gate in the route, but execute the
native open/query in a small spawned process pool so the serving process stays
responsive.
"""

from __future__ import annotations

from typing import Any, Literal

from .remote_htslib_process import run_remote_htslib


async def prepare_remote_variant_source(
    query_url: str,
    index_path: str,
    expected_references: list[dict[str, object]],
    *,
    source_format: Literal["vcf", "bcf"],
    source_identity: str,
) -> dict[str, Any]:
    return await run_remote_htslib(
        _prepare_worker,
        query_url,
        index_path,
        expected_references,
        source_format,
        source_identity,
    )


async def query_remote_variant_page(
    query_url: str,
    index_path: str,
    references: list[str],
    *,
    source_identity: str,
    assembly_revision: str,
    cursor: str | None,
    limit: int,
) -> dict[str, Any]:
    return await run_remote_htslib(
        _query_worker,
        query_url,
        index_path,
        references,
        source_identity,
        assembly_revision,
        cursor,
        limit,
    )


async def query_remote_variant_region(
    query_url: str,
    index_path: str,
    *,
    source_identity: str,
    chrom: str,
    start: int,
    end: int,
    limit: int,
) -> dict[str, Any]:
    return await run_remote_htslib(
        _query_region_worker,
        query_url,
        index_path,
        source_identity,
        chrom,
        start,
        end,
        limit,
    )


def _prepare_worker(
    query_url: str,
    index_path: str,
    expected_references: list[dict[str, object]],
    source_format: Literal["vcf", "bcf"],
    source_identity: str,
) -> dict[str, Any]:
    from .variant_queries import prepare_remote_variant_source

    return prepare_remote_variant_source(
        query_url,
        index_path,
        expected_references,
        source_format=source_format,
        source_identity=source_identity,
    )


def _query_worker(
    query_url: str,
    index_path: str,
    references: list[str],
    source_identity: str,
    assembly_revision: str,
    cursor: str | None,
    limit: int,
) -> dict[str, Any]:
    from .variant_queries import query_remote_variant_page

    return query_remote_variant_page(
        query_url,
        index_path,
        references,
        source_identity=source_identity,
        assembly_revision=assembly_revision,
        cursor=cursor,
        limit=limit,
    )


def _query_region_worker(
    query_url: str,
    index_path: str,
    source_identity: str,
    chrom: str,
    start: int,
    end: int,
    limit: int,
) -> dict[str, Any]:
    from .variant_queries import query_remote_variant_region

    return query_remote_variant_region(
        query_url,
        index_path,
        source_identity=source_identity,
        chrom=chrom,
        start=start,
        end=end,
        limit=limit,
    )
