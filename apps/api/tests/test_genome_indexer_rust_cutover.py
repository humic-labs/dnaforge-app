"""Pytest coverage for the Rust `dna-indexer` path in `genome_indexer.py`.

GenBank and FASTA both go through `dna-indexer index`; there is no BioPython
fallback. These tests pin the binary to a fresh `cargo build` when one exists
so a stale LFS helper cannot mask a source change.
"""

from __future__ import annotations

import gzip
import os
from pathlib import Path

import pytest

from src.services import dna_indexer_shellout as _dna_indexer_shellout
from src.services import genome_indexer as _genome_indexer


def _repo_root() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "Cargo.toml").is_file():
            return parent
    raise RuntimeError("cannot find worktree root")


def _puc19() -> Path:
    return _repo_root() / "test-fixtures" / "sequences" / "circular" / "pUC19.gb"


def _fresh_binaries() -> tuple[Path, ...]:
    return (
        _repo_root() / "target" / "release" / "dna-indexer",
        _repo_root() / "target" / "debug" / "dna-indexer",
    )


def _dna_indexer_built() -> bool:
    if os.environ.get("DNA_INDEXER_PATH") or any(
        path.is_file() and os.access(path, os.X_OK) for path in _fresh_binaries()
    ):
        return True
    try:
        _dna_indexer_shellout.find_dna_indexer_binary()
    except _dna_indexer_shellout.DnaIndexerNotFoundError:
        return False
    return True


pytestmark = pytest.mark.skipif(
    not _dna_indexer_built(), reason="dna-indexer helper not built"
)


@pytest.fixture(autouse=True)
def _prefer_fresh_binary(monkeypatch):
    if os.environ.get("DNA_INDEXER_PATH"):
        return
    for fresh in _fresh_binaries():
        if fresh.is_file() and os.access(fresh, os.X_OK):
            monkeypatch.setenv("DNA_INDEXER_PATH", str(fresh))
            return


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "pUC19.gb").write_bytes(_puc19().read_bytes())
    return ws


def _index(workspace: Path, source: Path, name: str):
    return _genome_indexer.index_genome(
        input_path=source,
        output_dir=workspace / f"out-{name}",
        name=name,
        workspace_root=workspace,
    )


def test_genbank_runs_rust_indexer_end_to_end(workspace: Path):
    result = _index(workspace, workspace / "pUC19.gb", "pUC19")
    assert result.metadata.length == 2686
    assert result.metadata.circular is True
    assert result.metadata.feature_count == 8
    assert result.gff_path is not None and result.gff_path.exists()
    assert result.tbi_path is not None and result.tbi_path.exists()
    assert Path(str(result.fasta_path) + ".gzi").exists()
    with gzip.open(result.fasta_path, "rt") as fh:
        assert fh.readline().strip() == ">pUC19"
    with gzip.open(result.gff_path, "rt") as fh:
        assert "##dna-indexer-version" in fh.read(200)


def test_fasta_runs_rust_indexer_and_renames_record(workspace: Path):
    source = workspace / "chr22.fa"
    source.write_text(">NC_000022.11 Homo sapiens chromosome 22\nACGTN\nacgt\n")
    result = _index(workspace, source, "chr22")
    assert result.metadata.length == 9
    assert result.metadata.circular is False
    assert result.metadata.feature_count == 0
    assert result.gff_path is None and result.tbi_path is None
    assert not (workspace / "out-chr22" / "chr22.gff3.gz").exists()
    with gzip.open(result.fasta_path, "rt") as fh:
        assert fh.read() == ">chr22\nacgtnacgt\n"
    assert result.fai_path.read_text().startswith("chr22\t9\t")


def test_gzipped_fasta_is_accepted(workspace: Path):
    source = workspace / "chrM.fa.gz"
    with gzip.open(source, "wt") as fh:
        fh.write(">chrM\nACGT\n")
    result = _index(workspace, source, "chrM")
    assert result.metadata.length == 4


@pytest.mark.parametrize(
    ("filename", "body"),
    [
        ("two.fa", ">a\nACGT\n>b\nACGT\n"),
        ("two.gb", None),
    ],
)
def test_multi_record_input_is_rejected(workspace: Path, filename: str, body):
    source = workspace / filename
    if body is None:
        one = _puc19().read_text()
        body = one + one
    source.write_text(body)
    with pytest.raises(_genome_indexer.GenomeIndexerError, match="multi-record"):
        _index(workspace, source, "x")
    assert not (workspace / "out-x").exists()


def test_invalid_genbank_raises_genome_indexer_error(workspace: Path):
    bad = workspace / "garbage.gb"
    bad.write_text("not a genbank file\n")
    with pytest.raises(_genome_indexer.GenomeIndexerError) as exc_info:
        _index(workspace, bad, "bad")
    assert "GENBANK_PARSE_FAILED" in str(exc_info.value)


def test_rust_stage_metadata_reads_topology_pragma_directly(workspace: Path):
    result = _index(workspace, workspace / "pUC19.gb", "pUC19")
    length, circular, feature_count = _genome_indexer._rust_stage_metadata(
        result.fasta_path, result.gff_path
    )
    assert length == 2686
    assert circular is True
    assert feature_count == 8


def test_indexer_never_imports_biopython():
    source = Path(_genome_indexer.__file__).read_text()
    assert "Bio" not in {
        token.split(".")[0]
        for line in source.splitlines()
        if line.lstrip().startswith(("import ", "from "))
        for token in line.split()[1:2]
    }
