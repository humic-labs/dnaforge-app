"""
Primer Binding Tool

Aligns primer sequences against a template to find binding sites.
Uses Hamming distance sliding window for substitution-only matching
(primer binding has no indels).

Features:
- Forward and reverse complement matching
- Configurable mismatch threshold
- Circular sequence support (origin-spanning)
- Batch primer alignment
- Per-position mismatch analysis with 3' match length and effective Tm
"""

import asyncio
import logging

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator

from .tm_calculator import calculate_tm_nn

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/tools/primers", tags=["Primer Binding"])


COMPLEMENT = str.maketrans("ATCGatcg", "TAGCtagc")


def reverse_complement(seq: str) -> str:
    """Return the reverse complement of a DNA sequence."""
    return seq.translate(COMPLEMENT)[::-1]


class PrimerBindRequest(BaseModel):
    """Request to align a single primer against a template."""

    primer: str = Field(..., min_length=1, description="Primer sequence (5'→3')")
    sequence: str = Field(..., min_length=1, description="Template sequence")
    max_edit_distance: int = Field(
        default=3, ge=0, le=10, description="Maximum edit distance for hits"
    )
    circular: bool = Field(default=False, description="Treat template as circular")

    @field_validator("primer", "sequence")
    @classmethod
    def must_be_dna(cls, v: str) -> str:
        """Strip whitespace, uppercase, basic validation."""
        cleaned = v.strip().upper()
        if not cleaned:
            raise ValueError("Sequence must not be empty")
        return cleaned


class BindingHit(BaseModel):
    """A single primer binding site on the template."""

    start: int = Field(..., description="Start position on template (0-indexed)")
    end: int = Field(..., description="End position on template (exclusive)")
    strand: int = Field(..., description="1 = forward (Watson), -1 = reverse (Crick)")
    identity: float = Field(..., description="Fraction of matching bases (0.0-1.0)")
    edit_distance: int = Field(..., description="Levenshtein edit distance")
    mismatch_positions: list[int] = Field(
        default_factory=list,
        description="Mismatch positions within primer (0-indexed from 5' end)",
    )
    three_prime_match_length: int = Field(
        default=0,
        description="Contiguous perfect match from 3' end of primer",
    )
    effective_tm: float = Field(
        default=0.0,
        description="SantaLucia Tm of the contiguous 3' match region",
    )


class PrimerBindResponse(BaseModel):
    """Response with binding hits for a single primer."""

    hits: list[BindingHit] = Field(default_factory=list)


class BatchBindRequest(BaseModel):
    """Request to align multiple primers against one template."""

    primers: list[str] = Field(
        ..., min_length=1, description="List of primer sequences"
    )
    sequence: str = Field(..., min_length=1, description="Template sequence")
    max_edit_distance: int = Field(default=5, ge=0, le=10)
    circular: bool = Field(default=False)
    min_match_length: int = Field(
        default=0, ge=0, description="Minimum 3' contiguous match length"
    )
    min_effective_tm: float = Field(
        default=0.0, ge=0, description="Minimum effective Tm of 3' match region"
    )
    max_mismatches: int = Field(
        default=10, ge=0, description="Maximum total mismatches allowed"
    )

    @field_validator("sequence")
    @classmethod
    def must_be_dna(cls, v: str) -> str:
        return v.strip().upper()


class BatchPrimerResult(BaseModel):
    """Result for one primer in a batch."""

    primer: str
    hits: list[BindingHit]


class BatchBindResponse(BaseModel):
    """Response with binding results for all primers."""

    results: list[BatchPrimerResult]


def _compute_three_prime_match(mismatch_positions: list[int], primer_len: int) -> int:
    """Compute contiguous perfect match length from the 3' end.

    Walk inward from the 3' end (position primer_len-1). The first mismatch
    encountered stops the count. Returns the number of contiguous matching bases.
    """
    if not mismatch_positions:
        return primer_len

    mismatch_set = set(mismatch_positions)
    match_len = 0
    for pos in range(primer_len - 1, -1, -1):
        if pos in mismatch_set:
            break
        match_len += 1
    return match_len


def _find_hits(
    primer: str,
    template: str,
    max_mismatches: int,
    strand: int,
) -> list[BindingHit]:
    """Hamming distance sliding window — substitution-only primer binding.

    Primer binding is a substitution-only problem: a 20bp oligo lays down on
    a 20bp region of the template with no insertions or deletions. Using an
    edit-distance aligner (edlib) introduced position-shift bugs because it
    prefers indel solutions that don't reflect physical reality.

    This function slides the primer across every position in the template,
    counts mismatches (Hamming distance), and keeps positions within the
    threshold. For a 20bp primer on a 20kb template, this is ~400k character
    comparisons — microseconds on modern hardware.
    """
    primer_len = len(primer)
    template_len = len(template)

    if primer_len > template_len:
        return []

    hits: list[BindingHit] = []

    for start in range(template_len - primer_len + 1):
        mismatches: list[int] = []
        exceeded = False
        for i in range(primer_len):
            if primer[i] != template[start + i]:
                mismatches.append(i)
                if len(mismatches) > max_mismatches:
                    exceeded = True
                    break
        if exceeded:
            continue

        ed = len(mismatches)
        identity = 1.0 - (ed / primer_len)
        end_excl = start + primer_len

        three_prime_match = _compute_three_prime_match(mismatches, primer_len)

        effective_tm = 0.0
        if three_prime_match >= 6:
            three_prime_seq = primer[primer_len - three_prime_match :]
            effective_tm = calculate_tm_nn(three_prime_seq)

        hits.append(
            BindingHit(
                start=start,
                end=end_excl,
                strand=strand,
                identity=round(identity, 4),
                edit_distance=ed,
                mismatch_positions=mismatches,
                three_prime_match_length=three_prime_match,
                effective_tm=effective_tm,
            )
        )

    return hits


def align_primer(
    primer: str,
    sequence: str,
    max_edit_distance: int = 3,
    circular: bool = False,
) -> list[BindingHit]:
    """
    Find all binding sites for a primer on a template sequence.

    Searches both strands (forward and reverse complement).
    For circular sequences, the template is doubled to catch origin-spanning hits.
    """
    template = sequence.upper()
    query = primer.upper()

    if circular:
        template = template + template

    hits = _find_hits(query, template, max_edit_distance, strand=1)

    rc_query = reverse_complement(query)
    hits.extend(_find_hits(rc_query, template, max_edit_distance, strand=-1))

    if circular:
        seq_len = len(sequence)
        filtered: list[BindingHit] = []
        seen_positions: set[tuple[int, int, int]] = set()
        for h in hits:
            norm_start = h.start % seq_len
            norm_end = h.end % seq_len if h.end <= seq_len else h.end - seq_len
            key = (norm_start, norm_end, h.strand)
            if key not in seen_positions:
                seen_positions.add(key)
                filtered.append(
                    BindingHit(
                        start=norm_start,
                        end=norm_end if norm_end > 0 else h.end,
                        strand=h.strand,
                        identity=h.identity,
                        edit_distance=h.edit_distance,
                        mismatch_positions=h.mismatch_positions,
                        three_prime_match_length=h.three_prime_match_length,
                        effective_tm=h.effective_tm,
                    )
                )
        hits = filtered

    hits.sort(key=lambda h: (-h.identity, h.start))
    return hits


@router.post("/bind", response_model=PrimerBindResponse)
async def bind_primer(request: PrimerBindRequest) -> PrimerBindResponse:
    """Align a single primer against a template sequence."""
    hits = await asyncio.to_thread(
        align_primer,
        request.primer,
        request.sequence,
        request.max_edit_distance,
        request.circular,
    )
    return PrimerBindResponse(hits=hits)


def _filter_hits(
    hits: list[BindingHit],
    min_match_length: int,
    min_effective_tm: float,
    max_mismatches: int,
) -> list[BindingHit]:
    """Filter hits by 3' match criteria."""
    if min_match_length <= 0 and min_effective_tm <= 0:
        return hits
    return [
        h
        for h in hits
        if h.three_prime_match_length >= min_match_length
        and h.effective_tm >= min_effective_tm
        and h.edit_distance <= max_mismatches
    ]


@router.post("/bind/batch", response_model=BatchBindResponse)
async def bind_primers_batch(request: BatchBindRequest) -> BatchBindResponse:
    """Align multiple primers against a single template sequence.

    Hits are filtered by 3' match criteria: min_match_length, min_effective_tm,
    max_mismatches. Only hits meeting ALL criteria are returned.
    """
    return await asyncio.to_thread(_bind_primers_batch_sync, request)


def _bind_primers_batch_sync(request: BatchBindRequest) -> BatchBindResponse:
    results: list[BatchPrimerResult] = []
    for primer_seq in request.primers:
        cleaned = primer_seq.strip().upper()
        if not cleaned:
            results.append(BatchPrimerResult(primer=primer_seq, hits=[]))
            continue
        hits = align_primer(
            primer=cleaned,
            sequence=request.sequence,
            max_edit_distance=request.max_edit_distance,
            circular=request.circular,
        )
        hits = _filter_hits(
            hits,
            request.min_match_length,
            request.min_effective_tm,
            request.max_mismatches,
        )
        results.append(BatchPrimerResult(primer=primer_seq, hits=hits))
    return BatchBindResponse(results=results)
