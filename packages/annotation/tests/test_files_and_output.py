from __future__ import annotations

import json
from io import StringIO

import pytest

from dnaforge_annotation.contract import AnnotationFeature, AnnotationResult
from dnaforge_annotation.files import (
    FastaFormatError,
    read_gff3,
    read_annotation_output,
    read_single_fasta,
    write_gff3,
)


def test_read_single_fasta_accepts_wrapped_sequence_and_rejects_multiple_records() -> (
    None
):
    record = read_single_fasta(StringIO(">plasmid one\nAC GT\nNN\n"))
    assert record.identifier == "plasmid"
    assert record.description == "plasmid one"
    assert record.sequence == "ACGTNN"

    with pytest.raises(FastaFormatError, match="exactly one"):
        read_single_fasta(StringIO(">one\nACGT\n>two\nTGCA\n"))


@pytest.mark.parametrize("feature_type", ["promoter", "misc_feature", ""])
def test_gff3_contains_round_trippable_feature_fields(feature_type: str) -> None:
    result = AnnotationResult(
        sequence_length=20,
        features=[
            AnnotationFeature(
                name="promoter; alpha",
                accession="ACC=1",
                start=2,
                end=8,
                strand=-1,
                identity=99.5,
                coverage=75.0,
                fragment=False,
                type=feature_type,
                description="line one\nline two",
                ref_start=1,
                ref_end=7,
                ref_length=10,
                db_source="nucleotide",
            )
        ],
    )
    output = StringIO()

    write_gff3(result, sequence_id="plasmid", destination=output)

    lines = output.getvalue().splitlines()
    assert lines[:2] == ["##gff-version 3", "##sequence-region plasmid 1 20"]
    columns = lines[2].split("\t")
    assert columns[:8] == [
        "plasmid",
        "dnaforge-annotation",
        feature_type or "misc_feature",
        "2",
        "8",
        ".",
        "-",
        ".",
    ]
    attributes = dict(item.split("=", 1) for item in columns[8].split(";"))
    assert attributes == {
        "ID": "feature-1",
        "Name": "promoter%3B%20alpha",
        "accession": "ACC%3D1",
        "identity": "99.5",
        "coverage": "75.0",
        "fragment": "false",
        "description": "line%20one%0Aline%20two",
        "ref_start": "1",
        "ref_end": "7",
        "ref_length": "10",
        "db_source": "nucleotide",
        "annotation_type": feature_type,
    }

    restored = json.loads(result.model_dump_json())
    assert restored["features"][0]["description"] == "line one\nline two"
    assert read_gff3(StringIO(output.getvalue())) == result


def test_gff3_splits_and_round_trips_a_circular_origin_crossing_feature() -> None:
    result = AnnotationResult(
        sequence_length=20,
        features=[
            AnnotationFeature(
                name="origin crossing",
                accession="ORI",
                start=18,
                end=4,
                strand=1,
                identity=97,
                coverage=80,
                fragment=True,
                type="rep_origin",
                description="crosses base one",
                ref_start=3,
                ref_end=9,
                ref_length=10,
                db_source="nucleotide",
            )
        ],
    )
    output = StringIO()

    write_gff3(result, sequence_id="circular", destination=output)

    rows = [
        line.split("\t")
        for line in output.getvalue().splitlines()
        if not line.startswith("#")
    ]
    assert [(row[3], row[4]) for row in rows] == [("18", "20"), ("1", "4")]
    ids = [dict(item.split("=", 1) for item in row[8].split(";"))["ID"] for row in rows]
    assert ids == ["feature-1", "feature-1"]
    assert read_gff3(StringIO(output.getvalue())) == result


def test_gff3_refuses_to_serialize_an_error_as_a_successful_empty_result() -> None:
    result = AnnotationResult(
        features=[], sequence_length=100, error="reference data unavailable"
    )

    with pytest.raises(ValueError, match="reference data unavailable"):
        write_gff3(result, sequence_id="sample", destination=StringIO())


def _circular_gff3() -> str:
    attributes = (
        "ID=one;Name=feature;identity=100;coverage=100;fragment=false;"
        "ref_start=1;ref_end=7;ref_length=7;db_source=nucleotide;"
        "circular=true;circular_start=18;circular_end=4;circular_part="
    )
    return (
        "##gff-version 3\n##sequence-region sample 1 20\n"
        f"sample\ttool\trep_origin\t18\t20\t.\t+\t.\t{attributes}1/2\n"
        f"sample\ttool\trep_origin\t1\t4\t.\t+\t.\t{attributes}2/2\n"
    )


@pytest.mark.parametrize(
    "change",
    [
        lambda text: "\n".join(text.splitlines()[:-1]),
        lambda text: text + text.splitlines()[-1] + "\n",
        lambda text: text.replace("circular_part=2/2", "circular_part=1/2"),
        lambda text: text.replace("\t1\t4\t", "\t2\t4\t"),
        lambda text: text.replace("Name=feature", "Name=changed", 1),
        lambda text: text.replace("sample\t", "another\t", 1),
        lambda text: text.replace("\t+\t", "\t?\t", 1),
        lambda text: text.replace("ID=one", "ID=one;ID=two", 1),
        lambda text: text.replace(
            "##sequence-region sample 1 20", "##sequence-region sample 2 20"
        ),
        lambda text: text.replace("##gff-version 3\n", ""),
        lambda text: text.replace("identity=100", "identity=nan"),
        lambda text: text.replace("fragment=false", "fragment=maybe"),
    ],
)
def test_gff3_rejects_incomplete_or_conflicting_external_results(change) -> None:
    with pytest.raises(ValueError):
        read_gff3(StringIO(change(_circular_gff3())))


def test_output_reader_needs_no_receipt_and_preserves_valid_empty_results() -> None:
    expected = AnnotationResult(features=[], sequence_length=0)
    assert (
        read_annotation_output(StringIO(expected.model_dump_json()), format="json")
        == expected
    )
    assert (
        read_annotation_output(StringIO("##gff-version 3\n"), format="gff3") == expected
    )


@pytest.mark.parametrize(
    "payload",
    [
        {"features": [], "sequence_length": -1},
        {"features": [], "sequence_length": 10, "error": "engine failed"},
    ],
)
def test_output_reader_rejects_failed_or_invalid_json(payload) -> None:
    with pytest.raises(ValueError):
        read_annotation_output(StringIO(json.dumps(payload)), format="json")
