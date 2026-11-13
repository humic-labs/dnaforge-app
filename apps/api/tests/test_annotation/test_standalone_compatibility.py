from __future__ import annotations

import asyncio
import importlib
import sys
import threading
import tomllib
from pathlib import Path

import pandas as pd
import pytest


def test_legacy_scientific_modules_are_thin_biopython_free_adapters() -> None:
    annotation_dir = Path(__file__).parents[2] / "src" / "annotation"
    for name in ("annotate.py", "infernal.py"):
        source = (annotation_dir / name).read_text()
        assert "from Bio" not in source
        assert "import Bio" not in source
        assert len(source.splitlines()) < 25


def test_legacy_annotate_module_preserves_monkeypatch_seams() -> None:
    imported_biopython_modules = {
        name for name in sys.modules if name == "Bio" or name.startswith("Bio.")
    }
    legacy = importlib.import_module("src.annotation.annotate")
    standalone = importlib.import_module("dnaforge_annotation.engine")

    assert legacy is standalone
    assert legacy.annotate is standalone.annotate
    assert {
        name for name in sys.modules if name == "Bio" or name.startswith("Bio.")
    } == imported_biopython_modules


def test_service_reexports_the_shared_validated_contract() -> None:
    from dnaforge_annotation.contract import AnnotationRequest as SharedRequest
    from dnaforge_annotation.contract import AnnotationResult as SharedResult

    from src.services.plannotate import AnnotationRequest, AnnotationResult

    assert AnnotationRequest is SharedRequest
    assert AnnotationResult is SharedResult


def test_sidecar_declares_the_local_standalone_distribution() -> None:
    api_root = Path(__file__).parents[2]
    project = tomllib.loads((api_root / "pyproject.toml").read_text())

    assert "dnaforge-annotation" in project["project"]["dependencies"]
    assert project["tool"]["uv"]["sources"]["dnaforge-annotation"] == {
        "path": "../../packages/annotation",
        "editable": True,
    }


@pytest.mark.asyncio
async def test_cancelled_awaiter_does_not_release_physical_engine_capacity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import src.services.plannotate as plannotate
    from src.services.plannotate import PlannotateService

    service = PlannotateService()
    engine = importlib.import_module("src.annotation.annotate")
    first_entered = threading.Event()
    release_first = threading.Event()
    calls = 0

    def held_annotate(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            first_entered.set()
            assert release_first.wait(timeout=5)
        return pd.DataFrame()

    monkeypatch.setattr(engine, "annotate", held_annotate)
    monkeypatch.setattr(
        plannotate,
        "check_required_binaries",
        lambda _directory: {
            "blastn": "/tools/blastn",
            "diamond": "/tools/diamond",
            "cmscan": "/tools/cmscan",
        },
    )
    first = asyncio.create_task(service._run_plannotate("AAAA", linear=True))
    await asyncio.to_thread(first_entered.wait, 2)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first

    second = asyncio.create_task(service._run_plannotate("CCCC", linear=True))
    await asyncio.sleep(0.05)
    try:
        assert calls == 1
    finally:
        release_first.set()
        await second

    assert calls == 2
