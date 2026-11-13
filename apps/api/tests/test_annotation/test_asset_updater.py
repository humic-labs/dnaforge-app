"""Generic versioned-asset updater .

The transactional download→verify→swap→validate→record machinery is asset-
agnostic. These tests drive it with a SYNTHETIC asset (no Rfam knowledge) to prove
the substrate itself; the Rfam wiring is proven in test_rfam_autoupdate.py.
"""

import hashlib
import io
import json
import logging
import os
import subprocess
import tarfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

import src.annotation.asset_updater as au
from src.annotation.asset_updater import (
    AssetUpdateInProgressError,
    AssetValidationError,
    VersionedAssetSpec,
    asset_needs_update,
    download_and_swap_asset,
    ensure_asset_current,
    fetch_asset,
    get_asset_version,
    record_validation_failure,
    verify_sha256,
)
from src.storage_capacity import StorageCapacity, StorageCapacityUnknown

FILES = ["a.dat", "b.dat", "c.dat"]


@pytest.fixture(autouse=True)
def deterministic_capacity(monkeypatch):
    monkeypatch.setattr(
        au,
        "read_storage_capacity",
        lambda path, *, purpose: StorageCapacity(
            str(path),
            48239351818,
            0,
            3996329328640,
            "macos-opportunistic-usage",
            purpose,
        ),
    )


def make_spec(**overrides) -> VersionedAssetSpec:
    base = {
        "asset_id": "demo",
        "target_version": "2.0",
        "url": "https://example.test/demo-2.0.tar.gz",
        "sha256": "0" * 64,
        "files": FILES,
        "install_subdir": "db",
        "version_filename": "demo-version.json",
        "version_key": "version",
        "bundled_version": "1.0",
        "presence_probe": "db/a.dat",
        "min_free_bytes": 0,
    }
    base.update(overrides)
    return VersionedAssetSpec(**base)


def seed_installed(data_dir: Path, content: str = "OLD-1.0") -> None:
    """A bundled (v1.0) asset present on disk, no version marker."""
    install = data_dir / "db"
    install.mkdir(parents=True, exist_ok=True)
    for f in FILES:
        (install / f).write_text(content)


def fake_fetch_factory(content: str = "NEW-2.0", drop_last: bool = False):
    def _fetch(spec: VersionedAssetSpec, staging: Path) -> None:
        names = FILES[:-1] if drop_last else FILES
        for f in names:
            (staging / f).write_text(content)

    return _fetch


class TestVersionResolution:
    def test_bundled_asset_without_marker_reports_bundled_version(self, tmp_path):
        seed_installed(tmp_path)
        assert get_asset_version(make_spec(), tmp_path) == "1.0"

    def test_recorded_marker_wins(self, tmp_path):
        seed_installed(tmp_path)
        (tmp_path / "demo-version.json").write_text(json.dumps({"version": "2.0"}))
        assert get_asset_version(make_spec(), tmp_path) == "2.0"

    def test_absent_asset_is_none(self, tmp_path):
        assert get_asset_version(make_spec(), tmp_path) is None

    def test_corrupt_marker_falls_back_to_on_disk(self, tmp_path):
        seed_installed(tmp_path)
        (tmp_path / "demo-version.json").write_text("{ not json")
        assert get_asset_version(make_spec(), tmp_path) == "1.0"

    def test_non_dict_or_missing_key_marker_falls_back_to_on_disk(self, tmp_path):
        for payload in ('["x"]', '{"other": "9.9"}', '{"version": ""}'):
            seed_installed(tmp_path)
            (tmp_path / "demo-version.json").write_text(payload)
            assert get_asset_version(make_spec(), tmp_path) == "1.0", payload

    def test_needs_update_true_when_older(self, tmp_path):
        seed_installed(tmp_path)
        assert asset_needs_update(make_spec(), tmp_path) is True

    def test_needs_update_false_when_current(self, tmp_path):
        seed_installed(tmp_path)
        (tmp_path / "demo-version.json").write_text(json.dumps({"version": "2.0"}))
        assert asset_needs_update(make_spec(), tmp_path) is False

    def test_needs_update_false_when_absent(self, tmp_path):
        assert asset_needs_update(make_spec(), tmp_path) is False


class TestIntegrity:
    def test_verify_sha256_matches_and_mismatches(self, tmp_path):
        blob = tmp_path / "x"
        blob.write_bytes(b"hello")
        verify_sha256(blob, hashlib.sha256(b"hello").hexdigest())
        with pytest.raises(RuntimeError, match="checksum"):
            verify_sha256(blob, "0" * 64)


class TestFetch:
    def _write_tar(self, path: Path) -> None:
        with tarfile.open(path, "w:gz") as t:
            for name in FILES:
                data = ("content-" + name).encode()
                info = tarfile.TarInfo(name)
                info.size = len(data)
                t.addfile(info, io.BytesIO(data))

    def test_curl_bounded_https_only(self, tmp_path, monkeypatch):
        seen = {}

        def fake_run(args, **kw):
            seen["args"] = args
            seen["timeout"] = kw.get("timeout")
            return subprocess.CompletedProcess(
                args, returncode=1, stdout="", stderr="x"
            )

        monkeypatch.setattr(au.subprocess, "run", fake_run)
        with pytest.raises(RuntimeError, match="download failed"):
            fetch_asset(make_spec(download_timeout_s=123, max_filesize="7M"), tmp_path)
        assert "--max-filesize" in seen["args"] and "7M" in seen["args"]
        assert "--proto" in seen["args"] and "=https" in seen["args"]
        assert seen["timeout"] == 123

    def test_checksum_verified_before_extraction(self, tmp_path, monkeypatch):
        def fake_run(args, **kw):
            self._write_tar(Path(args[args.index("-o") + 1]))
            return subprocess.CompletedProcess(args, returncode=0, stdout="", stderr="")

        monkeypatch.setattr(au.subprocess, "run", fake_run)
        extracted = {"called": False}
        real_open = tarfile.open

        def spy_open(*a, **k):
            mode = a[1] if len(a) > 1 else k.get("mode", "r")
            if "r" in mode:
                extracted["called"] = True
            return real_open(*a, **k)

        monkeypatch.setattr(au.tarfile, "open", spy_open)
        with pytest.raises(RuntimeError, match="checksum"):
            fetch_asset(make_spec(), tmp_path)
        assert extracted["called"] is False

    def test_success_extracts_then_removes_tarball(self, tmp_path, monkeypatch):
        def fake_run(args, **kw):
            self._write_tar(Path(args[args.index("-o") + 1]))
            return subprocess.CompletedProcess(args, returncode=0, stdout="", stderr="")

        monkeypatch.setattr(au.subprocess, "run", fake_run)
        monkeypatch.setattr(au, "verify_sha256", lambda p, e: None)
        fetch_asset(make_spec(), tmp_path)
        for name in FILES:
            assert (tmp_path / name).read_text() == "content-" + name
        assert not (tmp_path / "demo.tar.gz").exists()


class TestSwap:
    def test_swaps_files_and_records_version(self, tmp_path):
        seed_installed(tmp_path)
        download_and_swap_asset(make_spec(), tmp_path, _fetch=fake_fetch_factory())
        install = tmp_path / "db"
        for f in FILES:
            assert (install / f).read_text() == "NEW-2.0"
        recorded = json.loads((tmp_path / "demo-version.json").read_text())
        assert recorded["version"] == "2.0"

    def test_missing_file_aborts_without_corrupting_or_recording(self, tmp_path):
        seed_installed(tmp_path)
        with pytest.raises(RuntimeError, match="missing|incomplete"):
            download_and_swap_asset(
                make_spec(), tmp_path, _fetch=fake_fetch_factory(drop_last=True)
            )
        assert (tmp_path / "db" / FILES[0]).read_text() == "OLD-1.0"
        assert not (tmp_path / "demo-version.json").exists()

    def test_partial_swap_rolls_back_and_self_heals(self, tmp_path, monkeypatch):
        seed_installed(tmp_path)
        install = tmp_path / "db"
        real_replace = os.replace
        installs = {"n": 0}

        def flaky_replace(src, dst):
            if str(dst).startswith(str(install)):
                installs["n"] += 1
                if installs["n"] == 3:
                    raise OSError("simulated crash mid-swap")
            return real_replace(src, dst)

        monkeypatch.setattr(au.os, "replace", flaky_replace)
        with pytest.raises(OSError, match="mid-swap"):
            download_and_swap_asset(make_spec(), tmp_path, _fetch=fake_fetch_factory())

        for f in FILES:
            assert (install / f).read_text() == "OLD-1.0", f"{f} not rolled back"
        assert not (tmp_path / "demo-version.json").exists()
        assert not list(tmp_path.glob(".demo-rollback-*"))

        monkeypatch.setattr(au.os, "replace", real_replace)
        download_and_swap_asset(make_spec(), tmp_path, _fetch=fake_fetch_factory())
        for f in FILES:
            assert (install / f).read_text() == "NEW-2.0"
        assert (
            json.loads((tmp_path / "demo-version.json").read_text())["version"] == "2.0"
        )

    def test_orphan_rollback_dir_is_reclaimed(self, tmp_path):
        seed_installed(tmp_path)
        orphan = tmp_path / ".demo-rollback-STALE"
        orphan.mkdir()
        (orphan / "junk").write_text("leftover from a prior crash")
        download_and_swap_asset(make_spec(), tmp_path, _fetch=fake_fetch_factory())
        assert not list(tmp_path.glob(".demo-rollback-*"))

    def test_background_update_uses_opportunistic_capacity_with_zero_raw_free(
        self, tmp_path, monkeypatch
    ):
        seed_installed(tmp_path)
        calls = []

        def capacity(path, *, purpose):
            calls.append((path, purpose))
            return StorageCapacity(
                str(path),
                48239351818,
                0,
                3996329328640,
                "macos-opportunistic-usage",
                purpose,
            )

        monkeypatch.setattr(au, "read_storage_capacity", capacity)
        download_and_swap_asset(
            make_spec(min_free_bytes=1024**3), tmp_path, _fetch=fake_fetch_factory()
        )
        assert calls == [(tmp_path, "opportunistic")]
        assert (tmp_path / "db" / FILES[0]).read_text() == "NEW-2.0"

    def test_unknown_capacity_does_not_fetch_or_modify_the_installed_asset(
        self, tmp_path, monkeypatch
    ):
        seed_installed(tmp_path)
        unknown = StorageCapacityUnknown("Available storage capacity is unknown.")

        def capacity(*args, **kwargs):
            raise unknown

        monkeypatch.setattr(au, "read_storage_capacity", capacity)
        fetch = AsyncMock()
        with pytest.raises(StorageCapacityUnknown):
            download_and_swap_asset(make_spec(), tmp_path, _fetch=fetch)
        fetch.assert_not_called()
        assert (tmp_path / "db" / FILES[0]).read_text() == "OLD-1.0"

    def test_insufficient_disk_aborts_before_touching_the_asset(self, tmp_path):
        seed_installed(tmp_path)
        with pytest.raises(RuntimeError, match="Insufficient disk"):
            download_and_swap_asset(
                make_spec(min_free_bytes=1 << 62),
                tmp_path,
                _fetch=fake_fetch_factory(),
            )
        assert (tmp_path / "db" / FILES[0]).read_text() == "OLD-1.0"


class TestValidateProbe:
    """Q2 — post-install functional probe with self-healing rollback."""

    def test_failed_validation_rolls_back_and_does_not_record(self, tmp_path):
        seed_installed(tmp_path)

        def bad_probe(install_dir: Path) -> None:
            raise RuntimeError("asset does not load on this platform")

        with pytest.raises(AssetValidationError, match="validation failed"):
            download_and_swap_asset(
                make_spec(validate=bad_probe),
                tmp_path,
                _fetch=fake_fetch_factory(),
            )
        for f in FILES:
            assert (tmp_path / "db" / f).read_text() == "OLD-1.0"
        assert not (tmp_path / "demo-version.json").exists()
        assert not list(tmp_path.glob(".demo-rollback-*"))

    def test_probe_sees_installed_files_and_success_records_version(self, tmp_path):
        seed_installed(tmp_path)
        saw = {}

        def good_probe(install_dir: Path) -> None:
            saw["content"] = (install_dir / FILES[0]).read_text()

        download_and_swap_asset(
            make_spec(validate=good_probe), tmp_path, _fetch=fake_fetch_factory()
        )
        assert saw["content"] == "NEW-2.0"
        assert (
            json.loads((tmp_path / "demo-version.json").read_text())["version"] == "2.0"
        )


class TestEnsureAssetCurrent:
    @pytest.mark.asyncio
    async def test_skips_when_absent(self, tmp_path):
        with patch.object(au, "download_and_swap_asset") as swap:
            await ensure_asset_current(make_spec(), tmp_path)
            swap.assert_not_called()

    @pytest.mark.asyncio
    async def test_skips_when_current(self, tmp_path):
        seed_installed(tmp_path)
        (tmp_path / "demo-version.json").write_text(json.dumps({"version": "2.0"}))
        with patch.object(au, "download_and_swap_asset") as swap:
            await ensure_asset_current(make_spec(), tmp_path)
            swap.assert_not_called()

    @pytest.mark.asyncio
    async def test_updates_when_stale(self, tmp_path):
        seed_installed(tmp_path)
        with patch.object(au, "download_and_swap_asset") as swap:
            await ensure_asset_current(make_spec(), tmp_path)
            swap.assert_called_once()

    @pytest.mark.asyncio
    async def test_never_raises_retries_and_reports_transient_failure(
        self, tmp_path, caplog
    ):
        seed_installed(tmp_path)
        spec = make_spec(max_attempts=3)
        with (
            patch.object(
                au, "download_and_swap_asset", side_effect=RuntimeError("boom")
            ) as swap,
            patch.object(au.asyncio, "sleep", new_callable=AsyncMock),
            caplog.at_level(logging.ERROR, logger="src.annotation.asset_updater"),
        ):
            await ensure_asset_current(spec, tmp_path)
        assert swap.call_count == 3
        assert any(r.levelno >= logging.ERROR for r in caplog.records)

    @pytest.mark.asyncio
    async def test_validation_failure_is_terminal_no_retry(self, tmp_path, caplog):
        seed_installed(tmp_path)
        spec = make_spec(max_attempts=3)
        with (
            patch.object(
                au,
                "download_and_swap_asset",
                side_effect=AssetValidationError("won't load here"),
            ) as swap,
            patch.object(au.asyncio, "sleep", new_callable=AsyncMock) as sleep,
            caplog.at_level(logging.ERROR, logger="src.annotation.asset_updater"),
        ):
            await ensure_asset_current(spec, tmp_path)
        assert swap.call_count == 1
        sleep.assert_not_called()
        assert any(
            "validation" in r.getMessage().lower()
            for r in caplog.records
            if r.levelno >= logging.ERROR
        )

    @pytest.mark.asyncio
    async def test_reentrancy_guard_is_per_asset(self, tmp_path):
        seed_installed(tmp_path)
        au._in_flight.add("demo")
        try:
            with patch.object(au, "download_and_swap_asset") as swap:
                await ensure_asset_current(make_spec(asset_id="demo"), tmp_path)
                swap.assert_not_called()
        finally:
            au._in_flight.discard("demo")
        assert au.is_updating("demo") is False


class TestCrashRecoveryAndConcurrency:
    """ review P1: orphan-rollback reclaim must never delete the last copy,
    and swaps must serialize across processes on the installation-global data dir."""

    def test_orphan_reclaim_restores_a_stranded_file(self, tmp_path):
        install = tmp_path / "db"
        install.mkdir(parents=True)
        (install / "b.dat").write_text("kept")
        orphan = tmp_path / ".demo-rollback-CRASHED"
        orphan.mkdir()
        (orphan / "a.dat").write_text("stranded-old")
        (orphan / "b.dat").write_text("stale")
        (orphan / "junk").write_text("not ours")

        au._reclaim_orphan_rollbacks(tmp_path, make_spec(), install)

        assert (install / "a.dat").read_text() == "stranded-old"
        assert (install / "b.dat").read_text() == "kept"
        assert not (install / "junk").exists()
        assert not orphan.exists()

    def test_swap_skips_when_a_peer_holds_the_lock(self, tmp_path):
        seed_installed(tmp_path)
        (tmp_path / ".demo.swap-lock").mkdir()
        with pytest.raises(AssetUpdateInProgressError):
            download_and_swap_asset(make_spec(), tmp_path, _fetch=fake_fetch_factory())
        assert (tmp_path / ".demo.swap-lock").exists()
        assert (tmp_path / "db" / "a.dat").read_text() == "OLD-1.0"

    def test_stale_lock_is_reclaimed(self, tmp_path, monkeypatch):
        seed_installed(tmp_path)
        lock = tmp_path / ".demo.swap-lock"
        lock.mkdir()
        monkeypatch.setattr(au, "_SWAP_LOCK_STALE_S", -1)
        download_and_swap_asset(make_spec(), tmp_path, _fetch=fake_fetch_factory())
        assert (tmp_path / "db" / "a.dat").read_text() == "NEW-2.0"
        assert not lock.exists()

    @pytest.mark.asyncio
    async def test_ensure_skips_cleanly_on_peer_lock(self, tmp_path, caplog):
        seed_installed(tmp_path)
        spec = make_spec()
        with patch.object(
            au,
            "download_and_swap_asset",
            side_effect=AssetUpdateInProgressError("peer"),
        ):
            with caplog.at_level(logging.ERROR, logger="src.annotation.asset_updater"):
                await ensure_asset_current(spec, tmp_path)
        assert not [r for r in caplog.records if r.levelno >= logging.ERROR]


class TestValidationFailurePersistence:
    """ review P2: a platform-incompatible asset must not re-download +
    re-fail on every launch — the failure is remembered until the target changes."""

    def test_failed_target_short_circuits_needs_update(self, tmp_path):
        seed_installed(tmp_path)
        spec = make_spec()
        assert asset_needs_update(spec, tmp_path) is True
        record_validation_failure(tmp_path, spec)
        assert asset_needs_update(spec, tmp_path) is False

    def test_a_newer_target_ignores_the_old_failure(self, tmp_path):
        seed_installed(tmp_path)
        record_validation_failure(tmp_path, make_spec(target_version="2.0"))
        assert asset_needs_update(make_spec(target_version="3.0"), tmp_path) is True

    def test_validator_revision_change_retries_a_rejected_target(self, tmp_path):
        seed_installed(tmp_path)
        record_validation_failure(
            tmp_path, make_spec(validation_revision="old-validator")
        )

        fixed = make_spec(validation_revision="windows-native-press-v1")

        assert asset_needs_update(fixed, tmp_path) is True

    def test_ensure_records_failure_and_then_stops_downloading(self, tmp_path):
        seed_installed(tmp_path)

        def failing_probe(_install_dir):
            raise RuntimeError("won't load on this platform")

        spec = make_spec(validate=failing_probe)
        import asyncio

        with patch.object(au, "fetch_asset", fake_fetch_factory()):
            asyncio.run(ensure_asset_current(spec, tmp_path))
        assert au._validation_failed_version(tmp_path, spec) == "2.0"
        assert (tmp_path / "db" / "a.dat").read_text() == "OLD-1.0"
        assert asset_needs_update(spec, tmp_path) is False

    def test_success_clears_a_prior_failure_marker(self, tmp_path):
        seed_installed(tmp_path)
        spec = make_spec()
        record_validation_failure(tmp_path, spec)
        download_and_swap_asset(spec, tmp_path, _fetch=fake_fetch_factory())
        assert au._validation_failed_version(tmp_path, spec) is None
