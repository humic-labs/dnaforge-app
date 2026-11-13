import hashlib
import json

import pytest

from tests.assembly_fixtures import (
    assembly_sequence_directories,
    materialize_genbank_fixture_directory,
)


def test_flat_fixture_view_preserves_all_product_bytes_without_package_history(
    tmp_path,
):
    source = tmp_path / "source"
    source.mkdir()
    (source / "flat.gb").write_bytes(b"flat GenBank bytes\n")
    package = source / "packaged"
    package.mkdir()
    (package / "product.gb").write_bytes(b"packaged GenBank bytes\r\n")
    history = package / ".forge" / "history"
    history.mkdir(parents=True)
    (history / "old.gb").write_bytes(b"historical bytes")
    target = materialize_genbank_fixture_directory(source, tmp_path / "view")
    assert {p.name for p in target.glob("*.gb")} == {"flat.gb", "product.gb"}
    assert (target / "flat.gb").read_bytes() == (source / "flat.gb").read_bytes()
    assert (target / "product.gb").read_bytes() == (package / "product.gb").read_bytes()
    assert (target / "product.gb").stat().st_ino != (
        package / "product.gb"
    ).stat().st_ino
    manifest = json.loads((target / ".fixture-provenance.json").read_text())
    assert len(manifest["files"]) == 2
    for item in manifest["files"]:
        assert (
            hashlib.sha256((target / item["name"]).read_bytes()).hexdigest()
            == item["sha256"]
        )
    assert (history / "old.gb").read_bytes() == b"historical bytes"


def test_fixture_view_rejects_ambiguous_names_without_overwriting_one(tmp_path):
    source = tmp_path / "source"
    (source / "one").mkdir(parents=True)
    (source / "two").mkdir()
    (source / "one" / "same.gb").write_bytes(b"first")
    (source / "two" / "same.gb").write_bytes(b"second")
    target = tmp_path / "view"
    with pytest.raises(AssertionError, match="Ambiguous GenBank fixture"):
        materialize_genbank_fixture_directory(source, target)
    assert (target / "same.gb").read_bytes() == b"first"
    assert (source / "two" / "same.gb").read_bytes() == b"second"


def test_fixture_discovery_does_not_treat_hidden_history_as_current_inputs(tmp_path):
    history = tmp_path / ".forge"
    history.mkdir()
    (history / "old.gb").write_bytes(b"historical bytes")
    with pytest.raises(AssertionError, match="No GenBank assembly fixtures"):
        assembly_sequence_directories(tmp_path)


def test_fixture_materialization_refuses_to_write_inside_its_source(tmp_path):
    (tmp_path / "current.gb").write_bytes(b"current")
    with pytest.raises(AssertionError):
        materialize_genbank_fixture_directory(tmp_path, tmp_path / "view")
    assert not (tmp_path / "view").exists()
