"""Built-in providers + plugin registry for the external_resource substrate.

V1 shipped UniProt.  adds RCSB metadata as the first structure provider
foundation. Demo adds NCBI nuccore (nucleotide GenBank fetch). Further
providers (Ensembl, InterProScan, ESM Atlas) are deferred to follow-up plans;
third-party plugin loading is deferred to Phase 5.
"""

from .ncbi_nuccore import NcbiNuccoreProvider
from .neb_tm import NebTmProvider
from .paper_source import PaperSourceProvider
from .rcsb import RCSBProvider
from .ucsc import UcscApiEndpoint, UcscProvider
from .uniprot import UniProtProvider

__all__ = [
    "NcbiNuccoreProvider",
    "NebTmProvider",
    "PaperSourceProvider",
    "RCSBProvider",
    "UniProtProvider",
    "UcscApiEndpoint",
    "UcscProvider",
]
