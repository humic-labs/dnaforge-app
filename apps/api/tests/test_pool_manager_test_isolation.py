"""Regression proof for process-global pool-manager isolation between tests."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def test_pool_manager_override_is_restored_between_tests(tmp_path: Path) -> None:
    """A reduced pool configuration must not leak into the next test."""

    probe = tmp_path / "test_pool_manager_boundary.py"
    probe.write_text(
        """
from src.concurrency.pools import PoolConfig, get_pool_manager, reset_pool_manager
from src.concurrency.schema import PoolName


def test_install_reduced_pool_manager():
    reset_pool_manager(
        [PoolConfig(PoolName.CPU_SLOW.value, 1, 1, "asyncio-test")]
    )
    assert set(get_pool_manager().stats()) == {PoolName.CPU_SLOW.value}


def test_next_test_starts_with_every_default_pool():
    assert set(get_pool_manager().stats()) == {pool.value for pool in PoolName}
""",
        encoding="utf-8",
    )

    api_root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-p",
            "tests.conftest",
            "--rootdir",
            str(api_root),
            str(probe),
            "-q",
        ],
        cwd=api_root,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr
