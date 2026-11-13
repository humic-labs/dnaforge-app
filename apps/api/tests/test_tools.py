"""Tests for the tool registry and runtime binary download system.

TDD tests for:
- A-1: TOOL_REGISTRY structure and validation
- A-2: get_tools_dir() platform-specific path
- A-3: _fetch_archive() download and verification
- A-4: _extract_binaries() extraction and permissions
- A-5: validate_tools() presence checking
- A-6: ensure_tools() auto-download orchestration
"""

import gzip
import hashlib
import io
import json
import stat
import tarfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


class TestToolRegistry:
    """TOOL_REGISTRY defines default tools as a plain Python dict."""

    def test_registry_has_required_entries(self):
        from src.annotation.tools import TOOL_REGISTRY

        assert "blast" in TOOL_REGISTRY
        assert "diamond" in TOOL_REGISTRY
        assert "infernal" in TOOL_REGISTRY

    def test_all_entries_have_required_fields(self):
        from src.annotation.tools import TOOL_REGISTRY

        for name, entry in TOOL_REGISTRY.items():
            assert "version" in entry, f"{name} missing version"
            assert "required_by" in entry, f"{name} missing required_by"
            assert "platforms" in entry, f"{name} missing platforms"

    def test_all_platforms_have_required_fields(self):
        from src.annotation.tools import TOOL_REGISTRY

        for name, entry in TOOL_REGISTRY.items():
            for platform, pdata in entry["platforms"].items():
                assert "url" in pdata, f"{name}/{platform} missing url"
                assert "sha256" in pdata, f"{name}/{platform} missing sha256"
                assert (
                    "archive_type" in pdata
                ), f"{name}/{platform} missing archive_type"
                assert "binaries" in pdata, f"{name}/{platform} missing binaries"
                assert isinstance(
                    pdata["binaries"], dict
                ), f"{name}/{platform} binaries must be dict"

    def test_all_urls_use_https_or_known_exceptions(self):
        from src.annotation.tools import TOOL_REGISTRY

        KNOWN_HTTP_EXCEPTIONS = {"eddylab.org"}

        for name, entry in TOOL_REGISTRY.items():
            for platform, pdata in entry["platforms"].items():
                url = pdata["url"]
                if any(domain in url for domain in KNOWN_HTTP_EXCEPTIONS):
                    assert url.startswith(
                        "http://"
                    ), f"{name}/{platform}: expected http for known exception"
                else:
                    assert url.startswith(
                        "https://"
                    ), f"{name}/{platform}: must use HTTPS, got {url}"

    def test_blast_archive_contains_both_binaries(self):
        from src.annotation.tools import TOOL_REGISTRY

        blast = TOOL_REGISTRY["blast"]
        for platform, pdata in blast["platforms"].items():
            assert "blastn" in pdata["binaries"], f"blast/{platform} missing blastn"
            assert (
                "makeblastdb" in pdata["binaries"]
            ), f"blast/{platform} missing makeblastdb"

    def test_all_sha256_are_64_char_hex(self):
        from src.annotation.tools import TOOL_REGISTRY

        for name, entry in TOOL_REGISTRY.items():
            for platform, pdata in entry["platforms"].items():
                sha = pdata["sha256"]
                assert (
                    len(sha) == 64
                ), f"{name}/{platform} sha256 wrong length: {len(sha)}"
                assert all(
                    c in "0123456789abcdef" for c in sha
                ), f"{name}/{platform} sha256 not hex: {sha}"


class TestGetToolsDir:
    def test_returns_path_with_platform_suffix(self):
        from src.annotation.tools import get_tools_dir

        tools_dir = get_tools_dir()
        parts = tools_dir.parts
        assert "tools" in parts, f"'tools' not in path: {tools_dir}"

    def test_respects_waypoint_data_dir(self, monkeypatch, tmp_path):
        from src.annotation.tools import get_tools_dir

        monkeypatch.setenv("WAYPOINT_DATA_DIR", str(tmp_path))
        tools_dir = get_tools_dir()
        assert str(tools_dir).startswith(str(tmp_path))

    def test_creates_directory(self, monkeypatch, tmp_path):
        from src.annotation.tools import get_tools_dir

        monkeypatch.setenv("WAYPOINT_DATA_DIR", str(tmp_path))
        tools_dir = get_tools_dir()
        assert tools_dir.is_dir()


class TestFetchArchive:
    def _make_gzip_content(self, data: bytes = b"test content") -> bytes:
        """Create valid gzip content."""
        buf = io.BytesIO()
        with gzip.GzipFile(fileobj=buf, mode="wb") as f:
            f.write(data)
        return buf.getvalue()

    def test_rejects_non_gzip(self, tmp_path):
        from src.annotation.tools import _fetch_archive

        dest = tmp_path / "bad.tar.gz"
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            dest.write_bytes(b"not a gzip file")
            result = _fetch_archive("https://example.com/file.tar.gz", dest, "abc123")
            assert result["success"] is False
            assert "gzip" in result["error"].lower()

    def test_rejects_sha256_mismatch(self, tmp_path):
        from src.annotation.tools import _fetch_archive

        dest = tmp_path / "bad_hash.tar.gz"
        gz_content = self._make_gzip_content()
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            dest.write_bytes(gz_content)
            result = _fetch_archive("https://example.com/file.tar.gz", dest, "0" * 64)
            assert result["success"] is False
            assert "sha256" in result["error"].lower()

    def test_cleans_up_on_failure(self, tmp_path):
        from src.annotation.tools import _fetch_archive

        dest = tmp_path / "cleanup.tar.gz"
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            dest.write_bytes(b"not gzip")
            _fetch_archive("https://example.com/file.tar.gz", dest, "abc")
            assert not dest.exists()

    def test_succeeds_with_valid_archive(self, tmp_path):
        from src.annotation.tools import _fetch_archive

        dest = tmp_path / "good.tar.gz"
        gz_content = self._make_gzip_content()
        expected_sha = hashlib.sha256(gz_content).hexdigest()

        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            dest.write_bytes(gz_content)
            result = _fetch_archive(
                "https://example.com/file.tar.gz", dest, expected_sha
            )
            assert result["success"] is True

    def test_curl_failure_returns_error(self, tmp_path):
        from src.annotation.tools import _fetch_archive

        dest = tmp_path / "fail.tar.gz"
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stderr="connection refused")
            result = _fetch_archive("https://example.com/file.tar.gz", dest, "abc")
            assert result["success"] is False

    def _make_zip_content(self) -> bytes:
        """Create minimal valid ZIP content (PK magic bytes + end-of-central-directory)."""
        buf = io.BytesIO()
        import zipfile

        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("test.txt", "test content")
        return buf.getvalue()

    def test_accepts_zip_archive(self, tmp_path):
        from src.annotation.tools import _fetch_archive

        dest = tmp_path / "mafft.zip"
        zip_content = self._make_zip_content()
        expected_sha = hashlib.sha256(zip_content).hexdigest()

        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            dest.write_bytes(zip_content)
            result = _fetch_archive(
                "https://example.com/mafft.zip", dest, expected_sha, archive_type="zip"
            )
            assert result["success"] is True

    def test_rejects_non_zip_when_archive_type_is_zip(self, tmp_path):
        from src.annotation.tools import _fetch_archive

        dest = tmp_path / "bad.zip"
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            dest.write_bytes(b"not a zip file")
            result = _fetch_archive(
                "https://example.com/bad.zip", dest, "abc123", archive_type="zip"
            )
            assert result["success"] is False
            assert "zip" in result["error"].lower()

    def test_rejects_gzip_content_when_zip_expected(self, tmp_path):
        from src.annotation.tools import _fetch_archive

        dest = tmp_path / "wrong.zip"
        gz_content = self._make_gzip_content()
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            dest.write_bytes(gz_content)
            result = _fetch_archive(
                "https://example.com/wrong.zip", dest, "abc123", archive_type="zip"
            )
            assert result["success"] is False

    def test_cleans_up_on_zip_magic_failure(self, tmp_path):
        from src.annotation.tools import _fetch_archive

        dest = tmp_path / "cleanup.zip"
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            dest.write_bytes(b"not a zip")
            _fetch_archive(
                "https://example.com/cleanup.zip", dest, "abc", archive_type="zip"
            )
            assert not dest.exists()


class TestExtractBinaries:
    def _make_tar_gz(self, tmp_path: Path, files: dict[str, bytes]) -> Path:
        """Create a tar.gz archive with given files."""
        archive_path = tmp_path / "test.tar.gz"
        with tarfile.open(archive_path, "w:gz") as tar:
            for name, content in files.items():
                info = tarfile.TarInfo(name=name)
                info.size = len(content)
                tar.addfile(info, io.BytesIO(content))
        return archive_path

    def test_extracts_to_unsuffixed_names(self, tmp_path):
        from src.annotation.tools import _extract_binaries

        archive = self._make_tar_gz(
            tmp_path,
            {
                "pkg/bin/blastn": b"\x7fELF_blastn_content",
                "pkg/bin/makeblastdb": b"\x7fELF_makeblastdb_content",
            },
        )
        dest = tmp_path / "dest"
        dest.mkdir()

        result = _extract_binaries(
            archive,
            {"blastn": "pkg/bin/blastn", "makeblastdb": "pkg/bin/makeblastdb"},
            dest,
        )
        assert result["success"] is True
        assert (dest / "blastn").exists()
        assert (dest / "makeblastdb").exists()
        assert not list(dest.glob("blastn-*"))

    def test_sets_executable_permission(self, tmp_path):
        import platform as _pf

        if _pf.system().lower() == "windows":
            pytest.skip(
                "POSIX executable bit is not applicable on Windows "
                "(chmod +x is a no-op; execution is driven by file extension)"
            )

        from src.annotation.tools import _extract_binaries

        archive = self._make_tar_gz(tmp_path, {"bin/tool": b"\x7fELF_tool"})
        dest = tmp_path / "dest"
        dest.mkdir()

        _extract_binaries(archive, {"tool": "bin/tool"}, dest)
        mode = (dest / "tool").stat().st_mode
        assert mode & stat.S_IXUSR, "Binary should be executable"

    def test_rejects_zero_byte_result(self, tmp_path):
        from src.annotation.tools import _extract_binaries

        archive = self._make_tar_gz(tmp_path, {"bin/tool": b""})
        dest = tmp_path / "dest"
        dest.mkdir()

        result = _extract_binaries(archive, {"tool": "bin/tool"}, dest)
        assert result["success"] is False
        assert "zero" in result["error"].lower() or "empty" in result["error"].lower()

    def test_cleans_up_on_partial_failure(self, tmp_path):
        from src.annotation.tools import _extract_binaries

        archive = self._make_tar_gz(tmp_path, {"bin/good": b"\x7fELF_good"})
        dest = tmp_path / "dest"
        dest.mkdir()

        result = _extract_binaries(
            archive,
            {"good": "bin/good", "missing": "bin/missing"},
            dest,
        )
        assert result["success"] is False
        assert not (dest / "good").exists()


class TestExtractDirectory:
    def _make_linked_archive(self, tmp_path: Path, link_target: str) -> Path:
        archive_path = tmp_path / "mafft.tar.gz"
        binary_path = "mafft-linux64/mafftdir/libexec/mafft/mafft-distance"
        link_path = "mafft-linux64/mafftdir/bin/mafft-distance"

        with tarfile.open(archive_path, "w:gz") as tar:
            content = b"\x7fELF_mafft-distance"
            binary = tarfile.TarInfo(name=binary_path)
            binary.size = len(content)
            binary.mode = 0o755
            tar.addfile(binary, io.BytesIO(content))

            link = tarfile.TarInfo(name=link_path)
            link.type = tarfile.SYMTYPE
            link.linkname = link_target
            tar.addfile(link)

        return archive_path

    def test_accepts_relative_symlink_that_resolves_inside_archive(self, tmp_path):
        from src.annotation.tools import _extract_directory

        archive = self._make_linked_archive(tmp_path, "../libexec/mafft/mafft-distance")
        destination = tmp_path / "destination"
        destination.mkdir()

        result = _extract_directory(archive, "mafft-linux64", destination)

        assert result["success"] is True
        link = destination / "mafft-linux64/mafftdir/bin/mafft-distance"
        assert link.resolve().read_bytes() == b"\x7fELF_mafft-distance"

    def test_rejects_absolute_symlink_in_tool_archive(self, tmp_path):
        from src.annotation.tools import _extract_directory

        archive = self._make_linked_archive(
            tmp_path, "/mafftdir/libexec/mafft/mafft-distance"
        )
        destination = tmp_path / "destination"
        destination.mkdir()

        result = _extract_directory(archive, "mafft-linux64", destination)

        assert result["success"] is False
        assert "absolute path" in result["error"]
        assert not (destination / "mafft-linux64").exists()


class TestValidateTools:
    def test_valid_tools_return_true(self, tmp_path):
        from src.annotation.tools import TOOL_REGISTRY, validate_tools

        for entry in TOOL_REGISTRY.values():
            is_dir_tool = entry.get("extract_dir", False)
            for pdata in entry["platforms"].values():
                for bin_name, archive_path in pdata["binaries"].items():
                    if is_dir_tool:
                        f = tmp_path / archive_path
                    else:
                        f = tmp_path / bin_name
                    f.parent.mkdir(parents=True, exist_ok=True)
                    f.write_bytes(b"\x7fELF")

        result = validate_tools(tmp_path)
        for name, valid in result.items():
            assert valid is True, f"{name} should be valid"

    def test_missing_tools_return_false(self, tmp_path):
        from src.annotation.tools import validate_tools

        result = validate_tools(tmp_path)
        for name, valid in result.items():
            assert valid is False, f"{name} should be missing"

    def test_zero_byte_tools_return_false(self, tmp_path):
        from src.annotation.tools import TOOL_REGISTRY, validate_tools

        for entry in TOOL_REGISTRY.values():
            for pdata in entry["platforms"].values():
                for bin_name in pdata["binaries"]:
                    f = tmp_path / bin_name
                    f.touch()
                break

        result = validate_tools(tmp_path)
        for name, valid in result.items():
            assert valid is False, f"0-byte {name} should be invalid"


def _write_fake_extracted_binaries(_archive, binaries, destination):
    installed = []
    for output_name in binaries:
        target = destination / output_name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("test executable")
        installed.append(output_name)
    return {"success": True, "installed": installed}


def _write_fake_extracted_directory(_archive, archive_root, destination):
    (destination / archive_root).mkdir(parents=True)
    return {"success": True, "installed": [archive_root]}


class TestEnsureTools:
    @pytest.mark.asyncio
    async def test_skips_when_all_valid(self, tmp_path, monkeypatch):
        from src.annotation.tools import ensure_tools

        with patch("src.annotation.tools.validate_tools") as mock_validate:
            mock_validate.return_value = {
                "blastn": True,
                "makeblastdb": True,
                "diamond": True,
                "cmscan": True,
            }
            with patch("src.annotation.tools.get_tools_dir", return_value=tmp_path):
                with patch("src.annotation.tools._fetch_archive") as mock_fetch:
                    await ensure_tools(data_dir=tmp_path)
                    mock_fetch.assert_not_called()

    @pytest.mark.asyncio
    async def test_downloads_missing_archives(self, tmp_path):
        from src.annotation.tools import ensure_tools

        with (
            patch(
                "src.toolbox.executable_paths.get_platform_suffix",
                return_value="x86_64-unknown-linux-gnu",
            ),
            patch("src.annotation.tools.get_tools_dir", return_value=tmp_path),
        ):
            with patch("src.annotation.tools.validate_tools") as mock_validate:
                mock_validate.side_effect = [
                    {
                        "blastn": False,
                        "makeblastdb": False,
                        "diamond": False,
                        "cmscan": False,
                    },
                    {
                        "blastn": True,
                        "makeblastdb": True,
                        "diamond": True,
                        "cmscan": True,
                    },
                ]
                with patch(
                    "src.annotation.tools._fetch_archive",
                    return_value={"success": True},
                ):
                    with (
                        patch(
                            "src.annotation.tools._extract_binaries",
                            side_effect=_write_fake_extracted_binaries,
                        ),
                        patch(
                            "src.annotation.tools._extract_directory",
                            side_effect=_write_fake_extracted_directory,
                        ),
                    ):
                        await ensure_tools(data_dir=tmp_path)

    @pytest.mark.asyncio
    async def test_writes_version_file(self, tmp_path):
        import json

        from src.annotation.tools import ensure_tools

        with (
            patch(
                "src.toolbox.executable_paths.get_platform_suffix",
                return_value="x86_64-unknown-linux-gnu",
            ),
            patch("src.annotation.tools.get_tools_dir", return_value=tmp_path),
        ):
            with patch("src.annotation.tools.validate_tools") as mock_validate:
                mock_validate.side_effect = [
                    {
                        "blastn": False,
                        "makeblastdb": False,
                        "diamond": False,
                        "cmscan": False,
                    },
                    {
                        "blastn": True,
                        "makeblastdb": True,
                        "diamond": True,
                        "cmscan": True,
                    },
                ]
                with patch(
                    "src.annotation.tools._fetch_archive",
                    return_value={"success": True},
                ):
                    with (
                        patch(
                            "src.annotation.tools._extract_binaries",
                            side_effect=_write_fake_extracted_binaries,
                        ),
                        patch(
                            "src.annotation.tools._extract_directory",
                            side_effect=_write_fake_extracted_directory,
                        ),
                    ):
                        await ensure_tools(data_dir=tmp_path)

        version_file = tmp_path / "tools-version.json"
        assert version_file.exists()
        data = json.loads(version_file.read_text())
        assert "blast" in data

    @pytest.mark.asyncio
    async def test_never_raises_on_error(self, tmp_path):
        from src.annotation.tools import ensure_tools

        with patch("src.annotation.tools.get_tools_dir", return_value=tmp_path):
            with patch(
                "src.annotation.tools.validate_tools", side_effect=Exception("boom")
            ):
                await ensure_tools(data_dir=tmp_path)

    @pytest.mark.asyncio
    async def test_sets_and_clears_downloading_flag(self, tmp_path):
        import src.annotation.tools as tools_mod
        from src.annotation.tools import ensure_tools

        flag_during = None
        call_count = 0

        def validate_side_effect(*args, **kwargs):
            nonlocal flag_during, call_count
            call_count += 1
            if call_count == 1:
                return {
                    "blastn": False,
                    "makeblastdb": False,
                    "diamond": False,
                    "cmscan": False,
                }
            flag_during = tools_mod._downloading_tools
            return {
                "blastn": True,
                "makeblastdb": True,
                "diamond": True,
                "cmscan": True,
            }

        with (
            patch(
                "src.toolbox.executable_paths.get_platform_suffix",
                return_value="x86_64-unknown-linux-gnu",
            ),
            patch("src.annotation.tools.get_tools_dir", return_value=tmp_path),
        ):
            with patch(
                "src.annotation.tools.validate_tools", side_effect=validate_side_effect
            ):
                with patch(
                    "src.annotation.tools._fetch_archive",
                    return_value={"success": True},
                ):
                    with (
                        patch(
                            "src.annotation.tools._extract_binaries",
                            side_effect=_write_fake_extracted_binaries,
                        ),
                        patch(
                            "src.annotation.tools._extract_directory",
                            side_effect=_write_fake_extracted_directory,
                        ),
                    ):
                        await ensure_tools(data_dir=tmp_path)

        assert flag_during is True, "Flag should be True during download"
        assert tools_mod._downloading_tools is False, "Flag should be False after"

    @pytest.mark.asyncio
    async def test_unsupported_platform_skips_gracefully(self, tmp_path):
        """ensure_tools() prints warning and continues for unknown platform."""
        from src.annotation.tools import ensure_tools

        fake_registry = {
            "fake_tool": {
                "version": "1.0",
                "required_by": "test",
                "platforms": {
                    "mips-unknown-bsd": {
                        "url": "https://example.com/fake.tar.gz",
                        "sha256": "abc123",
                        "archive_type": "tar.gz",
                        "binaries": {"faketool": "faketool"},
                    },
                },
            },
        }
        with patch("src.annotation.tools.TOOL_REGISTRY", fake_registry):
            with patch(
                "src.annotation.tools.validate_tools", return_value={"faketool": False}
            ):
                await ensure_tools(data_dir=tmp_path)

    @pytest.mark.asyncio
    async def test_skips_auto_download_on_windows(self, tmp_path):
        """On Windows, tools are bundle-provided (prepare-windows-bioinformatics-
        tools.ps1); ensure_tools must NOT attempt a network download that can't
        replicate BLAST's dependent DLLs or unpack Diamond's .zip ."""
        import src.annotation.tools as tools_mod
        from src.annotation.tools import ensure_tools

        with (
            patch(
                "src.toolbox.executable_paths.get_platform_suffix",
                return_value="x86_64-pc-windows-msvc",
            ),
            patch("src.annotation.tools.get_tools_dir", return_value=tmp_path),
        ):
            with patch(
                "src.annotation.tools.validate_tools",
                return_value={
                    "blastn": False,
                    "makeblastdb": False,
                    "diamond": False,
                    "mafft": False,
                },
            ):
                with patch("src.annotation.tools._fetch_archive") as mock_fetch:
                    await ensure_tools(data_dir=tmp_path)
                    mock_fetch.assert_not_called()

        assert tools_mod._downloading_tools is False

    @pytest.mark.asyncio
    async def test_offline_mode_never_downloads_missing_tools(
        self, tmp_path, monkeypatch
    ):
        from src.annotation.tools import ensure_tools

        monkeypatch.setenv("DNAFORGE_OFFLINE_ANNOTATION", "1")
        with (
            patch(
                "src.toolbox.executable_paths.get_platform_suffix",
                return_value="x86_64-unknown-linux-gnu",
            ),
            patch(
                "src.annotation.tools.validate_tools",
                return_value={"blastn": False, "diamond": False, "cmscan": False},
            ),
            patch("src.annotation.tools._fetch_archive") as mock_fetch,
        ):
            await ensure_tools(data_dir=tmp_path)

        mock_fetch.assert_not_called()

    @pytest.mark.asyncio
    async def test_failed_staged_extraction_cannot_overwrite_a_live_tool(
        self, tmp_path
    ):
        from src.annotation.tools import ensure_tools

        live = tmp_path / "example"
        live.write_text("working-old-tool")
        fake_registry = {
            "example": {
                "version": "1.0",
                "required_by": "plannotate",
                "platforms": {
                    "x86_64-unknown-linux-gnu": {
                        "url": "https://example.invalid/example.tar.gz",
                        "sha256": "0" * 64,
                        "archive_type": "tar.gz",
                        "binaries": {"example": "bin/example"},
                    }
                },
            }
        }

        def fake_extract(_archive, _binaries, destination):
            (destination / "example").write_text("broken-new-tool")
            return {"success": False, "error": "incomplete archive"}

        with (
            patch("src.annotation.tools.TOOL_REGISTRY", fake_registry),
            patch(
                "src.toolbox.executable_paths.get_platform_suffix",
                return_value="x86_64-unknown-linux-gnu",
            ),
            patch(
                "src.annotation.tools.validate_tools",
                return_value={"example": False},
            ),
            patch(
                "src.annotation.tools._fetch_archive",
                return_value={"success": True},
            ),
            patch("src.annotation.tools._extract_binaries", side_effect=fake_extract),
        ):
            await ensure_tools(data_dir=tmp_path)

        assert live.read_text() == "working-old-tool"

    @pytest.mark.asyncio
    async def test_interrupted_tool_publication_is_rolled_back(self, tmp_path):
        from src.annotation.tools import ensure_tools

        transaction = tmp_path / ".tool-example-transaction-interrupted"
        backup = transaction / "backup"
        backup.mkdir(parents=True)
        (backup / "example").write_text("working-old-tool")
        (transaction / "manifest.json").write_text(
            json.dumps({"targets": ["example"], "present": ["example"]})
        )
        fake_registry = {
            "example": {
                "version": "1.0",
                "required_by": "plannotate",
                "platforms": {
                    "x86_64-unknown-linux-gnu": {
                        "url": "https://example.invalid/example.tar.gz",
                        "sha256": "0" * 64,
                        "archive_type": "tar.gz",
                        "binaries": {"example": "bin/example"},
                    }
                },
            }
        }

        with (
            patch("src.annotation.tools.TOOL_REGISTRY", fake_registry),
            patch(
                "src.toolbox.executable_paths.get_platform_suffix",
                return_value="x86_64-unknown-linux-gnu",
            ),
            patch(
                "src.annotation.tools.validate_tools",
                return_value={"example": False},
            ),
            patch(
                "src.annotation.tools._fetch_archive",
                return_value={"success": False, "error": "offline"},
            ),
        ):
            await ensure_tools(data_dir=tmp_path)

        assert (tmp_path / "example").read_text() == "working-old-tool"
        assert not transaction.exists()

    @pytest.mark.asyncio
    async def test_crash_after_manifest_preserves_an_old_tool_not_yet_backed_up(
        self, tmp_path
    ):
        from src.annotation.tools import ensure_tools

        live = tmp_path / "example"
        live.write_text("working-old-tool")
        transaction = tmp_path / ".tool-example-transaction-before-first-rename"
        (transaction / "backup").mkdir(parents=True)
        (transaction / "manifest.json").write_text(
            json.dumps({"targets": ["example"], "present": ["example"]})
        )
        fake_registry = {
            "example": {
                "version": "1.0",
                "required_by": "plannotate",
                "platforms": {
                    "x86_64-unknown-linux-gnu": {
                        "url": "https://example.invalid/example.tar.gz",
                        "sha256": "0" * 64,
                        "archive_type": "tar.gz",
                        "binaries": {"example": "bin/example"},
                    }
                },
            }
        }

        with (
            patch("src.annotation.tools.TOOL_REGISTRY", fake_registry),
            patch(
                "src.toolbox.executable_paths.get_platform_suffix",
                return_value="x86_64-unknown-linux-gnu",
            ),
            patch(
                "src.annotation.tools.validate_tools",
                return_value={"example": False},
            ),
            patch(
                "src.annotation.tools._fetch_archive",
                return_value={"success": False, "error": "offline"},
            ),
        ):
            await ensure_tools(data_dir=tmp_path)

        assert live.read_text() == "working-old-tool"
        assert not transaction.exists()

    @pytest.mark.asyncio
    async def test_malformed_tool_manifest_cannot_delete_outside_the_tools_dir(
        self, tmp_path
    ):
        from src.annotation.tools import ensure_tools

        tools_dir = tmp_path / "tools"
        outside = tmp_path / "outside.txt"
        outside.write_text("keep-me")
        transaction = tools_dir / ".tool-example-transaction-malformed"
        (transaction / "backup").mkdir(parents=True)
        (transaction / "manifest.json").write_text(
            json.dumps({"targets": ["../outside.txt"], "present": []})
        )
        fake_registry = {
            "example": {
                "version": "1.0",
                "required_by": "plannotate",
                "platforms": {
                    "x86_64-unknown-linux-gnu": {
                        "url": "https://example.invalid/example.tar.gz",
                        "sha256": "0" * 64,
                        "archive_type": "tar.gz",
                        "binaries": {"example": "bin/example"},
                    }
                },
            }
        }

        with (
            patch("src.annotation.tools.TOOL_REGISTRY", fake_registry),
            patch(
                "src.toolbox.executable_paths.get_platform_suffix",
                return_value="x86_64-unknown-linux-gnu",
            ),
            patch(
                "src.annotation.tools.validate_tools",
                return_value={"example": False},
            ),
            patch(
                "src.annotation.tools._fetch_archive",
                return_value={"success": False, "error": "offline"},
            ),
        ):
            await ensure_tools(data_dir=tools_dir)

        assert outside.read_text() == "keep-me"
        assert transaction.exists()


class TestToolsToServiceIntegration:
    """Test real filesystem handoff between tools.py and plannotate.py.

    Simulates ensure_tools() populating get_tools_dir() with binaries,
    then verifies find_binaries_dir() discovers them.
    """

    def test_find_binaries_discovers_tools_dir(self, tmp_path, monkeypatch):
        """When all required tools are present, find_binaries_dir() returns tools dir."""
        import src.toolbox.executable_paths as executable_paths
        from src.annotation.tools import get_tools_dir, validate_tools
        from src.services.plannotate import find_binaries_dir

        monkeypatch.setenv("WAYPOINT_DATA_DIR", str(tmp_path))
        monkeypatch.setattr(executable_paths, "_platform_suffix_cache", None)
        monkeypatch.delenv("WAYPOINT_BINARIES_PATH", raising=False)

        tools_dir = get_tools_dir()

        from src.annotation.tools import TOOL_REGISTRY
        from src.services.plannotate import get_platform_suffix

        suffix = get_platform_suffix()
        for entry in TOOL_REGISTRY.values():
            is_dir_tool = entry.get("extract_dir", False)
            pdata = entry["platforms"].get(suffix)
            if pdata is None:
                continue
            for bin_name, archive_path in pdata["binaries"].items():
                if is_dir_tool:
                    f = tools_dir / archive_path
                else:
                    f = tools_dir / bin_name
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_bytes(b"\x7fELF" + b"\x00" * 100)

        status = validate_tools(tools_dir)
        assert all(status.values()), f"validate_tools should see all tools: {status}"

        result = find_binaries_dir()
        assert result == tools_dir

    def test_partial_tools_not_discovered(self, tmp_path, monkeypatch):
        """When only some tools are present, find_binaries_dir() does NOT return tools dir."""
        import src.toolbox.executable_paths as executable_paths
        from src.annotation.tools import get_tools_dir
        from src.services.plannotate import find_binaries_dir

        monkeypatch.setenv("WAYPOINT_DATA_DIR", str(tmp_path))
        monkeypatch.setattr(executable_paths, "_platform_suffix_cache", None)
        monkeypatch.delenv("WAYPOINT_BINARIES_PATH", raising=False)

        tools_dir = get_tools_dir()

        (tools_dir / "blastn").write_bytes(b"\x7fELF" + b"\x00" * 100)

        result = find_binaries_dir()
        assert result != tools_dir
