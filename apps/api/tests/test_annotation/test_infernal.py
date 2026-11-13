"""Tests for vendored infernal parser."""

from pathlib import Path
from tempfile import NamedTemporaryFile

import pandas as pd


class TestParseInfernal:
    def test_parse_infernal_exists(self):
        from src.annotation.infernal import parse_infernal

        assert callable(parse_infernal)

    def test_parse_infernal_empty_file(self):
        """Empty cmscan output should return empty DataFrame, not crash."""
        from src.annotation.infernal import parse_infernal

        tmp = NamedTemporaryFile(mode="w", suffix=".txt", delete=False)
        tmp.write("#target name\n")
        tmp.write("#---\n")
        tmp.close()

        result = parse_infernal(tmp.name)
        assert isinstance(result, pd.DataFrame)
        assert len(result) == 0
        Path(tmp.name).unlink()

    def test_parse_infernal_empty_result_has_expected_columns(self):
        """Empty result DataFrame should have the standard columns for downstream compat."""
        from src.annotation.infernal import parse_infernal

        tmp = NamedTemporaryFile(mode="w", suffix=".txt", delete=False)
        tmp.write("# header line\n")
        tmp.write("# comment line\n")
        tmp.close()

        result = parse_infernal(tmp.name)
        assert isinstance(result, pd.DataFrame)
        assert len(result) == 0

        expected_cols = {
            "sseqid",
            "Feature",
            "qstart",
            "qend",
            "sstart",
            "send",
            "sframe",
            "score",
            "evalue",
            "Description",
            "qseq",
            "length",
            "slen",
            "pident",
        }
        assert expected_cols.issubset(
            set(result.columns)
        ), f"Missing columns: {expected_cols - set(result.columns)}"
        Path(tmp.name).unlink()

    def test_parse_infernal_single_line_file(self):
        """Single-line file (less than 2 lines) should return empty DataFrame."""
        from src.annotation.infernal import parse_infernal

        tmp = NamedTemporaryFile(mode="w", suffix=".txt", delete=False)
        tmp.write("# single header\n")
        tmp.close()

        result = parse_infernal(tmp.name)
        assert isinstance(result, pd.DataFrame)
        assert len(result) == 0
        Path(tmp.name).unlink()

    def test_parse_infernal_reads_commented_tblout_header_with_hits(self):
        """Infernal tblout uses commented #idx/#--- headers before hit rows."""
        from src.annotation.infernal import parse_infernal

        tmp = NamedTemporaryFile(mode="w", suffix=".txt", delete=False)
        tmp.write(
            "#idx target name            accession query name           accession clan name mdl mdl from   mdl to seq from   seq to strand trunc pass   gc  bias  score   E-value inc olp anyidx afrct1 afrct2 winidx wfrct1 wfrct2 mdl len seq len description of target\n"
        )
        tmp.write(
            "#--- ---------------------- --------- -------------------- --------- --------- --- -------- -------- -------- -------- ------ ----- ---- ---- ----- ------ --------- --- --- ------ ------ ------ ------ ------ ------ ------- ------- ---------------------\n"
        )
        tmp.write(
            "1    SSU_rRNA_bacteria      RF00177   rrsC_16S             -         CL00111    cm        1     1533        1     1542      +    no    1 0.54  14.0 1581.0         0  !   ^       -      -      -      -      -      -    1533    1542 Bacterial small subunit ribosomal RNA\n"
        )
        tmp.write("# Program: cmscan\n")
        tmp.close()

        try:
            result = parse_infernal(tmp.name)
        finally:
            Path(tmp.name).unlink()

        assert len(result) == 1
        assert result.loc[0, "Feature"] == "SSU rRNA bacteria"
        assert result.loc[0, "qstart"] == 1
        assert result.loc[0, "qend"] == 1542
        assert result.loc[0, "sframe"] == 1
        assert result.loc[0, "length"] == 1542
        assert result.loc[0, "evalue"] == 0
        assert "RF00177" in result.loc[0, "Description"]

    def test_parse_infernal_minus_strand_coordinates_do_not_overflow(self):
        """A 363 bp minus-strand RF00023 hit keeps raw 1-based coordinates."""
        import src.annotation.infernal as infernal_mod
        from src.annotation.annotate import calculate

        tmp = NamedTemporaryFile(mode="w", suffix=".txt", delete=False)
        tmp.write(
            "#idx target name          accession query name           accession clan name mdl mdl from   mdl to seq from   seq to strand trunc pass   gc  bias  score   E-value inc olp anyidx afrct1 afrct2 winidx wfrct1 wfrct2 mdl len seq len description of target\n"
        )
        tmp.write(
            "#--- -------------------- --------- -------------------- --------- --------- --- -------- -------- -------- -------- ------ ----- ---- ---- ----- ------ --------- --- --- ------ ------ ------ ------ ------ ------ ------- ------- ---------------------\n"
        )
        tmp.write(
            "1    tmRNA                RF00023   ssrA                 -         CL0001    cm        1      354      363        1      -    no    1 0.54   0.0  231.6     1e-68  !   ^       -      -      -      -      -      -     354     363 transfer-messenger RNA\n"
        )
        tmp.close()

        try:
            result = infernal_mod.parse_infernal(tmp.name)
        finally:
            Path(tmp.name).unlink()

        assert result.loc[0, "Feature"] == "tmRNA"
        assert result.loc[0, "qstart"] == 1
        assert result.loc[0, "qend"] == 363
        assert result.loc[0, "sframe"] == -1
        assert result.loc[0, "length"] == 363
        assert result.loc[0, "evalue"] == 1e-68
        assert "RF00023" in result.loc[0, "Description"]

        result["priority"] = 1
        result["qlen"] = 363
        calculated = calculate(result, is_linear=True)
        assert calculated.loc[0, "qstart"] == 0
        assert calculated.loc[0, "qend"] == 362
        assert calculated.loc[0, "qstart"] + 1 == 1
        assert calculated.loc[0, "qend"] + 1 == 363

    def test_parse_infernal_keeps_included_hit_with_malformed_large_evalue(self):
        """Included --cut_ga rows should survive pLannotate's generic evalue gate."""
        from src.annotation.infernal import parse_infernal

        tmp = NamedTemporaryFile(mode="w", suffix=".txt", delete=False)
        tmp.write(
            "#idx target name          accession query name           accession clan name mdl mdl from   mdl to seq from   seq to strand trunc pass   gc  bias  score   E-value inc olp anyidx afrct1 afrct2 winidx wfrct1 wfrct2 mdl len seq len description of target\n"
        )
        tmp.write(
            "#--- -------------------- --------- -------------------- --------- --------- --- -------- -------- -------- -------- ------ ----- ---- ---- ----- ------ --------- --- --- ------ ------ ------ ------ ------ ------ ------- ------- ---------------------\n"
        )
        tmp.write(
            "1    tmRNA                RF00023   ssrA                 -         CL0001    cm        1      354      363        1      -    no    1 0.54   0.0  231.6   1.6e+06  !   ^       -      -      -      -      -      -     354     363 transfer-messenger RNA\n"
        )
        tmp.close()

        try:
            result = parse_infernal(tmp.name)
        finally:
            Path(tmp.name).unlink()

        assert len(result) == 1
        assert result.loc[0, "Feature"] == "tmRNA"
        assert result.loc[0, "evalue"] == 0
        assert "inc" not in result.columns

    def test_no_streamlit_import(self):
        """Infernal module must not import streamlit."""
        import sys

        if "src.annotation.infernal" in sys.modules:
            del sys.modules["src.annotation.infernal"]
        from src.annotation import infernal as mod  # noqa: F401

        assert "streamlit" not in sys.modules
