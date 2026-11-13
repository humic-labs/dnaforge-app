"""Maintained real-data fixtures for the bioinformatics DB substrate .

NOTE: Every accession, PDB ID, AlphaFold model id, and cross-reference in this
module is real and verifiable against the source database. Synthetic IDs are
banned (see project memory `feedback_real_fixtures_only_never_synthetic`).

If a fixture goes stale (e.g. UniProt deprecates an accession), update it here
in one place — these fixtures are imported by every L0/L1 test in this scope.
"""

from .external_resources import (
    AFDB_GROEL,
    AFDB_RUBISCO_LARGE,
    AFDB_TFR1,
    BIOLOGY_CROSS_REFS,
    LICENSE_TABLE,
    PDB_GROEL_GROES,
    PDB_RUBISCO,
    PDB_TFR1,
    UNIPROT_GROEL_ECOLI,
    UNIPROT_RUBISCO_LARGE,
    UNIPROT_TFR1_HUMAN,
    canonical_external_resources,
    canonical_xrefs,
)

__all__ = [
    "AFDB_GROEL",
    "AFDB_RUBISCO_LARGE",
    "AFDB_TFR1",
    "BIOLOGY_CROSS_REFS",
    "LICENSE_TABLE",
    "PDB_GROEL_GROES",
    "PDB_RUBISCO",
    "PDB_TFR1",
    "UNIPROT_GROEL_ECOLI",
    "UNIPROT_RUBISCO_LARGE",
    "UNIPROT_TFR1_HUMAN",
    "canonical_external_resources",
    "canonical_xrefs",
]
