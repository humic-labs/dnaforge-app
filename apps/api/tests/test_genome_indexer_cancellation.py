from __future__ import annotations

import os
from pathlib import Path

import pytest

from src.services import dna_indexer_shellout, genome_indexer
from src.services.genome_indexer import (
    GenomeIndexCancelledError,
    _raise_if_shellout_cancelled,
    index_genome,
)


def test_rust_shellout_cancellation_keeps_the_typed_route_error() -> None:
    cause = RuntimeError("structured shellout failure")

    with pytest.raises(
        GenomeIndexCancelledError, match="last owner released"
    ) as caught:
        _raise_if_shellout_cancelled("CANCELLED", "last owner released", cause)

    assert caught.value.__cause__ is cause


def test_non_cancellation_shellout_error_remains_for_the_caller_to_map() -> None:
    _raise_if_shellout_cancelled(
        "GENBANK_PARSE_FAILED",
        "invalid record",
        RuntimeError("structured shellout failure"),
    )


def test_gff_cancellation_never_publishes_a_partial_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = tmp_path / "workspace"
    output_dir = workspace / "derived"
    workspace.mkdir()
    output_dir.mkdir()
    gff_path = workspace / "reference.gff3"
    fasta_input = workspace / "reference.fa"
    gff_path.write_text("##gff-version 3\n")
    fasta_input.write_text(">chr1\nACGT\n")

    final_paths = (
        output_dir / "chr1.fa.gz",
        output_dir / "chr1.fa.gz.fai",
        output_dir / "chr1.fa.gz.gzi",
        output_dir / "chr1.gff3.gz",
        output_dir / "chr1.gff3.gz.tbi",
    )
    previous_bytes = {
        path: f"previous-{index}".encode() for index, path in enumerate(final_paths)
    }
    for path, content in previous_bytes.items():
        path.write_bytes(content)

    fake_indexer = workspace / "partial-indexer"
    fake_indexer.write_text(
        "#!/usr/bin/env python3\n"
        "import os, pathlib, sys, time\n"
        "out_dir = pathlib.Path(sys.argv[sys.argv.index('--out-dir') + 1])\n"
        "name = sys.argv[sys.argv.index('--name') + 1]\n"
        "(out_dir.parent / 'cancel-child.pid').write_text(str(os.getpid()))\n"
        "(out_dir / f'{name}.fa.gz').write_text('partial-fasta')\n"
        "(out_dir / f'{name}.fa.gz.fai').write_text('partial-fai')\n"
        "(out_dir / f'{name}.fa.gz.gzi').write_bytes(b'partial-gzi')\n"
        "while True:\n"
        "    time.sleep(0.05)\n"
    )
    fake_indexer.chmod(0o755)
    monkeypatch.setattr(
        dna_indexer_shellout, "find_dna_indexer_binary", lambda: fake_indexer
    )

    def cancel_after_partial_write() -> bool:
        return any(
            output_dir.parent.glob(f".{output_dir.name}.chr1.indexing.*/chr1.fa.gz.fai")
        )

    with pytest.raises(GenomeIndexCancelledError, match="cancelled"):
        index_genome(
            input_path=gff_path,
            output_dir=output_dir,
            name="chr1",
            workspace_root=workspace,
            cancel_check=cancel_after_partial_write,
        )

    assert {path: path.read_bytes() for path in final_paths} == previous_bytes
    assert list(output_dir.parent.glob(f".{output_dir.name}.chr1.indexing.*")) == []
    child_pid = int((output_dir.parent / "cancel-child.pid").read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(child_pid, 0)


def test_gff_success_promotes_only_the_complete_staged_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = tmp_path / "workspace"
    output_dir = workspace / "derived"
    workspace.mkdir()
    gff_path = workspace / "reference.gff3"
    fasta_input = workspace / "reference.fa"
    gff_path.write_text("##gff-version 3\n")
    fasta_input.write_text(">chr1\nACGT\n")

    fake_indexer = workspace / "complete-indexer"
    fake_indexer.write_text(
        "#!/usr/bin/env python3\n"
        "import gzip, json, pathlib, sys\n"
        "out_dir = pathlib.Path(sys.argv[sys.argv.index('--out-dir') + 1])\n"
        "name = sys.argv[sys.argv.index('--name') + 1]\n"
        "(out_dir / f'{name}.fa.gz').write_text('>chr1\\nACGT\\n')\n"
        "(out_dir / f'{name}.fa.gz.fai').write_text('chr1\\t4\\t6\\t4\\t5\\n')\n"
        "(out_dir / f'{name}.fa.gz.gzi').write_bytes(b'test-gzi')\n"
        "with gzip.open(out_dir / f'{name}.gff3.gz', 'wt') as handle:\n"
        "    handle.write('##gff-version 3\\n')\n"
        "    handle.write('##dna-indexer-topology linear\\n')\n"
        "    handle.write('chr1\\ttest\\tgene\\t1\\t4\\t.\\t+\\t.\\tID=g1\\n')\n"
        "(out_dir / f'{name}.gff3.gz.tbi').write_bytes(b'test-index')\n"
        "print(json.dumps({'ok': True, 'length': 4, 'feature_count': 1, "
        "'topology': 'linear'}))\n"
    )
    fake_indexer.chmod(0o755)
    monkeypatch.setattr(
        dna_indexer_shellout, "find_dna_indexer_binary", lambda: fake_indexer
    )

    result = index_genome(
        input_path=gff_path,
        output_dir=output_dir,
        name="chr1",
        workspace_root=workspace,
    )

    assert result.metadata.length == 4
    assert result.metadata.feature_count == 1
    assert result.fasta_path.read_text() == ">chr1\nACGT\n"
    assert result.fai_path.read_text() == "chr1\t4\t6\t4\t5\n"
    assert result.gff_path == output_dir / "chr1.gff3.gz"
    assert result.tbi_path == output_dir / "chr1.gff3.gz.tbi"
    assert list(output_dir.parent.glob(f".{output_dir.name}.chr1.indexing.*")) == []


def test_genbank_cancellation_after_metadata_never_replaces_visible_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = tmp_path / "workspace"
    output_dir = workspace / "derived"
    workspace.mkdir()
    output_dir.mkdir()
    genbank_path = workspace / "reference.gb"
    genbank_path.write_text("LOCUS       chr1\nORIGIN\n//\n")

    final_paths = (
        output_dir / "chr1.fa.gz",
        output_dir / "chr1.fa.gz.fai",
        output_dir / "chr1.fa.gz.gzi",
        output_dir / "chr1.gff3.gz",
        output_dir / "chr1.gff3.gz.tbi",
    )
    previous_bytes = {
        path: f"previous-{index}".encode() for index, path in enumerate(final_paths)
    }
    for path, content in previous_bytes.items():
        path.write_bytes(content)

    def stage_complete_rust_index(
        *,
        staging_dir: Path,
        fasta_stage: Path,
        fai_stage: Path,
        **_kwargs: object,
    ) -> None:
        fasta_stage.write_bytes(b"replacement-fasta")
        fai_stage.write_bytes(b"replacement-fai")
        (staging_dir / "chr1.gff3.gz").write_bytes(b"replacement-gff")
        (staging_dir / "chr1.gff3.gz.tbi").write_bytes(b"replacement-tbi")

    metadata_finished = False

    def finish_metadata_then_cancel(
        _fasta_stage: Path, _gff_gz_stage: Path
    ) -> tuple[int, bool, int]:
        nonlocal metadata_finished
        metadata_finished = True
        return 4, False, 1

    monkeypatch.setattr(genome_indexer, "_run_rust_indexer", stage_complete_rust_index)
    monkeypatch.setattr(
        genome_indexer, "_rust_stage_metadata", finish_metadata_then_cancel
    )

    with pytest.raises(GenomeIndexCancelledError, match="cancelled"):
        index_genome(
            input_path=genbank_path,
            output_dir=output_dir,
            name="chr1",
            workspace_root=workspace,
            cancel_check=lambda: metadata_finished,
        )

    assert {path: path.read_bytes() for path in final_paths} == previous_bytes
    assert list(output_dir.parent.glob(f".{output_dir.name}.chr1.indexing.*")) == []
