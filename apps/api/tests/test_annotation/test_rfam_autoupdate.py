""" — robust background Rfam auto-update.

The app keeps the Rfam ncRNA database current on its own: on startup it checks the
installed Rfam version against the target we host, and if stale downloads the
pre-pressed asset in the background, validates it, and atomically swaps it into
place. It never blocks startup, never raises, keeps the working DB serving on
failure, retries with backoff, and reports failures via structured logging (the
Electron host funnels sidecar stderr to Sentry/PostHog — ; the sidecar
must NOT init Sentry itself). No user-facing UI in v1.
"""

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
from src.storage_capacity import StorageCapacity


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


RFAM_ASSET_FILES = [
    "Rfam.cm",
    "Rfam.cm.i1f",
    "Rfam.cm.i1i",
    "Rfam.cm.i1m",
    "Rfam.cm.i1p",
    "Rfam.clanin",
]


def _seed_bundle_rfam(data_dir: Path) -> None:
    """Simulate the pLannotate-bundle Rfam (14.5) present, no rfam-version.json."""
    blast = data_dir / "BLAST_dbs"
    blast.mkdir(parents=True, exist_ok=True)
    for f in RFAM_ASSET_FILES:
        (blast / f).write_text("OLD-14.5")


class TestRfamVersion:
    def test_bundled_rfam_without_version_file_reports_bundled_version(self, tmp_path):
        from src.annotation.setup import BUNDLED_RFAM_VERSION, get_rfam_version

        _seed_bundle_rfam(tmp_path)
        assert get_rfam_version(tmp_path) == BUNDLED_RFAM_VERSION

    def test_recorded_version_wins(self, tmp_path):
        from src.annotation.setup import RFAM_VERSION_FILE, get_rfam_version

        _seed_bundle_rfam(tmp_path)
        (tmp_path / RFAM_VERSION_FILE).write_text(json.dumps({"rfam_version": "15.1"}))
        assert get_rfam_version(tmp_path) == "15.1"

    def test_no_rfam_present_is_none(self, tmp_path):
        from src.annotation.setup import get_rfam_version

        assert get_rfam_version(tmp_path) is None

    def test_needs_update_when_bundled_older_than_target(self, tmp_path):
        from src.annotation.setup import (
            BUNDLED_RFAM_VERSION,
            RFAM_VERSION,
            rfam_needs_update,
        )

        assert BUNDLED_RFAM_VERSION != RFAM_VERSION
        _seed_bundle_rfam(tmp_path)
        assert rfam_needs_update(tmp_path) is True

    def test_no_update_when_current(self, tmp_path):
        from src.annotation.setup import (
            RFAM_VERSION,
            RFAM_VERSION_FILE,
            rfam_needs_update,
        )

        _seed_bundle_rfam(tmp_path)
        (tmp_path / RFAM_VERSION_FILE).write_text(
            json.dumps({"rfam_version": RFAM_VERSION})
        )
        assert rfam_needs_update(tmp_path) is False


class TestDownloadAndSwap:
    @pytest.fixture(autouse=True)
    def _ample_disk(self, monkeypatch):
        import src.annotation.setup as setup

        monkeypatch.setattr(setup, "RFAM_MIN_FREE_BYTES", 0)
        monkeypatch.setattr(setup, "_validate_rfam_loads", lambda _install_dir: None)

    def test_swaps_files_and_records_version(self, tmp_path):
        from src.annotation.setup import (
            RFAM_VERSION,
            RFAM_VERSION_FILE,
            _download_and_swap_rfam,
        )

        _seed_bundle_rfam(tmp_path)

        def fake_fetch(staging: Path) -> None:
            for f in RFAM_ASSET_FILES:
                (staging / f).write_text("NEW-15.1")

        _download_and_swap_rfam(tmp_path, _fetch=fake_fetch)
        blast = tmp_path / "BLAST_dbs"
        for f in RFAM_ASSET_FILES:
            assert (blast / f).read_text() == "NEW-15.1"
        recorded = json.loads((tmp_path / RFAM_VERSION_FILE).read_text())
        assert recorded["rfam_version"] == RFAM_VERSION

    def test_missing_file_aborts_without_corrupting_or_recording(self, tmp_path):
        from src.annotation.setup import RFAM_VERSION_FILE, _download_and_swap_rfam

        _seed_bundle_rfam(tmp_path)

        def bad_fetch(staging: Path) -> None:
            for f in RFAM_ASSET_FILES[:-1]:
                (staging / f).write_text("NEW-15.1")

        with pytest.raises(RuntimeError, match="missing|incomplete"):
            _download_and_swap_rfam(tmp_path, _fetch=bad_fetch)
        assert (tmp_path / "BLAST_dbs" / RFAM_ASSET_FILES[0]).read_text() == "OLD-14.5"
        assert not (tmp_path / RFAM_VERSION_FILE).exists()

    def test_partial_swap_rolls_back_and_self_heals(self, tmp_path, monkeypatch):
        """A failure MID the os.replace loop must ROLL BACK to the old set — never
        leave a mixed new-.cm/old-index DB — not record the version, leave no
        orphan rollback dir, and self-heal on the next good run."""
        from src.annotation.setup import (
            RFAM_VERSION,
            RFAM_VERSION_FILE,
            _download_and_swap_rfam,
        )

        _seed_bundle_rfam(tmp_path)
        blast = tmp_path / "BLAST_dbs"

        def fake_fetch(staging: Path) -> None:
            for f in RFAM_ASSET_FILES:
                (staging / f).write_text("NEW-15.1")

        real_replace = os.replace
        installs = {"n": 0}

        def flaky_replace(src, dst):
            if str(dst).startswith(str(blast)):
                installs["n"] += 1
                if installs["n"] == 4:
                    raise OSError("simulated crash mid-swap")
            return real_replace(src, dst)

        monkeypatch.setattr(au.os, "replace", flaky_replace)
        with pytest.raises(OSError, match="mid-swap"):
            _download_and_swap_rfam(tmp_path, _fetch=fake_fetch)

        for f in RFAM_ASSET_FILES:
            assert (blast / f).read_text() == "OLD-14.5", f"{f} not rolled back"
        assert not (tmp_path / RFAM_VERSION_FILE).exists()
        assert not list(tmp_path.glob(".rfam-rollback-*"))

        monkeypatch.setattr(au.os, "replace", real_replace)
        _download_and_swap_rfam(tmp_path, _fetch=fake_fetch)
        for f in RFAM_ASSET_FILES:
            assert (blast / f).read_text() == "NEW-15.1"
        assert (
            json.loads((tmp_path / RFAM_VERSION_FILE).read_text())["rfam_version"]
            == RFAM_VERSION
        )


class TestFetchRfamAsset:
    """The REAL network fetch path (curl bounds, sha256-before-extract, cleanup)."""

    def _write_tar(self, path: Path) -> None:
        with tarfile.open(path, "w:gz") as t:
            for name in RFAM_ASSET_FILES:
                data = ("content-" + name).encode()
                info = tarfile.TarInfo(name)
                info.size = len(data)
                t.addfile(info, io.BytesIO(data))

    def test_curl_is_bounded_and_https_only(self, tmp_path, monkeypatch):
        import src.annotation.setup as setup

        seen = {}

        def fake_run(args, **kw):
            seen["args"] = args
            seen["timeout"] = kw.get("timeout")
            return subprocess.CompletedProcess(
                args, returncode=1, stdout="", stderr="x"
            )

        monkeypatch.setattr(au.subprocess, "run", fake_run)
        with pytest.raises(RuntimeError, match="download failed"):
            setup._fetch_rfam_asset(tmp_path)
        assert "--max-filesize" in seen["args"] and "200M" in seen["args"]
        assert "--proto" in seen["args"] and "=https" in seen["args"]
        assert seen["timeout"] == setup.RFAM_DOWNLOAD_TIMEOUT_S

    def test_checksum_is_verified_before_extraction(self, tmp_path, monkeypatch):
        import src.annotation.setup as setup

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
            setup._fetch_rfam_asset(tmp_path)
        assert extracted["called"] is False

    def test_success_extracts_then_removes_tarball(self, tmp_path, monkeypatch):
        import src.annotation.setup as setup

        def fake_run(args, **kw):
            self._write_tar(Path(args[args.index("-o") + 1]))
            return subprocess.CompletedProcess(args, returncode=0, stdout="", stderr="")

        monkeypatch.setattr(au.subprocess, "run", fake_run)
        monkeypatch.setattr(au, "verify_sha256", lambda p, e: None)
        setup._fetch_rfam_asset(tmp_path)
        for name in RFAM_ASSET_FILES:
            assert (tmp_path / name).read_text() == "content-" + name
        assert not (tmp_path / "rfam.tar.gz").exists()


class TestBundleReinstallClearsRfamMarker:
    """ (silent-downgrade fix): a bundle (re)install lays Rfam 14.5, so it
    must drop rfam-version.json — else the updater trusts a stale 15.1 marker and
    the app silently serves 14.5."""

    def test_download_databases_clears_stale_rfam_marker(self, tmp_path, monkeypatch):
        import src.annotation.setup as setup
        from src.annotation.setup import RFAM_VERSION_FILE, download_databases

        (tmp_path / RFAM_VERSION_FILE).write_text(json.dumps({"rfam_version": "15.1"}))

        def fake_run(args, **kw):
            if "-o" in args:
                Path(args[args.index("-o") + 1]).write_bytes(b"bundle")
            return subprocess.CompletedProcess(args, returncode=0, stdout="", stderr="")

        monkeypatch.setattr(setup.subprocess, "run", fake_run)
        monkeypatch.setattr(setup.tarfile, "open", lambda *a, **k: _BundleTar())
        for expected in setup.EXPECTED_DB_FILES:
            p = tmp_path / expected
            p.parent.mkdir(parents=True, exist_ok=True)
            p.touch()

        result = download_databases(tmp_path)
        assert result["success"] is True
        assert not (tmp_path / RFAM_VERSION_FILE).exists()
        assert setup.get_rfam_version(tmp_path) == setup.BUNDLED_RFAM_VERSION

    def test_record_bundle_version_writes_version_and_drops_marker(self, tmp_path):
        """ review: the coupled 'write version.json + drop rfam marker' now
        lives in ONE helper called by both install paths, so it can't diverge."""
        import src.annotation.setup as setup
        from src.annotation.setup import RFAM_VERSION_FILE

        (tmp_path / RFAM_VERSION_FILE).write_text(json.dumps({"rfam_version": "15.1"}))
        setup._record_bundle_version(tmp_path)
        assert json.loads((tmp_path / "version.json").read_text())["version"] == (
            setup.ANNOTATION_VERSION
        )
        assert not (tmp_path / RFAM_VERSION_FILE).exists()

    @pytest.mark.asyncio
    async def test_STREAM_download_also_clears_stale_rfam_marker(
        self, tmp_path, monkeypatch
    ):
        """The SSE streaming install path is the sibling of download_databases; it
        must clear the marker too (the review flagged this path as untested — a
        regression here would silently downgrade Rfam 15.1 → 14.5 on the live path)."""
        import src.annotation.setup as setup
        from src.annotation.setup import RFAM_VERSION_FILE, download_databases_stream

        (tmp_path / RFAM_VERSION_FILE).write_text(json.dumps({"rfam_version": "15.1"}))

        def fake_run(args, **kw):
            if "-o" in args:
                Path(args[args.index("-o") + 1]).write_bytes(b"x")
            return subprocess.CompletedProcess(args, returncode=0, stdout="", stderr="")

        monkeypatch.setattr(setup.subprocess, "run", fake_run)
        monkeypatch.setattr(setup.tarfile, "open", lambda *a, **k: _BundleTar())
        for expected in setup.EXPECTED_DB_FILES:
            if expected == "swissprot.csv.gz":
                continue
            p = tmp_path / expected
            p.parent.mkdir(parents=True, exist_ok=True)
            p.touch()

        events = [e async for e in download_databases_stream(tmp_path)]
        assert any(e.get("event") == "complete" for e in events), events
        assert not (tmp_path / RFAM_VERSION_FILE).exists()
        assert setup.get_rfam_version(tmp_path) == setup.BUNDLED_RFAM_VERSION


class _BundleTar:
    """Minimal complete bundle extracted into the installer's staging directory."""

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def extractall(self, path, **_kwargs):
        from src.annotation.setup import EXPECTED_DB_FILES

        for relative in EXPECTED_DB_FILES:
            if relative == "swissprot.csv.gz":
                continue
            target = Path(path) / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"database")


class TestIntegrity:
    def test_verify_sha256_passes_on_match_and_raises_on_mismatch(self, tmp_path):
        import hashlib

        from src.annotation.setup import _verify_sha256

        blob = tmp_path / "asset.tar.gz"
        blob.write_bytes(b"hello rfam")
        good = hashlib.sha256(b"hello rfam").hexdigest()

        _verify_sha256(blob, good)
        with pytest.raises(RuntimeError, match="checksum"):
            _verify_sha256(blob, "0" * 64)

    def test_asset_checksum_constant_is_a_sha256(self):
        from src.annotation.setup import RFAM_SHA256

        assert isinstance(RFAM_SHA256, str)
        assert len(RFAM_SHA256) == 64
        int(RFAM_SHA256, 16)


class TestRfamValidateProbe:
    """Q2 — the Rfam post-install load probe. A real cmscan load-test that fails
    OPEN when it can't run (binary absent / timeout) and CLOSED only on a
    definitive cmscan load failure."""

    def _install(self, tmp_path):
        install = tmp_path / "BLAST_dbs"
        install.mkdir(parents=True, exist_ok=True)
        (install / "Rfam.cm").write_text("cm")
        (install / "Rfam.clanin").write_text("clanin")
        return install

    def test_skips_when_cmscan_missing(self, tmp_path, monkeypatch):
        import src.annotation.setup as setup
        import src.services.plannotate as plannotate

        install = self._install(tmp_path)
        monkeypatch.setattr(plannotate, "find_binaries_dir", lambda: None)
        monkeypatch.setattr(plannotate, "get_binary_path", lambda *a, **k: None)
        monkeypatch.setattr(setup.shutil, "which", lambda *a, **k: None)
        ran = {"called": False}

        def fake_run(*a, **k):
            ran["called"] = True

        monkeypatch.setattr(setup.subprocess, "run", fake_run)
        setup._validate_rfam_loads(install)
        assert ran["called"] is False

    def test_raises_on_definitive_load_failure(self, tmp_path, monkeypatch):
        import src.annotation.setup as setup
        import src.services.plannotate as plannotate

        install = self._install(tmp_path)
        monkeypatch.setattr(plannotate, "find_binaries_dir", lambda: tmp_path)
        monkeypatch.setattr(plannotate, "get_binary_path", lambda *a, **k: "/x/cmscan")
        monkeypatch.setattr(
            setup.subprocess,
            "run",
            lambda *a, **k: subprocess.CompletedProcess(
                a, returncode=1, stdout="", stderr="bad index file"
            ),
        )
        with pytest.raises(RuntimeError, match="could not load"):
            setup._validate_rfam_loads(install)

    def test_proceeds_on_timeout(self, tmp_path, monkeypatch):
        import src.annotation.setup as setup
        import src.services.plannotate as plannotate

        install = self._install(tmp_path)
        monkeypatch.setattr(plannotate, "find_binaries_dir", lambda: tmp_path)
        monkeypatch.setattr(plannotate, "get_binary_path", lambda *a, **k: "/x/cmscan")

        def timeout_run(*a, **k):
            raise subprocess.TimeoutExpired(cmd="cmscan", timeout=1)

        monkeypatch.setattr(setup.subprocess, "run", timeout_run)
        setup._validate_rfam_loads(install)

    def test_passes_on_exit_zero(self, tmp_path, monkeypatch):
        import src.annotation.setup as setup
        import src.services.plannotate as plannotate

        install = self._install(tmp_path)
        monkeypatch.setattr(plannotate, "find_binaries_dir", lambda: tmp_path)
        monkeypatch.setattr(plannotate, "get_binary_path", lambda *a, **k: "/x/cmscan")
        monkeypatch.setattr(
            setup.subprocess,
            "run",
            lambda *a, **k: subprocess.CompletedProcess(
                a, returncode=0, stdout="", stderr=""
            ),
        )
        setup._validate_rfam_loads(install)

    def test_windows_represses_before_cmscan_validation(self, tmp_path, monkeypatch):
        """Windows must not consume binary indexes pressed on another platform."""
        import src.annotation.setup as setup

        install = self._install(tmp_path)
        calls = []

        monkeypatch.setattr(setup, "_is_windows", lambda: True)
        monkeypatch.setattr(
            setup,
            "_infernal_binary",
            lambda name: f"C:/DNAForge/{name}.exe",
        )

        def fake_run(args, **kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, returncode=0, stdout="", stderr="")

        monkeypatch.setattr(setup.subprocess, "run", fake_run)

        setup._validate_rfam_loads(install)

        assert calls[0] == [
            "C:/DNAForge/cmpress.exe",
            "-F",
            str(install / "Rfam.cm"),
        ]
        assert calls[1][0] == "C:/DNAForge/cmscan.exe"
        assert calls[1][calls[1].index("--fmt") + 1] == "2"


class TestEnsureRfamCurrent:
    @pytest.mark.asyncio
    async def test_skips_when_no_base_db(self, tmp_path):
        from src.annotation.setup import ensure_rfam_current

        with patch.object(au, "download_and_swap_asset") as swap:
            await ensure_rfam_current(data_dir=tmp_path)
            swap.assert_not_called()

    @pytest.mark.asyncio
    async def test_skips_when_current(self, tmp_path):
        from src.annotation.setup import (
            RFAM_VERSION,
            RFAM_VERSION_FILE,
            ensure_rfam_current,
        )

        _seed_bundle_rfam(tmp_path)
        (tmp_path / RFAM_VERSION_FILE).write_text(
            json.dumps({"rfam_version": RFAM_VERSION})
        )
        with patch.object(au, "download_and_swap_asset") as swap:
            await ensure_rfam_current(data_dir=tmp_path)
            swap.assert_not_called()

    @pytest.mark.asyncio
    async def test_updates_when_stale(self, tmp_path):
        from src.annotation.setup import ensure_rfam_current

        _seed_bundle_rfam(tmp_path)
        with patch.object(au, "download_and_swap_asset", return_value=True) as swap:
            await ensure_rfam_current(data_dir=tmp_path)
            swap.assert_called_once()

    @pytest.mark.asyncio
    async def test_never_raises_retries_and_reports_on_failure(self, tmp_path, caplog):
        from src.annotation.setup import MAX_RFAM_UPDATE_ATTEMPTS, ensure_rfam_current

        _seed_bundle_rfam(tmp_path)
        with (
            patch.object(
                au,
                "download_and_swap_asset",
                side_effect=RuntimeError("boom"),
            ) as swap,
            patch.object(au.asyncio, "sleep", new_callable=AsyncMock),
            caplog.at_level(logging.ERROR, logger="src.annotation.asset_updater"),
        ):
            await ensure_rfam_current(data_dir=tmp_path)

        assert swap.call_count == MAX_RFAM_UPDATE_ATTEMPTS
        assert any(
            "rfam" in r.getMessage().lower()
            for r in caplog.records
            if r.levelno >= logging.ERROR
        ), "a failure must be reported at ERROR level (host funnels to Sentry)"
