import runpy
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.mark.parametrize("minimum_score", [None, 25])
def test_vendored_cli_forwards_chaining_score_and_alignment_options(
    monkeypatch, minimum_score
):
    calls = []
    mapped = []

    def aligner(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(
            map=lambda sequence, **options: mapped.append((sequence, options)) or []
        )

    monkeypatch.setitem(
        sys.modules,
        "mappy",
        SimpleNamespace(
            Aligner=aligner, fastx_read=lambda path: [("query", "ACGT", None)]
        ),
    )
    cli = Path(__file__).resolve().parents[1] / "vendor/mappy/python/minimap2.py"
    main = runpy.run_path(str(cli), run_name="dnaforge_mappy_cli")["main"]
    arguments = [
        "minimap2.py",
        "-x",
        "asm5",
        "-n",
        "3",
        "-k",
        "11",
        "-w",
        "3",
        "-r",
        "500",
        "-c",
        "-d",
        "-M",
    ]
    if minimum_score is not None:
        arguments += ["-m", str(minimum_score)]
    main([*arguments, "reference.fa", "query.fa"])
    assert calls == [
        (
            ("reference.fa",),
            {
                "preset": "asm5",
                "min_cnt": 3,
                "min_chain_score": minimum_score,
                "k": 11,
                "w": 3,
                "bw": 500,
            },
        )
    ]
    assert mapped == [("ACGT", {"cs": True, "ds": True, "MD": True})]
