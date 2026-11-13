"""Standalone DNA annotation contracts and synchronous entry point."""

from .contract import (
    AnnotationExecutables,
    AnnotationFeature,
    AnnotationRequest,
    AnnotationResult,
    AnnotationRuntime,
    DbSource,
)
from .core import run_annotation

__all__ = [
    "AnnotationExecutables",
    "AnnotationFeature",
    "AnnotationRequest",
    "AnnotationResult",
    "AnnotationRuntime",
    "DbSource",
    "run_annotation",
]
