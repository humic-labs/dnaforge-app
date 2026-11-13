from __future__ import annotations

from importlib import import_module
from typing import Any

_MODULES = {
    "FASTQ_PREPROCESSING_OPERATION_KIND": ".fastq_preprocessing",
    "NGS_READ_ANALYSIS_OPERATION_KIND": ".ngs_read_analysis",
    "ALIGNMENT_COVERAGE_PREPARATION_OPERATION_KIND": ".alignment_coverage_preparation",
    "ALIGNMENT_INDEX_PREPARATION_OPERATION_KIND": ".alignment_index_preparation",
    "ANNOTATION_OPERATION_KIND": ".annotation",
    "ANNOTATION_PROVISIONING_OPERATION_KIND": ".annotation_provisioning",
    "GENOME_INDEXING_OPERATION_KIND": ".genome_indexing",
    "MULTIPLE_SEQUENCE_ALIGNMENT_OPERATION_KIND": ".multiple_sequence_alignment",
    "PAIRWISE_SESSION_ALIGNMENT_OPERATION_KIND": ".pairwise_session_alignment",
    "PRIMER_LIBRARY_SEARCH_OPERATION_KIND": ".primer_library_search",
    "TRACK_REGISTRATION_OPERATION_KIND": ".track_registration",
    "VARIANT_SOURCE_PREPARATION_OPERATION_KIND": ".variant_source_preparation",
}

__all__ = list(_MODULES)


def __getattr__(name: str) -> Any:
    module = _MODULES.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(module, __name__), name)
    globals()[name] = value
    return value
