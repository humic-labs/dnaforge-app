import { describe, expect, it } from 'vitest';
import {
  COMPARISON_SOURCE_SCHEMA,
  comparisonCameraSchema,
  comparisonProjectionViewStateSchema,
  comparisonSourceDescriptorSchema,
  comparisonSourceProjectionId,
  type ComparisonSourceDescriptor,
} from './comparison-source';

const source: ComparisonSourceDescriptor = {
  schema: COMPARISON_SOURCE_SCHEMA,
  path: 'measurements/alignment.paf',
  sha256: 'a'.repeat(64),
  targetReference: { id: 'NC_000913.3', chrom: 'NC_000913.3', length: 4_641_652 },
  queryReference: {
    id: 'NC_004741.1',
    chrom: 'NC_004741.1',
    length: 4_599_354,
    label: 'Shigella flexneri 2457T',
  },
};

describe('comparison source contract', () => {
  it('retains exact paired accessions, lengths and a content-specific projection identity', () => {
    expect(comparisonSourceDescriptorSchema.parse(source)).toEqual(source);
    expect(comparisonSourceProjectionId(source)).toBe(`comparison:${source.sha256}`);
  });

  it.each([
    '/alignment.paf',
    '../alignment.paf',
    'measurements/../alignment.paf',
    'measurements/./alignment.paf',
    'measurements//alignment.paf',
    'C:/alignment.paf',
    'measurements\\alignment.paf',
    'alignment.paf\u0000',
  ])('rejects non-relative or ambiguous paths: %s', (path) => {
    expect(comparisonSourceDescriptorSchema.safeParse({ ...source, path }).success).toBe(false);
  });

  it('requires an exact unprefixed SHA-256 and exposes no row-filter option', () => {
    for (const sha256 of ['', 'a'.repeat(63), 'A'.repeat(64), `sha256:${source.sha256}`]) {
      expect(comparisonSourceDescriptorSchema.safeParse({ ...source, sha256 }).success).toBe(false);
    }
    expect(
      comparisonSourceDescriptorSchema.safeParse({ ...source, minimumAlignmentColumns: 1000 })
        .success
    ).toBe(false);
  });

  it('requires exact chromosome accessions and safe positive reference lengths', () => {
    for (const change of [
      { id: 'alias' },
      { chrom: 'alias' },
      { id: 'space id', chrom: 'space id' },
      { length: 0 },
      { length: 1.5 },
      { length: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(
        comparisonSourceDescriptorSchema.safeParse({
          ...source,
          targetReference: { ...source.targetReference, ...change },
        }).success
      ).toBe(false);
    }
  });

  it('saves an absolute owning project and the exact alignment-column camera', () => {
    const camera = {
      projectionId: comparisonSourceProjectionId(source),
      startColumn: 10.5,
      endColumn: 80,
    };
    const view = { kind: 'aligned-genomes', project: '/project', source, camera };
    expect(comparisonProjectionViewStateSchema.parse(view)).toEqual(view);
    expect(
      comparisonProjectionViewStateSchema.safeParse({ ...view, project: 'relative-project' })
        .success
    ).toBe(false);
    expect(
      comparisonProjectionViewStateSchema.safeParse({
        ...view,
        camera: { ...camera, projectionId: 'comparison:obsolete-revision' },
      }).success
    ).toBe(false);
    for (const change of [
      { startColumn: -1 },
      { startColumn: 80 },
      { endColumn: Infinity },
      { endColumn: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(comparisonCameraSchema.safeParse({ ...camera, ...change }).success).toBe(false);
    }
  });
});
