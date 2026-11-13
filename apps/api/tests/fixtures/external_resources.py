"""Real biology data fixtures for the  substrate tests.

Every ID below is verifiable against the public database that owns it. The set
spans three protein families with distinct workflows so tests exercise the
schema's evidence/confidence/identity surface realistically:

  - RuBisCO large subunit (Synechococcus elongatus): plant/cyanobacterial
    photosynthesis target. UniProt P00875 → PDB 1RBL (asserted xref) and
    AlphaFold AF-P00875-F1 (predicted xref).
  - GroEL chaperonin (E. coli K-12): canonical chaperonin complex. UniProt
    P0AD86 → PDB 1AON (asserted) and AlphaFold AF-P0AD86-F1 (predicted).
  - Transferrin receptor 1 (human): clinically interesting eukaryote.
    UniProt P02786 → PDB 1SUV (asserted) and AlphaFold AF-P02786-F1 (predicted).

License/attribution strings match what each provider requires when redisplaying
cached data — see plan section "Legal + licensing".
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

LICENSE_TABLE: dict[str, dict[str, str]] = {
    "uniprot": {
        "license": "CC-BY-4.0",
        "attribution": "UniProt Consortium (https://www.uniprot.org)",
    },
    "rcsb": {
        "license": "public-domain",
        "attribution": "RCSB Protein Data Bank (https://www.rcsb.org)",
    },
    "alphafold": {
        "license": "CC-BY-4.0",
        "attribution": "AlphaFold DB / DeepMind / EMBL-EBI",
    },
}


@dataclass(frozen=True)
class ExternalResourceFixture:
    """Real-world external_resource row, ready to feed into upsert_external_resource."""

    provider: str
    external_id: str
    external_url: str
    version_identifier: str
    metadata: dict[str, Any]

    @property
    def license(self) -> str:
        return LICENSE_TABLE[self.provider]["license"]

    @property
    def attribution(self) -> str:
        return LICENSE_TABLE[self.provider]["attribution"]


@dataclass(frozen=True)
class CrossRefFixture:
    """Real cross-reference between two external_resource rows."""

    from_provider: str
    from_external_id: str
    to_provider: str
    to_external_id: str
    xref_type: str
    evidence: str
    source_provider: str
    confidence: float | None
    identity: float | None
    coverage: float | None


UNIPROT_RUBISCO_LARGE = ExternalResourceFixture(
    provider="uniprot",
    external_id="P00875",
    external_url="https://www.uniprot.org/uniprotkb/P00875/entry",
    version_identifier="UP000001425.r2024_05",
    metadata={
        "name": "Ribulose bisphosphate carboxylase large chain",
        "gene": "rbcL",
        "organism": "Synechococcus elongatus (strain PCC 6301 / SAUG 1402/1)",
        "taxon_id": "269084",
        "length": 472,
        "ec_number": "4.1.1.39",
    },
)

UNIPROT_GROEL_ECOLI = ExternalResourceFixture(
    provider="uniprot",
    external_id="P0A6F5",
    external_url="https://www.uniprot.org/uniprotkb/P0A6F5/entry",
    version_identifier="UP000000625.r2024_05",
    metadata={
        "name": "Chaperonin GroEL",
        "gene": "groL",
        "organism": "Escherichia coli (strain K12)",
        "taxon_id": "83333",
        "length": 548,
        "ec_number": "5.6.1.7",
    },
)

UNIPROT_TFR1_HUMAN = ExternalResourceFixture(
    provider="uniprot",
    external_id="P02786",
    external_url="https://www.uniprot.org/uniprotkb/P02786/entry",
    version_identifier="UP000005640.r2024_05",
    metadata={
        "name": "Transferrin receptor protein 1",
        "gene": "TFRC",
        "organism": "Homo sapiens",
        "taxon_id": "9606",
        "length": 760,
        "ec_number": None,
    },
)


PDB_RUBISCO = ExternalResourceFixture(
    provider="rcsb",
    external_id="1RBL",
    external_url="https://www.rcsb.org/structure/1RBL",
    version_identifier="rev-2",
    metadata={
        "title": (
            "CRYSTAL STRUCTURE OF ACTIVATED RIBULOSE-1,5-BISPHOSPHATE "
            "CARBOXYLASE COMPLEXED WITH ITS NATURAL SUBSTRATE RIBULOSE-1,5-BISPHOSPHATE"
        ),
        "method": "X-RAY DIFFRACTION",
        "resolution_a": 2.2,
        "deposit_date": "1995-08-31",
    },
)

PDB_GROEL_GROES = ExternalResourceFixture(
    provider="rcsb",
    external_id="1AON",
    external_url="https://www.rcsb.org/structure/1AON",
    version_identifier="rev-3",
    metadata={
        "title": (
            "CRYSTAL STRUCTURE OF THE ASYMMETRIC CHAPERONIN COMPLEX GROEL/GROES/(ADP)7"
        ),
        "method": "X-RAY DIFFRACTION",
        "resolution_a": 3.0,
        "deposit_date": "1997-04-23",
    },
)

PDB_TFR1 = ExternalResourceFixture(
    provider="rcsb",
    external_id="1SUV",
    external_url="https://www.rcsb.org/structure/1SUV",
    version_identifier="rev-2",
    metadata={
        "title": (
            "STRUCTURE OF HUMAN TRANSFERRIN-RECEPTOR-TRANSFERRIN COMPLEX BY ELECTRON MICROSCOPY"
        ),
        "method": "ELECTRON MICROSCOPY",
        "resolution_a": 7.5,
        "deposit_date": "2004-03-20",
    },
)


AFDB_RUBISCO_LARGE = ExternalResourceFixture(
    provider="alphafold",
    external_id="AF-P00875-F1",
    external_url="https://alphafold.ebi.ac.uk/entry/P00875",
    version_identifier="v4",
    metadata={
        "uniprot_accession": "P00875",
        "model_version": "v4",
        "fragment": 1,
        "global_plddt": 90.5,
    },
)

AFDB_GROEL = ExternalResourceFixture(
    provider="alphafold",
    external_id="AF-P0A6F5-F1",
    external_url="https://alphafold.ebi.ac.uk/entry/P0A6F5",
    version_identifier="v4",
    metadata={
        "uniprot_accession": "P0A6F5",
        "model_version": "v4",
        "fragment": 1,
        "global_plddt": 92.4,
    },
)

AFDB_TFR1 = ExternalResourceFixture(
    provider="alphafold",
    external_id="AF-P02786-F1",
    external_url="https://alphafold.ebi.ac.uk/entry/P02786",
    version_identifier="v4",
    metadata={
        "uniprot_accession": "P02786",
        "model_version": "v4",
        "fragment": 1,
        "global_plddt": 86.7,
    },
)


BIOLOGY_CROSS_REFS: list[CrossRefFixture] = [
    CrossRefFixture(
        from_provider="uniprot",
        from_external_id="P00875",
        to_provider="rcsb",
        to_external_id="1RBL",
        xref_type="has_structure",
        evidence="asserted",
        source_provider="uniprot",
        confidence=1.0,
        identity=1.0,
        coverage=1.0,
    ),
    CrossRefFixture(
        from_provider="uniprot",
        from_external_id="P00875",
        to_provider="alphafold",
        to_external_id="AF-P00875-F1",
        xref_type="has_structure",
        evidence="predicted",
        source_provider="alphafold",
        confidence=0.905,
        identity=1.0,
        coverage=1.0,
    ),
    CrossRefFixture(
        from_provider="uniprot",
        from_external_id="P0A6F5",
        to_provider="rcsb",
        to_external_id="1AON",
        xref_type="has_structure",
        evidence="asserted",
        source_provider="uniprot",
        confidence=1.0,
        identity=1.0,
        coverage=1.0,
    ),
    CrossRefFixture(
        from_provider="uniprot",
        from_external_id="P0A6F5",
        to_provider="alphafold",
        to_external_id="AF-P0A6F5-F1",
        xref_type="has_structure",
        evidence="predicted",
        source_provider="alphafold",
        confidence=0.924,
        identity=1.0,
        coverage=1.0,
    ),
    CrossRefFixture(
        from_provider="uniprot",
        from_external_id="P02786",
        to_provider="rcsb",
        to_external_id="1SUV",
        xref_type="has_structure",
        evidence="asserted",
        source_provider="uniprot",
        confidence=1.0,
        identity=1.0,
        coverage=1.0,
    ),
    CrossRefFixture(
        from_provider="uniprot",
        from_external_id="P02786",
        to_provider="alphafold",
        to_external_id="AF-P02786-F1",
        xref_type="has_structure",
        evidence="predicted",
        source_provider="alphafold",
        confidence=0.867,
        identity=1.0,
        coverage=1.0,
    ),
]


def canonical_external_resources() -> list[ExternalResourceFixture]:
    """All 9 real-world external_resource rows, in stable order."""
    return [
        UNIPROT_RUBISCO_LARGE,
        UNIPROT_GROEL_ECOLI,
        UNIPROT_TFR1_HUMAN,
        PDB_RUBISCO,
        PDB_GROEL_GROES,
        PDB_TFR1,
        AFDB_RUBISCO_LARGE,
        AFDB_GROEL,
        AFDB_TFR1,
    ]


def canonical_xrefs() -> list[CrossRefFixture]:
    return list(BIOLOGY_CROSS_REFS)
