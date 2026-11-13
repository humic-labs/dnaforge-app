""" P2 — transcript-resolver CORPUS, ported from the TS keystone.

Every ``resolveTranscripts`` case from
``apps/desktop/src/features/sequence/components/spliced-feature-resolver.test.ts``
is ported here verbatim (same fixtures, same expected exon/CDS bp), plus the
``resolveSplicedFeatures`` segment-fold cases re-expressed against the transcript
model, plus the synthesizer shape invariants. This is the corpus that GATES the
Python port (``src/services/spliced_resolver.py``) — if a case is lost, the gene
glyphs on screen are wrong (the  multi-isoform CDS class of bug).

Coordinate convention matches TS exactly: GenomeFeature.start is 0-based; resolved
exon/CDS intervals are 1-based inclusive (start = f.start + 1).
"""

from __future__ import annotations

from src.services.spliced_resolver import (
    GenomeFeature,
    ResolvedGene,
    ResolvedTranscript,
    resolve_transcripts,
)


def feat(type, start, end, *, strand="+", attributes=None, chrom="chr1", source="test"):
    return GenomeFeature(
        type=type,
        start=start,
        end=end,
        strand=strand,
        attributes=attributes or {},
        chrom=chrom,
        source=source,
    )


def _intervals(items):
    return [(i.start, i.end) for i in items]


def _find_tx(out, tx_id):
    for f in out:
        if isinstance(f, ResolvedTranscript) and f.transcriptId == tx_id:
            return f
    return None


def test_pass2c_folds_canonical_mrna_exon_cds():
    features = [
        feat("mRNA", 99, 1000, attributes={"ID": ["HBB.mrna.1"], "gene": ["HBB"]}),
        feat("exon", 99, 200, attributes={"Parent": ["HBB.mrna.1"]}),
        feat("exon", 399, 500, attributes={"Parent": ["HBB.mrna.1"]}),
        feat("exon", 799, 1000, attributes={"Parent": ["HBB.mrna.1"]}),
        feat(
            "CDS",
            149,
            200,
            attributes={"Parent": ["HBB.mrna.1"], "translation": ["MVHLT"]},
        ),
        feat(
            "CDS",
            399,
            500,
            attributes={"Parent": ["HBB.mrna.1"], "translation": ["MVHLT"]},
        ),
        feat(
            "CDS",
            799,
            950,
            attributes={"Parent": ["HBB.mrna.1"], "translation": ["MVHLT"]},
        ),
    ]
    out = resolve_transcripts(features)
    mrna = _find_tx(out, "HBB.mrna.1")
    assert mrna is not None
    assert len(mrna.exons) == 3
    assert _intervals(mrna.cds) == [(150, 200), (400, 500), (800, 950)]
    assert mrna.translation == "MVHLT"
    assert [f for f in out if getattr(f, "type", None) == "exon"] == []
    assert [f for f in out if getattr(f, "type", None) == "CDS"] == []


def test_pass2c_consumes_utr_start_stop_into_transcript():
    features = [
        feat("mRNA", 99, 400, attributes={"ID": ["TX-with-utr"]}),
        feat("exon", 99, 400, attributes={"Parent": ["TX-with-utr"]}),
        feat("five_prime_UTR", 99, 149, attributes={"Parent": ["TX-with-utr"]}),
        feat("CDS", 149, 300, attributes={"Parent": ["TX-with-utr"]}),
        feat("three_prime_UTR", 300, 400, attributes={"Parent": ["TX-with-utr"]}),
        feat("start_codon", 149, 152, attributes={"Parent": ["TX-with-utr"]}),
        feat("stop_codon", 297, 300, attributes={"Parent": ["TX-with-utr"]}),
    ]
    out = resolve_transcripts(features)
    tx = _find_tx(out, "TX-with-utr")
    assert _intervals(tx.exons) == [(100, 400)]
    assert _intervals(tx.cds) == [(150, 300)]
    assert [getattr(f, "type", None) for f in out] == ["mRNA"]


def test_pass2c_synthesizes_exon_from_utr_cds_when_no_exon_rows():
    features = [
        feat("mRNA", 99, 900, attributes={"ID": ["TX-no-exon-rows"]}),
        feat("five_prime_UTR", 99, 149, attributes={"Parent": ["TX-no-exon-rows"]}),
        feat("CDS", 149, 300, attributes={"Parent": ["TX-no-exon-rows"]}),
        feat("three_prime_UTR", 300, 400, attributes={"Parent": ["TX-no-exon-rows"]}),
        feat("CDS", 649, 800, attributes={"Parent": ["TX-no-exon-rows"]}),
        feat("UTR", 800, 900, attributes={"Parent": ["TX-no-exon-rows"]}),
    ]
    out = resolve_transcripts(features)
    tx = _find_tx(out, "TX-no-exon-rows")
    assert _intervals(tx.exons) == [(100, 400), (650, 900)]
    assert _intervals(tx.cds) == [(150, 300), (650, 800)]
    leftover = [
        f
        for f in out
        if getattr(f, "type", None)
        in ("CDS", "five_prime_UTR", "three_prime_UTR", "UTR")
    ]
    assert leftover == []


def test_pass2d_groups_transcripts_under_gene():
    features = [
        feat("gene", 99, 1000, attributes={"ID": ["gene-HBB"]}),
        feat(
            "mRNA", 99, 1000, attributes={"ID": ["HBB.mrna.1"], "Parent": ["gene-HBB"]}
        ),
        feat("exon", 99, 200, attributes={"Parent": ["HBB.mrna.1"]}),
        feat("exon", 799, 1000, attributes={"Parent": ["HBB.mrna.1"]}),
        feat(
            "mRNA", 99, 800, attributes={"ID": ["HBB.mrna.2"], "Parent": ["gene-HBB"]}
        ),
        feat("exon", 99, 200, attributes={"Parent": ["HBB.mrna.2"]}),
        feat("exon", 599, 800, attributes={"Parent": ["HBB.mrna.2"]}),
    ]
    out = resolve_transcripts(features)
    genes = [f for f in out if isinstance(f, ResolvedGene)]
    assert len(genes) == 1
    gene = genes[0]
    assert gene.geneId == "gene-HBB"
    assert len(gene.transcripts) == 2
    assert sorted(t.transcriptId for t in gene.transcripts) == [
        "HBB.mrna.1",
        "HBB.mrna.2",
    ]
    assert [f for f in out if isinstance(f, ResolvedTranscript)] == []


def test_pass2d_gene_only_no_transcripts():
    features = [feat("gene", 99, 1000, attributes={"ID": ["lncRNA-region"]})]
    out = resolve_transcripts(features)
    gene = next(f for f in out if isinstance(f, ResolvedGene))
    assert gene.transcripts == []


def test_pass2c_ncrna_with_exons_no_cds():
    features = [
        feat("ncRNA", 99, 500, attributes={"ID": ["lnc-1"], "ncRNA_class": ["lncRNA"]}),
        feat("exon", 99, 200, attributes={"Parent": ["lnc-1"]}),
        feat("exon", 399, 500, attributes={"Parent": ["lnc-1"]}),
    ]
    out = resolve_transcripts(features)
    tx = _find_tx(out, "lnc-1")
    assert tx.type == "ncRNA"
    assert len(tx.exons) == 2
    assert tx.cds == []
    assert tx.translation is None


def test_pass2c_refseq_transcript_class_terms_with_direct_exon_children():
    features = [
        feat(
            "primary_transcript",
            99,
            200,
            attributes={"ID": ["MIR.primary_transcript.1"], "gene": ["MIR"]},
        ),
        feat("exon", 99, 200, attributes={"Parent": ["MIR.primary_transcript.1"]}),
        feat("scaRNA", 399, 500, attributes={"ID": ["sca-1"], "gene": ["SCA"]}),
        feat("exon", 399, 500, attributes={"Parent": ["sca-1"]}),
        feat("antisense_RNA", 799, 900, attributes={"ID": ["as-1"], "gene": ["AS"]}),
        feat("exon", 799, 900, attributes={"Parent": ["as-1"]}),
    ]
    out = resolve_transcripts(features)
    assert [f for f in out if getattr(f, "type", None) == "exon"] == []
    for tid in ["MIR.primary_transcript.1", "sca-1", "as-1"]:
        tx = _find_tx(out, tid)
        assert isinstance(tx, ResolvedTranscript)
        assert len(tx.exons) == 1
        assert tx.cds == []


def test_pass2c_direct_pseudogene_and_gene_segment_children_no_empty_gene():
    features = [
        feat(
            "pseudogene",
            999,
            1400,
            attributes={"ID": ["Pseudo.pseudogene.1"], "gene": ["Pseudo"]},
        ),
        feat("exon", 999, 1100, attributes={"Parent": ["Pseudo.pseudogene.1"]}),
        feat("exon", 1299, 1400, attributes={"Parent": ["Pseudo.pseudogene.1"]}),
        feat(
            "V_gene_segment",
            1999,
            2200,
            attributes={"ID": ["TRV.segment.1"], "gene": ["TRV"]},
        ),
        feat("exon", 1999, 2200, attributes={"Parent": ["TRV.segment.1"]}),
    ]
    out = resolve_transcripts(features)
    assert [f for f in out if getattr(f, "type", None) == "exon"] == []
    assert [f for f in out if isinstance(f, ResolvedGene)] == []
    pseudo = _find_tx(out, "Pseudo.pseudogene.1")
    assert pseudo.type == "pseudogene"
    assert _intervals(pseudo.exons) == [(1000, 1100), (1300, 1400)]
    segment = _find_tx(out, "TRV.segment.1")
    assert segment.type == "V_gene_segment"
    assert _intervals(segment.exons) == [(2000, 2200)]


def test_bacterial_cds_auto_promote():
    features = [
        feat(
            "CDS",
            999,
            2000,
            attributes={"ID": ["lacZ"], "gene": ["lacZ"], "translation": ["MTMITDS"]},
        ),
    ]
    out = resolve_transcripts(features)
    assert len(out) == 1
    tx = out[0]
    assert isinstance(tx, ResolvedTranscript)
    assert tx.type == "mRNA"
    assert _intervals(tx.exons) == [(1000, 2000)]
    assert _intervals(tx.cds) == [(1000, 2000)]
    assert tx.translation == "MTMITDS"
    assert tx.attributes["_syntheticTranscript"] == ["true"]


def test_legacy_foldup_mrna_and_cds_same_parent_ref():
    features = [
        feat(
            "mRNA",
            99,
            200,
            attributes={"ID": ["LOC.mrna.0"], "Parent": ["LOC124905154-3"]},
        ),
        feat(
            "mRNA",
            399,
            500,
            attributes={"ID": ["LOC.mrna.1"], "Parent": ["LOC124905154-3"]},
        ),
        feat(
            "mRNA",
            799,
            1000,
            attributes={"ID": ["LOC.mrna.2"], "Parent": ["LOC124905154-3"]},
        ),
        feat(
            "CDS",
            149,
            200,
            attributes={
                "ID": ["LOC.cds.0"],
                "Parent": ["LOC124905154-3"],
                "translation": ["MTG"],
            },
        ),
        feat(
            "CDS",
            399,
            500,
            attributes={
                "ID": ["LOC.cds.1"],
                "Parent": ["LOC124905154-3"],
                "translation": ["MTG"],
            },
        ),
        feat(
            "CDS",
            799,
            950,
            attributes={
                "ID": ["LOC.cds.2"],
                "Parent": ["LOC124905154-3"],
                "translation": ["MTG"],
            },
        ),
    ]
    out = resolve_transcripts(features)
    assert len(out) == 1
    tx = out[0]
    assert isinstance(tx, ResolvedTranscript)
    assert tx.transcriptId == "LOC124905154-3"
    assert len(tx.exons) == 3
    assert _intervals(tx.cds) == [(150, 200), (400, 500), (800, 950)]
    assert tx.translation == "MTG"
    assert tx.attributes["_legacyMultipart"] == ["true"]


def test_legacy_foldup_different_refs_combine_by_gene_and_coverage():
    features = [
        feat(
            "mRNA",
            100,
            140,
            attributes={
                "ID": ["OR4F5.mrna.0"],
                "Parent": ["OR4F5-mrna"],
                "gene": ["OR4F5"],
            },
        ),
        feat(
            "mRNA",
            200,
            260,
            attributes={
                "ID": ["OR4F5.mrna.1"],
                "Parent": ["OR4F5-mrna"],
                "gene": ["OR4F5"],
            },
        ),
        feat(
            "CDS",
            220,
            250,
            attributes={
                "ID": ["OR4F5.cds.0"],
                "Parent": ["OR4F5-cds"],
                "gene": ["OR4F5"],
            },
        ),
    ]
    out = resolve_transcripts(features)
    assert len(out) == 1
    tx = out[0]
    assert tx.transcriptId == "OR4F5-mrna"
    assert _intervals(tx.exons) == [(101, 140), (201, 260)]
    assert _intervals(tx.cds) == [(221, 250)]


def test_legacy_foldup_parentless_cds_attaches_to_parentless_mrna():
    features = [
        feat(
            "gene", 999, 1500, attributes={"ID": ["B3GALT6.gene"], "gene": ["B3GALT6"]}
        ),
        feat(
            "mRNA", 999, 1500, attributes={"ID": ["B3GALT6.mrna"], "gene": ["B3GALT6"]}
        ),
        feat(
            "CDS", 1099, 1300, attributes={"ID": ["B3GALT6.cds"], "gene": ["B3GALT6"]}
        ),
    ]
    out = resolve_transcripts(features)
    transcripts = [f for f in out if isinstance(f, ResolvedTranscript)]
    assert len(transcripts) == 1
    assert transcripts[0].transcriptId == "B3GALT6.mrna"
    assert _intervals(transcripts[0].exons) == [(1000, 1500)]
    assert _intervals(transcripts[0].cds) == [(1100, 1300)]
    assert [f for f in out if getattr(f, "type", None) == "CDS"] == []


def test_legacy_cds_cluster_without_mrna_becomes_standalone():
    features = [
        feat(
            "CDS", 99, 200, attributes={"ID": ["OrphCDS.0"], "Parent": ["orph-cds-ref"]}
        ),
        feat(
            "CDS",
            399,
            500,
            attributes={"ID": ["OrphCDS.1"], "Parent": ["orph-cds-ref"]},
        ),
    ]
    out = resolve_transcripts(features)
    assert len(out) == 1
    tx = out[0]
    assert tx.type == "mRNA"
    assert _intervals(tx.exons) == _intervals(tx.cds)
    assert len(tx.cds) == 2


def test_passthrough_non_transcript_class_rows():
    features = [
        feat(
            "promoter",
            540,
            571,
            attributes={"ID": ["lac-prom"], "label": ["lac promoter"]},
        ),
        feat("primer_bind", 49, 70, attributes={"ID": ["M13-fwd"]}),
        feat("regulatory", 99, 200, attributes={"ID": ["enh-1"]}),
    ]
    out = resolve_transcripts(features)
    assert len(out) == 3
    assert sorted(getattr(f, "type", None) for f in out) == [
        "primer_bind",
        "promoter",
        "regulatory",
    ]


def test_mixed_canonical_and_legacy_bundle():
    features = [
        feat("mRNA", 99, 1000, attributes={"ID": ["ABL1.mrna.1"]}),
        feat("exon", 99, 1000, attributes={"Parent": ["ABL1.mrna.1"]}),
        feat(
            "CDS",
            199,
            800,
            attributes={"Parent": ["ABL1.mrna.1"], "translation": ["MGE"]},
        ),
        feat(
            "mRNA", 4999, 5500, attributes={"ID": ["HBB.0"], "Parent": ["HBB-legacy"]}
        ),
        feat(
            "CDS",
            5099,
            5400,
            attributes={"ID": ["HBB.cds.0"], "Parent": ["HBB-legacy"]},
        ),
    ]
    out = resolve_transcripts(features)
    assert len(out) == 2
    canonical = _find_tx(out, "ABL1.mrna.1")
    legacy = _find_tx(out, "HBB-legacy")
    assert canonical.cds[0].start == 200
    assert legacy.cds[0].start == 5100
    assert legacy.attributes["_legacyMultipart"] == ["true"]


def test_trans_splicing_rejection():
    features = [
        feat("mRNA", 99, 1000, strand="+", attributes={"ID": ["tx-fwd"]}),
        feat("exon", 99, 200, strand="+", attributes={"Parent": ["tx-fwd"]}),
        feat("exon", 399, 500, strand="-", attributes={"Parent": ["tx-fwd"]}),
    ]
    out = resolve_transcripts(features)
    tx = out[0]
    assert isinstance(tx, ResolvedTranscript)
    assert len(tx.exons) == 1
    assert tx.strand == "+"


def test_single_exon_coding_yeast():
    features = [
        feat("mRNA", 999, 2500, strand="-", attributes={"ID": ["YAL001C"]}),
        feat("exon", 999, 2500, strand="-", attributes={"Parent": ["YAL001C"]}),
        feat("CDS", 999, 2500, strand="-", attributes={"Parent": ["YAL001C"]}),
    ]
    out = resolve_transcripts(features)
    tx = out[0]
    assert _intervals(tx.exons) == [(1000, 2500)]
    assert _intervals(tx.cds) == [(1000, 2500)]


def test_synthesizer_dedups_identical_translations():
    features = [
        feat("mRNA", 99, 500, attributes={"ID": ["t"]}),
        feat("exon", 99, 500, attributes={"Parent": ["t"]}),
        feat("CDS", 99, 200, attributes={"Parent": ["t"], "translation": ["MABC"]}),
        feat("CDS", 299, 400, attributes={"Parent": ["t"], "translation": ["MABC"]}),
    ]
    out = resolve_transcripts(features)
    tx = _find_tx(out, "t")
    assert tx.translation == "MABC"


def test_cds_clipped_to_exon_coverage():
    features = [
        feat("mRNA", 99, 300, attributes={"ID": ["clip"]}),
        feat("exon", 99, 200, attributes={"Parent": ["clip"]}),
        feat("CDS", 149, 250, attributes={"Parent": ["clip"]}),
    ]
    out = resolve_transcripts(features)
    tx = _find_tx(out, "clip")
    assert _intervals(tx.cds) == [(150, 200)]
