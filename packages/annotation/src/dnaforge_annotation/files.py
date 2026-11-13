"""Ordinary FASTA, JSON and GFF3 file handling."""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
from typing import Literal, TextIO
from urllib.parse import quote, unquote

from .contract import AnnotationFeature, AnnotationResult


class FastaFormatError(ValueError):
    """Raised when input is not one complete FASTA record."""


@dataclass(frozen=True)
class FastaRecord:
    identifier: str
    description: str
    sequence: str


def read_single_fasta(source: TextIO) -> FastaRecord:
    """Read exactly one FASTA record without app or scientific dependencies."""
    description: str | None = None
    sequence_parts: list[str] = []
    for line_number, raw_line in enumerate(source, start=1):
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith(">"):
            if description is not None:
                raise FastaFormatError("FASTA input must contain exactly one record")
            description = line[1:].strip()
            if not description:
                raise FastaFormatError(f"FASTA header on line {line_number} is empty")
            continue
        if description is None:
            raise FastaFormatError("FASTA input must start with a '>' header")
        sequence_parts.append("".join(line.split()))

    if description is None:
        raise FastaFormatError("FASTA input must contain exactly one record")
    identifier = description.split(maxsplit=1)[0]
    return FastaRecord(
        identifier=identifier,
        description=description,
        sequence="".join(sequence_parts),
    )


def _escape_gff3(value: object) -> str:
    return quote(str(value), safe="-._~:")


def write_gff3(
    result: AnnotationResult, *, sequence_id: str, destination: TextIO
) -> None:
    """Write a successful result as GFF3 while retaining every feature field."""
    if result.error is not None:
        raise ValueError(f"cannot write failed annotation result: {result.error}")
    validate_annotation_output(result)
    destination.write("##gff-version 3\n")
    if result.sequence_length:
        destination.write(
            f"##sequence-region {_escape_gff3(sequence_id)} 1 {result.sequence_length}\n"
        )
    for index, feature in enumerate(result.features, start=1):
        attributes = {
            "ID": f"feature-{index}",
            "Name": feature.name,
            "accession": feature.accession,
            "identity": feature.identity,
            "coverage": feature.coverage,
            "fragment": str(feature.fragment).lower(),
            "description": feature.description,
            "ref_start": feature.ref_start,
            "ref_end": feature.ref_end,
            "ref_length": feature.ref_length,
            "db_source": feature.db_source,
            "annotation_type": feature.type,
        }
        encoded_attributes = ";".join(
            f"{key}={_escape_gff3(value)}" for key, value in attributes.items()
        )
        feature_type = feature.type or "misc_feature"
        strand = "-" if feature.strand < 0 else "+"
        segments = [(feature.start, feature.end, "")]
        if feature.start > feature.end:
            if result.sequence_length <= 0:
                raise ValueError("origin-crossing feature requires a sequence length")
            circular = f";circular=true;circular_start={feature.start};circular_end={feature.end}"
            segments = [
                (
                    feature.start,
                    result.sequence_length,
                    f"{circular};circular_part=1/2",
                ),
                (1, feature.end, f"{circular};circular_part=2/2"),
            ]
        for segment_start, segment_end, segment_attributes in segments:
            destination.write(
                "\t".join(
                    [
                        _escape_gff3(sequence_id),
                        "dnaforge-annotation",
                        _escape_gff3(feature_type),
                        str(segment_start),
                        str(segment_end),
                        ".",
                        strand,
                        ".",
                        encoded_attributes + segment_attributes,
                    ]
                )
                + "\n"
            )


def _parse_attributes(value: str) -> dict[str, str]:
    attributes: dict[str, str] = {}
    for item in value.split(";"):
        if not item:
            continue
        key, separator, encoded = item.partition("=")
        if not separator:
            raise ValueError(f"invalid GFF3 attribute: {item}")
        if key in attributes:
            raise ValueError(f"duplicate GFF3 attribute: {key}")
        attributes[key] = unquote(encoded)
    return attributes


def read_gff3(source: TextIO) -> AnnotationResult:
    """Read GFF3 emitted by :func:`write_gff3`, joining circular segments."""
    sequence_length = 0
    sequence_id: str | None = None
    version_seen = False
    features_by_id: dict[str, AnnotationFeature] = {}
    circular_parts: dict[str, set[str]] = {}
    row_signatures: dict[str, tuple[str, ...]] = {}
    for line_number, raw_line in enumerate(source, start=1):
        line = raw_line.rstrip("\r\n")
        if not line:
            continue
        if not version_seen:
            if line != "##gff-version 3":
                raise ValueError("Annotation GFF3 must begin with ##gff-version 3")
            version_seen = True
            continue
        if line.startswith("##sequence-region "):
            parts = line.split()
            if len(parts) != 4 or parts[2] != "1" or sequence_id is not None:
                raise ValueError(f"invalid sequence-region on line {line_number}")
            sequence_id = unquote(parts[1])
            sequence_length = int(parts[3])
            if sequence_length <= 0:
                raise ValueError("GFF3 sequence-region must have a positive length")
            continue
        if line.startswith("#"):
            continue

        columns = line.split("\t")
        if len(columns) != 9:
            raise ValueError(f"expected nine GFF3 columns on line {line_number}")
        if sequence_id is None or unquote(columns[0]) != sequence_id:
            raise ValueError(
                f"feature does not match sequence-region on line {line_number}"
            )
        if columns[6] not in ("+", "-"):
            raise ValueError(f"annotation strand must be + or - on line {line_number}")
        attributes = _parse_attributes(columns[8])
        feature_id = attributes.get("ID")
        if not feature_id:
            raise ValueError(f"missing feature ID on line {line_number}")
        start = int(columns[3])
        end = int(columns[4])
        if not 1 <= start <= end <= sequence_length:
            raise ValueError(
                f"feature coordinates are outside sequence-region on line {line_number}"
            )
        if attributes.get("fragment", "false") not in ("true", "false"):
            raise ValueError(f"invalid fragment value on line {line_number}")
        if "circular" in attributes and attributes["circular"] != "true":
            raise ValueError(f"invalid circular value on line {line_number}")
        if attributes.get("circular") == "true":
            try:
                original_start = int(attributes["circular_start"])
                original_end = int(attributes["circular_end"])
                part = attributes["circular_part"]
            except KeyError as error:
                raise ValueError("incomplete circular feature metadata") from error
            expected = {
                "1/2": (original_start, sequence_length),
                "2/2": (1, original_end),
            }
            if (
                not 1 <= original_end < original_start <= sequence_length
                or expected.get(part) != (start, end)
                or part in circular_parts.get(feature_id, set())
            ):
                raise ValueError(f"invalid circular segment on line {line_number}")
            circular_parts.setdefault(feature_id, set()).add(part)
            start, end = original_start, original_end
        elif feature_id in features_by_id or any(
            key.startswith("circular_") for key in attributes
        ):
            raise ValueError(f"duplicate or incomplete feature on line {line_number}")
        feature = AnnotationFeature(
            name=attributes.get("Name", ""),
            accession=attributes.get("accession", ""),
            start=start,
            end=end,
            strand=-1 if columns[6] == "-" else 1,
            identity=float(attributes.get("identity", 0)),
            coverage=float(attributes.get("coverage", 0)),
            fragment=attributes.get("fragment", "false") == "true",
            type=attributes.get("annotation_type", unquote(columns[2])),
            description=attributes.get("description", ""),
            ref_start=int(attributes.get("ref_start", 1)),
            ref_end=int(attributes.get("ref_end", 1)),
            ref_length=int(attributes.get("ref_length", 1)),
            db_source=attributes.get("db_source", "nucleotide"),
        )
        signature = tuple(columns[:3] + columns[5:8]) + tuple(
            f"{key}={value}"
            for key, value in sorted(attributes.items())
            if key != "circular_part"
        )
        if feature_id in features_by_id and (
            features_by_id[feature_id] != feature
            or row_signatures[feature_id] != signature
        ):
            raise ValueError(f"conflicting circular feature on line {line_number}")
        features_by_id[feature_id] = feature
        row_signatures[feature_id] = signature
    if not version_seen:
        raise ValueError("Missing GFF3 version header")
    if any(parts != {"1/2", "2/2"} for parts in circular_parts.values()):
        raise ValueError("Incomplete circular feature: both segments are required")
    return validate_annotation_output(
        AnnotationResult(
            features=list(features_by_id.values()), sequence_length=sequence_length
        )
    )


def validate_annotation_output(result: AnnotationResult) -> AnnotationResult:
    """Validate a successful file result without assuming any run provenance."""
    if result.error is not None:
        raise ValueError(f"Annotation output reports failure: {result.error}")
    if result.sequence_length < 0:
        raise ValueError("Annotation sequence length cannot be negative")
    for feature in result.features:
        if not (
            1 <= feature.start <= result.sequence_length
            and 1 <= feature.end <= result.sequence_length
            and 1 <= feature.ref_start <= feature.ref_length
            and 1 <= feature.ref_end <= feature.ref_length
        ):
            raise ValueError(
                "Annotation feature coordinates exceed the query or reference"
            )
        if feature.strand not in (-1, 1) or not all(
            math.isfinite(value) and value >= 0
            for value in (feature.identity, feature.coverage)
        ):
            raise ValueError(
                "Annotation feature has an invalid strand or alignment score"
            )
    return result


def read_annotation_output(
    source: TextIO, *, format: Literal["json", "gff3"]
) -> AnnotationResult:
    """Read ordinary output; no receipt, runtime, tools or database is required."""
    if format == "gff3":
        return read_gff3(source)
    if format == "json":
        return validate_annotation_output(
            AnnotationResult.model_validate(json.load(source), strict=True)
        )
    raise ValueError(f"Unsupported annotation output format: {format}")
