"""
Bioinformatics tools module.

This module contains compute-intensive bioinformatics operations
that are better suited for Python (Primer3, BLAST, MAFFT, etc.)
"""

from .alignment import router as alignment_router
from .primer_bind import router as primer_bind_router

try:
    from .primer_design import router as primer_design_router

    __all__ = ["primer_design_router", "alignment_router", "primer_bind_router"]
except ImportError:
    primer_design_router = None
    __all__ = ["alignment_router", "primer_bind_router"]
