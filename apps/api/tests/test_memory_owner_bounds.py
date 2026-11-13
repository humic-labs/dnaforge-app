from __future__ import annotations

import threading
from pathlib import Path

from src.services import annotation_tiles, coverage_pyramid


def test_base_layer_lock_owner_retires_after_last_waiter(tmp_path: Path) -> None:
    cache_path = tmp_path / "coverage.npy"
    first_entered = threading.Event()
    release_first = threading.Event()
    second_entered = threading.Event()

    def first() -> None:
        with coverage_pyramid._base_layer_lock(cache_path):
            first_entered.set()
            assert release_first.wait(timeout=2)

    def second() -> None:
        assert first_entered.wait(timeout=2)
        with coverage_pyramid._base_layer_lock(cache_path):
            second_entered.set()

    with coverage_pyramid._BASE_LAYER_LOCKS_GUARD:
        coverage_pyramid._BASE_LAYER_LOCKS.clear()

    first_thread = threading.Thread(target=first)
    second_thread = threading.Thread(target=second)
    first_thread.start()
    second_thread.start()

    assert first_entered.wait(timeout=2)
    assert not second_entered.wait(timeout=0.05)
    release_first.set()
    first_thread.join(timeout=2)
    second_thread.join(timeout=2)

    assert not first_thread.is_alive()
    assert not second_thread.is_alive()
    assert second_entered.is_set()
    with coverage_pyramid._BASE_LAYER_LOCKS_GUARD:
        assert coverage_pyramid._BASE_LAYER_LOCKS == {}


def test_depth_summary_memos_are_lru_bounded() -> None:
    coverage_pyramid._clear_depth_summary_memos()
    limit = coverage_pyramid._DEPTH_SUMMARY_MEMO_MAX

    for index in range(limit):
        coverage_pyramid._store_depth_summary_memo(
            coverage_pyramid._DEPTH_SCALE_MEMO,
            f"scale-{index}",
            {"value": index},
        )
    assert coverage_pyramid._read_depth_summary_memo(
        coverage_pyramid._DEPTH_SCALE_MEMO,
        "scale-0",
    ) == {"value": 0}
    coverage_pyramid._store_depth_summary_memo(
        coverage_pyramid._DEPTH_SCALE_MEMO,
        "overflow",
        {"value": limit},
    )

    assert len(coverage_pyramid._DEPTH_SCALE_MEMO) == limit
    assert "scale-1" not in coverage_pyramid._DEPTH_SCALE_MEMO
    assert "scale-0" in coverage_pyramid._DEPTH_SCALE_MEMO
    coverage_pyramid._clear_depth_summary_memos()


def test_verified_annotation_artifacts_are_lru_bounded() -> None:
    annotation_tiles._clear_verified_artifacts()
    limit = annotation_tiles._VERIFIED_ARTIFACTS_MAX

    for index in range(limit):
        annotation_tiles._remember_verified_artifact(f"artifact-{index}")
    assert annotation_tiles._is_verified_artifact("artifact-0")
    annotation_tiles._remember_verified_artifact("overflow")

    assert len(annotation_tiles._VERIFIED_ARTIFACTS) == limit
    assert not annotation_tiles._is_verified_artifact("artifact-1")
    assert annotation_tiles._is_verified_artifact("artifact-0")
    annotation_tiles._clear_verified_artifacts()
