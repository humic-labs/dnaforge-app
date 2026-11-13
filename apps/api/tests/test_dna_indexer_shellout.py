"""Pytest coverage for the dna-indexer shell-out wrapper  Step 4)."""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

import pytest

_MODULE_PATH = (
    Path(__file__).resolve().parent.parent
    / "src"
    / "services"
    / "dna_indexer_shellout.py"
)
_spec = importlib.util.spec_from_file_location("dna_indexer_shellout", _MODULE_PATH)
_mod = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
sys.modules["dna_indexer_shellout"] = _mod
_spec.loader.exec_module(_mod)  # type: ignore[union-attr]

DnaIndexerError = _mod.DnaIndexerError
DnaIndexerNotFoundError = _mod.DnaIndexerNotFoundError
DnaIndexerProgress = _mod.DnaIndexerProgress
check_binary_compatibility = _mod.check_binary_compatibility
find_dna_indexer_binary = _mod.find_dna_indexer_binary
iter_progress_events = _mod.iter_progress_events
run_index = _mod.run_index


def _repo_root() -> Path:
    """Walk up from this test file to find the worktree root."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "Cargo.toml").is_file():
            return parent
    raise RuntimeError("cannot find worktree root")


def _puc19_fixture() -> Path:
    return _repo_root() / "test-fixtures" / "sequences" / "circular" / "pUC19.gb"


def _binary() -> Path | None:
    """Try to find the freshly-built binary. Return None if not built —
    tests that need it skip rather than fail.

    NOTE: prefers a cargo-built `target/{debug,release}/dna-indexer`
    over the LFS-tracked `apps/desktop/resources/helpers/dna-indexer-*`
    which may be stale. The shell-out's `find_dna_indexer_binary` doesn't
    know about staleness — tests have to be explicit."""
    for fresh in (
        _repo_root() / "target" / "debug" / "dna-indexer",
        _repo_root() / "target" / "release" / "dna-indexer",
    ):
        if fresh.is_file() and os.access(fresh, os.X_OK):
            return fresh
    try:
        return find_dna_indexer_binary()
    except DnaIndexerNotFoundError:
        return None


def test_iter_progress_events_parses_ndjson():
    """The parser must accept the NDJSON shape the Rust binary emits."""
    stream = """\
{"progress":0.0,"stage":"parsing","feature_count":0}
{"progress":0.3,"stage":"gff_emit","feature_count":21}
not a json line — should be ignored
{"progress":0.6,"stage":"writing","feature_count":21}
{"ok":true,"length":2686,"feature_count":21,"topology":"circular"}
"""
    events = list(iter_progress_events(stream))
    assert len(events) == 3, f"expected 3 progress events, got {len(events)}: {events}"
    assert events[0].stage == "parsing"
    assert events[0].progress == 0.0
    assert events[1].stage == "gff_emit"
    assert events[2].feature_count == 21
    assert all(e.stage != "done" for e in events) or any(
        e.stage == "done" for e in events
    )


def test_dna_indexer_error_carries_code_and_context():
    err = DnaIndexerError("FOO_BAR", "stuff broke", {"key": "value"})
    assert err.code == "FOO_BAR"
    assert err.message == "stuff broke"
    assert err.context == {"key": "value"}
    assert "FOO_BAR" in str(err)
    assert "stuff broke" in str(err)


def test_binary_not_found_includes_searched_paths():
    err = DnaIndexerNotFoundError([Path("/nowhere/a"), Path("/nowhere/b")])
    assert err.code == "BINARY_NOT_FOUND"
    assert "/nowhere/a" in str(err.context["searched"]).replace("\\", "/")


def test_host_suffix_detects_apple_silicon_under_rosetta(monkeypatch):
    """Python can report x86_64 under Rosetta on Apple Silicon; the resolver
    must match download-binaries.sh's sysctl-based suffix."""

    class Proc:
        returncode = 0
        stdout = "Apple M3 Max\n"

    monkeypatch.setattr(_mod.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(_mod.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(_mod.subprocess, "run", lambda *args, **kwargs: Proc())

    assert _mod._host_suffix() == "aarch64-apple-darwin"


def test_find_dna_indexer_binary_locates_executable():
    """If the binary's been built (it is in this worktree's target/release
    or the LFS-tracked helpers path), find_dna_indexer_binary returns it."""
    binary = _binary()
    if binary is None:
        pytest.skip("dna-indexer binary not built — run `npm run helpers:build`")
    assert binary.is_file()
    assert os.access(binary, os.X_OK)


def test_check_binary_compatibility_reports_current_schema():
    binary = _binary()
    if binary is None:
        pytest.skip("dna-indexer binary not built")
    schema = check_binary_compatibility(binary)
    assert schema >= 2, f"expected schema >= 2, got {schema}"


def test_run_index_puc19_end_to_end(tmp_path: Path):
    """Full shell-out against the real pUC19 fixture."""
    binary = _binary()
    if binary is None:
        pytest.skip("dna-indexer binary not built")
    input_path = _puc19_fixture()
    if not input_path.exists():
        pytest.skip(f"fixture {input_path} not present")

    progress_events: list[DnaIndexerProgress] = []
    result = run_index(
        input_path=input_path,
        out_dir=tmp_path,
        name="puc19",
        binary=binary,
        progress_cb=progress_events.append,
    )
    assert result.length == 2686
    assert result.feature_count >= 1
    assert result.topology == "circular"
    assert result.fa_path.exists()
    assert result.fai_path.exists()
    assert result.gzi_path.exists()
    assert result.gff_gz_path.exists()
    assert result.tbi_path.exists()

    stages = {e.stage for e in progress_events}
    assert "parsing" in stages
    assert "done" in stages


def test_run_index_missing_input_raises_structured_error(tmp_path: Path):
    binary = _binary()
    if binary is None:
        pytest.skip("dna-indexer binary not built")
    with pytest.raises(DnaIndexerError) as exc_info:
        run_index(
            input_path=Path("/nonexistent/file.gb"),
            out_dir=tmp_path,
            name="x",
            binary=binary,
        )
    assert exc_info.value.code == "GENBANK_PARSE_FAILED"


def test_run_index_invalid_genbank_raises(tmp_path: Path):
    binary = _binary()
    if binary is None:
        pytest.skip("dna-indexer binary not built")
    bad = tmp_path / "garbage.gb"
    bad.write_text("not a genbank file\n")
    with pytest.raises(DnaIndexerError) as exc_info:
        run_index(
            input_path=bad,
            out_dir=tmp_path / "out",
            name="garbage",
            binary=binary,
        )
    assert exc_info.value.code == "GENBANK_PARSE_FAILED"


def test_run_index_drains_chatty_child_before_pipe_capacity_blocks(tmp_path: Path):
    """A child may emit more than one OS pipe buffer before it exits."""
    fake_indexer = tmp_path / "chatty-indexer"
    fake_indexer.write_text(
        "#!/usr/bin/env python3\n"
        "import sys\n"
        "sys.stderr.write('warning\\n' * 50000)\n"
        "sys.stderr.flush()\n"
        'print(\'{"ok":true,"length":4,"feature_count":0,'
        '"topology":"linear"}\')\n'
    )
    fake_indexer.chmod(0o755)
    input_path = tmp_path / "input.gb"
    input_path.write_text("fixture contents are ignored by the fake indexer\n")

    result = run_index(
        input_path=input_path,
        out_dir=tmp_path / "out",
        name="chatty",
        binary=fake_indexer,
        timeout_sec=2,
    )

    assert result.length == 4
    assert result.feature_count == 0


def test_run_index_cancels_chatty_child_without_orphaning_it(tmp_path: Path):
    fake_indexer = tmp_path / "chatty-cancellable-indexer"
    fake_indexer.write_text(
        "#!/usr/bin/env python3\n"
        "import os, pathlib, sys\n"
        "out_dir = pathlib.Path(sys.argv[sys.argv.index('--out-dir') + 1])\n"
        "(out_dir / 'child.pid').write_text(str(os.getpid()))\n"
        "while True:\n"
        "    sys.stderr.write('warning\\n' * 1000)\n"
        "    sys.stderr.flush()\n"
    )
    fake_indexer.chmod(0o755)
    input_path = tmp_path / "input.gb"
    input_path.write_text("fixture contents are ignored by the fake indexer\n")
    pid_path = tmp_path / "out" / "child.pid"

    with pytest.raises(DnaIndexerError, match="CANCELLED") as exc_info:
        run_index(
            input_path=input_path,
            out_dir=tmp_path / "out",
            name="chatty",
            binary=fake_indexer,
            timeout_sec=2,
            cancel_check=pid_path.exists,
        )

    assert exc_info.value.code == "CANCELLED"
    child_pid = int(pid_path.read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(child_pid, 0)
