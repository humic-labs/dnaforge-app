import { describe, expect, it } from 'vitest';
import { parseTrackViewDocument, serializeTrackViewDocument } from './track-view';
import { trackViewFixture } from './track-view-fixture';
import {
  comparisonSourceDescriptorSchema,
  comparisonSourceProjectionId,
  comparisonSourceWindowRequestSchema,
  type ComparisonSourceDescriptor,
} from './comparison-source';

const binding = {
  referenceId: 'prepared-query',
  sequenceIdentity: 'b'.repeat(64),
  annotationIdentity: 'c'.repeat(64),
};
const source: ComparisonSourceDescriptor = {
  schema: 'dnaforge.comparison-source.v1',
  path: 'comparison.paf',
  sha256: 'a'.repeat(64),
  targetReference: { id: 'pUC19', chrom: 'pUC19', length: 2686 },
  queryReference: { id: 'query.1', chrom: 'query.1', length: 3000 },
  targetSource: { ...binding, referenceId: 'prepared-target' },
  querySource: binding,
};

describe('pinned prepared comparison sources', () => {
  it('round-trips both exact native source bindings and camera without source bases or annotation copies', () => {
    const comparison = {
      kind: 'aligned-genomes' as const,
      project: '/project',
      source,
      camera: {
        projectionId: comparisonSourceProjectionId(source),
        startColumn: 10,
        endColumn: 90,
      },
    };
    const text = serializeTrackViewDocument({
      ...trackViewFixture(),
      comparisonProjection: comparison,
    });
    expect(parseTrackViewDocument(text).comparisonProjection).toEqual(comparison);
    expect(text).not.toContain('SequenceWindows');
    expect(text).not.toContain('annotations');
  });

  it('pins the original requested source identity and both content revisions in the projected camera', () => {
    const id = comparisonSourceProjectionId(source);
    expect(id).not.toBe(`comparison:${source.sha256}`);
    for (const side of ['targetSource', 'querySource'] as const) {
      for (const field of ['referenceId', 'sequenceIdentity', 'annotationIdentity'] as const) {
        const value = field === 'referenceId' ? 'another-prepared-reference' : 'd'.repeat(64);
        expect(
          comparisonSourceProjectionId({ ...source, [side]: { ...source[side]!, [field]: value } })
        ).not.toBe(id);
      }
    }
    expect(
      comparisonSourceProjectionId({
        ...source,
        querySource: {
          annotationIdentity: binding.annotationIdentity,
          sequenceIdentity: binding.sequenceIdentity,
          referenceId: binding.referenceId,
        },
      })
    ).toBe(id);
    expect(
      comparisonSourceProjectionId({ ...source, targetSource: undefined, querySource: undefined })
    ).toBe(`comparison:${source.sha256}`);
  });

  it('rejects unpinned paths, incomplete identities, malformed hashes and caller-defined source material', () => {
    for (const querySource of [
      { referenceId: binding.referenceId },
      { ...binding, sequenceIdentity: 'x'.repeat(64) },
      { ...binding, annotationIdentity: `sha256:${binding.annotationIdentity}` },
      { ...binding, fastaPath: '/arbitrary.fa' },
      { ...binding, sequence: 'ACGT' },
    ])
      expect(comparisonSourceDescriptorSchema.safeParse({ ...source, querySource }).success).toBe(
        false
      );
  });

  it('requires a new camera when either prepared binding changes', () => {
    const request = {
      project: '/project',
      source,
      camera: { projectionId: comparisonSourceProjectionId(source), startColumn: 0, endColumn: 80 },
    };
    expect(comparisonSourceWindowRequestSchema.parse(request)).toEqual(request);
    expect(
      comparisonSourceWindowRequestSchema.safeParse({
        ...request,
        source: { ...source, querySource: { ...binding, annotationIdentity: 'e'.repeat(64) } },
      }).success
    ).toBe(false);
  });
});
