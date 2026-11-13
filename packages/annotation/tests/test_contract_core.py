from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

from dnaforge_annotation.contract import (
    AnnotationExecutables,
    AnnotationRequest,
    AnnotationRuntime,
)
from dnaforge_annotation.core import run_annotation


def _runtime(tmp_path: Path) -> AnnotationRuntime:
    executable = tmp_path / "tool"
    return AnnotationRuntime(
        data_dir=tmp_path / "data",
        executables=AnnotationExecutables(
            blastn=executable,
            diamond=executable,
            cmscan=executable,
        ),
        temp_dir=tmp_path / "tmp",
        threads=3,
    )


def test_public_import_does_not_load_scientific_stack() -> None:
    package_src = Path(__file__).parents[1] / "src"
    env = os.environ.copy()
    env["PYTHONPATH"] = str(package_src)
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import json, sys; import dnaforge_annotation; "
                "print(json.dumps(sorted(name for name in sys.modules "
                "if name == 'Bio' or name.startswith(('Bio.', 'pandas', 'numpy')))))"
            ),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )

    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout) == []


def test_contract_rejects_unknown_input_and_invalid_runtime(tmp_path: Path) -> None:
    with pytest.raises(ValidationError):
        AnnotationRequest(sequence="ACGT", sequnce="typo")

    with pytest.raises(ValidationError):
        AnnotationRuntime(
            data_dir=tmp_path,
            executables=AnnotationExecutables(
                blastn=tmp_path / "blastn",
                diamond=tmp_path / "diamond",
                cmscan=tmp_path / "cmscan",
            ),
            threads=0,
        )


def test_run_annotation_preserves_managed_normalization_and_offsets(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from dnaforge_annotation import engine

    recorded: dict[str, object] = {}

    def fake_annotate_sequence(
        sequence: str, *, linear: bool, runtime: AnnotationRuntime
    ) -> list[dict[str, object]]:
        recorded.update(sequence=sequence, linear=linear, runtime=runtime)
        return [
            {
                "qstart": 0,
                "qend": 4,
                "sstart": 2,
                "send": 11,
                "slen": 30,
                "sframe": -1,
                "pident": 98.25,
                "percmatch": -40.0,
                "abs percmatch": 40.0,
                "fragment": True,
                "Feature": "example feature",
                "Description": "example description",
                "sseqid": "P12345",
                "db": "swissprot",
                "Type": "",
            }
        ]

    monkeypatch.setattr(engine, "annotate_sequence", fake_annotate_sequence)
    request = AnnotationRequest(sequence="aa cc\nGGTT", start=2, end=6)

    result = run_annotation(request, _runtime(tmp_path))

    assert recorded == {
        "sequence": "CCGG",
        "linear": True,
        "runtime": _runtime(tmp_path),
    }
    assert result.sequence_length == 8
    assert result.error is None
    assert result.features[0].model_dump() == {
        "name": "example feature",
        "accession": "P12345",
        "start": 3,
        "end": 6,
        "strand": -1,
        "identity": 98.25,
        "coverage": 40.0,
        "fragment": True,
        "type": "swissprot",
        "description": "example description",
        "ref_start": 2,
        "ref_end": 11,
        "ref_length": 10,
        "db_source": "protein",
    }


def test_empty_sequence_never_imports_or_validates_the_engine(tmp_path: Path) -> None:
    result = run_annotation(AnnotationRequest(sequence=" \n"), _runtime(tmp_path))

    assert result.features == []
    assert result.sequence_length == 0
    assert result.error is None
