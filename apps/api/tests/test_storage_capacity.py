"""The same destination/purpose contract as the Node capacity adapter."""

import json
import re
import subprocess
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import src.storage_capacity as storage

APPLE = {
    "totalBytes": "3996329328640",
    "freeBytes": "0",
    "importantBytes": "789331063752",
    "opportunisticBytes": "48239351818",
}


@pytest.mark.parametrize("purpose", ["important", "opportunistic"])
def test_apple_capacity_uses_the_purpose_and_actual_destination(
    tmp_path, monkeypatch, purpose
):
    monkeypatch.setattr(storage.sys, "platform", "darwin")
    raw = Mock(side_effect=AssertionError("raw-free fallback"))
    monkeypatch.setattr(storage.shutil, "disk_usage", raw)
    destination = tmp_path / 'quotes " $() and newline\n'
    destination.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(destination, target_is_directory=True)
    query = Mock(return_value=SimpleNamespace(stdout=json.dumps(APPLE)))
    monkeypatch.setattr(storage.subprocess, "run", query)

    result = storage.read_storage_capacity(alias, purpose=purpose)

    assert result.available_bytes == int(APPLE[f"{purpose}Bytes"])
    assert result.free_bytes == 0
    assert result.source == f"macos-{purpose}-usage"
    assert result.destination_path == str(destination.resolve())
    args, kwargs = query.call_args
    assert args[0][:4] == ["/usr/bin/osascript", "-l", "JavaScript", "-e"]
    assert json.dumps(str(destination.resolve())) in args[0][4]
    usage_key_kind = "Important" if purpose == "important" else "Opportunistic"
    assert re.findall(r"\$\.NSURLVolume\w+Key", args[0][4]) == [
        "$.NSURLVolumeTotalCapacityKey",
        "$.NSURLVolumeAvailableCapacityKey",
        f"$.NSURLVolumeAvailableCapacityFor{usage_key_kind}UsageKey",
    ]
    assert kwargs["timeout"] == 10
    assert kwargs.get("shell", False) is False
    raw.assert_not_called()


@pytest.mark.parametrize(
    "value", [None, "-1", "1.5", True, "9007199254740992", "3996329328641"]
)
def test_invalid_apple_capacity_is_unknown_without_raw_fallback(
    tmp_path, monkeypatch, value
):
    monkeypatch.setattr(storage.sys, "platform", "darwin")
    raw = Mock(side_effect=AssertionError("raw-free fallback"))
    monkeypatch.setattr(storage.shutil, "disk_usage", raw)
    monkeypatch.setattr(
        storage.subprocess,
        "run",
        Mock(
            return_value=SimpleNamespace(
                stdout=json.dumps({**APPLE, "importantBytes": value})
            )
        ),
    )
    with pytest.raises(storage.StorageCapacityUnknown, match="capacity is unknown"):
        storage.read_storage_capacity(tmp_path)
    raw.assert_not_called()


def test_unavailable_apple_query_is_unknown_without_raw_fallback(tmp_path, monkeypatch):
    monkeypatch.setattr(storage.sys, "platform", "darwin")
    raw = Mock(side_effect=AssertionError("raw-free fallback"))
    monkeypatch.setattr(storage.shutil, "disk_usage", raw)
    monkeypatch.setattr(
        storage.subprocess, "run", Mock(side_effect=OSError("unavailable"))
    )
    with pytest.raises(storage.StorageCapacityUnknown, match="capacity is unknown"):
        storage.read_storage_capacity(tmp_path)
    raw.assert_not_called()


def test_non_macos_uses_filesystem_capacity(tmp_path, monkeypatch):
    monkeypatch.setattr(storage.sys, "platform", "linux")
    monkeypatch.setattr(
        storage.shutil, "disk_usage", lambda _: SimpleNamespace(free=200, total=1000)
    )
    result = storage.read_storage_capacity(tmp_path)
    assert result.available_bytes == 200
    assert result.source == "filesystem-available"


def test_real_local_destination(tmp_path):
    try:
        result = storage.read_storage_capacity(tmp_path)
    except storage.StorageCapacityUnknown as exc:
        assert storage.sys.platform == "darwin"
        assert isinstance(exc.__cause__, subprocess.TimeoutExpired)
        return
    assert result.destination_path == str(tmp_path.resolve())
    assert result.available_bytes >= 0
    assert result.source == (
        "macos-important-usage"
        if storage.sys.platform == "darwin"
        else "filesystem-available"
    )
