"""Tests for vendored annotation resources."""

from unittest.mock import patch


class TestResources:
    def test_get_yaml_path_returns_path(self):
        from src.annotation.resources import get_yaml_path

        path = get_yaml_path()
        assert path is not None
        assert "databases.yml" in str(path)

    def test_get_yaml_parses_databases(self):
        from src.annotation.resources import get_yaml, get_yaml_path

        path = get_yaml_path()
        databases = get_yaml(path)
        assert isinstance(databases, dict)
        assert "Rfam" in databases
        assert "fpbase" in databases
        assert "swissprot" in databases
        assert "snapgene" in databases

    def test_df_cols_constant_exists(self):
        from src.annotation.resources import DF_COLS

        assert isinstance(DF_COLS, list)
        assert "sseqid" in DF_COLS
        assert "qstart" in DF_COLS

    def test_no_streamlit_import(self):
        import sys

        if "src.annotation.resources" in sys.modules:
            del sys.modules["src.annotation.resources"]
        from src.annotation import resources as mod  # noqa: F401

        assert "streamlit" not in sys.modules


class TestDatabasesExistResolution:
    """databases_exist() must check the app data dir, not just the package dir."""

    def test_databases_exist_checks_app_data_dir(self, tmp_path):
        from src.annotation.resources import databases_exist
        from tests.test_annotation.test_setup import create_expected_database_files

        data_dir = tmp_path / "annotation"
        create_expected_database_files(data_dir)
        with patch.dict("os.environ", {"WAYPOINT_DATA_DIR": str(tmp_path)}):
            assert databases_exist() is True

    def test_databases_exist_rejects_partial_app_data_dir(self, tmp_path):
        from src.annotation.resources import databases_exist

        data_dir = tmp_path / "annotation"
        blast_dir = data_dir / "BLAST_dbs"
        blast_dir.mkdir(parents=True)
        (blast_dir / "Rfam.cm").write_bytes(b"partial")
        with patch.dict("os.environ", {"WAYPOINT_DATA_DIR": str(tmp_path)}):
            assert databases_exist() is False

    def test_databases_exist_false_when_no_dbs_anywhere(self, tmp_path):
        from src.annotation.resources import databases_exist

        with patch.dict("os.environ", {"WAYPOINT_DATA_DIR": str(tmp_path)}):
            assert databases_exist() is False

    def test_get_yaml_resolves_default_to_app_data_dir(self, tmp_path):
        from src.annotation.resources import get_yaml, get_yaml_path

        data_dir = tmp_path / "annotation"
        blast_dir = data_dir / "BLAST_dbs"
        blast_dir.mkdir(parents=True)
        with patch.dict("os.environ", {"WAYPOINT_DATA_DIR": str(tmp_path)}):
            dbs = get_yaml(get_yaml_path())
            assert str(blast_dir) in dbs["snapgene"]["db_loc"]

    def test_get_yaml_falls_back_to_package_dir(self):
        import tempfile

        from src.annotation.resources import get_yaml, get_yaml_path

        with tempfile.TemporaryDirectory() as empty_dir:
            with patch.dict("os.environ", {"WAYPOINT_DATA_DIR": empty_dir}):
                dbs = get_yaml(get_yaml_path())
                assert "db_loc" in dbs["snapgene"]


class TestInfernalTupleDbLoc:
    """Infernal db_loc is a (clanin, cm) tuple, not a string."""

    def test_infernal_db_loc_is_tuple(self):
        from src.annotation.resources import get_yaml, get_yaml_path

        dbs = get_yaml(get_yaml_path())
        for db_name, db_info in dbs.items():
            if db_info.get("method") == "infernal":
                assert isinstance(
                    db_info["db_loc"], tuple
                ), f"{db_name}: infernal db_loc should be tuple, got {type(db_info['db_loc'])}"
                assert len(db_info["db_loc"]) == 2
                assert db_info["db_loc"][0].endswith(".clanin")
                assert db_info["db_loc"][1].endswith(".cm")

    def test_non_infernal_db_loc_is_string(self):
        from src.annotation.resources import get_yaml, get_yaml_path

        dbs = get_yaml(get_yaml_path())
        for db_name, db_info in dbs.items():
            if db_info.get("method") != "infernal":
                assert isinstance(
                    db_info["db_loc"], str
                ), f"{db_name}: non-infernal db_loc should be str, got {type(db_info['db_loc'])}"
