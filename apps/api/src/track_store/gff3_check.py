"""Is this file a GFF3 the track store can hold for this assembly?

Registration copies the user's bytes unchanged, so the checks here are the
ones the store promises to every reader: a GFF3 header, nine tab-separated
columns, coordinates inside the assembly, column 1 naming the assembly, and
rows sorted by start so `tabix -p gff` indexes the file as written. Anything
about the attributes is the reader's business (docs/genome-viewer/
TRACK_STORE_GFF3.md), not the store's.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

MAX_PROBLEMS = 10


@dataclass(frozen=True)
class Gff3Summary:
    rows: int
    types: Counter = field(default_factory=Counter)


class Gff3CheckError(ValueError):
    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


def check_gff3(
    data: bytes, *, accession: str, length_bp: int, aliases: tuple[str, ...] = ()
) -> Gff3Summary:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise Gff3CheckError([f"not UTF-8 text (byte {exc.start})"]) from exc
    seqids = {accession, *aliases}
    problems: list[str] = []
    types: Counter = Counter()
    rows = 0
    seen_header = False
    last_start = 0
    last_end = 0

    def problem(message: str) -> None:
        if len(problems) < MAX_PROBLEMS:
            problems.append(message)

    for number, raw in enumerate(text.split("\n"), start=1):
        line = raw[:-1] if raw.endswith("\r") else raw
        if not line:
            continue
        if line.startswith("##FASTA") or line.startswith(">"):
            break
        if line.startswith("#"):
            if number == 1 and line.startswith("##gff-version 3"):
                seen_header = True
            continue
        if not seen_header:
            problem("line 1 must be '##gff-version 3'")
            seen_header = True
        columns = line.split("\t")
        if len(columns) != 9:
            problem(f"line {number}: {len(columns)} columns, GFF3 rows have 9")
            continue
        seqid, _source, ftype, start_text, end_text, _score, strand, _phase, _attrs = (
            columns
        )
        if seqid not in seqids:
            problem(f"line {number}: column 1 is {seqid!r}, not {accession}")
            continue
        try:
            start, end = int(start_text), int(end_text)
        except ValueError:
            problem(f"line {number}: columns 4-5 are not integers")
            continue
        if start < 1 or end < start or end > length_bp:
            problem(f"line {number}: [{start}, {end}] is outside 1..{length_bp}")
            continue
        if strand not in ("+", "-", ".", "?"):
            problem(f"line {number}: strand {strand!r} is not +, -, . or ?")
            continue
        if (start, end) < (last_start, last_end):
            problem(
                f"line {number}: rows are not sorted by start (sort with "
                "`sort -k1,1 -k4,4n -k5,5n` or `bedtools sort` first)"
            )
            continue
        last_start, last_end = start, end
        rows += 1
        types[ftype] += 1

    if rows == 0 and not problems:
        problems.append("no feature rows")
    if problems:
        raise Gff3CheckError(problems)
    return Gff3Summary(rows=rows, types=types)


__all__ = ["Gff3CheckError", "Gff3Summary", "check_gff3"]
