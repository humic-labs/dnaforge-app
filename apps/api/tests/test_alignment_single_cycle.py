import asyncio
import threading
import time
from pathlib import Path
from types import MappingProxyType

import pytest
from fastapi import HTTPException

from src.tools import alignment

REFERENCE = "AACCGGTTAACG"
QUERY = "AACCGGATAACG"
REPEATED_OUTPUT = (
    f">reference\n{REFERENCE * 2}\n>query\n{QUERY[:3]}{'-' * 6}{QUERY[3:6]}{'-' * 6}{QUERY[6:]}\n"
)
SINGLE_OUTPUT = f">reference\n{REFERENCE}\n>query\n{QUERY}\n"


@pytest.mark.asyncio
async def test_circular_alignment_preserves_one_reference_and_all_query_bases(
    monkeypatch,
):
    inputs = []

    async def run(args, **_kwargs):
        inputs.append(Path(args[-1]).read_text())
        return (REPEATED_OUTPUT if len(inputs) == 1 else SINGLE_OUTPUT), ""

    monkeypatch.setattr(alignment, "run_mafft", run)
    result = await alignment._execute_pairwise_alignment(
        alignment.PairwiseAlignmentRequest(
            query=QUERY, reference=REFERENCE, is_circular=True, use_cache=False
        )
    )

    assert result.aligned_reference.replace("-", "") == REFERENCE
    assert result.aligned_query.replace("-", "") == QUERY
    assert result.circular_offset == 0
    assert len(inputs) == 2
    assert inputs[1] == f">reference\n{REFERENCE}\n>query\n{QUERY}\n"
    assert [(mutation.type, mutation.position) for mutation in result.mutations] == [
        ("substitution", 7)
    ]
    assert any(
        warning["type"] == "circular_alignment_recomputed"
        for warning in result.analysis["warnings"]
    )


@pytest.mark.asyncio
async def test_partial_circular_alignment_keeps_structural_mutations_in_local_coordinates(
    monkeypatch,
):
    reference = "ATGAAACCCGGGTAA"
    query = "GGCTAAATGA"
    mafft_output = f">reference\n{reference * 2}\n>query\n{'-' * 9}{query}{'-' * 11}\n"
    inputs = []
    structural_inputs = []
    analyze_structure = alignment.analyze_alignment_structure

    async def run(args, **_kwargs):
        inputs.append(Path(args[-1]).read_text())
        return mafft_output, ""

    def record_structural_input(aligned_reference, aligned_query, mutations, **kwargs):
        structural_inputs.append(
            (aligned_reference, aligned_query, [dict(mutation) for mutation in mutations])
        )
        return analyze_structure(aligned_reference, aligned_query, mutations, **kwargs)

    monkeypatch.setattr(alignment, "run_mafft", run)
    monkeypatch.setattr(alignment, "analyze_alignment_structure", record_structural_input)
    result = await alignment._execute_pairwise_alignment(
        alignment.PairwiseAlignmentRequest(
            query=query, reference=reference, is_circular=True, use_cache=False
        )
    )

    assert inputs == [f">reference\n{reference * 2}\n>query\n{query}\n"]
    assert result.aligned_reference == "GGGTAAATGA"
    assert result.aligned_query == query
    assert result.circular_offset == 9
    assert [(mutation.type, mutation.position) for mutation in result.mutations] == [
        ("substitution", 12)
    ]
    assert result.analysis["point_mutations"][0]["position"] == 12
    assert result.analysis["point_mutations"][0]["column"] == 2
    assert structural_inputs == [
        (
            "GGGTAAATGA",
            query,
            [
                {
                    "type": "substitution",
                    "position": 12,
                    "column": 2,
                    "length": 1,
                    "ref_base": "G",
                    "query_base": "C",
                }
            ],
        )
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["canceled", "timeout"])
async def test_single_cycle_recomputation_keeps_cancellation_and_deadline(monkeypatch, failure):
    calls = []
    cancel = threading.Event()
    deadline = time.monotonic() + 10
    runtime = alignment.MafftRuntime("mafft", MappingProxyType({}))

    async def run(_args, **kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            return REPEATED_OUTPUT, ""
        if failure == "canceled":
            raise alignment.AlignmentCanceled()
        raise asyncio.TimeoutError()

    monkeypatch.setattr(alignment, "run_mafft", run)
    expected = alignment.AlignmentCanceled if failure == "canceled" else HTTPException
    with pytest.raises(expected) as caught:
        await alignment._execute_pairwise_alignment(
            alignment.PairwiseAlignmentRequest(
                query=QUERY, reference=REFERENCE, is_circular=True, use_cache=False
            ),
            timeout_seconds=10,
            cancel_event=cancel,
            runtime=runtime,
            deadline=deadline,
        )

    assert len(calls) == 2
    assert all(call["cancel_event"] is cancel for call in calls)
    assert all(call["runtime"] is runtime for call in calls)
    assert all(call["deadline"] == deadline for call in calls)
    if failure == "timeout":
        assert caught.value.status_code == 504
