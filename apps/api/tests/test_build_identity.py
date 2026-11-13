import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from src import build_identity


@pytest.mark.parametrize("changes_during_read", [False, True])
def test_descriptor_collection_preserves_windows_change_time(
    tmp_path, monkeypatch, changes_during_read
):
    source = tmp_path / "source.py"
    source.write_bytes(b"source bytes\r\n")
    real_fstat = build_identity.os.fstat
    descriptor_reads = 0

    def descriptor_stat(descriptor):
        nonlocal descriptor_reads
        descriptor_reads += 1
        actual = real_fstat(descriptor)
        values = {
            name: getattr(actual, name)
            for name in (
                "st_dev",
                "st_ino",
                "st_mode",
                "st_size",
                "st_mtime_ns",
                "st_ctime_ns",
            )
        }
        values["st_ctime_ns"] += 1_000_000_000
        if changes_during_read and descriptor_reads >= 3:
            values["st_ctime_ns"] += 1
        return SimpleNamespace(**values)

    with monkeypatch.context() as scoped:
        scoped.setattr(build_identity.os, "name", "nt")
        scoped.setattr(build_identity.os, "fstat", descriptor_stat)
        files = []
        build_identity._collect_files(tmp_path, source, files, [])
        if changes_during_read:
            with pytest.raises(ValueError, match="changed while hashing"):
                build_identity._read_bounded_regular_file(source, files[0][1])
        else:
            content = build_identity._read_bounded_regular_file(source, files[0][1])
    if not changes_during_read:
        assert content == b"source bytes\n"


def test_source_fingerprint_matches_the_build_receipt_authority():
    repo_root = Path(__file__).resolve().parents[3]
    python_fingerprint = build_identity.compute_source_sidecar_fingerprint(repo_root)
    node = subprocess.run(
        [
            "node",
            "-e",
            (
                "const r=require('./scripts/sidecar-build-receipt.cjs');"
                "process.stdout.write(r.computeSidecarSourceHash(process.cwd()).sourceHash)"
            ),
        ],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    )

    assert python_fingerprint == node.stdout
    assert len(python_fingerprint or "") == 64


def test_invalid_utf8_is_hashed_as_exact_bytes_without_replacement_collisions():
    assert build_identity._normalized_content(b"\x80") == b"\x80"
    assert build_identity._normalized_content(b"\x81") == b"\x81"
    assert build_identity._normalized_content(
        b"\x80"
    ) != build_identity._normalized_content(b"\x81")


def test_source_reader_uses_binary_descriptors_before_normalizing_crlf(
    tmp_path, monkeypatch
):
    source = tmp_path / "source.py"
    source.write_bytes(b"first\r\nsecond\r\n")
    real_open = build_identity.os.open
    real_read = build_identity.os.read
    native_binary_flag = getattr(build_identity.os, "O_BINARY", 0)
    binary_flag = 0x8000
    descriptor_modes = {}

    def windows_open(path, flags):

        descriptor = real_open(path, (flags & ~binary_flag) | native_binary_flag)
        descriptor_modes[descriptor] = bool(flags & binary_flag)
        return descriptor

    def windows_read(descriptor, size):
        content = real_read(descriptor, size)

        return (
            content if descriptor_modes[descriptor] else content.replace(b"\r\n", b"\n")
        )

    monkeypatch.setattr(build_identity.os, "O_BINARY", binary_flag, raising=False)
    monkeypatch.setattr(build_identity.os, "open", windows_open)
    monkeypatch.setattr(build_identity.os, "read", windows_read)

    files = []
    build_identity._collect_files(tmp_path, source, files, [])
    assert (
        build_identity._read_bounded_regular_file(source, files[0][1])
        == b"first\nsecond\n"
    )


def test_only_the_exact_generated_identity_path_is_excluded(tmp_path):
    source_root = tmp_path / "apps" / "api" / "src"
    source_root.mkdir(parents=True)
    contract = source_root / "sidecar-source-inputs.json"
    contract.write_text(
        '{"schema":"dnaforge.sidecar-source-inputs.v1","paths":["apps/api/src"]}\n',
        encoding="utf-8",
    )
    baseline = build_identity.compute_source_sidecar_fingerprint(tmp_path)

    (source_root / "_frozen_build_identity.py").write_text(
        'SOURCE_FINGERPRINT = "generated"\n', encoding="utf-8"
    )
    assert build_identity.compute_source_sidecar_fingerprint(tmp_path) == baseline

    nested_identity = source_root / "build" / "_frozen_build_identity.py"
    nested_identity.parent.mkdir()
    nested_identity.write_text('SOURCE_FINGERPRINT = "runtime"\n', encoding="utf-8")
    assert build_identity.compute_source_sidecar_fingerprint(tmp_path) != baseline


def test_frozen_identity_comes_from_the_value_compiled_into_the_binary(monkeypatch):
    monkeypatch.setitem(build_identity.__dict__, "__compiled__", object())
    monkeypatch.setattr(build_identity, "_FROZEN_SOURCE_FINGERPRINT", "a" * 64)

    assert build_identity._resolve_intrinsic_sidecar_source_fingerprint() == "a" * 64

    monkeypatch.setattr(build_identity, "_FROZEN_SOURCE_FINGERPRINT", "not-a-sha")
    assert build_identity._resolve_intrinsic_sidecar_source_fingerprint() is None


def test_intrinsic_identity_is_the_process_startup_snapshot(monkeypatch):
    startup_fingerprint = build_identity.intrinsic_sidecar_source_fingerprint()
    monkeypatch.setattr(
        build_identity, "compute_source_sidecar_fingerprint", lambda _root: "b" * 64
    )

    assert build_identity.intrinsic_sidecar_source_fingerprint() == startup_fingerprint
