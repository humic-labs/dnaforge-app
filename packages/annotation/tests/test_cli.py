from __future__ import annotations

import json
from pathlib import Path

import pytest

from dnaforge_annotation import cli
from dnaforge_annotation.contract import AnnotationFeature, AnnotationResult


def _success() -> AnnotationResult:
    return AnnotationResult(
        sequence_length=4,
        features=[
            AnnotationFeature(
                name="feature one",
                accession="ACC1",
                start=1,
                end=4,
                strand=1,
                identity=100,
                coverage=100,
                fragment=False,
                type="CDS",
                description="complete",
                ref_start=1,
                ref_end=4,
                ref_length=4,
                db_source="nucleotide",
            )
        ],
    )


def test_cli_writes_lossless_json_and_optional_receipt(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source = tmp_path / "input.fa"
    output = tmp_path / "result.json"
    receipt = tmp_path / "receipt.json"
    data_dir = tmp_path / "references"
    tools_dir = tmp_path / "tools"
    temp_dir = tmp_path / "temporary"
    source.write_text(">sample sequence\nACGT\n")
    recorded: dict[str, object] = {}

    def fake_run(request, runtime):
        recorded.update(request=request, runtime=runtime)
        return _success()

    monkeypatch.setattr(cli, "run_annotation", fake_run)

    exit_code = cli.main(
        [
            str(source),
            "--format",
            "json",
            "--output",
            str(output),
            "--receipt",
            str(receipt),
            "--data-dir",
            str(data_dir),
            "--tools-dir",
            str(tools_dir),
            "--temp-dir",
            str(temp_dir),
            "--threads",
            "2",
            "--linear",
        ]
    )

    assert exit_code == 0
    assert json.loads(output.read_text()) == _success().model_dump(mode="json")
    assert recorded["request"].model_dump() == {
        "sequence": "ACGT",
        "linear": True,
        "start": None,
        "end": None,
    }
    runtime = recorded["runtime"]
    assert runtime.data_dir == data_dir
    assert runtime.temp_dir == temp_dir
    assert runtime.threads == 2
    assert runtime.executables.blastn == tools_dir / "blastn"
    receipt_payload = json.loads(receipt.read_text())
    assert receipt_payload["schema_version"] == 1
    assert receipt_payload["outcome"] == "succeeded"
    assert receipt_payload["input"]["sequence_id"] == "sample"
    assert receipt_payload["output"] == {
        "format": "json",
        "path": str(output.resolve()),
    }
    assert receipt_payload["runtime"]["executables"] == {
        "blastn": str((tools_dir / "blastn").resolve()),
        "diamond": str((tools_dir / "diamond").resolve()),
        "cmscan": str((tools_dir / "cmscan").resolve()),
    }
    assert receipt_payload["reference_data"]["versions"] == {
        "Rfam": "release 14.5",
        "fpbase": "downloaded 2020-09-02",
        "swissprot": "Release 2021_03",
        "snapgene": "Downloaded 2021-07-23",
    }
    assert receipt_payload["result"] == _success().model_dump(mode="json")


def test_cli_failure_writes_no_output_or_success_receipt(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    source = tmp_path / "input.fa"
    output = tmp_path / "result.gff3"
    receipt = tmp_path / "receipt.json"
    source.write_text(">sample\nACGT\n")

    def fail(*_args, **_kwargs):
        raise FileNotFoundError("blastn")

    monkeypatch.setattr(cli, "run_annotation", fail)

    exit_code = cli.main(
        [
            str(source),
            "--output",
            str(output),
            "--receipt",
            str(receipt),
            "--data-dir",
            str(tmp_path / "references"),
            "--tools-dir",
            str(tmp_path / "tools"),
        ]
    )

    assert exit_code != 0
    assert "blastn" in capsys.readouterr().err
    assert not output.exists()
    assert not receipt.exists()


def test_cli_empty_fasta_succeeds_without_local_tools(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source = tmp_path / "empty.fa"
    output = tmp_path / "empty.json"
    source.write_text(">empty\n")

    exit_code = cli.main(
        [
            str(source),
            "--format",
            "json",
            "--output",
            str(output),
            "--data-dir",
            str(tmp_path / "absent-data"),
            "--tools-dir",
            str(tmp_path / "absent-tools"),
        ]
    )

    assert exit_code == 0
    assert json.loads(output.read_text()) == {
        "features": [],
        "sequence_length": 0,
        "error": None,
    }


def test_cli_resolves_windows_executable_suffixes(tmp_path: Path) -> None:
    tools_dir = tmp_path / "tools"
    tools_dir.mkdir()
    executable = tools_dir / "blastn.exe"
    executable.write_bytes(b"binary")

    assert cli._tool_path(tools_dir, "blastn", windows=True) == executable


def test_cli_rejects_a_nonpositive_thread_limit_before_running(
    tmp_path: Path,
) -> None:
    source = tmp_path / "input.fa"
    output = tmp_path / "result.json"
    source.write_text(">sample\nACGT\n")

    with pytest.raises(SystemExit) as exit_info:
        cli.main(
            [
                str(source),
                "--format",
                "json",
                "--output",
                str(output),
                "--data-dir",
                str(tmp_path),
                "--tools-dir",
                str(tmp_path),
                "--threads",
                "0",
            ]
        )

    assert exit_info.value.code == 2
    assert not output.exists()
