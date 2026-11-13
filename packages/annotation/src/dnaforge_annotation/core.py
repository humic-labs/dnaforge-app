"""Synchronous, app-independent annotation boundary."""

from collections.abc import Iterable, Mapping
from typing import Any

from .contract import (
    AnnotationFeature,
    AnnotationRequest,
    AnnotationResult,
    AnnotationRuntime,
    DbSource,
)

DB_SOURCE_MAP: dict[str, DbSource] = {
    "swissprot": "protein",
    "fpbase": "protein",
    "snapgene": "nucleotide",
    "Rfam": "rna",
}


def clean_sequence(sequence: str) -> str:
    """Apply the managed annotation sequence normalization exactly."""
    return sequence.upper().replace(" ", "").replace("\n", "")


def normalize_annotate_range(
    start: Any, end: Any, sequence_length: int
) -> tuple[int, int] | None:
    """Normalize a 0-indexed, half-open range within a source sequence."""
    if start is None or end is None:
        return None
    try:
        start0 = int(start)
        end0 = int(end)
    except (TypeError, ValueError):
        return None
    start0 = max(0, min(start0, sequence_length))
    end0 = max(0, min(end0, sequence_length))
    if end0 <= start0:
        return None
    if start0 == 0 and end0 == sequence_length:
        return None
    return start0, end0


def rows_to_features(
    rows: Iterable[Mapping[str, object]], *, coordinate_offset: int = 0
) -> list[AnnotationFeature]:
    """Validate engine rows and convert them to the shared feature contract."""
    features: list[AnnotationFeature] = []
    for row in rows:
        db_name = str(row.get("db", ""))
        db_source: DbSource = DB_SOURCE_MAP.get(db_name, "nucleotide")
        sstart = int(row.get("sstart", 1))
        send = int(row.get("send", 1))
        feature_type = str(row.get("Type", ""))
        if not feature_type and db_source == "protein":
            feature_type = "swissprot" if db_name == "swissprot" else "CDS"

        features.append(
            AnnotationFeature(
                name=str(row.get("Feature", "")),
                accession=str(row.get("sseqid", "")),
                start=int(row.get("qstart", 0)) + 1 + coordinate_offset,
                end=int(row.get("qend", 0)) + coordinate_offset,
                strand=int(row.get("sframe", 1)),
                identity=float(row.get("pident", 0)),
                coverage=float(row.get("abs percmatch", row.get("percmatch", 0))),
                fragment=bool(row.get("fragment", False)),
                type=feature_type,
                description=str(row.get("Description", "")),
                ref_start=min(sstart, send),
                ref_end=max(sstart, send),
                ref_length=(
                    int(row.get("slen", 1)) // 3
                    if db_source == "protein"
                    else int(row.get("slen", 1))
                ),
                db_source=db_source,
            )
        )
    return features


def run_annotation(
    request: AnnotationRequest, runtime: AnnotationRuntime
) -> AnnotationResult:
    """Run annotation synchronously using only explicitly supplied resources."""
    sequence = clean_sequence(request.sequence)
    if not sequence:
        return AnnotationResult(features=[], sequence_length=0)

    sequence_length = len(sequence)
    normalized_range = normalize_annotate_range(
        request.start, request.end, sequence_length
    )
    if normalized_range is None:
        engine_sequence = sequence
        linear = request.linear
        coordinate_offset = 0
    else:
        start0, end0 = normalized_range
        engine_sequence = sequence[start0:end0]
        linear = True
        coordinate_offset = start0

    from .engine import annotate_sequence

    rows = annotate_sequence(engine_sequence, linear=linear, runtime=runtime)
    return AnnotationResult(
        features=rows_to_features(rows, coordinate_offset=coordinate_offset),
        sequence_length=sequence_length,
    )
