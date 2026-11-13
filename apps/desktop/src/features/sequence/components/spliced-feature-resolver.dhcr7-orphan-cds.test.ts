// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { isResolvedTranscript, type GenomeFeature } from '@waypoint/genome-data';
import { resolveTranscripts } from './spliced-feature-resolver';

function feat(
  overrides: Partial<GenomeFeature> & Pick<GenomeFeature, 'type' | 'start' | 'end'>
): GenomeFeature {
  return {
    chrom: 'chr11',
    source: 'DNAForge',
    score: '.',
    strand: '-',
    phase: '.',
    attributes: {},
    raw: '',
    ...overrides,
  } as GenomeFeature;
}

function dhcr7Fixture(): GenomeFeature[] {
  const exonBpsA = [
    { start: 71434410, end: 71435839 },
    { start: 71437811, end: 71437943 },
    { start: 71444854, end: 71444952 },
  ];
  const ownCdsBps = [
    { start: 71435374, end: 71435839 },
    { start: 71437811, end: 71437943 },
    { start: 71444854, end: 71444952 },
  ];
  const out: GenomeFeature[] = [];
  out.push(
    feat({
      type: 'gene',
      start: 71427286,
      end: 71449043,
      attributes: { ID: ['DHCR7.gene.1'], gene: ['DHCR7'] },
    })
  );
  out.push(
    feat({
      type: 'mRNA',
      start: 71434410,
      end: 71448393,
      attributes: {
        ID: ['DHCR7.mrna.10'],
        gene: ['DHCR7'],
        product: ['7-dehydrocholesterol reductase, transcript variant 1'],
      },
    })
  );
  for (let i = 0; i < exonBpsA.length; i++) {
    const e = exonBpsA[i];
    out.push(
      feat({
        type: 'exon',
        start: e.start,
        end: e.end,
        attributes: { ID: [`DHCR7.exon.10-${i}`], Parent: ['DHCR7.mrna.10'], gene: ['DHCR7'] },
      })
    );
  }
  for (let i = 0; i < ownCdsBps.length; i++) {
    const c = ownCdsBps[i];
    out.push(
      feat({
        type: 'CDS',
        start: c.start,
        end: c.end,
        attributes: { ID: [`DHCR7.cds.10-${i}`], Parent: ['DHCR7.mrna.10'], gene: ['DHCR7'] },
      })
    );
  }
  out.push(
    feat({
      type: 'mRNA',
      start: 71434410,
      end: 71448393,
      attributes: {
        ID: ['DHCR7.mrna.3'],
        gene: ['DHCR7'],
        product: ['7-dehydrocholesterol reductase, transcript variant 2'],
      },
    })
  );
  for (let i = 0; i < exonBpsA.length; i++) {
    const e = exonBpsA[i];
    out.push(
      feat({
        type: 'exon',
        start: e.start,
        end: e.end,
        attributes: { ID: [`DHCR7.exon.3-${i}`], Parent: ['DHCR7.mrna.3'], gene: ['DHCR7'] },
      })
    );
  }
  out.push(
    feat({
      type: 'mRNA',
      start: 71434410,
      end: 71448393,
      attributes: {
        ID: ['DHCR7.mrna.16'],
        gene: ['DHCR7'],
        product: ['7-dehydrocholesterol reductase, transcript variant 6'],
      },
    })
  );
  for (let i = 0; i < exonBpsA.length; i++) {
    const e = exonBpsA[i];
    out.push(
      feat({
        type: 'exon',
        start: e.start,
        end: e.end,
        attributes: { ID: [`DHCR7.exon.16-${i}`], Parent: ['DHCR7.mrna.16'], gene: ['DHCR7'] },
      })
    );
  }
  for (let i = 0; i < ownCdsBps.length; i++) {
    const c = ownCdsBps[i];
    out.push(
      feat({
        type: 'CDS',
        start: c.start,
        end: c.end,
        attributes: {
          ID: [`DHCR7.cds.7-${i}`],
          gene: ['DHCR7'],
          note: ['isoform 1 is encoded by transcript variant 1; orphan'],
        },
      })
    );
  }
  for (let i = 0; i < ownCdsBps.length; i++) {
    const c = ownCdsBps[i];
    out.push(
      feat({
        type: 'CDS',
        start: c.start,
        end: c.end,
        attributes: {
          ID: [`DHCR7.cds.8-${i}`],
          gene: ['DHCR7'],
          note: ['isoform 1 is encoded by transcript variant 2; orphan'],
        },
      })
    );
  }
  for (let i = 0; i < ownCdsBps.length; i++) {
    const c = ownCdsBps[i];
    out.push(
      feat({
        type: 'CDS',
        start: c.start,
        end: c.end,
        attributes: {
          ID: [`DHCR7.cds.9-${i}`],
          gene: ['DHCR7'],
          note: ['isoform 1 is encoded by transcript variant 6; orphan'],
        },
      })
    );
  }
  return out;
}

describe('resolveTranscripts —  DHCR7 orphan-CDS recovery (multi-empty-isoform gene)', () => {
  it('drops bp-duplicate orphan cluster (cds.7-*) — neither attaches to mrna.10 nor bacterial-promotes', () => {
    const resolved = resolveTranscripts(dhcr7Fixture());
    const transcripts = resolved.filter(isResolvedTranscript);
    const mrna10 = transcripts.find((t) => t.transcriptId === 'DHCR7.mrna.10');
    expect(mrna10, 'mrna.10 should survive resolution').toBeDefined();
    expect(mrna10!.cds).toHaveLength(3);
    const promotedFromCds7 = transcripts.filter((t) => /DHCR7\.cds\.7-\d+/.test(t.transcriptId));
    expect(
      promotedFromCds7,
      `cds.7-* should NOT bacterial-promote (bp-duplicate of mrna.10's CDS) — got: ${promotedFromCds7
        .map((t) => t.transcriptId)
        .join(', ')}`
    ).toHaveLength(0);
  });

  it('routes orphan cluster cds.8-* (variant 2) to mrna.3 via variant-N text tiebreak', () => {
    const resolved = resolveTranscripts(dhcr7Fixture());
    const transcripts = resolved.filter(isResolvedTranscript);
    const mrna3 = transcripts.find((t) => t.transcriptId === 'DHCR7.mrna.3');
    expect(mrna3, 'mrna.3 should survive resolution').toBeDefined();
    expect(mrna3!.cds).toHaveLength(3);
    const promotedFromCds8 = transcripts.filter((t) => /DHCR7\.cds\.8-\d+/.test(t.transcriptId));
    expect(
      promotedFromCds8,
      `cds.8-* should attach to mrna.3 (variant 2), not bacterial-promote — got: ${promotedFromCds8
        .map((t) => t.transcriptId)
        .join(', ')}`
    ).toHaveLength(0);
  });

  it('routes orphan cluster cds.9-* (variant 6) to mrna.16 via variant-N text tiebreak', () => {
    const resolved = resolveTranscripts(dhcr7Fixture());
    const transcripts = resolved.filter(isResolvedTranscript);
    const mrna16 = transcripts.find((t) => t.transcriptId === 'DHCR7.mrna.16');
    expect(mrna16, 'mrna.16 should survive resolution').toBeDefined();
    expect(mrna16!.cds).toHaveLength(3);
    const promotedFromCds9 = transcripts.filter((t) => /DHCR7\.cds\.9-\d+/.test(t.transcriptId));
    expect(
      promotedFromCds9,
      `cds.9-* should attach to mrna.16 (variant 6), not bacterial-promote — got: ${promotedFromCds9
        .map((t) => t.transcriptId)
        .join(', ')}`
    ).toHaveLength(0);
  });

  it('mrna.10 keeps its own Parent=-linked CDS chain unmodified (no cross-contamination from cds.7)', () => {
    const resolved = resolveTranscripts(dhcr7Fixture());
    const transcripts = resolved.filter(isResolvedTranscript);
    const mrna10 = transcripts.find((t) => t.transcriptId === 'DHCR7.mrna.10');
    expect(mrna10!.cds.map((c) => `${c.start}-${c.end}`).sort()).toEqual(
      ['71435375-71435839', '71437812-71437943', '71444855-71444952'].sort()
    );
  });

  it('no orphan from the three test clusters bacterial-promotes (zero ghost lanes)', () => {
    const resolved = resolveTranscripts(dhcr7Fixture());
    const transcripts = resolved.filter(isResolvedTranscript);
    const ghostGlyphs = transcripts.filter(
      (t) =>
        /DHCR7\.cds\.[789]-\d+/.test(t.transcriptId) ||
        (t.exons.length === 1 && /DHCR7\.cds\./.test(t.transcriptId))
    );
    expect(
      ghostGlyphs.map((t) => `${t.transcriptId}(exons=${t.exons.length},cds=${t.cds.length})`),
      'zero orphan-promoted single-part ghost glyphs — these are what the user saw in lanes 16/17/18'
    ).toEqual([]);
  });

  it('still refuses ambiguous attachment when neither bp-duplicate nor variant-N tiebreak fires (LGALS12 invariant preserved)', () => {
    const exonBps = [
      { start: 100, end: 200 },
      { start: 300, end: 400 },
    ];
    const fixture: GenomeFeature[] = [
      feat({
        type: 'gene',
        start: 99,
        end: 400,
        attributes: { ID: ['G.gene.1'], gene: ['G'] },
      }),
      feat({
        type: 'mRNA',
        start: 99,
        end: 400,
        attributes: { ID: ['G.mrna.A'], gene: ['G'] },
      }),
      feat({
        type: 'mRNA',
        start: 99,
        end: 400,
        attributes: { ID: ['G.mrna.B'], gene: ['G'] },
      }),
      ...exonBps.map((e, i) =>
        feat({
          type: 'exon',
          start: e.start,
          end: e.end,
          attributes: { ID: [`G.exon.A-${i}`], Parent: ['G.mrna.A'], gene: ['G'] },
        })
      ),
      ...exonBps.map((e, i) =>
        feat({
          type: 'exon',
          start: e.start,
          end: e.end,
          attributes: { ID: [`G.exon.B-${i}`], Parent: ['G.mrna.B'], gene: ['G'] },
        })
      ),
      feat({
        type: 'CDS',
        start: 300,
        end: 400,
        attributes: { ID: ['G.orphan.0'], gene: ['G'] },
      }),
    ];
    const resolved = resolveTranscripts(fixture);
    const transcripts = resolved.filter(isResolvedTranscript);
    const a = transcripts.find((t) => t.transcriptId === 'G.mrna.A');
    const b = transcripts.find((t) => t.transcriptId === 'G.mrna.B');
    expect(a!.cds, 'mrna.A must not adopt the ambiguous orphan').toHaveLength(0);
    expect(b!.cds, 'mrna.B must not adopt the ambiguous orphan').toHaveLength(0);
    const promoted = transcripts.filter((t) => /G\.orphan\.0/.test(t.transcriptId));
    expect(promoted).toHaveLength(1);
    expect(promoted[0].type).toBe('CDS');
  });
});
