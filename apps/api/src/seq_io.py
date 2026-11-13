"""Minimal, dependency-free FASTA I/O + reverse-complement.

Replaces biopython (`SeqIO` / `Seq`) for the sidecar's simple sequence needs.
GenBank parsing (the hard part) lives in the Rust `dna-assembly` binary; this
module only covers FASTA read/write and reverse-complement — trivial string
operations that never justified a heavyweight, unmaintained dependency.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Union

_COMPLEMENT = str.maketrans(
    "ACGTURYSWKMBDHVNacgturyswkmbdhvn",
    "TGCAAYRSWMKVHDBNtgcaayrswmkvhdbn",
)


def reverse_complement(seq: str) -> str:
    """Reverse-complement a DNA/RNA string (IUPAC-aware), preserving case."""
    return seq.translate(_COMPLEMENT)[::-1]


@dataclass
class FastaRecord:
    id: str
    description: str
    seq: str


def read_fasta(path: Union[str, Path]) -> list[FastaRecord]:
    """Parse a FASTA file; sequence lines are concatenated with whitespace stripped."""
    records: list[FastaRecord] = []
    header: str | None = None
    chunks: list[str] = []

    def _flush() -> None:
        if header is not None:
            ident, _, desc = header.partition(" ")
            records.append(FastaRecord(id=ident, description=desc, seq="".join(chunks)))

    with open(path) as handle:
        for raw in handle:
            line = raw.strip()
            if line.startswith(">"):
                _flush()
                header = line[1:]
                chunks = []
            elif line and header is not None:
                chunks.append(line)
    _flush()
    return records


def _emit_fasta(handle, records: Iterable, wrap: int) -> None:
    for record in records:
        if isinstance(record, FastaRecord):
            ident, desc, seq = record.id, record.description, record.seq
        else:
            ident, seq = record
            desc = ""
        header = f">{ident} {desc}".rstrip() if desc else f">{ident}"
        handle.write(header + "\n")
        for i in range(0, len(seq), wrap):
            handle.write(seq[i : i + wrap] + "\n")


def write_fasta(
    dest: Union[str, Path, "object"], records: Iterable, wrap: int = 60
) -> None:
    """Write records to FASTA. `dest` is a path or an open text handle; each
    record is a FastaRecord or an ``(id, seq)`` tuple. Sequence is wrapped at
    `wrap` columns (60 = biopython default, keeps `samtools faidx` happy)."""
    if hasattr(dest, "write"):
        _emit_fasta(dest, records, wrap)
    else:
        with open(dest, "w") as handle:
            _emit_fasta(handle, records, wrap)
