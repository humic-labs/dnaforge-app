"""Shared executable managed-operation kinds for contract tests.

Tests bind a stand-in executor to every executable kind and override only
the operations they exercise, preserving coverage of the complete contract.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from src.managed_operations import MANAGED_OPERATION_SYSTEM
from src.operations.registration import ExecutableOperationKind

MANAGED_OPERATION_KINDS = frozenset(
    {
        "alignment-coverage-preparation",
        "alignment-index-preparation",
        "annotation",
        "annotation-provisioning",
        "fastq-preprocessing",
        "genome-indexing",
        "multiple-sequence-alignment",
        "ngs-read-analysis",
        "pairwise-session-alignment",
        "primer-library-search",
        "track-registration",
        "variant-source-preparation",
    }
)


def bind_test_executors(
    default: Any, overrides: Mapping[Any, Any] | None = None
) -> Any:
    """Bind `default` to every executable kind, then `overrides` by kind key."""
    bindings = {
        package.key: default
        for package in MANAGED_OPERATION_SYSTEM.packages
        if isinstance(package, ExecutableOperationKind)
    }
    bindings.update(overrides or {})
    return MANAGED_OPERATION_SYSTEM.bind_executors(bindings)
