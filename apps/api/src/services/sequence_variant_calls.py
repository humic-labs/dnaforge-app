"""Project indexed calls without manufacturing a clone consensus or missing counts."""

from __future__ import annotations

import hashlib

from ..sequence_variant_contract import (
    SequenceVariantCall,
    SequenceVariantCallsRequest,
    SequenceVariantCallsResult,
)
from ..variant_source_operation_contract import (
    VariantReferenceIdentity,
    variant_assembly_revision,
)
from .variant_queries import query_variant_region


def query_sequence_variant_calls(
    request: SequenceVariantCallsRequest,
) -> SequenceVariantCallsResult:
    source = request.source
    if request.chrom not in source.matched_references:
        raise ValueError(
            "The selected chromosome is absent from the prepared reference mapping."
        )
    if request.sample not in source.samples:
        raise ValueError("The selected sample is absent from the variant source.")
    if source.assembly_revision != variant_assembly_revision(
        [VariantReferenceIdentity(name=request.chrom, length=len(request.sequence))]
    ):
        raise ValueError(
            "The prepared single-reference identity does not match this sequence length. Use indexed review for a multi-contig reference."
        )
    result = query_variant_region(
        source.query_path,
        source.index_path,
        source_generation=source.source_generation,
        query_generation=source.query_generation,
        index_generation=source.index_generation,
        chrom=request.chrom,
        start=0,
        end=len(request.sequence),
        limit=request.limit,
        sample=request.sample,
    )
    if result["truncated"]:
        raise ValueError(
            "Variant calls exceed the sequence-review limit; use indexed regional review."
        )
    calls = []
    for row in result["variants"]:
        reference = row["ref"].upper()
        if request.sequence[row["start"] : row["start"] + len(reference)] != reference:
            raise ValueError(
                f"The reference does not match the VCF at position {row['position']}."
            )
        evidence = row["sampleEvidence"]
        depths = evidence["depths"]
        total = sum(depths) if depths is not None else None
        for alternate in row["alts"]:
            index = evidence["alleles"].index(alternate)
            supported = not (set(alternate.upper()) - set("ACGT")) and not (
                set(reference) - set("ACGT")
            )
            calls.append(
                SequenceVariantCall(
                    id=f"{row['id']}:{index}",
                    position=row["position"],
                    reference=reference,
                    alternate=alternate,
                    allele_index=index,
                    quality=row["quality"],
                    filters=row["filters"],
                    genotype=evidence["genotype"],
                    reference_count=depths[0] if depths is not None else None,
                    alternate_count=depths[index] if depths is not None else None,
                    total_allele_count=total,
                    allele_fraction=depths[index] / total if total else None,
                    unsupported_reason=(
                        None
                        if supported
                        else "Symbolic, ambiguous or spanning-deletion alleles require an explicit structural-variant mapping."
                    ),
                )
            )
            if len(calls) > request.limit:
                raise ValueError(
                    "Alternate alleles exceed the sequence-review limit; use indexed regional review."
                )
    return SequenceVariantCallsResult(
        source_identity=source.source_identity,
        reference_sha256=hashlib.sha256(request.sequence.encode("ascii")).hexdigest(),
        chrom=request.chrom,
        sample=request.sample,
        calls=calls,
    )
