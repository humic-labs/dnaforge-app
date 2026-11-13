from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

import pytest
from pydantic import ValidationError

from dnaforge_annotation.contract import (
    AnnotationExecutables,
    AnnotationRequest,
    AnnotationResult,
    AnnotationRuntime,
)
from dnaforge_annotation.receipt import AnnotationRunReceiptV1, create_receipt


@pytest.fixture
def receipt(tmp_path: Path) -> dict:
    return create_receipt(
        request=AnnotationRequest(sequence="ac gt\n", linear=True),
        result=AnnotationResult(features=[], sequence_length=4),
        runtime=AnnotationRuntime(
            data_dir=tmp_path / "references",
            executables=AnnotationExecutables(
                blastn=tmp_path / "blastn",
                diamond=tmp_path / "diamond",
                cmscan=tmp_path / "cmscan",
            ),
        ),
        input_path="-",
        sequence_id="sample",
        output_path="-",
        output_format="json",
        started_at=datetime.now(timezone.utc),
    )


def test_receipt_is_self_contained_and_does_not_open_claimed_paths(
    receipt: dict,
) -> None:
    receipt["runtime"]["data_dir"] = "/missing/references"
    receipt["reference_data"]["manifest"] = "https://invalid.example/manifest"
    parsed = AnnotationRunReceiptV1.model_validate(receipt)
    assert parsed.result.sequence_length == 4
    assert parsed.input.revision.startswith("annotation-input-v1:sha256:")
    assert (
        AnnotationRunReceiptV1.model_validate_json(parsed.model_dump_json()) == parsed
    )


def test_missing_reference_version_remains_unknown(receipt: dict) -> None:
    receipt["reference_data"]["versions"] = {"custom-reference": None}
    assert AnnotationRunReceiptV1.model_validate(receipt).reference_data.versions == {
        "custom-reference": None
    }


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("start", 5),
        ("end", 0),
        ("strand", 0),
        ("identity", float("nan")),
        ("ref_end", 5),
    ],
)
def test_receipt_rejects_invalid_feature_coordinates_and_scores(
    receipt: dict, field: str, value: object
) -> None:
    feature = {
        "name": "example",
        "start": 1,
        "end": 4,
        "strand": 1,
        "identity": 100,
        "coverage": 100,
        "fragment": False,
        "ref_start": 1,
        "ref_end": 4,
        "ref_length": 4,
        "db_source": "nucleotide",
    }
    feature[field] = value
    receipt["result"]["features"] = [feature]
    with pytest.raises(ValidationError):
        AnnotationRunReceiptV1.model_validate(receipt)


def test_origin_crossing_feature_is_valid(receipt: dict) -> None:
    receipt["result"]["features"] = [
        {
            "name": "example",
            "start": 4,
            "end": 2,
            "strand": -1,
            "identity": 100,
            "coverage": 100,
            "fragment": False,
            "ref_start": 1,
            "ref_end": 3,
            "ref_length": 3,
            "db_source": "nucleotide",
        }
    ]
    assert AnnotationRunReceiptV1.model_validate(receipt).result.features[0].start == 4


@pytest.mark.parametrize(
    ("section", "field", "value"),
    [
        ("input", "revision", "annotation-input-v1:sha256:" + "0" * 64),
        ("input", "sequence_length", 3),
        ("result", "sequence_length", 3),
        ("result", "error", "engine failed"),
        ("request", "sequence", "AAAA"),
        ("output", "format", "shell"),
        ("runtime", "threads", 0),
        ("tool", "name", "another-tool"),
    ],
)
def test_receipt_rejects_inconsistent_or_unsupported_claims(
    receipt: dict, section: str, field: str, value: object
) -> None:
    broken = deepcopy(receipt)
    broken[section][field] = value
    with pytest.raises(ValidationError):
        AnnotationRunReceiptV1.model_validate(broken)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("schema_version", 2),
        ("run_id", "not-a-run-id"),
        ("outcome", "running"),
        ("actor", "trusted-admin"),
        ("started_at", "2099-01-01T00:00:00+00:00"),
        ("started_at", "2026-01-01T00:00:00"),
    ],
)
def test_receipt_rejects_unknown_contracts_and_invalid_reported_times(
    receipt: dict, field: str, value: object
) -> None:
    receipt[field] = value
    with pytest.raises(ValidationError):
        AnnotationRunReceiptV1.model_validate(receipt)
