from __future__ import annotations

from .operations import ActiveJoinMode, CancellationMode
from .operations.registration import (
    ExecutableOperationKind,
    OperationKindKey,
    OperationLimits,
    ResultCodec,
    StartContract,
)
from .primer_library_search_operation_audit import (
    primer_library_search_audit_parameters,
)
from .primer_library_search_operation_contract import (
    PrimerLibrarySearchInput,
    PrimerLibrarySearchResult,
    PrimerLibrarySearchSubmission,
    prepare_primer_library_search_submission,
)

PRIMER_LIBRARY_SEARCH_OPERATION_KIND = ExecutableOperationKind(
    key=OperationKindKey(kind="primer-library-search", version=1),
    title="Search primer library",
    input_model=PrimerLibrarySearchInput,
    result=ResultCodec(
        current_version=1,
        model=PrimerLibrarySearchResult,
        decoders={1: PrimerLibrarySearchResult.model_validate},
    ),
    start=StartContract(
        request_model=PrimerLibrarySearchSubmission,
        prepare=prepare_primer_library_search_submission,
        required_capabilities=frozenset({"operations.start"}),
        audit_parameters=primer_library_search_audit_parameters,
    ),
    cancellation=CancellationMode.QUEUED_ONLY,
    active_join=ActiveJoinMode.SUBJECT_REVISION,
    limits=OperationLimits(
        max_input_bytes=16 * 1024 * 1024,
        max_result_bytes=16 * 1024 * 1024,
    ),
)

__all__ = ["PRIMER_LIBRARY_SEARCH_OPERATION_KIND"]
