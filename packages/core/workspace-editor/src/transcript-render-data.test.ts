import { describe, expect, it } from 'vitest';
import type { Annotation } from '@waypoint/sequence-utils';
import { CDS_EXTENSION_ORIGINAL_QUALIFIER } from './cds-extension-affordance';
import {
  transcriptRenderAnnotations,
  cohesiveCdsRenderAnnotations,
} from './transcript-render-data';
const cds: Annotation = {
  type: 'CDS',
  name: 'coding',
  start: 21,
  end: 180,
  direction: 1,
  segments: [
    { start: 21, end: 60 },
    { start: 121, end: 180 },
  ],
  qualifiers: { gene: ['shared'] },
};
describe('display-only transcript association', () => {
  it('preserves explicit UTR exons and derives coding segments from a unique CDS', () => {
    const gene: Annotation = {
      type: 'gene',
      name: 'gene',
      start: 1,
      end: 200,
      direction: 1,
      segments: [
        { start: 1, end: 60 },
        { start: 121, end: 200 },
      ],
      qualifiers: { gene: ['shared'] },
    };
    const input = [gene, cds];
    const result = transcriptRenderAnnotations(input);
    expect(result[0].segments).toBe(gene.segments);
    expect(result[0].codingSegments).toBe(cds.segments);
    expect(gene).not.toHaveProperty('codingSegments');
    expect(result[1]).toBe(cds);
    expect(transcriptRenderAnnotations(input)).toBe(result);
  });
  it('leaves ambiguous isoforms and opposite-strand associations untouched', () => {
    const gene: Annotation = {
      type: 'gene',
      name: 'gene',
      start: 1,
      end: 200,
      direction: 1,
      qualifiers: { gene: ['shared'] },
    };
    expect(transcriptRenderAnnotations([gene, cds, { ...cds, start: 30 }])[0]).toBe(gene);
    expect(transcriptRenderAnnotations([gene, { ...cds, direction: -1 }])[0]).toBe(gene);
  });
  it('uses exact bounds when there is no identity and keeps reverse exon coordinates', () => {
    const reverse = { ...cds, direction: -1 as const, qualifiers: {} };
    const gene = { ...reverse, type: 'gene', segments: undefined };
    expect(transcriptRenderAnnotations([gene, reverse])[0].segments).toBe(reverse.segments);
  });
});

describe('one cohesive CDS display record', () => {
  it('keeps one drawing and every name without changing the source annotations', () => {
    const gene = { ...cds, type: 'gene', name: 'gene', segments: undefined };
    const input = [gene, cds];
    const adapted = transcriptRenderAnnotations(input);
    const result = cohesiveCdsRenderAnnotations(adapted);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'CDS', name: 'coding', _compactName: 'gene · coding' });
    expect(input).toHaveLength(2);
    expect(gene).not.toHaveProperty('codingSegments');
    expect(cds).not.toHaveProperty('_compactName');
    expect(cohesiveCdsRenderAnnotations(adapted)).toBe(result);
  });
  it('preserves a different splice model, strand, bounds, or ambiguous coding association', () => {
    for (const gene of [
      { ...cds, type: 'gene', end: 200 },
      { ...cds, type: 'gene', direction: -1 as const },
      {
        ...cds,
        type: 'mRNA',
        segments: [
          { start: 21, end: 70 },
          { start: 131, end: 180 },
        ],
      },
    ])
      expect(cohesiveCdsRenderAnnotations(transcriptRenderAnnotations([gene, cds]))).toHaveLength(
        2
      );
    const gene = { ...cds, type: 'gene', segments: undefined };
    expect(
      cohesiveCdsRenderAnnotations(
        transcriptRenderAnnotations([gene, cds, { ...cds, name: 'other isoform' }])
      )
    ).toHaveLength(3);
  });
  it('keeps the gene association while a CDS extension is previewed', () => {
    const gene = { ...cds, type: 'gene', segments: undefined };
    const preview = {
      ...cds,
      start: 1,
      end: 200,
      qualifiers: {
        ...cds.qualifiers,
        [CDS_EXTENSION_ORIGINAL_QUALIFIER]: ['21..180'],
      },
    };
    expect(cohesiveCdsRenderAnnotations(transcriptRenderAnnotations([gene, preview]))).toHaveLength(
      1
    );
  });
  it('preserves the separate original record during draft review', () => {
    const gene = { ...cds, type: 'gene', segments: undefined };
    const draft = { ...cds, qualifiers: { source: ['pLannotate-draft'], status: ['accepted'] } };
    expect(cohesiveCdsRenderAnnotations(transcriptRenderAnnotations([gene, draft]))).toHaveLength(
      2
    );
  });
});
