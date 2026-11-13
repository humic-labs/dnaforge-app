"""Real MAFFT regression for clone inputs with another strand/circular origin."""

import random
from pathlib import Path

import pytest
from Bio import SeqIO

from src.tools.alignment import PairwiseAlignmentRequest, _execute_pairwise_alignment


@pytest.mark.asyncio
async def test_complete_saved_assembly_read_does_not_keep_an_unused_reference_copy():
    fixture = (
        Path(__file__).resolve().parents[3]
        / "test-fixtures/sequences/circular/pUC19.gb"
    )
    template = str(SeqIO.read(fixture, "genbank").seq)

    reference = template[120:540] + template[900:1320]
    result = await _execute_pairwise_alignment(
        PairwiseAlignmentRequest(
            reference=reference,
            query=reference,
            is_circular=True,
            use_cache=False,
            threads=4,
        ),
        timeout_seconds=30,
    )

    assert result.aligned_reference.upper() == reference.upper()
    assert result.aligned_query.upper() == reference.upper()
    assert result.circular_offset == 0
    assert result.identity == 100
    assert result.mutations == []


@pytest.mark.asyncio
@pytest.mark.parametrize("circular", [False, True])
async def test_clone_keeps_reference_coordinates_across_strand_and_origin(circular):
    rng = random.Random(3191)
    reference = "".join(rng.choice("ACGT") for _ in range(600))
    changed = list(reference)
    changed[52] = "A" if reference[52] != "A" else "C"
    query = "".join(changed)
    if circular:
        query = query[137:] + query[:137]
    query = query.translate(str.maketrans("ACGT", "TGCA"))[::-1]

    result = await _execute_pairwise_alignment(
        PairwiseAlignmentRequest(
            reference=reference,
            query=query,
            is_circular=circular,
            use_cache=False,
            threads=1,
        ),
        timeout_seconds=30,
    )

    assert result.aligned_reference.replace("-", "").upper() == reference
    assert result.circular_offset == 0
    assert [
        (m.type, m.position, (m.ref_base or "").upper(), (m.query_base or "").upper())
        for m in result.mutations
    ] == [
        ("substitution", 53, reference[52], changed[52]),
    ]


@pytest.mark.asyncio
async def test_partial_clone_keeps_only_observed_changes():
    rng = random.Random(3191)
    reference = "".join(rng.choice("ACGT") for _ in range(600))
    query = list(reference[100:500])
    query[100] = "A" if reference[200] != "A" else "C"
    query[250] = "N"
    result = await _execute_pairwise_alignment(
        PairwiseAlignmentRequest(
            reference=reference, query="".join(query), use_cache=False, threads=1
        ),
        timeout_seconds=30,
    )
    assert result.aligned_reference.replace("-", "").upper() == reference
    assert [(m.type, m.position) for m in result.mutations] == [("substitution", 201)]
    assert result.analysis["structural_regions"] == []
