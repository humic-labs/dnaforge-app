// @vitest-environment node

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { isResolvedGene, isResolvedTranscript, type GenomeFeature } from '@waypoint/genome-data';
import { resolveTranscripts } from './spliced-feature-resolver';

function feat(
  overrides: Partial<GenomeFeature> & Pick<GenomeFeature, 'type' | 'start' | 'end'>
): GenomeFeature {
  return {
    chrom: overrides.chrom ?? 'chr11',
    source: overrides.source ?? 'test',
    type: overrides.type,
    start: overrides.start,
    end: overrides.end,
    score: overrides.score ?? null,
    strand: overrides.strand ?? '+',
    phase: overrides.phase ?? null,
    attributes: overrides.attributes ?? {},
    raw: overrides.raw ?? '',
  };
}

const EXON_PITCH = 1_000;
const EXON_LEN = 100;

function buildLgals12LikeFixture(opts: {
  emptyCdsIsoformIndex: number;
  isoformCount: number;
  orphanCdsCount: number;
  exonCount?: number;
}): GenomeFeature[] {
  const exonCount = opts.exonCount ?? Math.max(opts.orphanCdsCount, 3);
  const features: GenomeFeature[] = [];
  const geneEnd = 100 + exonCount * EXON_PITCH + EXON_LEN;
  features.push(
    feat({
      type: 'gene',
      start: 100,
      end: geneEnd,
      attributes: { ID: ['LGALS12.gene.1'], gene: ['LGALS12'] },
    })
  );

  for (let i = 0; i < opts.isoformCount; i++) {
    const mrnaId = `LGALS12.mrna.${i + 1}`;
    features.push(
      feat({
        type: 'mRNA',
        start: 100,
        end: geneEnd,
        attributes: {
          ID: [mrnaId],
          Parent: ['LGALS12.gene.1'],
          gene: ['LGALS12'],
          transcript_id: [`NM_LGALS12.${i + 1}`],
        },
      })
    );
    for (let e = 0; e < exonCount; e++) {
      const exonStart = 100 + e * EXON_PITCH;
      const exonEnd = exonStart + EXON_LEN;
      features.push(
        feat({
          type: 'exon',
          start: exonStart,
          end: exonEnd,
          attributes: {
            ID: [`LGALS12.exon.${i + 1}-${e}`],
            Parent: [mrnaId],
            gene: ['LGALS12'],
          },
        })
      );
    }
    if (i !== opts.emptyCdsIsoformIndex) {
      for (let c = 0; c < exonCount; c++) {
        const cdsStart = 100 + c * EXON_PITCH + 20 + i;
        const cdsEnd = cdsStart + 60;
        features.push(
          feat({
            type: 'CDS',
            start: cdsStart,
            end: cdsEnd,
            attributes: {
              ID: [`LGALS12.cds.${i + 1}-${c}`],
              Parent: [mrnaId],
              gene: ['LGALS12'],
            },
          })
        );
      }
    }
  }

  for (let o = 0; o < opts.orphanCdsCount; o++) {
    const cdsStart = 100 + o * EXON_PITCH + 40;
    const cdsEnd = cdsStart + 50;
    features.push(
      feat({
        type: 'CDS',
        start: cdsStart,
        end: cdsEnd,
        attributes: {
          ID: [`LGALS12.cds.orphan-${o}`],
          gene: ['LGALS12'],
          note: [
            `isoform ${opts.emptyCdsIsoformIndex + 1} is encoded by transcript variant ${opts.emptyCdsIsoformIndex + 1}`,
          ],
        },
      })
    );
  }

  return features;
}

function flattenTranscripts(annotations: ReturnType<typeof resolveTranscripts>) {
  const out: Array<{
    transcriptId: string;
    cds: ReadonlyArray<{ start: number; end: number }>;
    geneId?: string;
  }> = [];
  for (const a of annotations) {
    if (isResolvedGene(a)) {
      for (const t of a.transcripts) {
        out.push({ transcriptId: t.transcriptId, cds: t.cds, geneId: a.geneId });
      }
    } else if (isResolvedTranscript(a)) {
      out.push({ transcriptId: a.transcriptId, cds: a.cds, geneId: a.geneId });
    }
  }
  return out;
}

describe('resolveTranscripts —  LGALS12 orphan-CDS recovery (multi-isoform gene)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('routes every orphan CDS to the originally-empty-cds isoform (LGALS12 scenario)', () => {
    const features = buildLgals12LikeFixture({
      emptyCdsIsoformIndex: 3,
      isoformCount: 7,
      orphanCdsCount: 8,
    });

    const resolved = resolveTranscripts(features);
    const transcripts = flattenTranscripts(resolved);
    const originalIsoforms = transcripts.filter((t) => /^LGALS12\.mrna\.\d+$/.test(t.transcriptId));
    expect(originalIsoforms.length).toBe(7);

    const mrna4 = originalIsoforms.find((t) => t.transcriptId === 'LGALS12.mrna.4');
    expect(mrna4, 'mrna.4 must be present after resolve').toBeDefined();
    expect(mrna4!.cds.length).toBe(8);

    const EXON_COUNT = 8;
    for (const t of originalIsoforms) {
      if (t.transcriptId === 'LGALS12.mrna.4') continue;
      expect(
        t.cds.length,
        `${t.transcriptId} should keep its own ${EXON_COUNT} CDS, not be polluted by orphans`
      ).toBe(EXON_COUNT);
    }

    const promotedSingleExonMrnas = resolved.filter(
      (a) => isResolvedTranscript(a) && a.transcriptId.includes('orphan')
    );
    expect(promotedSingleExonMrnas).toHaveLength(0);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('refuses ambiguous attachment when MULTIPLE candidates are originally-empty-cds', () => {
    const features = buildLgals12LikeFixture({
      emptyCdsIsoformIndex: 0,
      isoformCount: 3,
      orphanCdsCount: 2,
    });
    const stripped = features.filter(
      (f) => !(f.type === 'CDS' && f.attributes.Parent?.[0] === 'LGALS12.mrna.2')
    );

    const resolved = resolveTranscripts(stripped);
    const transcripts = flattenTranscripts(resolved);

    const mrna1 = transcripts.find((t) => t.transcriptId === 'LGALS12.mrna.1');
    const mrna2 = transcripts.find((t) => t.transcriptId === 'LGALS12.mrna.2');
    expect(mrna1!.cds.length).toBe(0);
    expect(mrna2!.cds.length).toBe(0);

    const promotedOrphans = resolved.filter(
      (a) => isResolvedTranscript(a) && /LGALS12\.cds\.orphan-/.test(a.attributes.ID?.[0] ?? '')
    );
    expect(promotedOrphans.length).toBe(2);
    expect(promotedOrphans.every((feature) => feature.type === 'CDS')).toBe(true);

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0][0]).toMatch(/refused to force-attach orphan CDS/);
    expect(warnSpy.mock.calls[0][0]).toMatch(/no unambiguous empty-cds match/);
  });

  it('refuses ambiguous attachment when ZERO candidates are originally-empty-cds (all isoforms already have their own CDS)', () => {
    const features = buildLgals12LikeFixture({
      emptyCdsIsoformIndex: -1,
      isoformCount: 3,
      orphanCdsCount: 2,
    });

    const resolved = resolveTranscripts(features);
    const transcripts = flattenTranscripts(resolved);

    const originalIsoforms = transcripts.filter((t) => /^LGALS12\.mrna\.\d+$/.test(t.transcriptId));
    expect(originalIsoforms.length).toBe(3);
    for (const t of originalIsoforms) {
      expect(
        t.cds.length,
        `${t.transcriptId} should keep its own CDS, unpolluted`
      ).toBeGreaterThanOrEqual(2);
    }

    const promotedOrphans = resolved.filter(
      (a) => isResolvedTranscript(a) && /LGALS12\.cds\.orphan-/.test(a.attributes.ID?.[0] ?? '')
    );
    expect(promotedOrphans.length).toBe(2);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('preserves single-candidate attach behavior (gene with only ONE isoform — no ambiguity)', () => {
    const features = buildLgals12LikeFixture({
      emptyCdsIsoformIndex: 0,
      isoformCount: 1,
      orphanCdsCount: 3,
    });

    const resolved = resolveTranscripts(features);
    const transcripts = flattenTranscripts(resolved);

    expect(transcripts.length).toBe(1);
    const mrna1 = transcripts[0];
    expect(mrna1.transcriptId).toBe('LGALS12.mrna.1');
    expect(mrna1.cds.length).toBe(3);

    const promotedOrphans = resolved.filter(
      (a) => isResolvedTranscript(a) && /LGALS12\.cds\.orphan-/.test(a.attributes.ID?.[0] ?? '')
    );
    expect(promotedOrphans).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
