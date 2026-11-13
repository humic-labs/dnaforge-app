from __future__ import annotations

import subprocess
import shutil
from pathlib import Path

import pytest

from dnaforge_annotation.contract import AnnotationExecutables, AnnotationRuntime


def test_blast_alias_stays_space_free_when_runtime_scratch_contains_whitespace(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from dnaforge_annotation import engine

    database_dir = tmp_path / "Application Support" / "references"
    database_dir.mkdir(parents=True)
    database_prefix = database_dir / "snapgene"
    reference_parts = {
        database_prefix.with_suffix(".nin"): b"index-bytes",
        database_prefix.with_suffix(".nsq"): b"sequence-bytes",
    }
    for path, content in reference_parts.items():
        path.write_bytes(content)

    configured_scratch = tmp_path / "Application Support" / "annotation" / "tmp"
    configured_scratch.mkdir(parents=True)
    system_scratch = tmp_path / "system-temp"
    system_scratch.mkdir()
    monkeypatch.setattr(engine.tempfile, "gettempdir", lambda: str(system_scratch))

    safe_prefix, cleanup = engine._safe_db_path(
        str(database_prefix), configured_scratch
    )
    try:
        assert not any(character.isspace() for character in safe_prefix)
        for source, original in reference_parts.items():
            suffix = str(source)[len(str(database_prefix)) :]
            assert Path(safe_prefix + suffix).read_bytes() == original
            assert source.read_bytes() == original
    finally:
        if cleanup:
            shutil.rmtree(cleanup)


def test_windows_blast_alias_uses_a_verified_short_temp_path() -> None:
    from dnaforge_annotation import engine

    configured = r"C:\Users\First Last\AppData\Local\Temp"
    shortened = r"C:\Users\FIRSTL~1\AppData\Local\Temp"

    selected = engine._space_free_alias_root(
        configured,
        platform_name="nt",
        system_temp_dir=configured,
        windows_shortener=lambda path: shortened if path == configured else None,
    )

    assert selected == shortened
    assert not any(character.isspace() for character in selected)


def test_windows_blast_alias_fails_clearly_without_a_space_free_temp_path() -> None:
    from dnaforge_annotation import engine

    configured = r"C:\Users\First Last\AppData\Local\Temp"

    with pytest.raises(RuntimeError, match="whitespace-free temporary directory"):
        engine._space_free_alias_root(
            configured,
            platform_name="nt",
            system_temp_dir=configured,
            windows_shortener=lambda _path: None,
        )


def test_scientific_python_path_contains_no_biopython_import() -> None:
    package_root = Path(__file__).parents[1]
    offenders = []
    for source in (package_root / "src").rglob("*.py"):
        text = source.read_text()
        if "from Bio" in text or "import Bio" in text:
            offenders.append(source.relative_to(package_root).as_posix())
    assert offenders == []


def test_packaged_complement_resource_matches_sequence_utils() -> None:
    package_root = Path(__file__).parents[1]
    completed = subprocess.run(
        ["node", str(package_root / "scripts" / "generate-complements.mjs"), "--check"],
        cwd=package_root,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr

    sequence = "AaCGTRYKMBVDHNU-.*"
    canonical = subprocess.run(
        [
            "node",
            "-e",
            (
                "import('@waypoint/sequence-utils/iupac')"
                f".then(m => process.stdout.write(m.reverseComplement({sequence!r})))"
            ),
        ],
        cwd=package_root,
        capture_output=True,
        text=True,
        check=False,
    )
    assert canonical.returncode == 0, canonical.stderr

    from dnaforge_annotation.iupac import reverse_complement

    assert reverse_complement(sequence) == canonical.stdout


def test_runtime_resolves_reference_paths_executables_and_thread_limits(
    tmp_path: Path,
) -> None:
    from dnaforge_annotation.resources import get_yaml, get_yaml_path

    runtime = AnnotationRuntime(
        data_dir=tmp_path / "reference data",
        executables=AnnotationExecutables(
            blastn=tmp_path / "tools" / "blastn-exact",
            diamond=tmp_path / "tools" / "diamond-exact",
            cmscan=tmp_path / "tools" / "cmscan-exact",
        ),
        temp_dir=tmp_path / "temporary files",
        threads=7,
    )

    databases = get_yaml(get_yaml_path(), runtime=runtime)

    assert databases["snapgene"]["db_loc"] == str(
        runtime.data_dir / "BLAST_dbs" / "snapgene"
    )
    assert databases["Rfam"]["db_loc"] == (
        str(runtime.data_dir / "BLAST_dbs" / "Rfam.clanin"),
        str(runtime.data_dir / "BLAST_dbs" / "Rfam.cm"),
    )
    assert databases["snapgene"]["executable"] == str(runtime.executables.blastn)
    assert databases["fpbase"]["executable"] == str(runtime.executables.diamond)
    assert databases["Rfam"]["executable"] == str(runtime.executables.cmscan)
    for database in databases.values():
        parameters = database["parameters"].split()
        if database["method"] == "blastn":
            assert parameters[parameters.index("-num_threads") + 1] == "7"
        elif database["method"] == "diamond":
            assert parameters[parameters.index("--threads") + 1] == "7"
        else:
            assert parameters[parameters.index("--cpu") + 1] == "7"


def test_annotate_sequence_returns_plain_rows_and_passes_explicit_runtime(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from dnaforge_annotation import engine

    runtime = AnnotationRuntime(
        data_dir=tmp_path / "references",
        executables=AnnotationExecutables(
            blastn=tmp_path / "blastn",
            diamond=tmp_path / "diamond",
            cmscan=tmp_path / "cmscan",
        ),
        temp_dir=tmp_path / "tmp",
        threads=2,
    )
    recorded = {}

    class FakeFrame:
        def to_dict(self, *, orient):
            assert orient == "records"
            return [{"Feature": "plain row", "qstart": 0, "qend": 2}]

    def fake_annotate(sequence, **kwargs):
        recorded.update(sequence=sequence, **kwargs)
        return FakeFrame()

    monkeypatch.setattr(engine, "annotate", fake_annotate)

    rows = engine.annotate_sequence("AC", linear=True, runtime=runtime)

    assert rows == [{"Feature": "plain row", "qstart": 0, "qend": 2}]
    assert recorded == {
        "sequence": "AC",
        "yaml_file": str(engine.get_yaml_path()),
        "linear": True,
        "is_detailed": False,
        "runtime": runtime,
    }
