""" P2 — Python PORT of the TS transcript resolver (the KEYSTONE).

Faithful port of:
  - ``apps/desktop/src/features/sequence/components/spliced-feature-resolver.ts``
    (``resolveTranscripts`` — the transcript-model fold: Parent=, orphan-CDS,
    legacy multipart, bacterial promote, gene aggregation)
  - ``packages/core/genome-data/src/transcript-synthesizer.ts``
    (``synthesizeTranscript`` / ``promoteBacterialCds`` — the shape contract:
    exon dedup+sort, CDS clip-to-exons + overlap-collapse, translation aggregate)

The TS regression corpus (~30 cases across ``spliced-feature-resolver.test.ts``)
is ported verbatim as ``test_spliced_resolver.py`` and GATES this module — do NOT
lose a case. Coordinate convention matches the TS exactly: ``GenomeFeature.start``
is 0-based; resolved exon/CDS intervals are 1-based inclusive
(``start = f.start + 1``).

Pure functions, no I/O, deterministic.
"""

from __future__ import annotations

import re
import urllib.parse
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class GenomeFeature:
    type: str
    start: int
    end: int
    chrom: str = "chr1"
    source: str = "ncbi"
    score: Optional[str] = None
    strand: str = "+"
    phase: Optional[str] = None
    attributes: dict[str, list[str]] = field(default_factory=dict)
    raw: str = ""


@dataclass
class BpInterval:
    start: int
    end: int

    def as_dict(self) -> dict:
        return {"start": self.start, "end": self.end}


@dataclass
class ResolvedTranscript:
    transcriptId: str
    chrom: str
    source: str
    type: str
    strand: str
    start: int
    end: int
    exons: list[BpInterval]
    cds: list[BpInterval]
    translation: Optional[str]
    attributes: dict[str, list[str]]
    geneId: Optional[str] = None
    score: Optional[str] = None
    phase: Optional[str] = None
    raw: str = ""
    kind: str = "transcript"


@dataclass
class ResolvedGene:
    geneId: str
    chrom: str
    source: str
    type: str
    strand: str
    start: int
    end: int
    transcripts: list[ResolvedTranscript]
    attributes: dict[str, list[str]]
    score: Optional[str] = None
    phase: Optional[str] = None
    raw: str = ""
    kind: str = "gene"


TRANSCRIPT_CLASS_TYPES = {
    "mRNA",
    "transcript",
    "ncRNA",
    "lnc_RNA",
    "lncRNA",
    "miRNA",
    "snoRNA",
    "snRNA",
    "tRNA",
    "rRNA",
    "primary_transcript",
    "scaRNA",
    "antisense_RNA",
    "pseudogenic_transcript",
}

GENE_CLASS_TYPES = {"gene", "pseudogene"}

DIRECT_TRANSCRIPT_PARENT_TYPES = {"pseudogene", "V_gene_segment"}

TRANSCRIPT_EXON_COMPONENT_TYPES = {
    "exon",
    "five_prime_UTR",
    "three_prime_UTR",
    "UTR",
}

TRANSCRIPT_CHILD_COMPONENT_TYPES = TRANSCRIPT_EXON_COMPONENT_TYPES | {
    "CDS",
    "start_codon",
    "stop_codon",
}


def _normalize_intervals(parts: list[BpInterval]) -> list[BpInterval]:
    """Dedup by (start, end), sort ascending by start then end."""
    if not parts:
        return []
    seen: set[tuple[int, int]] = set()
    out: list[BpInterval] = []
    for p in parts:
        key = (p.start, p.end)
        if key in seen:
            continue
        seen.add(key)
        out.append(BpInterval(p.start, p.end))
    out.sort(key=lambda i: (i.start, i.end))
    return out


def _clip_to_exons(cds: list[BpInterval], exons: list[BpInterval]) -> list[BpInterval]:
    """Clip CDS to exon coverage (CDS ⊆ exon per GFF3). Drop CDS outside all exons."""
    if not cds or not exons:
        return []
    clipped: list[BpInterval] = []
    for c in cds:
        for e in exons:
            start = max(c.start, e.start)
            end = min(c.end, e.end)
            if start <= end:
                clipped.append(BpInterval(start, end))
    return _normalize_intervals(clipped)


def _collapse_overlapping_cds(cds: list[BpInterval]) -> list[BpInterval]:
    """Keep the LONGER of two overlapping CDS within one transcript (sorted input)."""
    if len(cds) < 2:
        return list(cds)
    out: list[BpInterval] = []
    for interval in cds:
        last = out[-1] if out else None
        if last is not None and interval.start < last.end:
            last_len = last.end - last.start
            this_len = interval.end - interval.start
            if this_len > last_len:
                out[-1] = interval
        else:
            out.append(interval)
    return out


def _aggregate_translation(parts: Optional[list[str]]) -> Optional[str]:
    if not parts:
        return None
    if len(parts) == 1:
        return parts[0]
    first = parts[0]
    if all(p == first for p in parts):
        return first
    return "".join(parts)


def synthesize_transcript(
    *,
    transcript_id: str,
    chrom: str,
    source: str,
    type: str,
    strand: str,
    exon_parts: list[BpInterval],
    cds_parts: list[BpInterval],
    cds_translations: Optional[list[str]] = None,
    attributes: Optional[dict[str, list[str]]] = None,
    gene_id: Optional[str] = None,
    score: Optional[str] = None,
    phase: Optional[str] = None,
    raw: str = "",
) -> ResolvedTranscript:
    exons = _normalize_intervals(exon_parts)
    if not exons:
        raise ValueError(
            f"synthesize_transcript: transcriptId={transcript_id!r} has no exons."
        )
    cds = _collapse_overlapping_cds(
        _clip_to_exons(_normalize_intervals(cds_parts), exons)
    )
    translation = None if not cds else _aggregate_translation(cds_translations)
    bbox_start = exons[0].start - 1
    bbox_end = exons[-1].end
    attrs = dict(attributes or {})
    attrs["ID"] = [transcript_id]
    if gene_id:
        attrs["Parent"] = [gene_id]
    return ResolvedTranscript(
        transcriptId=transcript_id,
        chrom=chrom,
        source=source,
        type=type,
        strand=strand,
        start=bbox_start,
        end=bbox_end,
        exons=exons,
        cds=cds,
        translation=translation,
        attributes=attrs,
        geneId=gene_id,
        score=score,
        phase=phase,
        raw=raw,
    )


def promote_bacterial_cds(cds_row: GenomeFeature) -> ResolvedTranscript:
    transcript_id = (
        cds_row.attributes.get("ID", [None])[0]
        or f"_synth.{cds_row.start}_{cds_row.end}"
    )
    interval = BpInterval(cds_row.start + 1, cds_row.end)
    translation = cds_row.attributes.get("translation", [None])[0]
    attrs = dict(cds_row.attributes)
    attrs["ID"] = [transcript_id]
    attrs["_syntheticTranscript"] = ["true"]
    return ResolvedTranscript(
        transcriptId=transcript_id,
        chrom=cds_row.chrom,
        source=cds_row.source,
        type="mRNA",
        strand=cds_row.strand,
        start=cds_row.start,
        end=cds_row.end,
        exons=[interval],
        cds=[interval],
        translation=translation,
        attributes=attrs,
        score=cds_row.score,
        phase=cds_row.phase,
        raw=cds_row.raw,
    )


def _feature_interval(f: GenomeFeature) -> BpInterval:
    return BpInterval(f.start + 1, f.end)


def _is_coding_transcript_carrier(type: str) -> bool:
    return type in ("mRNA", "transcript")


def _feature_association_key(
    attrs_or_feature,
) -> Optional[str]:
    attrs = (
        attrs_or_feature.attributes
        if isinstance(attrs_or_feature, (GenomeFeature, ResolvedTranscript))
        else attrs_or_feature
    )
    raw = (
        (attrs.get("gene") or [None])[0]
        or (attrs.get("Name") or [None])[0]
        or (attrs.get("locus_tag") or [None])[0]
        or (attrs.get("transcript_id") or [None])[0]
    )
    key = raw.strip().lower() if raw else None
    return key or None


def _extract_transcript_variant_number(
    attrs: Optional[dict[str, list[str]]],
) -> Optional[str]:
    if not attrs:
        return None
    for raw in [(attrs.get("product") or [None])[0], (attrs.get("note") or [None])[0]]:
        if not raw:
            continue
        try:
            decoded = urllib.parse.unquote(raw)
        except Exception:  # noqa: BLE001
            decoded = raw
        m = re.search(r"transcript\s+variant\s+(\d+)\b", decoded, re.IGNORECASE)
        if m:
            return m.group(1)
    return None


def _compatible_strands(a: str, b: str) -> bool:
    return a == b or a == "." or b == "."


def _merge_intervals(intervals: list[BpInterval]) -> list[BpInterval]:
    if not intervals:
        return []
    s = sorted(
        (i for i in intervals if i.end >= i.start),
        key=lambda i: (i.start, i.end),
    )
    merged: list[BpInterval] = []
    for part in s:
        last = merged[-1] if merged else None
        if last is None or part.start > last.end + 1:
            merged.append(BpInterval(part.start, part.end))
        elif part.end > last.end:
            last.end = part.end
    return merged


def _interval_length(intervals: list[BpInterval]) -> int:
    return sum(max(0, p.end - p.start) for p in _merge_intervals(intervals))


def _interval_span(intervals: list[BpInterval]) -> float:
    if not intervals:
        return float("inf")
    lo = min(p.start for p in intervals)
    hi = max(p.end for p in intervals)
    return hi - lo


def _interval_coverage_ratio(
    query: list[BpInterval], covered_by: list[BpInterval]
) -> float:
    total = _interval_length(query)
    if total <= 0:
        return 0.0
    q = _merge_intervals(query)
    c = _merge_intervals(covered_by)
    covered = 0
    j = 0
    for part in q:
        while j < len(c) and c[j].end <= part.start:
            j += 1
        k = j
        while k < len(c) and c[k].start < part.end:
            covered += max(0, min(part.end, c[k].end) - max(part.start, c[k].start))
            k += 1
    return covered / total


def _is_orphan_cds_bp_duplicate(
    cds: GenomeFeature, candidates: list[ResolvedTranscript]
) -> bool:
    interval = _feature_interval(cds)
    for candidate in candidates:
        for existing in candidate.cds:
            if existing.start == interval.start and existing.end == interval.end:
                return True
    return False


def _best_transcript_for_cds(
    cds: GenomeFeature,
    candidates: list[ResolvedTranscript],
    originally_empty_cds: set[int],
) -> int:
    cds_interval = _feature_interval(cds)
    matching: list[int] = []
    for i, candidate in enumerate(candidates):
        if not _compatible_strands(candidate.strand, cds.strand):
            continue
        score = _interval_coverage_ratio([cds_interval], candidate.exons)
        if score < 0.95:
            continue
        matching.append(i)
    if not matching:
        return -1
    if len(matching) == 1:
        return matching[0]
    empty_matches = [i for i in matching if id(candidates[i]) in originally_empty_cds]
    if len(empty_matches) == 1:
        return empty_matches[0]
    if len(empty_matches) > 1:
        orphan_variant = _extract_transcript_variant_number(cds.attributes)
        if orphan_variant is not None:
            by_variant = [
                i
                for i in empty_matches
                if _extract_transcript_variant_number(candidates[i].attributes)
                == orphan_variant
            ]
            if len(by_variant) == 1:
                return by_variant[0]
    return -1


def _index_features_by_id(features: list[GenomeFeature]) -> dict[str, GenomeFeature]:
    by_id: dict[str, GenomeFeature] = {}
    for f in features:
        fid = (f.attributes.get("ID") or [None])[0]
        if fid:
            by_id[fid] = f
    return by_id


def _collect_transcript_child_rows(
    features: list[GenomeFeature],
    by_id: dict[str, GenomeFeature],
    can_carry_transcript_parts,
) -> tuple[
    dict[str, list[GenomeFeature]],
    dict[str, list[GenomeFeature]],
    dict[str, list[GenomeFeature]],
    set[int],
]:
    exons_by_tx: dict[str, list[GenomeFeature]] = {}
    exon_fallback_by_tx: dict[str, list[GenomeFeature]] = {}
    cds_by_tx: dict[str, list[GenomeFeature]] = {}
    consumed: set[int] = set()
    for f in features:
        if f.type not in TRANSCRIPT_CHILD_COMPONENT_TYPES:
            continue
        parent_refs = f.attributes.get("Parent")
        if not parent_refs:
            continue
        for parent_ref in parent_refs:
            parent = by_id.get(parent_ref)
            if parent is None or not can_carry_transcript_parts(parent.type):
                continue
            if f.strand != parent.strand and f.strand != ".":
                consumed.add(id(f))
                continue
            if f.type == "CDS":
                cds_by_tx.setdefault(parent_ref, []).append(f)
                exon_fallback_by_tx.setdefault(parent_ref, []).append(f)
            elif f.type in TRANSCRIPT_EXON_COMPONENT_TYPES:
                if f.type == "exon":
                    exons_by_tx.setdefault(parent_ref, []).append(f)
                exon_fallback_by_tx.setdefault(parent_ref, []).append(f)
            consumed.add(id(f))
    return exons_by_tx, exon_fallback_by_tx, cds_by_tx, consumed


def _collect_legacy_multipart_parts(
    features: list[GenomeFeature],
    by_id: dict[str, GenomeFeature],
    consumed: set[int],
    can_carry_transcript_parts,
) -> tuple[dict[str, list[GenomeFeature]], dict[str, list[GenomeFeature]]]:
    legacy_mrna_parts: dict[str, list[GenomeFeature]] = {}
    legacy_cds_parts: dict[str, list[GenomeFeature]] = {}
    for f in features:
        if id(f) in consumed:
            continue
        if not can_carry_transcript_parts(f.type) and f.type != "CDS":
            continue
        parent_refs = f.attributes.get("Parent")
        if not parent_refs:
            continue
        for parent_ref in parent_refs:
            if parent_ref in by_id:
                continue
            bucket = legacy_cds_parts if f.type == "CDS" else legacy_mrna_parts
            bucket.setdefault(parent_ref, []).append(f)
            consumed.add(id(f))
    return legacy_mrna_parts, legacy_cds_parts


def _collect_legacy_multipart_ids(
    legacy_mrna_parts: dict[str, list[GenomeFeature]],
) -> set[str]:
    ids: set[str] = set()
    for parts in legacy_mrna_parts.values():
        for p in parts:
            pid = (p.attributes.get("ID") or [None])[0]
            if pid:
                ids.add(pid)
    return ids


def _cds_translations_of(rows: list[GenomeFeature]) -> list[str]:
    return [
        t
        for t in ((c.attributes.get("translation") or [None])[0] for c in rows)
        if isinstance(t, str)
    ]


def _emit_real_parent_transcripts(
    features: list[GenomeFeature],
    by_id: dict[str, GenomeFeature],
    gene_types,
    can_carry_transcript_parts,
    exons_by_tx: dict[str, list[GenomeFeature]],
    exon_fallback_by_tx: dict[str, list[GenomeFeature]],
    cds_by_tx: dict[str, list[GenomeFeature]],
    legacy_multipart_ids: set[str],
    transcripts_by_id: dict[str, ResolvedTranscript],
    consumed: set[int],
) -> None:
    for f in features:
        if not can_carry_transcript_parts(f.type):
            continue
        fid = (f.attributes.get("ID") or [None])[0]
        if not fid:
            continue
        if fid in legacy_multipart_ids:
            continue
        explicit_exon_parts = [_feature_interval(e) for e in exons_by_tx.get(fid, [])]
        if explicit_exon_parts:
            exon_parts = explicit_exon_parts
        else:
            exon_parts = _merge_intervals(
                [_feature_interval(e) for e in exon_fallback_by_tx.get(fid, [])]
            )
        cds_parts = [BpInterval(c.start + 1, c.end) for c in cds_by_tx.get(fid, [])]
        if not exon_parts:
            exon_parts.append(BpInterval(f.start + 1, f.end))
        gene_id = None
        for p in f.attributes.get("Parent", []):
            parent = by_id.get(p)
            if parent and parent.type in gene_types:
                gene_id = p
                break
        transcripts_by_id[fid] = synthesize_transcript(
            transcript_id=fid,
            gene_id=gene_id,
            chrom=f.chrom,
            source=f.source,
            type=f.type,
            strand=f.strand,
            exon_parts=exon_parts,
            cds_parts=cds_parts,
            cds_translations=_cds_translations_of(cds_by_tx.get(fid, [])),
            attributes=dict(f.attributes),
            raw=f.raw,
            score=f.score,
            phase=f.phase,
        )
        consumed.add(id(f))


def _take_legacy_cds_rows_for_mrna(
    parent_ref: str,
    parts: list[GenomeFeature],
    legacy_cds_parts: dict[str, list[GenomeFeature]],
) -> list[GenomeFeature]:
    exact = legacy_cds_parts.get(parent_ref)
    if exact is not None:
        del legacy_cds_parts[parent_ref]
        return exact
    first = parts[0] if parts else None
    if first is None or not _is_coding_transcript_carrier(first.type):
        return []
    key = _feature_association_key(first)
    if not key:
        return []
    exon_parts = [_feature_interval(p) for p in parts]
    best_ref = None
    best_score = 0.0
    best_span = float("inf")
    for candidate_ref, cds_rows in legacy_cds_parts.items():
        if not cds_rows:
            continue
        cds_first = cds_rows[0]
        if _feature_association_key(cds_first) != key:
            continue
        if not _compatible_strands(first.strand, cds_first.strand):
            continue
        cds_parts_local = [_feature_interval(c) for c in cds_rows]
        score = _interval_coverage_ratio(cds_parts_local, exon_parts)
        if score < 0.95:
            continue
        span = _interval_span(exon_parts)
        if score > best_score or (score == best_score and span < best_span):
            best_ref = candidate_ref
            best_score = score
            best_span = span
    if best_ref is None:
        return []
    rows = legacy_cds_parts.get(best_ref, [])
    if best_ref in legacy_cds_parts:
        del legacy_cds_parts[best_ref]
    return rows


def _emit_legacy_multipart_transcripts(
    legacy_mrna_parts: dict[str, list[GenomeFeature]],
    legacy_cds_parts: dict[str, list[GenomeFeature]],
    transcripts_by_id: dict[str, ResolvedTranscript],
) -> None:
    for parent_ref, parts in legacy_mrna_parts.items():
        if not parts:
            continue
        first = parts[0]
        cds_rows = _take_legacy_cds_rows_for_mrna(parent_ref, parts, legacy_cds_parts)
        attrs = dict(first.attributes)
        attrs["_legacyMultipart"] = ["true"]
        transcripts_by_id[parent_ref] = synthesize_transcript(
            transcript_id=parent_ref,
            chrom=first.chrom,
            source=first.source,
            type=first.type,
            strand=first.strand,
            exon_parts=[BpInterval(p.start + 1, p.end) for p in parts],
            cds_parts=[BpInterval(c.start + 1, c.end) for c in cds_rows],
            cds_translations=_cds_translations_of(cds_rows),
            attributes=attrs,
            raw="",
            score=first.score,
            phase=first.phase,
        )

    for parent_ref, cds_rows in list(legacy_cds_parts.items()):
        if not cds_rows:
            continue
        first = cds_rows[0]
        intervals = [BpInterval(c.start + 1, c.end) for c in cds_rows]
        attrs = dict(first.attributes)
        attrs["_legacyMultipart"] = ["true"]
        transcripts_by_id[parent_ref] = synthesize_transcript(
            transcript_id=parent_ref,
            chrom=first.chrom,
            source=first.source,
            type="mRNA",
            strand=first.strand,
            exon_parts=intervals,
            cds_parts=intervals,
            cds_translations=_cds_translations_of(cds_rows),
            attributes=attrs,
            raw="",
            score=first.score,
            phase=first.phase,
        )


def _recover_bare_cds(
    features: list[GenomeFeature],
    transcripts_by_id: dict[str, ResolvedTranscript],
    consumed: set[int],
) -> None:
    transcripts_by_assoc: dict[str, list[ResolvedTranscript]] = {}
    for t in transcripts_by_id.values():
        if not _is_coding_transcript_carrier(t.type):
            continue
        key = _feature_association_key(t)
        if not key:
            continue
        transcripts_by_assoc.setdefault(key, []).append(t)

    originally_empty_cds: set[int] = set()
    for lst in transcripts_by_assoc.values():
        for t in lst:
            if len(t.cds) == 0:
                originally_empty_cds.add(id(t))

    for f in features:
        if f.type != "CDS":
            continue
        if id(f) in consumed:
            continue
        if f.attributes.get("Parent"):
            continue
        key = _feature_association_key(f)
        if not key:
            continue
        candidates = transcripts_by_assoc.get(key)
        if not candidates:
            continue
        match_index = _best_transcript_for_cds(f, candidates, originally_empty_cds)
        if match_index < 0:
            if _is_orphan_cds_bp_duplicate(f, candidates):
                consumed.add(id(f))
                continue
            continue
        current = candidates[match_index]
        updated = synthesize_transcript(
            transcript_id=current.transcriptId,
            gene_id=current.geneId,
            chrom=current.chrom,
            source=current.source,
            type=current.type,
            strand=current.strand,
            exon_parts=list(current.exons),
            cds_parts=list(current.cds) + [_feature_interval(f)],
            cds_translations=f.attributes.get("translation"),
            attributes=dict(current.attributes),
            raw=current.raw,
            score=current.score,
            phase=current.phase,
        )
        transcripts_by_id[updated.transcriptId] = updated
        if id(current) in originally_empty_cds:
            originally_empty_cds.add(id(updated))
        candidates[match_index] = updated
        consumed.add(id(f))


def _aggregate_resolved_genes(
    features: list[GenomeFeature],
    gene_types,
    transcripts_by_id: dict[str, ResolvedTranscript],
    consumed: set[int],
) -> dict[str, ResolvedGene]:
    transcripts_by_gene: dict[str, list[ResolvedTranscript]] = {}
    for t in transcripts_by_id.values():
        if not t.geneId:
            continue
        transcripts_by_gene.setdefault(t.geneId, []).append(t)

    genes_by_id: dict[str, ResolvedGene] = {}
    for f in features:
        if f.type not in gene_types:
            continue
        fid = (f.attributes.get("ID") or [None])[0]
        if not fid:
            continue
        if f.type in DIRECT_TRANSCRIPT_PARENT_TYPES and fid in transcripts_by_id:
            continue
        transcripts = transcripts_by_gene.get(fid, [])
        genes_by_id[fid] = ResolvedGene(
            geneId=fid,
            chrom=f.chrom,
            source=f.source,
            type=f.type,
            strand=f.strand,
            start=f.start,
            end=f.end,
            transcripts=transcripts,
            attributes=dict(f.attributes),
            score=f.score,
            phase=f.phase,
            raw=f.raw,
        )
        consumed.add(id(f))
        for t in transcripts:
            tid = (t.attributes.get("ID") or [None])[0]
            if tid and tid in transcripts_by_id:
                del transcripts_by_id[tid]
    return genes_by_id


def _promote_unconsumed_bacterial_cds(
    features: list[GenomeFeature],
    consumed: set[int],
) -> list[ResolvedTranscript]:
    promoted: list[ResolvedTranscript] = []
    for f in features:
        if f.type != "CDS":
            continue
        if id(f) in consumed:
            continue
        if f.attributes.get("Parent"):
            continue
        promoted.append(promote_bacterial_cds(f))
        consumed.add(id(f))
    return promoted


def resolve_transcripts(features: list[GenomeFeature]) -> list:
    """Port of TS ``resolveTranscripts``. Returns a list of ResolvedGene /
    ResolvedTranscript / GenomeFeature in the SAME emit order as the TS."""
    transcript_types = TRANSCRIPT_CLASS_TYPES
    gene_types = GENE_CLASS_TYPES

    def can_carry_transcript_parts(t: str) -> bool:
        return t in transcript_types or t in DIRECT_TRANSCRIPT_PARENT_TYPES

    by_id = _index_features_by_id(features)
    exons_by_tx, exon_fallback_by_tx, cds_by_tx, consumed = (
        _collect_transcript_child_rows(features, by_id, can_carry_transcript_parts)
    )
    legacy_mrna_parts, legacy_cds_parts = _collect_legacy_multipart_parts(
        features, by_id, consumed, can_carry_transcript_parts
    )

    transcripts_by_id: dict[str, ResolvedTranscript] = {}
    legacy_multipart_ids = _collect_legacy_multipart_ids(legacy_mrna_parts)
    _emit_real_parent_transcripts(
        features,
        by_id,
        gene_types,
        can_carry_transcript_parts,
        exons_by_tx,
        exon_fallback_by_tx,
        cds_by_tx,
        legacy_multipart_ids,
        transcripts_by_id,
        consumed,
    )
    _emit_legacy_multipart_transcripts(
        legacy_mrna_parts, legacy_cds_parts, transcripts_by_id
    )
    _recover_bare_cds(features, transcripts_by_id, consumed)
    genes_by_id = _aggregate_resolved_genes(
        features, gene_types, transcripts_by_id, consumed
    )
    promoted = _promote_unconsumed_bacterial_cds(features, consumed)

    out: list = []
    out.extend(genes_by_id.values())
    out.extend(transcripts_by_id.values())
    out.extend(promoted)
    for f in features:
        if id(f) in consumed:
            continue
        out.append(f)
    return out
