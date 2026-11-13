"""Compatibility imports for the annotation-era module name."""

from .annotation_operation_audit import (
    annotation_submission_audit_parameters,
    recorded_annotation_import_audit_parameters,
)
from .managed_operation_agent_tools import (
    managed_annotation_tool_definitions,
    managed_operation_audit_result,
    register_managed_annotation_agent_tools,
)

MANAGED_ANNOTATION_TOOL_NAMES = frozenset(
    {
        "operations.discover",
        "operations.list",
        "operations.get",
        "operations.result",
        "operations.actions",
        "operations.annotation.start",
        "operations.annotation.import_recorded",
        "operations.request_cancel",
        "operations.release_result",
    }
)

__all__ = [
    "MANAGED_ANNOTATION_TOOL_NAMES",
    "annotation_submission_audit_parameters",
    "managed_annotation_tool_definitions",
    "managed_operation_audit_result",
    "recorded_annotation_import_audit_parameters",
    "register_managed_annotation_agent_tools",
]
