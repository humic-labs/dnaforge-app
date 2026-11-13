from __future__ import annotations

import asyncio
import threading
from pathlib import Path

import pytest

from src.managed_operations import MANAGED_OPERATION_SYSTEM
from src.managed_track_registration import execute_managed_track_registration
from src.operations import OperationExecutionError
from src.track_registration_operation_audit import (
    track_registration_agent_audit_parameters,
    track_registration_submission_audit_parameters,
)
from src.track_registration_operation_contract import (
    RegisterTrackRequest,
    TrackRegistrationSubmission,
    prepare_track_registration_submission,
    track_registration_subject_id,
)
from src.track_store import read_current, read_meta, version_id
from src.track_store.gff3_check import Gff3CheckError, check_gff3
from src.track_store.root import resolve_dnaforge_data_root

GFF3 = (
    b"##gff-version 3\n"
    b"##sequence-region NC_000913.3 1 1000\n"
    b"NC_000913.3\tx\tterminator\t10\t20\t.\t+\t.\tID=a\n"
    b"U00096.3\tx\tterminator\t30\t40\t.\t-\t.\tID=b\n"
)


def _request(path: Path, **overrides: object) -> RegisterTrackRequest:
    base: dict[str, object] = {
        "path": str(path),
        "accession": "NC_000913.3",
        "lengthBp": 1000,
        "aliases": ["U00096.3"],
        "name": "my-terminators",
        "kinds": ["terminator"],
        "label": "My terminators",
        "evidence": "measured",
        "licenseAttribution": "Test data, CC0",
    }
    base.update(overrides)
    return RegisterTrackRequest.model_validate(base)


def _run(request: RegisterTrackRequest):
    return asyncio.run(execute_managed_track_registration(request, threading.Event()))


@pytest.fixture
def store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "data"
    monkeypatch.setenv("DNAFORGE_DATA_ROOT", str(root))
    return root / "tracks"


def test_track_registration_is_one_compiled_kind_with_three_surfaces():
    descriptors = {d.kind: d for d in MANAGED_OPERATION_SYSTEM.descriptors}
    kind = descriptors["track-registration"]
    assert kind.surfaces.http_start == "/operations/track-registration"
    assert kind.surfaces.cli_submit == (
        "dnaforge jobs submit track-registration --request FILE|-"
    )
    assert kind.surfaces.agent_start == "operations.track-registration.start"
    assert kind.surfaces.http_import_recorded is None


def test_registers_a_gff3_file_as_an_immutable_version_and_points_current_at_it(
    store: Path, tmp_path: Path
):
    source = tmp_path / "terminators.gff3"
    source.write_bytes(GFF3)
    result = _run(_request(source, producedBy="bedtools 2.31"))
    version = version_id(GFF3)
    stored = store / "NC_000913.3" / "my-terminators" / version / "my-terminators.gff3"
    assert result.model_dump(by_alias=True) == {
        "accession": "NC_000913.3",
        "track": "my-terminators",
        "version": version,
        "path": str(stored),
        "rows": 2,
        "alreadyPresent": False,
    }
    assert stored.read_bytes() == GFF3

    meta = read_meta(stored.parent)
    assert meta["track"] == "my-terminators"
    assert meta["assembly"] == {
        "accession": "NC_000913.3",
        "lengthBp": 1000,
        "aliases": ["U00096.3"],
    }
    assert meta["file"]["byteLength"] == len(GFF3)
    assert meta["file"]["sha256"].startswith(version)
    assert meta["residency"] == {"kind": "managed"}
    assert meta["license"] == {"attribution": "Test data, CC0"}
    assert meta["provenance"]["producedBy"] == {"tool": "bedtools 2.31"}
    assert meta["provenance"]["inputs"][0]["path"] == str(source)

    current = read_current(stored.parent.parent)
    assert current["version"] == version
    assert current["selectedAt"].endswith("Z")
    assert current["reason"] == "Registered from terminators.gff3"

    again = _run(_request(source))
    assert again.already_present is True
    assert again.version == version


def test_a_name_holding_a_different_track_is_refused_unless_replacing(
    store: Path, tmp_path: Path
):
    first = tmp_path / "a.gff3"
    first.write_bytes(GFF3)
    _run(_request(first))
    second = tmp_path / "b.gff3"
    second.write_bytes(GFF3.replace(b"ID=a", b"ID=c"))

    with pytest.raises(OperationExecutionError) as refused:
        _run(_request(second, label="Something else"))
    assert refused.value.payload.code == "TRACK_NAME_TAKEN"
    assert (
        "'my-terminators' already holds 'My terminators'"
        in refused.value.payload.message
    )

    replaced = _run(_request(second, label="Something else", replaceExisting=True))
    assert replaced.already_present is False
    track_dir = store / "NC_000913.3" / "my-terminators"
    assert read_current(track_dir)["version"] == replaced.version
    assert sorted(p.name for p in track_dir.iterdir() if p.is_dir()) == sorted(
        [version_id(GFF3), replaced.version]
    )


def test_refuses_files_the_store_cannot_hold(store: Path, tmp_path: Path):
    bad = tmp_path / "bad.gff3"
    bad.write_bytes(
        b"chr1\tx\tterminator\t10\t20\t.\t+\t.\tID=a\n"
        b"NC_000913.3\tx\tterminator\t50\t60\t.\t+\t.\tID=b\n"
        b"NC_000913.3\tx\tterminator\t40\t45\t.\t+\t.\tID=c\n"
        b"NC_000913.3\tx\tterminator\t900\t1001\t.\t+\t.\tID=d\n"
    )
    with pytest.raises(OperationExecutionError) as invalid:
        _run(_request(bad))
    assert invalid.value.payload.code == "TRACK_FILE_INVALID"
    assert "line 1 must be '##gff-version 3'" in invalid.value.payload.message
    assert "column 1 is 'chr1', not NC_000913.3" in invalid.value.payload.message
    assert "rows are not sorted by start" in invalid.value.payload.message
    assert "[900, 1001] is outside 1..1000" in invalid.value.payload.message

    with pytest.raises(OperationExecutionError) as missing:
        _run(_request(tmp_path / "nope.gff3"))
    assert missing.value.payload.code == "TRACK_FILE_MISSING"

    with pytest.raises(OperationExecutionError) as residency:
        _run(_request(bad, residency="linked"))
    assert residency.value.payload.code == "TRACK_RESIDENCY_UNSUPPORTED"
    assert not (store / "NC_000913.3").exists()


def test_check_gff3_stops_reporting_after_ten_problems():
    rows = b"".join(
        b"NC_000913.3\tx\tterminator\t%d\t%d\t.\t*\t.\tID=r%d\n" % (i, i, i)
        for i in range(1, 31)
    )
    with pytest.raises(Gff3CheckError) as exc:
        check_gff3(b"##gff-version 3\n" + rows, accession="NC_000913.3", length_bp=1000)
    assert len(exc.value.problems) == 10
    assert exc.value.problems[0] == "line 2: strand '*' is not +, -, . or ?"
    summary = check_gff3(
        GFF3, accession="NC_000913.3", length_bp=1000, aliases=("U00096.3",)
    )
    assert summary.rows == 2 and summary.types == {"terminator": 2}


def test_prepare_grounds_the_path_and_derives_the_subject(tmp_path: Path):
    source = tmp_path / "t.gff3"
    source.write_bytes(GFF3)
    submission = TrackRegistrationSubmission(
        submission_key="track-1",
        subject={"scope_id": "runtime-a"},
        input=_request(source).model_dump(by_alias=True, exclude_none=True),
    )
    prepared = prepare_track_registration_submission(submission)
    assert prepared.input.path == str(source.resolve())
    assert prepared.input.source_generation is not None
    assert prepared.subject.subject_id == track_registration_subject_id(prepared.input)
    assert prepared.subject.subject_id == track_registration_subject_id(
        _request(tmp_path / "elsewhere.gff3")
    ), "the subject is the track in the store, not the file"
    assert prepared.subject.input_revision.startswith("track-registration-v1:sha256:")


def test_audit_projections_hash_paths_and_keep_the_track_identity():
    projected = track_registration_submission_audit_parameters(
        {
            "submission_key": "k",
            "subject": {"scope_id": "s"},
            "input": {
                "path": "/secret/dir/file.gff3",
                "name": "my-terminators",
                "accession": "NC_000913.3",
                "kinds": ["terminator"],
                "evidence": "measured",
            },
        }
    )
    assert projected["input"]["name"] == "my-terminators"
    assert projected["input"]["path_sha256"].startswith("sha256:")
    assert "/secret" not in str(projected)
    agent = track_registration_agent_audit_parameters(
        {"path": "runs/2024/terminators.gff3", "name": "t", "accession": "NC_000913.3"}
    )
    assert agent["path_basename"] == "terminators.gff3"
    assert "runs/2024" not in str(agent)


def test_data_root_matches_the_desktop_resolver():
    home = Path("/Users/alice")
    assert resolve_dnaforge_data_root({}, "darwin", home) == Path(
        "/Users/alice/Library/Application Support/DNAForge"
    )
    assert (
        resolve_dnaforge_data_root(
            {"LOCALAPPDATA": r"C:\Users\alice\AppData\Local"},
            "win32",
            Path(r"C:\Users\alice"),
        )
        == Path(r"C:\Users\alice\AppData\Local") / "DNAForge"
    )
    assert resolve_dnaforge_data_root({}, "linux", Path("/home/alice")) == Path(
        "/home/alice/.local/share/DNAForge"
    )
    assert resolve_dnaforge_data_root(
        {"XDG_DATA_HOME": "/data/alice"}, "linux", Path("/home/alice")
    ) == Path("/data/alice/DNAForge")
    assert resolve_dnaforge_data_root(
        {"DNAFORGE_DATA_ROOT": "/srv/dnaforge"}, "linux", Path("/home/alice")
    ) == Path("/srv/dnaforge")
    with pytest.raises(ValueError):
        resolve_dnaforge_data_root({"DNAFORGE_DATA_ROOT": "relative"}, "linux", home)
