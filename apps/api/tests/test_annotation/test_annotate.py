"""Tests for vendored annotation engine — annotate module."""

import gzip
import os
import shutil
import subprocess

import pandas as pd
import pytest


class TestBLASTDispatch:
    """Tests for the BLAST/Diamond/Infernal dispatch function."""

    def test_blast_function_exists(self):
        from src.annotation.annotate import BLAST

        assert callable(BLAST)

    def test_calculate_function_exists(self):
        from src.annotation.annotate import calculate

        assert callable(calculate)

    def test_clean_function_exists(self):
        from src.annotation.annotate import clean

        assert callable(clean)

    def test_annotate_function_exists(self):
        from src.annotation.annotate import annotate

        assert callable(annotate)

    def test_resolve_executable_uses_path_key_casing(self, monkeypatch):
        import importlib

        ann = importlib.import_module("src.annotation.annotate")
        seen = {}

        def fake_which(name, *, path=None):
            seen["name"] = name
            seen["path"] = path
            return "C:/tools/blastn.exe"

        monkeypatch.setattr(ann.shutil, "which", fake_which)

        resolved = ann._resolve_executable("blastn", env={"Path": "C:/tools"})

        assert resolved == "C:/tools/blastn.exe"
        assert seen == {"name": "blastn", "path": "C:/tools"}


class TestAnnotateNoStreamlit:
    """Verify streamlit is not imported."""

    def test_no_streamlit_import(self):
        """The vendored annotate module must not import streamlit."""
        import sys

        if "src.annotation.annotate" in sys.modules:
            del sys.modules["src.annotation.annotate"]

        from src.annotation import annotate as mod  # noqa: F401

        assert (
            "streamlit" not in sys.modules
        ), "streamlit was imported by annotation.annotate"


class TestCalculateScoring:
    """Tests for the calculate() scoring function."""

    def test_calculate_adds_score_column(self):
        from src.annotation.annotate import calculate

        df = pd.DataFrame(
            {
                "qstart": [10],
                "qend": [50],
                "length": [40],
                "slen": [100],
                "pident": [95.0],
                "priority": [1],
                "qlen": [200],
            }
        )
        result = calculate(df, is_linear=True)
        assert "score" in result.columns
        assert "percmatch" in result.columns

    def test_calculate_circular_halves_qlen(self):
        from src.annotation.annotate import calculate

        df = pd.DataFrame(
            {
                "qstart": [10],
                "qend": [50],
                "length": [40],
                "slen": [100],
                "pident": [95.0],
                "priority": [1],
                "qlen": [200],
            }
        )
        result = calculate(df, is_linear=False)
        assert result["qlen"].iloc[0] == 100


class TestCleanOverlapFiltering:
    """Tests for clean() overlap handling."""

    def test_clean_handles_small_infernal_window_with_larger_query_length(self):
        """Regression for numpy int8 scalar overflow in Rfam ssrA cleanup."""
        from src.annotation.annotate import clean

        df = pd.DataFrame(
            {
                "qstart": pd.Series([0], dtype="int64"),
                "qend": pd.Series([60], dtype="int64"),
                "sseqid": ["RF00023"],
                "evalue": [0.0],
                "pi_permatch": [100.0],
                "qlen": pd.Series([363], dtype="int64"),
                "wstart": pd.Series([9], dtype="int64"),
                "wend": pd.Series([51], dtype="int64"),
                "kind": [1],
            }
        )

        result = clean(df)

        assert len(result) == 1
        assert result.loc[0, "sseqid"] == "RF00023"


class TestSafeDbPath:
    """Test _safe_db_path() symlink workaround for paths with spaces."""

    def test_no_space_passthrough(self, tmp_path):
        """Path without spaces returns unchanged, no cleanup needed."""
        from src.annotation.annotate import _safe_db_path

        db = tmp_path / "blastdb"
        db.touch()
        result, cleanup = _safe_db_path(str(db))
        assert result == str(db)
        assert cleanup is None

    def test_space_creates_symlinks(self, tmp_path):
        """Path with spaces creates symlinks in a temp dir."""
        from src.annotation.annotate import _safe_db_path

        space_dir = tmp_path / "Application Support" / "dbs"
        space_dir.mkdir(parents=True)
        base = space_dir / "snapgene"
        for ext in [".nsq", ".nin", ".nhr"]:
            (space_dir / f"snapgene{ext}").write_bytes(b"data")

        result, cleanup = _safe_db_path(str(base))
        assert cleanup is not None
        assert " " not in result
        assert os.path.islink(result + ".nsq")
        assert os.path.islink(result + ".nin")
        assert os.path.islink(result + ".nhr")
        assert os.path.realpath(result + ".nsq") == str(space_dir / "snapgene.nsq")
        shutil.rmtree(cleanup)
        assert not os.path.exists(cleanup)

    def test_windows_space_copies_db_files(self, tmp_path, monkeypatch):
        """Windows users should not need symlink privilege for spaced DB paths."""
        import importlib

        ann = importlib.import_module("src.annotation.annotate")
        monkeypatch.setattr(ann.os, "name", "nt")

        space_dir = tmp_path / "Application Support" / "dbs"
        space_dir.mkdir(parents=True)
        base = space_dir / "snapgene"
        for ext in [".nsq", ".nin", ".nhr"]:
            (space_dir / f"snapgene{ext}").write_bytes(b"data")

        result, cleanup = ann._safe_db_path(str(base))
        try:
            assert cleanup is not None
            assert " " not in result
            assert not os.path.islink(result + ".nsq")
            assert (result + ".nsq") != str(space_dir / "snapgene.nsq")
            assert open(result + ".nsq", "rb").read() == b"data"
        finally:
            shutil.rmtree(cleanup)

    def test_space_temp_dir_prefix(self, tmp_path):
        """Temp dir has blast_db_ prefix."""
        from src.annotation.annotate import _safe_db_path

        space_dir = tmp_path / "path with spaces"
        space_dir.mkdir()
        (space_dir / "db").touch()
        _, cleanup = _safe_db_path(str(space_dir / "db"))
        assert "blast_db_" in cleanup
        shutil.rmtree(cleanup)

    def test_infernal_two_paths(self, tmp_path):
        """Infernal needs two _safe_db_path calls (clanin + cm)."""
        from src.annotation.annotate import _safe_db_path

        space_dir = tmp_path / "Application Support" / "dbs"
        space_dir.mkdir(parents=True)
        (space_dir / "Rfam.clanin").write_bytes(b"data")
        (space_dir / "Rfam.cm").write_bytes(b"data")
        (space_dir / "Rfam.cm.i1m").write_bytes(b"data")

        safe1, tmp1 = _safe_db_path(str(space_dir / "Rfam.clanin"))
        safe2, tmp2 = _safe_db_path(str(space_dir / "Rfam.cm"))

        assert tmp1 is not None and tmp2 is not None
        assert " " not in safe1
        assert " " not in safe2
        assert tmp1 != tmp2

        shutil.rmtree(tmp1)
        shutil.rmtree(tmp2)

    def test_infernal_nonzero_exit_is_fatal(self, tmp_path, monkeypatch):
        """A broken cmscan build must not silently parse empty hits."""
        import importlib

        ann = importlib.import_module("src.annotation.annotate")
        monkeypatch.setattr(ann, "parse_infernal", lambda _path: pd.DataFrame())

        def fake_run(*_args, **_kwargs):
            return subprocess.CompletedProcess(
                args=["cmscan"], returncode=2, stdout="", stderr="bad cmscan"
            )

        monkeypatch.setattr(ann.subprocess, "run", fake_run)

        db = {
            "method": "infernal",
            "parameters": "--cpu 1",
            "db_loc": (str(tmp_path / "Rfam.clanin"), str(tmp_path / "Rfam.cm")),
        }
        (tmp_path / "Rfam.clanin").write_text("clan")
        (tmp_path / "Rfam.cm").write_text("cm")

        with pytest.raises(RuntimeError, match="bad cmscan"):
            ann.BLAST("ACGT", db, env={"PATH": "test-bin"})

    def test_subprocess_env_is_forwarded(self, tmp_path, monkeypatch):
        import importlib

        ann = importlib.import_module("src.annotation.annotate")
        seen_env = None

        def fake_run(*_args, **kwargs):
            nonlocal seen_env
            seen_env = kwargs.get("env")
            args = _args[0]
            tmp_name = args[args.index("-out") + 1]
            with open(tmp_name, "w", encoding="utf-8") as fh:
                fh.write("")
            return subprocess.CompletedProcess(args=["blastn"], returncode=0)

        monkeypatch.setattr(ann.subprocess, "run", fake_run)
        db = {
            "method": "blastn",
            "parameters": "",
            "db_loc": str(tmp_path / "snapgene"),
        }

        ann.BLAST("ACGT", db, env={"PATH": "custom-path"})

        assert seen_env == {"PATH": "custom-path"}

    def test_subprocess_uses_resolved_executable(self, tmp_path, monkeypatch):
        import importlib

        ann = importlib.import_module("src.annotation.annotate")
        seen_args = None

        def fake_run(*_args, **_kwargs):
            nonlocal seen_args
            seen_args = _args[0]
            tmp_name = seen_args[seen_args.index("-out") + 1]
            with open(tmp_name, "w", encoding="utf-8") as fh:
                fh.write("")
            return subprocess.CompletedProcess(args=seen_args, returncode=0)

        monkeypatch.setattr(
            ann, "_resolve_executable", lambda name, env=None: f"/tools/{name}"
        )
        monkeypatch.setattr(ann.subprocess, "run", fake_run)
        db = {
            "method": "blastn",
            "parameters": "",
            "db_loc": str(tmp_path / "snapgene"),
        }

        ann.BLAST("ACGT", db, env={"Path": "/tools"})

        assert seen_args[0] == "/tools/blastn"


class TestParseGz:
    """Test parse_gz() gzip CSV lookup for swissprot features."""

    def test_returns_matching_rows(self, tmp_path):
        from src.annotation.annotate import parse_gz

        gz_path = tmp_path / "test.csv.gz"
        with gzip.open(gz_path, "wt") as f:
            f.write("P62593,AmpR,Beta-lactamase\n")
            f.write("A7ZI91,lacZ,Beta-galactosidase\n")
            f.write("Q99999,GFP,Green fluorescent protein\n")

        result = parse_gz(["P62593", "A7ZI91"], str(gz_path))
        assert len(result) == 2
        assert list(result.columns) == ["sseqid", "Feature", "Description"]
        assert set(result["sseqid"]) == {"P62593", "A7ZI91"}

    def test_no_matches_returns_empty_df(self, tmp_path):
        from src.annotation.annotate import parse_gz

        gz_path = tmp_path / "test.csv.gz"
        with gzip.open(gz_path, "wt") as f:
            f.write("P62593,AmpR,Beta-lactamase\n")

        result = parse_gz(["NONEXISTENT"], str(gz_path))
        assert len(result) == 0
        assert list(result.columns) == ["sseqid", "Feature", "Description"]

    def test_only_first_three_columns(self, tmp_path):
        """Extra columns beyond 3 are ignored."""
        from src.annotation.annotate import parse_gz

        gz_path = tmp_path / "test.csv.gz"
        with gzip.open(gz_path, "wt") as f:
            f.write("P62593,AmpR,Beta-lactamase,extra1,extra2\n")

        result = parse_gz(["P62593"], str(gz_path))
        assert list(result.columns) == ["sseqid", "Feature", "Description"]
        assert result.iloc[0]["Feature"] == "AmpR"

    def test_handles_unicode_errors(self, tmp_path):
        """Invalid UTF-8 bytes are replaced, not crashing."""
        from src.annotation.annotate import parse_gz

        gz_path = tmp_path / "test.csv.gz"
        with gzip.open(gz_path, "wb") as f:
            f.write(b"P62593,AmpR,Beta-\xff-lactamase\n")

        result = parse_gz(["P62593"], str(gz_path))
        assert len(result) == 1


class TestNumericColumnCoercion:
    """Test that sseqid stays string while numeric columns convert."""

    def test_sseqid_preserved_as_string(self):
        """sseqid column must NOT be converted to numeric (breaks .str methods)."""
        df = pd.DataFrame(
            {
                "sseqid": ["12345", "67890"],
                "pident": ["99.5", "87.3"],
                "length": ["500", "300"],
                "qseq": ["ATCG", "GCTA"],
            }
        )
        string_cols = {"sseqid", "qseq"}
        for col in df.columns:
            if col in string_cols:
                continue
            try:
                df[col] = pd.to_numeric(df[col])
            except (ValueError, TypeError):
                pass

        assert pd.api.types.is_string_dtype(df["sseqid"])
        assert pd.api.types.is_string_dtype(df["qseq"])
        assert pd.api.types.is_numeric_dtype(df["pident"])
        assert pd.api.types.is_numeric_dtype(df["length"])

    def test_mixed_type_column_survives(self):
        """Column with mixed types doesn't crash (silent fail)."""
        df = pd.DataFrame({"col": ["abc", "123", "def"]})
        try:
            df["col"] = pd.to_numeric(df["col"])
        except (ValueError, TypeError):
            pass
        assert "abc" in df["col"].values
