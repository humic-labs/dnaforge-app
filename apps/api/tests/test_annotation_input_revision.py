import json
from pathlib import Path

import pytest
from dnaforge_annotation.contract import AnnotationRequest
from dnaforge_annotation.identity import annotation_input_revision

VECTORS = json.loads(
    (
        Path(__file__).resolve().parents[3]
        / "test-fixtures/contracts/annotation-input-revisions.json"
    ).read_text()
)


@pytest.mark.parametrize("vector", VECTORS, ids=lambda row: row["name"])
def test_shared_desktop_and_standalone_input_identity(vector):
    assert (
        annotation_input_revision(AnnotationRequest(**vector["request"]))
        == vector["revision"]
    )
