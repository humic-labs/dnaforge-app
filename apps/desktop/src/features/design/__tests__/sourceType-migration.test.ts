// @vitest-environment node

import { describe, it, expect } from 'vitest';
import type { DesignRegion } from '../types';

describe('sourceType migration', () => {
  it('should default regions without sourceType to pcr', () => {
    const oldRegion: Partial<DesignRegion> = {
      id: 'region-1',
      sourceSequenceId: 'seq-1',
      sourceSequenceName: 'pUC19',
      sourceStart: 0,
      sourceEnd: 100,
      sequence: 'ATCG',
      annotations: [],
    };

    const migrateRegion = (region: Partial<DesignRegion>): DesignRegion => {
      return {
        ...region,
        sourceType: region.sourceType ?? 'pcr',
      } as DesignRegion;
    };

    const migrated = migrateRegion(oldRegion);
    expect(migrated.sourceType).toBe('pcr');
  });

  it('should preserve existing sourceType', () => {
    const rdRegion: Partial<DesignRegion> = {
      id: 'region-2',
      sourceSequenceId: 'seq-2',
      sourceSequenceName: 'pBR322',
      sourceStart: 0,
      sourceEnd: 200,
      sequence: 'GCTA',
      annotations: [],
      sourceType: 'rd',
      rdOverhangs: {
        upstream: 'AATT',
        downstream: 'GATC',
      },
    };

    const migrateRegion = (region: Partial<DesignRegion>): DesignRegion => {
      return {
        ...region,
        sourceType: region.sourceType ?? 'pcr',
      } as DesignRegion;
    };

    const migrated = migrateRegion(rdRegion);
    expect(migrated.sourceType).toBe('rd');
    expect(migrated.rdOverhangs).toEqual({
      upstream: 'AATT',
      downstream: 'GATC',
    });
  });

  it('should handle all region properties during migration', () => {
    const fullRegion: DesignRegion = {
      id: 'region-3',
      sourceSequenceId: 'seq-3',
      sourceSequenceName: 'GFP',
      sourceStart: 50,
      sourceEnd: 150,
      sequence: 'ATCGATCG',
      annotations: [{ name: 'CDS', type: 'CDS', start: 0, end: 100, strand: 'forward' as const }],
      sourceType: 'pcr',
      isPlaceholder: false,
    };

    const migrateRegion = (region: Partial<DesignRegion>): DesignRegion => {
      return {
        ...region,
        sourceType: region.sourceType ?? 'pcr',
      } as DesignRegion;
    };

    const migrated = migrateRegion(fullRegion);
    expect(migrated).toEqual(fullRegion);
  });
});
