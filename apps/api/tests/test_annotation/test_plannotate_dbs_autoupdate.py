""" (A) — non-Rfam annotation DBs on the generic auto-update framework.

snapgene (BLAST) + fpbase/swissprot (Diamond) are hosted on our Cloudflare R2 and
wired onto the SAME ``asset_updater`` substrate as Rfam. They have no independent
upstream cadence (the pLannotate bundle is byte-identical across v1.x), so today the
updater is a deliberate NO-OP (installed 1.2.0 == hosted 1.2.0) — the wiring exists
so a future bump is a one-line change, and so the DBs live on our own host (no
GitHub single-point-of-failure). These tests pin the wiring + the Diamond load
probe; the swap mechanics themselves are proven generically in test_asset_updater.py.
"""

import json
import os
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

import src.annotation.asset_updater as au


def _seed_installed(data_dir: Path) -> None:
    """The non-Rfam DBs present on disk (from the pLannotate bundle), no marker."""
    blast = data_dir / "BLAST_dbs"
    blast.mkdir(parents=True, exist_ok=True)
    from src.annotation.setup import PLANNOTATE_DBS_FILES

    for f in PLANNOTATE_DBS_FILES:
        (blast / f).write_text("OLD")


class TestSpecWiring:
    def test_sha256_constant_is_a_sha256(self):
        from src.annotation.setup import PLANNOTATE_DBS_SHA256

        assert isinstance(PLANNOTATE_DBS_SHA256, str)
        assert len(PLANNOTATE_DBS_SHA256) == 64
        int(PLANNOTATE_DBS_SHA256, 16)

    def test_files_are_bare_names_installing_under_blast_dbs(self):
        from src.annotation.setup import PLANNOTATE_DBS_SPEC

        assert PLANNOTATE_DBS_SPEC.install_subdir == "BLAST_dbs"
        for f in PLANNOTATE_DBS_SPEC.files:
            assert "/" not in f and "\\" not in f
        assert "fpbase.dmnd" in PLANNOTATE_DBS_SPEC.files
        assert "swissprot.dmnd" in PLANNOTATE_DBS_SPEC.files

    def test_url_is_our_release_download_host(self):
        from src.annotation.setup import PLANNOTATE_DBS_URL

        assert PLANNOTATE_DBS_URL.startswith(
            "https://downloads.dnaforge.com/annotation-db/"
        )
        assert ".r2.dev" not in PLANNOTATE_DBS_URL
        assert PLANNOTATE_DBS_URL.endswith(".tar.gz")


class TestNoOpWhenCurrent:
    """Installed == hosted (1.2.0) → the updater must never fetch/swap."""

    @pytest.mark.asyncio
    async def test_ensure_is_a_no_op_on_a_current_install(self, tmp_path):
        from src.annotation.setup import ensure_plannotate_dbs_current

        _seed_installed(tmp_path)
        with patch.object(au, "download_and_swap_asset") as swap:
            await ensure_plannotate_dbs_current(data_dir=tmp_path)
            swap.assert_not_called()

    @pytest.mark.asyncio
    async def test_skips_when_dbs_absent(self, tmp_path):
        from src.annotation.setup import ensure_plannotate_dbs_current

        with patch.object(au, "download_and_swap_asset") as swap:
            await ensure_plannotate_dbs_current(data_dir=tmp_path)
            swap.assert_not_called()

    @pytest.mark.asyncio
    async def test_updates_when_marker_reports_older(self, tmp_path):
        """If a future bump raised the target, a stale marker triggers the swap
        (proves the wiring is live, not dead)."""
        import src.annotation.setup as setup

        _seed_installed(tmp_path)
        (tmp_path / setup.PLANNOTATE_DBS_VERSION_FILE).write_text(
            json.dumps({"plannotate_dbs_version": "0.0.1"})
        )
        with patch.object(au, "download_and_swap_asset") as swap:
            await setup.ensure_plannotate_dbs_current(data_dir=tmp_path)
            swap.assert_called_once()


class TestDiamondValidateProbe:
    """Q2 — the Diamond load probe. Fails OPEN on missing binary / timeout, CLOSED
    only on a definitive ``diamond dbinfo`` failure."""

    def _install(self, tmp_path):
        install = tmp_path / "BLAST_dbs"
        install.mkdir(parents=True, exist_ok=True)
        (install / "fpbase.dmnd").write_text("f")
        (install / "swissprot.dmnd").write_text("s")
        return install

    def test_skips_when_diamond_missing(self, tmp_path, monkeypatch):
        import src.annotation.setup as setup
        import src.services.plannotate as plannotate

        install = self._install(tmp_path)
        monkeypatch.setattr(plannotate, "find_binaries_dir", lambda: None)
        monkeypatch.setattr(plannotate, "get_binary_path", lambda *a, **k: None)
        monkeypatch.setattr(setup.shutil, "which", lambda *a, **k: None)
        ran = {"n": 0}
        monkeypatch.setattr(
            setup.subprocess, "run", lambda *a, **k: ran.__setitem__("n", ran["n"] + 1)
        )
        setup._validate_plannotate_dbs_loads(install)
        assert ran["n"] == 0

    def test_raises_on_definitive_load_failure(self, tmp_path, monkeypatch):
        import src.annotation.setup as setup
        import src.services.plannotate as plannotate

        install = self._install(tmp_path)
        monkeypatch.setattr(plannotate, "find_binaries_dir", lambda: tmp_path)
        monkeypatch.setattr(plannotate, "get_binary_path", lambda *a, **k: "/x/diamond")
        monkeypatch.setattr(
            setup.subprocess,
            "run",
            lambda *a, **k: subprocess.CompletedProcess(
                a, returncode=1, stdout="", stderr="format version too new"
            ),
        )
        with pytest.raises(RuntimeError, match="could not load"):
            setup._validate_plannotate_dbs_loads(install)

    def test_proceeds_on_timeout(self, tmp_path, monkeypatch):
        import src.annotation.setup as setup
        import src.services.plannotate as plannotate

        install = self._install(tmp_path)
        monkeypatch.setattr(plannotate, "find_binaries_dir", lambda: tmp_path)
        monkeypatch.setattr(plannotate, "get_binary_path", lambda *a, **k: "/x/diamond")

        def timeout_run(*a, **k):
            raise subprocess.TimeoutExpired(cmd="diamond", timeout=1)

        monkeypatch.setattr(setup.subprocess, "run", timeout_run)
        setup._validate_plannotate_dbs_loads(install)

    def test_passes_and_checks_both_dmnd_dbs(self, tmp_path, monkeypatch):
        import src.annotation.setup as setup
        import src.services.plannotate as plannotate

        install = self._install(tmp_path)
        monkeypatch.setattr(plannotate, "find_binaries_dir", lambda: tmp_path)
        monkeypatch.setattr(plannotate, "get_binary_path", lambda *a, **k: "/x/diamond")
        seen = []

        def ok_run(args, **k):
            seen.append(args[-1])
            return subprocess.CompletedProcess(args, returncode=0, stdout="", stderr="")

        monkeypatch.setattr(setup.subprocess, "run", ok_run)
        setup._validate_plannotate_dbs_loads(install)
        assert any("fpbase.dmnd" in p for p in seen)
        assert any("swissprot.dmnd" in p for p in seen)


class TestSwissprotCsvR2Preference:
    """The swissprot detail CSV is mirrored to R2; download prefers R2, falls back
    to pLannotate's GitHub raw — removing a second single-point-of-failure."""

    def test_curl_download_prefers_first_url_then_falls_back(
        self, tmp_path, monkeypatch
    ):
        import src.annotation.setup as setup

        dest = tmp_path / "out.gz"
        tried = []

        def fake_run(args, **kw):
            url = args[-1]
            tried.append(url)
            if len(tried) == 1:
                return subprocess.CompletedProcess(args, returncode=22, stderr="404")
            dest.write_bytes(b"csv")
            return subprocess.CompletedProcess(args, returncode=0, stderr="")

        monkeypatch.setattr(setup.subprocess, "run", fake_run)
        result = setup._curl_download(dest, ["https://r2/x", "https://github/x"], 30)
        assert result.returncode == 0 and dest.exists()
        assert tried == ["https://r2/x", "https://github/x"]

    def test_curl_download_hang_still_tries_the_fallback(self, tmp_path, monkeypatch):
        """ review: a HANGING first mirror (TimeoutExpired) must NOT prevent
        the fallback url from being tried — otherwise the SPOF-removal is defeated."""
        import src.annotation.setup as setup

        dest = tmp_path / "out.gz"
        tried = []

        def fake_run(args, **kw):
            tried.append(args[-1])
            assert "--proto" in args and "=https" in args
            if len(tried) == 1:
                raise subprocess.TimeoutExpired(cmd="curl", timeout=kw.get("timeout"))
            dest.write_bytes(b"csv")
            return subprocess.CompletedProcess(args, returncode=0, stderr="")

        monkeypatch.setattr(setup.subprocess, "run", fake_run)
        result = setup._curl_download(dest, ["https://r2/x", "https://github/x"], 5)
        assert result.returncode == 0 and dest.exists()
        assert len(tried) == 2

    def test_curl_download_total_failure_returns_last(self, tmp_path, monkeypatch):
        import src.annotation.setup as setup

        def fake_run(args, **kw):
            return subprocess.CompletedProcess(args, returncode=7, stderr="down")

        monkeypatch.setattr(setup.subprocess, "run", fake_run)
        result = setup._curl_download(
            tmp_path / "x.gz", ["https://r2/x", "https://github/x"], 5
        )
        assert result.returncode == 7 and result.stderr == "down"

    def test_download_databases_uses_r2_csv_first(self, tmp_path, monkeypatch):
        import src.annotation.setup as setup

        csv_urls = []

        def fake_run(args, **kw):
            if "-o" in args:
                out = Path(args[args.index("-o") + 1])
                out.write_bytes(b"x")
                if str(out).endswith("swissprot.csv.gz"):
                    csv_urls.append(args[-1])
            return subprocess.CompletedProcess(args, returncode=0, stdout="", stderr="")

        monkeypatch.setattr(setup.subprocess, "run", fake_run)
        archive_files = [
            expected
            for expected in setup.EXPECTED_DB_FILES
            if expected != "swissprot.csv.gz"
        ]
        monkeypatch.setattr(
            setup.tarfile, "open", lambda *a, **k: _NoopTar(archive_files)
        )

        result = setup.download_databases(tmp_path)
        assert result["success"] is True
        assert csv_urls and csv_urls[0] == setup.SWISSPROT_DETAILS_R2_URL


class _NoopTar:
    def __init__(self, extracted_files):
        self._extracted_files = extracted_files

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def extractall(self, path, *a, **k):
        for relative in self._extracted_files:
            destination = Path(path) / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.touch()


@pytest.mark.skipif(
    os.environ.get("WAYPOINT_ANNOTATION_DB_LIVE") != "1",
    reason="live R2 + diamond real-boundary test — set WAYPOINT_ANNOTATION_DB_LIVE=1",
)
class TestPlannotateDbsRealAsset:
    """Real-boundary proof: fetch the LIVE R2 slice, verify its sha256, swap it into
    a temp dir, and run the REAL ``diamond dbinfo`` validate probe. Downloads ~90 MB;
    opt-in only. Auto-skips if diamond can't be resolved on this machine."""

    def test_live_fetch_verify_swap_validate(self, tmp_path):
        import shutil as _sh

        from src.annotation.setup import (
            PLANNOTATE_DBS_FILES,
            PLANNOTATE_DBS_VERSION,
            PLANNOTATE_DBS_VERSION_FILE,
            _plannotate_dbs_spec,
            _validate_plannotate_dbs_loads,
        )
        from src.services.plannotate import find_binaries_dir, get_binary_path

        diamond = get_binary_path("diamond", find_binaries_dir()) or _sh.which(
            "diamond"
        )
        if not diamond:
            pytest.skip("diamond binary not resolvable on this machine")

        _seed_installed(tmp_path)
        au.download_and_swap_asset(_plannotate_dbs_spec(), tmp_path)

        blast = tmp_path / "BLAST_dbs"
        assert (blast / "swissprot.dmnd").stat().st_size > 100_000_000
        for f in PLANNOTATE_DBS_FILES:
            assert (blast / f).exists()
        recorded = json.loads((tmp_path / PLANNOTATE_DBS_VERSION_FILE).read_text())
        assert recorded["plannotate_dbs_version"] == PLANNOTATE_DBS_VERSION
        _validate_plannotate_dbs_loads(blast)
