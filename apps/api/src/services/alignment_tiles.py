"""/ — indexed alignment tiles for the linear pileup.

Alignment tiles are a fine-level source. Coverage owns coarse representation.
The sidecar publishes read intervals plus sparse reference-difference events;
row assignment and every visual decision remain renderer-owned.
"""

from __future__ import annotations

import math
from contextlib import nullcontext
from pathlib import Path
from typing import Callable, Literal, NotRequired, Optional, TypedDict

import pysam

from .pileup import (
    BamNotFoundError,
    ReferenceNotFoundError,
    _is_remote_bam,
    _open_alignment,
    _resolve_bam_path,
    _resolve_index_path,
    _resolve_reference_path,
)
from .tile_geometry import is_fine_level

READ_TILE_MAX_RECORDS = 100_000
ALT_GUIDE_MIN_WEIGHTED_FRACTION = 0.20
ALT_GUIDE_MIN_SUPPORTING_READS = 3
_DETAIL_TAGS = ("NM", "AS", "MD", "RG")
_UNKNOWN_MAPPING_QUALITY = 255


class AlignmentMismatch(TypedDict):
    pos: int
    kind: Literal["sub", "ins", "del"]
    length: int
    refBase: NotRequired[str]
    readBase: NotRequired[str]
    baseQ: NotRequired[int]


class AlignmentAlternateColumn(TypedDict):
    pos: int
    kind: Literal["sub", "ins", "del"]
    length: int
    refBase: NotRequired[str]
    readBase: NotRequired[str]
    coveringReadCount: int
    supportingReadCount: int
    weightedDepth: float
    weightedSupport: float
    weightedFraction: float


class AlignmentReadPair(TypedDict):
    paired: Literal[True]
    properPair: bool
    readNumber: NotRequired[Literal[1, 2]]
    mateUnmapped: bool
    mateReverse: bool
    mateStart: NotRequired[int]
    templateLength: int


class AlignmentReadBlock(TypedDict):
    start: int
    end: int


class AlignmentRead(TypedDict):
    start: int
    end: int
    strand: str
    mapq: int
    readId: str
    flag: int
    pair: NotRequired[AlignmentReadPair]
    mismatches: NotRequired[list[AlignmentMismatch]]
    blocks: list[AlignmentReadBlock]


class AlignmentTile(TypedDict):
    chrom: str
    level: int
    tileIndex: int
    start: int
    end: int
    reads: list[AlignmentRead]
    alternateColumns: list[AlignmentAlternateColumn]
    count: int
    sourceCount: int
    fine: bool
    truncated: bool


class AlignmentReadMetadata(TypedDict):
    readId: str
    chrom: str
    start: int
    end: int
    strand: str
    mapq: int
    flag: int
    cigar: str
    seq: str
    baseQualities: NotRequired[list[int]]
    pair: NotRequired[AlignmentReadPair]
    tags: dict[str, object]


class ReadNotFoundError(Exception):
    """No primary alignment matched the caller's composite BAM identity."""


class _AlternateAccumulator(TypedDict):
    supportingReadCount: int
    weightedSupport: float


def _read_number(read: pysam.AlignedSegment) -> Literal[1, 2] | None:
    if read.is_read1:
        return 1
    if read.is_read2:
        return 2
    return None


def _pair_metadata(read: pysam.AlignedSegment) -> AlignmentReadPair | None:
    if not read.is_paired:
        return None
    pair: AlignmentReadPair = {
        "paired": True,
        "properPair": bool(read.is_proper_pair),
        "mateUnmapped": bool(read.mate_is_unmapped),
        "mateReverse": bool(read.mate_is_reverse),
        "templateLength": int(read.template_length),
    }
    read_number = _read_number(read)
    if read_number is not None:
        pair["readNumber"] = read_number
    if (
        not read.mate_is_unmapped
        and read.next_reference_start >= 0
        and read.next_reference_id == read.reference_id
    ):
        pair["mateStart"] = int(read.next_reference_start)
    return pair


def _edit_distance(read: pysam.AlignedSegment) -> int | None:
    if not read.has_tag("NM"):
        return None
    value = read.get_tag("NM")
    return int(value) if isinstance(value, (int, float)) else None


def _base_quality(read: pysam.AlignedSegment, query_pos: int) -> int | None:
    qualities = read.query_qualities
    if qualities is None or query_pos < 0 or query_pos >= len(qualities):
        return None
    return int(qualities[query_pos])


def _mean_base_quality(
    read: pysam.AlignedSegment, query_start: int, length: int
) -> int | None:
    qualities = read.query_qualities
    if qualities is None or length <= 0:
        return None
    selected = qualities[query_start : query_start + length]
    if len(selected) != length:
        return None
    return int(round(sum(selected) / length))


def _insertion_events(read: pysam.AlignedSegment) -> list[AlignmentMismatch]:
    query = (read.query_sequence or "").upper()
    ref_pos = int(read.reference_start)
    query_pos = 0
    events: list[AlignmentMismatch] = []
    for operation, length in read.cigartuples or ():
        if operation in (0, 7, 8):
            ref_pos += length
            query_pos += length
        elif operation == 1:
            inserted = query[query_pos : query_pos + length]
            if inserted:
                event: AlignmentMismatch = {
                    "pos": ref_pos,
                    "kind": "ins",
                    "length": length,
                    "readBase": inserted,
                }
                quality = _mean_base_quality(read, query_pos, length)
                if quality is not None:
                    event["baseQ"] = quality
                events.append(event)
            query_pos += length
        elif operation in (2, 3):
            ref_pos += length
        elif operation == 4:
            query_pos += length
        elif operation in (5, 6):
            continue
    return events


def _events_from_md(read: pysam.AlignedSegment) -> list[AlignmentMismatch]:
    """Use pysam/htslib's MD decoder; CIGAR supplies insertion boundaries."""

    if _edit_distance(read) == 0:
        return []

    query = (read.query_sequence or "").upper()
    events = _insertion_events(read)
    deletion_start: int | None = None
    deletion_bases: list[str] = []
    previous_deletion_pos: int | None = None

    def flush_deletion() -> None:
        nonlocal deletion_start, deletion_bases, previous_deletion_pos
        if deletion_start is not None and deletion_bases:
            events.append(
                {
                    "pos": deletion_start,
                    "kind": "del",
                    "length": len(deletion_bases),
                    "refBase": "".join(deletion_bases),
                }
            )
        deletion_start = None
        deletion_bases = []
        previous_deletion_pos = None

    for query_pos, ref_pos, ref_base in read.get_aligned_pairs(
        matches_only=False, with_seq=True
    ):
        if query_pos is None and ref_pos is not None and ref_base is not None:
            if (
                deletion_start is None
                or previous_deletion_pos is None
                or ref_pos != previous_deletion_pos + 1
            ):
                flush_deletion()
                deletion_start = int(ref_pos)
            deletion_bases.append(str(ref_base).upper())
            previous_deletion_pos = int(ref_pos)
            continue

        flush_deletion()
        if (
            query_pos is None
            or ref_pos is None
            or ref_base is None
            or not str(ref_base).islower()
            or query_pos >= len(query)
        ):
            continue
        event: AlignmentMismatch = {
            "pos": int(ref_pos),
            "kind": "sub",
            "length": 1,
            "refBase": str(ref_base).upper(),
            "readBase": query[query_pos],
        }
        quality = _base_quality(read, int(query_pos))
        if quality is not None:
            event["baseQ"] = quality
        events.append(event)

    flush_deletion()
    events.sort(
        key=lambda event: (event["pos"], event["kind"], event.get("readBase", ""))
    )
    return events


def _events_from_reference(
    read: pysam.AlignedSegment,
    *,
    reference_start: int,
    reference_sequence: str,
) -> list[AlignmentMismatch]:
    """Fallback for BAMs without MD, using one tile-wide reference string."""

    if _edit_distance(read) == 0:
        return []

    query = (read.query_sequence or "").upper()
    ref_pos = int(read.reference_start)
    query_pos = 0
    events: list[AlignmentMismatch] = []
    for operation, length in read.cigartuples or ():
        if operation in (0, 7, 8):
            block_ref_index = ref_pos - reference_start
            if (
                block_ref_index >= 0
                and block_ref_index + length <= len(reference_sequence)
                and query_pos + length <= len(query)
                and reference_sequence[block_ref_index : block_ref_index + length]
                == query[query_pos : query_pos + length]
            ):
                ref_pos += length
                query_pos += length
                continue
            for offset in range(length):
                ref_index = ref_pos + offset - reference_start
                read_index = query_pos + offset
                if (
                    ref_index < 0
                    or ref_index >= len(reference_sequence)
                    or read_index >= len(query)
                ):
                    continue
                ref_base = reference_sequence[ref_index]
                read_base = query[read_index]
                if ref_base == read_base:
                    continue
                event: AlignmentMismatch = {
                    "pos": ref_pos + offset,
                    "kind": "sub",
                    "length": 1,
                    "refBase": ref_base,
                    "readBase": read_base,
                }
                quality = _base_quality(read, read_index)
                if quality is not None:
                    event["baseQ"] = quality
                events.append(event)
            ref_pos += length
            query_pos += length
        elif operation == 1:
            inserted = query[query_pos : query_pos + length]
            if inserted:
                event = {
                    "pos": ref_pos,
                    "kind": "ins",
                    "length": length,
                    "readBase": inserted,
                }
                quality = _mean_base_quality(read, query_pos, length)
                if quality is not None:
                    event["baseQ"] = quality
                events.append(event)
            query_pos += length
        elif operation == 2:
            ref_index = ref_pos - reference_start
            deleted = reference_sequence[ref_index : ref_index + length]
            event = {
                "pos": ref_pos,
                "kind": "del",
                "length": length,
            }
            if len(deleted) == length:
                event["refBase"] = deleted
            events.append(event)
            ref_pos += length
        elif operation == 3:
            ref_pos += length
        elif operation == 4:
            query_pos += length
        elif operation in (5, 6):
            continue
    return events


def _needs_reference_fallback(read: pysam.AlignedSegment) -> bool:
    return _edit_distance(read) != 0 and not read.has_tag("MD")


def _reference_blocks(read: pysam.AlignedSegment) -> list[AlignmentReadBlock]:
    """Split a CIGAR into reference blocks, breaking on introns (N).

    Match, sequence match, mismatch, and deletion stay in the same block.
    A reference skip starts the next block. Without a CIGAR, the whole
    alignment span is the only block.
    """
    start = int(read.reference_start)
    end = int(read.reference_end) if read.reference_end is not None else start
    tuples = read.cigartuples
    if not tuples:
        return [{"start": start, "end": end}]
    ref = start
    block_start: int | None = None
    blocks: list[AlignmentReadBlock] = []
    for operation, length in tuples:
        if operation in (0, 2, 7, 8):
            if block_start is None:
                block_start = ref
            ref += length
        elif operation == 3:
            if block_start is not None and ref > block_start:
                blocks.append({"start": block_start, "end": ref})
            ref += length
            block_start = None
        elif operation == 1:
            continue
    if block_start is not None and ref > block_start:
        blocks.append({"start": block_start, "end": ref})
    return blocks or [{"start": start, "end": end}]


def _read_payload(
    read: pysam.AlignedSegment, events: list[AlignmentMismatch]
) -> AlignmentRead:
    payload: AlignmentRead = {
        "start": int(read.reference_start),
        "end": int(read.reference_end),
        "strand": "-" if read.is_reverse else "+",
        "mapq": int(read.mapping_quality),
        "readId": read.query_name,
        "flag": int(read.flag),
        "blocks": _reference_blocks(read),
    }
    pair = _pair_metadata(read)
    if pair is not None:
        payload["pair"] = pair
    if events:
        payload["mismatches"] = events
    return payload


def _phred_probability(quality: int) -> float:
    if quality <= 0 or quality == _UNKNOWN_MAPPING_QUALITY:
        return 0.0
    return 1.0 - math.pow(10.0, -min(quality, 93) / 10.0)


def _usable_for_aggregate(read: pysam.AlignedSegment) -> bool:
    return (
        not read.is_unmapped
        and not read.is_secondary
        and not read.is_supplementary
        and not read.is_duplicate
        and not read.is_qcfail
        and read.reference_end is not None
        and _phred_probability(int(read.mapping_quality)) > 0
    )


def _alternate_columns(
    reads_with_events: list[tuple[pysam.AlignedSegment, list[AlignmentMismatch]]],
    *,
    start: int,
    end: int,
    check_cancelled: Callable[[], None] | None = None,
) -> list[AlignmentAlternateColumn]:
    span = max(0, end - start)
    if span == 0:
        return []

    for _, events in reads_with_events:
        if check_cancelled is not None:
            check_cancelled()
        if events:
            break
    else:
        return []

    depth_diff = [0.0] * (span + 1)
    count_diff = [0] * (span + 1)
    support: dict[
        tuple[int, str, int, str, str],
        _AlternateAccumulator,
    ] = {}

    for read, events in reads_with_events:
        if check_cancelled is not None:
            check_cancelled()
        if not _usable_for_aggregate(read):
            continue
        map_weight = _phred_probability(int(read.mapping_quality))
        for block in _reference_blocks(read):
            read_start = max(start, block["start"])
            read_end = min(end, block["end"])
            if read_end > read_start:
                depth_diff[read_start - start] += map_weight
                depth_diff[read_end - start] -= map_weight
                count_diff[read_start - start] += 1
                count_diff[read_end - start] -= 1

        for event in events:
            pos = event["pos"]
            if pos < start or pos >= end:
                continue
            base_weight = (
                _phred_probability(event["baseQ"]) if "baseQ" in event else 1.0
            )
            event_weight = map_weight * base_weight
            key = (
                pos,
                event["kind"],
                event["length"],
                event.get("refBase", ""),
                event.get("readBase", ""),
            )
            accumulator = support.setdefault(
                key, {"supportingReadCount": 0, "weightedSupport": 0.0}
            )
            accumulator["supportingReadCount"] += 1
            accumulator["weightedSupport"] += event_weight

    weighted_depths = [0.0] * span
    covering_counts = [0] * span
    depth = 0.0
    count = 0
    for index in range(span):
        if index % 1024 == 0 and check_cancelled is not None:
            check_cancelled()
        depth += depth_diff[index]
        count += count_diff[index]
        weighted_depths[index] = depth
        covering_counts[index] = count

    accepted: list[AlignmentAlternateColumn] = []
    for key, accumulator in support.items():
        if check_cancelled is not None:
            check_cancelled()
        pos, kind, length, ref_base, read_base = key
        weighted_depth = weighted_depths[pos - start]
        weighted_support = accumulator["weightedSupport"]
        weighted_fraction = (
            weighted_support / weighted_depth if weighted_depth > 0 else 0.0
        )
        if (
            accumulator["supportingReadCount"] < ALT_GUIDE_MIN_SUPPORTING_READS
            or weighted_fraction < ALT_GUIDE_MIN_WEIGHTED_FRACTION
        ):
            continue
        column: AlignmentAlternateColumn = {
            "pos": pos,
            "kind": kind,  # type: ignore[typeddict-item]
            "length": length,
            "coveringReadCount": covering_counts[pos - start],
            "supportingReadCount": accumulator["supportingReadCount"],
            "weightedDepth": round(weighted_depth, 6),
            "weightedSupport": round(weighted_support, 6),
            "weightedFraction": round(weighted_fraction, 6),
        }
        if ref_base:
            column["refBase"] = ref_base
        if read_base:
            column["readBase"] = read_base
        accepted.append(column)

    accepted.sort(
        key=lambda column: (
            column["pos"],
            column["kind"],
            column.get("readBase", ""),
            column.get("refBase", ""),
        )
    )
    return accepted


def _detail_tags(read: pysam.AlignedSegment) -> dict[str, object]:
    tags: dict[str, object] = {}
    for tag in _DETAIL_TAGS:
        if not read.has_tag(tag):
            continue
        value = read.get_tag(tag)
        if isinstance(value, (str, int, float, bool)) or value is None:
            tags[tag] = value
        elif hasattr(value, "tolist"):
            tags[tag] = value.tolist()
        else:
            tags[tag] = str(value)
    return tags


def alignment_tile(
    bam_path: str,
    chrom: str,
    start: int,
    end: int,
    *,
    level: int,
    tile_index: int,
    index_path: Optional[str] = None,
    reference_fasta: Optional[str] = None,
    guides_only: bool = False,
    opened_alignment: pysam.AlignmentFile | None = None,
    check_cancelled: Callable[[], None] | None = None,
) -> AlignmentTile:
    """Return sparse read differences for an indexed fine-level tile.

    ``guides_only`` keeps the aggregate alternate-column signal at the
    read-to-histogram handoff without serializing individual read rows.
    """

    if check_cancelled is not None:
        check_cancelled()
    empty: AlignmentTile = {
        "chrom": chrom,
        "level": level,
        "tileIndex": tile_index,
        "start": start,
        "end": end,
        "reads": [],
        "alternateColumns": [],
        "count": 0,
        "sourceCount": 0,
        "fine": is_fine_level(level),
        "truncated": False,
    }
    if not is_fine_level(level) or end <= start:
        return empty

    resolved = _resolve_bam_path(bam_path)
    if not _is_remote_bam(resolved) and not Path(resolved).is_file():
        raise BamNotFoundError(f"BAM not found: {bam_path}")
    resolved_index = _resolve_index_path(index_path)
    resolved_reference = _resolve_reference_path(reference_fasta)

    aligned_reads: list[pysam.AlignedSegment] = []
    reader = (
        nullcontext(opened_alignment)
        if opened_alignment is not None
        else _open_alignment(resolved, resolved_index, resolved_reference)
    )
    with reader as bam:
        for read in bam.fetch(chrom, start, end):
            if check_cancelled is not None:
                check_cancelled()
            if (
                read.is_unmapped
                or read.is_secondary
                or read.is_supplementary
                or read.reference_end is None
            ):
                continue
            aligned_reads.append(read)

    fallback_reads = []
    for read in aligned_reads:
        if check_cancelled is not None:
            check_cancelled()
        if _needs_reference_fallback(read):
            fallback_reads.append(read)
    reference_start = 0
    reference_sequence = ""
    if fallback_reads:
        if resolved_reference is None:
            raise ReferenceNotFoundError(
                "alignment differences require a matching reference FASTA "
                "when BAM records do not carry MD tags"
            )
        reference_start = min(int(read.reference_start) for read in fallback_reads)
        reference_end = max(
            int(read.reference_end or read.reference_start) for read in fallback_reads
        )
        with pysam.FastaFile(resolved_reference) as reference:
            reference_sequence = reference.fetch(
                chrom, reference_start, reference_end
            ).upper()
        if check_cancelled is not None:
            check_cancelled()

    reads_with_events: list[tuple[pysam.AlignedSegment, list[AlignmentMismatch]]] = []
    for read in aligned_reads:
        if check_cancelled is not None:
            check_cancelled()
        if _edit_distance(read) == 0:
            events: list[AlignmentMismatch] = []
        elif read.has_tag("MD"):
            events = _events_from_md(read)
        else:
            events = _events_from_reference(
                read,
                reference_start=reference_start,
                reference_sequence=reference_sequence,
            )
        reads_with_events.append((read, events))

    alternate_columns = _alternate_columns(
        reads_with_events,
        start=start,
        end=end,
        check_cancelled=check_cancelled,
    )
    if guides_only:
        truncated = False
        reads: list[AlignmentRead] = []
    else:
        truncated = len(reads_with_events) > READ_TILE_MAX_RECORDS
        if truncated:
            stride = math.ceil(len(reads_with_events) / READ_TILE_MAX_RECORDS)
            displayed = reads_with_events[::stride]
        else:
            displayed = reads_with_events
        reads = []
        for read, events in displayed:
            if check_cancelled is not None:
                check_cancelled()
            reads.append(_read_payload(read, events))

    if check_cancelled is not None:
        check_cancelled()

    return {
        "chrom": chrom,
        "level": level,
        "tileIndex": tile_index,
        "start": start,
        "end": end,
        "reads": reads,
        "alternateColumns": alternate_columns,
        "count": len(reads),
        "sourceCount": len(reads_with_events),
        "fine": True,
        "truncated": truncated,
    }


def read_single_read_metadata(
    bam_path: str,
    chrom: str,
    *,
    read_id: str,
    reference_start: int,
    flag: int,
    read_number: Literal[1, 2] | None = None,
    index_path: Optional[str] = None,
    reference_fasta: Optional[str] = None,
) -> AlignmentReadMetadata:
    """Return one primary alignment selected by its composite BAM identity."""

    resolved = _resolve_bam_path(bam_path)
    if not _is_remote_bam(resolved) and not Path(resolved).is_file():
        raise BamNotFoundError(f"BAM not found: {bam_path}")
    resolved_index = _resolve_index_path(index_path)
    resolved_reference = _resolve_reference_path(reference_fasta)

    with _open_alignment(resolved, resolved_index, resolved_reference) as bam:
        for read in bam.fetch(chrom, reference_start, reference_start + 1):
            if (
                read.is_unmapped
                or read.is_secondary
                or read.is_supplementary
                or read.reference_end is None
                or read.query_name != read_id
                or int(read.reference_start) != reference_start
                or int(read.flag) != flag
                or (read_number is not None and _read_number(read) != read_number)
            ):
                continue
            metadata: AlignmentReadMetadata = {
                "readId": read.query_name,
                "chrom": chrom,
                "start": int(read.reference_start),
                "end": int(read.reference_end),
                "strand": "-" if read.is_reverse else "+",
                "mapq": int(read.mapping_quality),
                "flag": int(read.flag),
                "cigar": read.cigarstring or "",
                "seq": (read.query_sequence or "").upper(),
                "tags": _detail_tags(read),
            }
            if read.query_qualities is not None:
                metadata["baseQualities"] = [
                    int(score) for score in read.query_qualities
                ]
            pair = _pair_metadata(read)
            if pair is not None:
                metadata["pair"] = pair
            return metadata

    raise ReadNotFoundError(
        f"read alignment not found for {read_id!r} at {chrom}:{reference_start} flag={flag}"
    )
