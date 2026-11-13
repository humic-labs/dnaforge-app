"""Tests for annotation database setup flow."""

import io
import json
import subprocess
import tarfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


def create_expected_database_files(data_dir: Path) -> None:
    from src.annotation.setup import EXPECTED_DB_FILES

    for expected in EXPECTED_DB_FILES:
        path = data_dir / expected
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()


def complete_database_download(arguments, **_kwargs):
    from src.annotation.setup import EXPECTED_DB_FILES

    destination = Path(arguments[arguments.index("-o") + 1])
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.name == "BLAST_dbs.tar.gz":
        with tarfile.open(destination, "w:gz") as archive:
            for relative in EXPECTED_DB_FILES:
                if relative == "swissprot.csv.gz":
                    continue
                payload = b"database"
                info = tarfile.TarInfo(relative)
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))
    else:
        destination.write_bytes(b"protein descriptions")
    return subprocess.CompletedProcess(arguments, 0, "", "")


class TestAnnotationDataPath:
    """Test data path resolution."""

    def test_get_data_dir_returns_path(self):
        from src.annotation.setup import get_annotation_data_dir

        path = get_annotation_data_dir()
        assert isinstance(path, Path)
        assert "waypoint" in str(path).lower() or "annotation" in str(path).lower()

    def test_get_data_dir_creates_directory(self, tmp_path):
        from src.annotation.setup import get_annotation_data_dir

        with patch.dict("os.environ", {"WAYPOINT_DATA_DIR": str(tmp_path)}):
            path = get_annotation_data_dir()
            assert path.exists()

    def test_get_data_dir_env_override(self, tmp_path):
        from src.annotation.setup import get_annotation_data_dir

        with patch.dict("os.environ", {"WAYPOINT_DATA_DIR": str(tmp_path)}):
            path = get_annotation_data_dir()
            assert str(path).startswith(str(tmp_path))

    def test_get_data_dir_returns_annotation_subdir(self, tmp_path):
        from src.annotation.setup import get_annotation_data_dir

        with patch.dict("os.environ", {"WAYPOINT_DATA_DIR": str(tmp_path)}):
            path = get_annotation_data_dir()
            assert path.name == "annotation"


class TestDatabaseStatus:
    """Test database status checking."""

    def test_status_when_no_databases(self, tmp_path):
        from src.annotation.setup import get_database_status

        status = get_database_status(tmp_path)
        assert status["downloaded"] is False
        assert status["version"] is None
        assert "path" in status

    def test_status_when_databases_exist(self, tmp_path):
        from src.annotation.setup import get_database_status

        db_dir = tmp_path / "BLAST_dbs"
        db_dir.mkdir()
        version_file = tmp_path / "version.json"
        version_file.write_text(json.dumps({"version": "1.2.2"}))
        create_expected_database_files(tmp_path)

        status = get_database_status(tmp_path)
        assert status["downloaded"] is True
        assert status["version"] == "1.2.2"

    def test_status_includes_expected_version(self, tmp_path):
        from src.annotation.setup import ANNOTATION_VERSION, get_database_status

        status = get_database_status(tmp_path)
        assert status["expected_version"] == ANNOTATION_VERSION

    def test_status_needs_update_when_version_mismatch(self, tmp_path):
        from src.annotation.setup import get_database_status

        version_file = tmp_path / "version.json"
        version_file.write_text(json.dumps({"version": "0.9.0"}))

        status = get_database_status(tmp_path)
        assert status["needs_update"] is True

    def test_status_no_update_needed_when_current(self, tmp_path):
        from src.annotation.setup import ANNOTATION_VERSION, get_database_status

        version_file = tmp_path / "version.json"
        version_file.write_text(json.dumps({"version": ANNOTATION_VERSION}))

        status = get_database_status(tmp_path)
        assert status["needs_update"] is False

    def test_status_handles_corrupt_version_file(self, tmp_path):
        from src.annotation.setup import get_database_status

        version_file = tmp_path / "version.json"
        version_file.write_text("not valid json {{{")

        status = get_database_status(tmp_path)
        assert status["version"] is None
        assert status["downloaded"] is False


class TestDatabaseValidation:
    """Test database file validation."""

    def test_validate_databases_checks_expected_files(self, tmp_path):
        from src.annotation.setup import validate_databases

        assert validate_databases(tmp_path) is False

        create_expected_database_files(tmp_path)
        assert validate_databases(tmp_path) is True

    def test_validate_databases_fails_with_missing_file(self, tmp_path):
        from src.annotation.setup import validate_databases

        db_dir = tmp_path / "BLAST_dbs"
        db_dir.mkdir()
        for name in ["snapgene.nsq", "fpbase.dmnd", "swissprot.dmnd"]:
            (db_dir / name).touch()
        assert validate_databases(tmp_path) is False

    def test_expected_files_include_rfam_pressed_index_and_clanin(self):
        from src.annotation.setup import EXPECTED_DB_FILES

        for expected in [
            "BLAST_dbs/Rfam.clanin",
            "BLAST_dbs/Rfam.cm",
            "BLAST_dbs/Rfam.cm.i1f",
            "BLAST_dbs/Rfam.cm.i1i",
            "BLAST_dbs/Rfam.cm.i1m",
            "BLAST_dbs/Rfam.cm.i1p",
        ]:
            assert expected in EXPECTED_DB_FILES


class TestDatabaseDownload:
    """Test database download and extraction."""

    def test_database_archive_url_uses_minor_release_asset(self):
        from src.annotation.setup import (
            ANNOTATION_DB_ASSET_VERSION,
            ANNOTATION_VERSION,
            DB_DOWNLOAD_URL,
        )

        assert ANNOTATION_VERSION == "1.2.2"
        assert ANNOTATION_DB_ASSET_VERSION == "1.2.0"
        assert DB_DOWNLOAD_URL.endswith("/v1.2.0/BLAST_dbs.tar.gz")

    def test_download_creates_version_file(self, tmp_path):
        """After download, version.json should exist."""
        from src.annotation.setup import download_databases

        with patch(
            "src.annotation.setup.subprocess.run",
            side_effect=complete_database_download,
        ):
            result = download_databases(tmp_path)

        assert result["success"] is True
        assert (tmp_path / "version.json").exists()

    def test_download_returns_error_on_curl_failure(self, tmp_path):
        from src.annotation.setup import download_databases

        with patch("src.annotation.setup.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stderr="Connection refused")
            result = download_databases(tmp_path)
            assert result["success"] is False
            assert "Download failed" in result["error"]

    def test_download_creates_missing_data_dir_before_curl(self, tmp_path):
        from src.annotation.setup import download_databases

        data_dir = tmp_path / "missing" / "annotation"
        with patch("src.annotation.setup.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stderr="Connection refused")

            result = download_databases(data_dir)

        assert data_dir.exists()
        assert result["success"] is False
        assert "Download failed" in result["error"]

    def test_download_cleans_up_tarball_on_error(self, tmp_path):
        from src.annotation.setup import download_databases

        with patch("src.annotation.setup.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            tarball = tmp_path / "annotation" / "BLAST_dbs.tar.gz"
            tarball.parent.mkdir(parents=True, exist_ok=True)
            tarball.write_text("not a real tarball")

            with patch.dict("os.environ", {"WAYPOINT_DATA_DIR": str(tmp_path)}):
                result = download_databases()
                assert result["success"] is False
                assert not tarball.exists()

    def test_invalid_staged_bundle_cannot_overwrite_live_database(self, tmp_path):
        from src.annotation.setup import EXPECTED_DB_FILES, download_databases

        live = tmp_path / "BLAST_dbs" / "snapgene.nsq"
        live.parent.mkdir(parents=True)
        live.write_text("working-old-database")

        def fake_curl(arguments, **_kwargs):
            destination = Path(arguments[arguments.index("-o") + 1])
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.name == "BLAST_dbs.tar.gz":
                with tarfile.open(destination, "w:gz") as archive:
                    for relative in EXPECTED_DB_FILES[:-2]:
                        payload = b"new-database"
                        info = tarfile.TarInfo(relative)
                        info.size = len(payload)
                        archive.addfile(info, io.BytesIO(payload))
            else:
                destination.write_bytes(b"new-details")
            return subprocess.CompletedProcess(arguments, 0, "", "")

        with patch("src.annotation.setup.subprocess.run", side_effect=fake_curl):
            result = download_databases(tmp_path)

        assert result["success"] is False
        assert live.read_text() == "working-old-database"
        assert not (tmp_path / "version.json").exists()

    def test_crash_transaction_is_rolled_back_before_a_new_download(self, tmp_path):
        from src.annotation.setup import download_databases

        transaction = tmp_path / ".annotation-db-transaction-interrupted"
        backup = transaction / "backup" / "BLAST_dbs"
        backup.mkdir(parents=True)
        (backup / "snapgene.nsq").write_text("working-old-database")
        (transaction / "manifest.json").write_text(
            json.dumps({"targets": ["BLAST_dbs"], "present": ["BLAST_dbs"]})
        )

        with patch("src.annotation.setup.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stderr="Connection refused")
            result = download_databases(tmp_path)

        assert result["success"] is False
        assert (tmp_path / "BLAST_dbs" / "snapgene.nsq").read_text() == (
            "working-old-database"
        )
        assert not transaction.exists()

    def test_crash_after_manifest_preserves_an_old_database_not_yet_backed_up(
        self, tmp_path
    ):
        from src.annotation.setup import download_databases

        live = tmp_path / "BLAST_dbs" / "snapgene.nsq"
        live.parent.mkdir(parents=True)
        live.write_text("working-old-database")
        transaction = tmp_path / ".annotation-db-transaction-before-first-rename"
        (transaction / "backup").mkdir(parents=True)
        (transaction / "manifest.json").write_text(
            json.dumps({"targets": ["BLAST_dbs"], "present": ["BLAST_dbs"]})
        )

        with patch("src.annotation.setup.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stderr="Connection refused")
            result = download_databases(tmp_path)

        assert result["success"] is False
        assert live.read_text() == "working-old-database"
        assert not transaction.exists()

    def test_malformed_recovery_manifest_cannot_delete_outside_the_data_dir(
        self, tmp_path
    ):
        from src.annotation.setup import download_databases

        data_dir = tmp_path / "annotation"
        outside = tmp_path / "outside.txt"
        outside.write_text("keep-me")
        transaction = data_dir / ".annotation-db-transaction-malformed"
        (transaction / "backup").mkdir(parents=True)
        (transaction / "manifest.json").write_text(
            json.dumps({"targets": ["../outside.txt"], "present": []})
        )

        with patch("src.annotation.setup.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stderr="Connection refused")
            result = download_databases(data_dir)

        assert result["success"] is False
        assert outside.read_text() == "keep-me"
        assert transaction.exists()


class TestDownloadDatabasesStream:
    """Test the async SSE streaming download function."""

    @pytest.mark.asyncio
    async def test_stream_yields_progress_events(self, tmp_path):
        from src.annotation.setup import download_databases_stream

        events = []
        with patch(
            "src.annotation.setup.subprocess.run",
            side_effect=complete_database_download,
        ):
            async for event in download_databases_stream(tmp_path):
                events.append(event)
        assert [event["event"] for event in events] == ["progress", "complete"]

    @pytest.mark.asyncio
    async def test_stream_error_on_curl_failure(self, tmp_path):
        from src.annotation.setup import download_databases_stream

        events = []
        with patch("src.annotation.setup.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stderr="Connection refused")
            async for event in download_databases_stream(tmp_path):
                events.append(event)
        assert any(e["event"] == "error" for e in events)

    @pytest.mark.asyncio
    async def test_stream_prevents_concurrent_downloads(self, tmp_path):
        import asyncio

        from src.annotation.setup import download_databases_stream

        events_1 = []
        events_2 = []

        async def collect_1():
            async for event in download_databases_stream(tmp_path):
                events_1.append(event)

        async def collect_2():
            async for event in download_databases_stream(tmp_path):
                events_2.append(event)

        with patch("src.annotation.setup.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            with patch("src.annotation.setup.tarfile.open"):
                create_expected_database_files(tmp_path)
                await asyncio.gather(collect_1(), collect_2())

        all_events = events_1 + events_2
        assert len(all_events) > 0

    @pytest.mark.asyncio
    async def test_invalid_streamed_bundle_cannot_overwrite_live_database(
        self, tmp_path
    ):
        from src.annotation.setup import download_databases_stream

        live = tmp_path / "BLAST_dbs" / "snapgene.nsq"
        live.parent.mkdir(parents=True)
        live.write_text("working-old-database")

        class InvalidArchive:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def extractall(self, path, **_kwargs):
                replacement = Path(path) / "BLAST_dbs" / "snapgene.nsq"
                replacement.parent.mkdir(parents=True, exist_ok=True)
                replacement.write_text("broken-new-database")

        def fake_curl(arguments, **_kwargs):
            destination = Path(arguments[arguments.index("-o") + 1])
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(b"download")
            return subprocess.CompletedProcess(arguments, 0, "", "")

        events = []
        with (
            patch("src.annotation.setup.subprocess.run", side_effect=fake_curl),
            patch("src.annotation.setup.tarfile.open", return_value=InvalidArchive()),
        ):
            async for event in download_databases_stream(tmp_path):
                events.append(event)

        assert any(event["event"] == "error" for event in events)
        assert live.read_text() == "working-old-database"


class TestAutoDownloadOnStartup:
    """Database download should trigger automatically on startup."""

    @pytest.mark.asyncio
    async def test_ensure_databases_starts_download_when_missing(self, tmp_path):
        """ensure_databases() should start download if databases don't exist."""
        from src.annotation.setup import ensure_databases

        with patch("src.annotation.setup.download_databases") as mock_dl:
            mock_dl.return_value = {"success": True, "version": "1.2.2"}
            await ensure_databases(data_dir=tmp_path)
            mock_dl.assert_called_once()

    @pytest.mark.asyncio
    async def test_ensure_databases_skips_when_present(self, tmp_path):
        """ensure_databases() should skip download if databases exist."""
        from src.annotation.setup import ensure_databases

        create_expected_database_files(tmp_path)

        with patch("src.annotation.setup.download_databases") as mock_dl:
            await ensure_databases(data_dir=tmp_path)
            mock_dl.assert_not_called()

    @pytest.mark.asyncio
    async def test_ensure_databases_recovers_a_pending_publication_before_skip(
        self, tmp_path
    ):
        from src.annotation.setup import ANNOTATION_VERSION, ensure_databases

        create_expected_database_files(tmp_path)
        (tmp_path / "version.json").write_text(
            json.dumps({"version": ANNOTATION_VERSION})
        )
        transaction = tmp_path / ".annotation-db-transaction-interrupted"
        transaction.mkdir()
        (transaction / "manifest.json").write_text(
            json.dumps({"targets": [], "present": []})
        )

        with patch("src.annotation.setup.download_databases") as mock_download:
            await ensure_databases(data_dir=tmp_path)

        mock_download.assert_not_called()
        assert not transaction.exists()

    @pytest.mark.asyncio
    async def test_ensure_databases_logs_failure_does_not_crash(self, tmp_path):
        """If download fails, ensure_databases logs but doesn't raise."""
        from src.annotation.setup import ensure_databases

        with patch("src.annotation.setup.download_databases") as mock_dl:
            mock_dl.return_value = {"success": False, "error": "No network"}
            await ensure_databases(data_dir=tmp_path)

    @pytest.mark.asyncio
    async def test_offline_mode_never_downloads_missing_databases(
        self, tmp_path, monkeypatch
    ):
        from src.annotation.setup import ensure_databases

        monkeypatch.setenv("DNAFORGE_OFFLINE_ANNOTATION", "1")
        with patch("src.annotation.setup.download_databases") as mock_download:
            await ensure_databases(data_dir=tmp_path)

        mock_download.assert_not_called()

    def test_execute_without_databases_returns_error(self):
        from src.main import app
        from tests.sidecar_test_client import (
            AuthenticatedSidecarTestClient as TestClient,
        )

        client = TestClient(app)
        response = client.post(
            "/annotation",
            json={"sequence": "ATCGATCG"},
        )
        assert response.status_code == 200
        data = response.json()
        if not data.get("features") and "error" in data:
            error_lower = data["error"].lower()
            assert any(
                keyword in error_lower
                for keyword in [
                    "setup",
                    "database",
                    "binary",
                    "binaries",
                    "missing",
                    "installing",
                    "tools",
                ]
            ), f"Error should be actionable, got: {data['error']}"
