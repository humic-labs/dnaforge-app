"""Application adapter around the independently usable annotation implementation."""

from __future__ import annotations

import threading
from functools import partial
from pathlib import Path

from .annotation_provisioning import execute_managed_annotation_provisioning
from .control_plane import ControlPlaneStore
from .managed_alignment_coverage import execute_managed_alignment_coverage
from .managed_alignment_index import execute_managed_alignment_index
from .managed_genome_index import execute_managed_genome_index
from .managed_msa import execute_managed_msa
from .managed_operations import MANAGED_OPERATION_SYSTEM
from .managed_pairwise_session_alignment import (
    execute_managed_pairwise_session_alignment,
)
from .managed_primer_library_search import execute_managed_primer_library_search
from .managed_track_registration import execute_managed_track_registration
from .managed_variant_source import execute_managed_variant_source
from .operation_agent_authority import validate_operation_principal
from .operation_connection import (
    operation_connection_path as _operation_connection_path,
)
from .operation_kinds import (
    ALIGNMENT_COVERAGE_PREPARATION_OPERATION_KIND,
    ALIGNMENT_INDEX_PREPARATION_OPERATION_KIND,
    ANNOTATION_OPERATION_KIND,
    ANNOTATION_PROVISIONING_OPERATION_KIND,
    FASTQ_PREPROCESSING_OPERATION_KIND,
    GENOME_INDEXING_OPERATION_KIND,
    MULTIPLE_SEQUENCE_ALIGNMENT_OPERATION_KIND,
    NGS_READ_ANALYSIS_OPERATION_KIND,
    PAIRWISE_SESSION_ALIGNMENT_OPERATION_KIND,
    PRIMER_LIBRARY_SEARCH_OPERATION_KIND,
    TRACK_REGISTRATION_OPERATION_KIND,
    VARIANT_SOURCE_PREPARATION_OPERATION_KIND,
)
from .operations import (
    ManagedOperationService,
    OperationExecutionError,
)
from .routes.operations import operation_owner_id
from .services import registry
from .services.fastq_preprocessing import execute_fastq_preprocessing
from .services.ngs_read_analysis import execute_ngs_read_analysis
from .services.plannotate import (
    PLANNOTATE_SERVICE_NAME,
    AnnotationRequest,
    AnnotationResult,
    PlannotateService,
)


def create_managed_operation_service(
    store: ControlPlaneStore,
    *,
    runtime_scope: str,
) -> ManagedOperationService:
    annotation = registry.get(PLANNOTATE_SERVICE_NAME)
    if not isinstance(annotation, PlannotateService):
        raise RuntimeError("Annotation service is not registered")

    async def execute(
        request: AnnotationRequest, _cancel: threading.Event
    ) -> AnnotationResult:

        result = await annotation.annotate(request)
        if result.error:
            raise OperationExecutionError(
                "ANNOTATION_FAILED", result.error.splitlines()[0][:1024]
            )
        return result

    return ManagedOperationService(
        store=store,
        runtime_scope=runtime_scope,
        adapters=MANAGED_OPERATION_SYSTEM.bind_executors(
            {
                NGS_READ_ANALYSIS_OPERATION_KIND.key: execute_ngs_read_analysis,
                FASTQ_PREPROCESSING_OPERATION_KIND.key: execute_fastq_preprocessing,
                ALIGNMENT_COVERAGE_PREPARATION_OPERATION_KIND.key: execute_managed_alignment_coverage,
                ALIGNMENT_INDEX_PREPARATION_OPERATION_KIND.key: execute_managed_alignment_index,
                ANNOTATION_OPERATION_KIND.key: execute,
                ANNOTATION_PROVISIONING_OPERATION_KIND.key: execute_managed_annotation_provisioning,
                GENOME_INDEXING_OPERATION_KIND.key: execute_managed_genome_index,
                MULTIPLE_SEQUENCE_ALIGNMENT_OPERATION_KIND.key: execute_managed_msa,
                PAIRWISE_SESSION_ALIGNMENT_OPERATION_KIND.key: execute_managed_pairwise_session_alignment,
                PRIMER_LIBRARY_SEARCH_OPERATION_KIND.key: execute_managed_primer_library_search,
                TRACK_REGISTRATION_OPERATION_KIND.key: execute_managed_track_registration,
                VARIANT_SOURCE_PREPARATION_OPERATION_KIND.key: execute_managed_variant_source,
            }
        ),
        principal_validator=partial(
            validate_operation_principal,
            store=store,
            runtime_scope=runtime_scope,
            owner_id=operation_owner_id(),
        ),
    )


def create_managed_annotation_service(
    store: ControlPlaneStore,
    *,
    runtime_scope: str,
) -> ManagedOperationService:
    """Compatibility name for callers predating the multi-kind runtime."""
    return create_managed_operation_service(store, runtime_scope=runtime_scope)


def operation_connection_path(store: ControlPlaneStore, scope_id: str) -> Path:
    """Compatibility adapter for application callers that already own a store."""
    return _operation_connection_path(store.db_path, scope_id)
