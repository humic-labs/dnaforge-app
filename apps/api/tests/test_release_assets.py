"""Contract tests for mirrored bioinformatics release assets."""

import json
from pathlib import Path

from src.annotation.setup import (
    PLANNOTATE_DBS_URL,
    RFAM_DB_URL,
    SWISSPROT_DETAILS_R2_URL,
)
from src.annotation.tools import TOOL_REGISTRY

REPO_ROOT = Path(__file__).resolve().parents[3]
LOCK_PATH = REPO_ROOT / ".ci" / "release-assets.lock.json"


def test_runtime_tool_registry_matches_release_asset_lock():
    """Every runtime download must resolve to the immutable DNAForge mirror."""
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    public_base_url = lock["publicBaseUrl"].rstrip("/")

    assert set(TOOL_REGISTRY) == set(lock["tools"])
    for tool_name, tool in TOOL_REGISTRY.items():
        locked_tool = lock["tools"][tool_name]
        assert tool["version"] == locked_tool["version"]
        assert set(tool["platforms"]) == set(locked_tool["platforms"])

        for platform, runtime_asset in tool["platforms"].items():
            locked_asset = locked_tool["platforms"][platform]
            assert runtime_asset["url"] == (f"{public_base_url}/{locked_asset['key']}")
            assert runtime_asset["sha256"] == locked_asset["sha256"]
            assert runtime_asset["archive_type"] == locked_asset["archiveType"]


def test_release_asset_lock_is_the_only_runtime_download_origin():
    public_base_url = json.loads(LOCK_PATH.read_text(encoding="utf-8"))["publicBaseUrl"]
    runtime_urls = [
        asset["url"]
        for tool in TOOL_REGISTRY.values()
        for asset in tool["platforms"].values()
    ]
    runtime_urls += [RFAM_DB_URL, PLANNOTATE_DBS_URL, SWISSPROT_DETAILS_R2_URL]

    for url in runtime_urls:
        assert url.startswith(f"{public_base_url.rstrip('/')}/"), url


def test_release_assets_are_not_served_from_the_rate_limited_r2_dev_address():
    public_base_url = json.loads(LOCK_PATH.read_text(encoding="utf-8"))["publicBaseUrl"]
    assert ".r2.dev" not in public_base_url
