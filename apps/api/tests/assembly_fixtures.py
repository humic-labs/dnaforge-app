import hashlib
import json
import shutil
from pathlib import Path

import pytest


def assembly_sequence_directories(path: Path) -> list[Path]:
    directories = sorted(
        {
            file.parent
            for pattern in ("*.gb", "*.gbk")
            for file in path.rglob(pattern)
            if not any(part.startswith(".") for part in file.relative_to(path).parts)
        }
    )
    assert directories, f"No GenBank assembly fixtures found under {path}"
    return directories


def assembly_sequence_file(path: Path, name: str) -> Path:
    files = sorted(path.rglob(name))
    assert len(files) == 1, f"Expected one GenBank fixture named {name} under {path}"
    return files[0]


def materialize_genbank_fixture_directory(source: Path, target: Path) -> Path:
    assert not target.resolve().is_relative_to(source.resolve())
    target.mkdir(parents=True, exist_ok=False)
    inputs = []
    for directory in assembly_sequence_directories(source):
        for pattern in ("*.gb", "*.gbk"):
            for file in directory.glob(pattern):
                destination = target / file.name
                assert (
                    not destination.exists()
                ), f"Ambiguous GenBank fixture: {file.name}"
                before = file.stat()
                shutil.copyfile(file, destination)
                original = hashlib.sha256(file.read_bytes()).hexdigest()
                copied = hashlib.sha256(destination.read_bytes()).hexdigest()
                after = file.stat()
                assert (before.st_size, before.st_mtime_ns) == (
                    after.st_size,
                    after.st_mtime_ns,
                ), f"Fixture changed while copying: {file}"
                assert original == copied, f"Fixture copy differs: {file}"
                inputs.append(
                    {
                        "source": str(file.resolve()),
                        "name": destination.name,
                        "bytes": after.st_size,
                        "sha256": copied,
                    }
                )
    (target / ".fixture-provenance.json").write_text(
        json.dumps({"source": str(source.resolve()), "files": inputs}, indent=2) + "\n"
    )
    return target


@pytest.fixture(scope="session")
def assembly_fixture_directory(tmp_path_factory):
    source = Path(__file__).resolve().parents[4] / "wp-assets" / "00-assembly"
    if not source.exists():
        return source
    target = tmp_path_factory.mktemp("flat-assembly-fixtures")
    for name in ("sequences", "reference"):
        if (source / name).exists():
            materialize_genbank_fixture_directory(source / name, target / name)
    return target
