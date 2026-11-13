""" Phase A — annotation DB auto-update mechanism.

`get_database_status` already computes `needs_update` (version.json vs the pinned
ANNOTATION_VERSION) but nothing consumed it, so a stale-but-present DB was treated
as "ready" forever. Phase A wires the redownload + surfaces the signal to the
toolbox. Phase B (actually shipping current Rfam) is a separate, fork-gated step.
"""

import json
from pathlib import Path
from unittest.mock import patch

import pytest


def _create_expected_database_files(data_dir: Path) -> None:
    from src.annotation.setup import EXPECTED_DB_FILES

    for expected in EXPECTED_DB_FILES:
        path = data_dir / expected
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()


class TestEnsureDatabasesRedownloadsOnUpdate:
    @pytest.mark.asyncio
    async def test_redownloads_when_present_but_stale(self, tmp_path):
        """A complete-but-stale DB (old version.json) must re-download.

        This is the stale-forever bug: before Phase A, ensure_databases early-
        returned on presence and never re-pulled a version-mismatched DB.
        """
        from src.annotation.setup import ANNOTATION_VERSION, ensure_databases

        _create_expected_database_files(tmp_path)
        (tmp_path / "version.json").write_text(json.dumps({"version": "0.9.0"}))

        with patch("src.annotation.setup.download_databases") as mock_dl:
            mock_dl.return_value = {"success": True, "version": ANNOTATION_VERSION}
            await ensure_databases(data_dir=tmp_path)
            mock_dl.assert_called_once()

    @pytest.mark.asyncio
    async def test_no_redownload_when_present_and_current(self, tmp_path):
        """A present, up-to-date DB must NOT re-pull (309 MB guarded on mismatch)."""
        from src.annotation.setup import ANNOTATION_VERSION, ensure_databases

        _create_expected_database_files(tmp_path)
        (tmp_path / "version.json").write_text(
            json.dumps({"version": ANNOTATION_VERSION})
        )

        with patch("src.annotation.setup.download_databases") as mock_dl:
            await ensure_databases(data_dir=tmp_path)
            mock_dl.assert_not_called()

    @pytest.mark.asyncio
    async def test_no_version_file_present_is_not_treated_as_stale(self, tmp_path):
        """Files present but no version.json → version None → NOT needs_update,
        so no surprise re-pull (preserves the pre- skip behavior)."""
        from src.annotation.setup import ensure_databases

        _create_expected_database_files(tmp_path)

        with patch("src.annotation.setup.download_databases") as mock_dl:
            await ensure_databases(data_dir=tmp_path)
            mock_dl.assert_not_called()

    @pytest.mark.asyncio
    async def test_patch_only_version_bump_does_not_redownload(self, tmp_path):
        """A patch-only ANNOTATION_VERSION bump (same DB ASSET, byte-identical)
        must NOT re-pull 309 MB. The DB bytes are pinned to the asset series
        (major.minor.0), so staleness keys on the asset series, not the patch."""
        from src.annotation.setup import ANNOTATION_DB_ASSET_VERSION, ensure_databases

        _create_expected_database_files(tmp_path)
        (tmp_path / "version.json").write_text(
            json.dumps({"version": ANNOTATION_DB_ASSET_VERSION})
        )

        with patch("src.annotation.setup.download_databases") as mock_dl:
            await ensure_databases(data_dir=tmp_path)
            mock_dl.assert_not_called()


class TestStaleKeyedOnAssetSeries:
    """needs_update tracks the DB asset series (major.minor), not the app patch."""

    def test_no_update_when_stored_matches_asset_series(self, tmp_path):
        from src.annotation.setup import (
            ANNOTATION_DB_ASSET_VERSION,
            get_database_status,
        )

        (tmp_path / "version.json").write_text(
            json.dumps({"version": ANNOTATION_DB_ASSET_VERSION})
        )
        assert get_database_status(tmp_path)["needs_update"] is False

    def test_needs_update_when_asset_series_differs(self, tmp_path):
        from src.annotation.setup import get_database_status

        (tmp_path / "version.json").write_text(json.dumps({"version": "0.9.0"}))
        assert get_database_status(tmp_path)["needs_update"] is True
