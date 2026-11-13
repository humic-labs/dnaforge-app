"""App resource compatibility over the standalone annotation package."""

from pathlib import Path

from dnaforge_annotation.resources import *  # noqa: F403
from dnaforge_annotation.resources import (
    get_details as _get_details,
)
from dnaforge_annotation.resources import (
    get_yaml as _get_yaml,
)


def get_details(name: str) -> str:
    from .setup import get_annotation_data_dir

    return _get_details(name, data_dir=get_annotation_data_dir())


def get_yaml(yaml_file_loc):
    from .setup import get_annotation_data_dir

    data_dir = get_annotation_data_dir()
    return _get_yaml(
        yaml_file_loc,
        data_dir=data_dir if (data_dir / "BLAST_dbs").is_dir() else None,
    )


def databases_exist() -> bool:
    from .setup import get_annotation_data_dir, validate_databases

    data_dir = get_annotation_data_dir()
    return validate_databases(data_dir) if (data_dir / "BLAST_dbs").is_dir() else False


ROOT_DIR = str(Path(__file__).parent)
