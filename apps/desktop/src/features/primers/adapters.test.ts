// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { dbPrimerToPrimerDisplay } from './adapters';
import type { DbBoundPrimerRow } from './types';

function makeRow(overrides: Partial<DbBoundPrimerRow> = {}): DbBoundPrimerRow {
  return {
    id: 'primer-1',
    catalog_number: 'P001',
    name: 'EGFP-C',
    sequence: 'CATGGTCCTGCTGGAGTTCGTG',
    length: 22,
    tm: 62.3,
    gc_percent: 59,
    origin: 'manual',
    origin_details: null,
    status: 'designed',
    vendor: null,
    order_date: null,
    application: 'sequencing',
    scale: null,
    purification: null,
    modifications: null,
    stock_location: null,
    concentration: null,
    notes: null,
    workspace_id: null,
    created_at: 0,
    updated_at: 0,
    binding_id: 'binding-1',
    binding_start: 100,
    binding_end: 122,
    strand: 1,
    source: 'manual',
    binding_created_at: 0,
    binding_updated_at: 0,
    ...overrides,
  };
}

describe('dbPrimerToPrimerDisplay', () => {
  describe('direction follows binding.strand', () => {
    it('renders forward when binding.strand=1  regression: EGFP-C on pAJM.657)', () => {
      const row = makeRow({ strand: 1 });
      const display = dbPrimerToPrimerDisplay(row);
      expect(display.direction).toBe('forward');
    });

    it('renders reverse when binding.strand=-1', () => {
      const row = makeRow({ strand: -1 });
      const display = dbPrimerToPrimerDisplay(row);
      expect(display.direction).toBe('reverse');
    });
  });

  it('projects validated vendor modification anchors for attached-primer rendering', () => {
    const display = dbPrimerToPrimerDisplay(
      makeRow({
        sequence: 'ACGT',
        length: 4,
        binding_start: 100,
        binding_end: 104,
        vendor: 'idt',
        modifications: '/5Phos/AC/iSp18/G/3InvdT/',
      })
    );

    expect(display.modificationMarkers).toEqual([
      expect.objectContaining({
        token: '/5Phos/',
        anchor: { kind: 'terminus', end: 'five-prime' },
      }),
      expect.objectContaining({ token: '/iSp18/', anchor: { kind: 'between-bases', offset: 2 } }),
      expect.objectContaining({ token: '/3InvdT/', anchor: { kind: 'base', index: 3 } }),
    ]);
  });

  it('parses attached RNA modification markers with the projected oligo identity', () => {
    const display = dbPrimerToPrimerDisplay(
      makeRow({
        sequence: 'AUC',
        length: 3,
        binding_start: 100,
        binding_end: 103,
        origin_details: JSON.stringify({
          authority: 'primer_artifact',
          oligoOrderType: 'rna',
        }),
        vendor: 'idt',
        modifications: 'rA/i2FU/rC',
      })
    );

    expect(display.modificationMarkers).toEqual([
      expect.objectContaining({
        token: '/i2FU/',
        anchor: { kind: 'base', index: 1 },
      }),
    ]);
  });

  it('still renders historical markers after a newer vendor ordering restriction', () => {
    const display = dbPrimerToPrimerDisplay(
      makeRow({
        sequence: 'AC',
        length: 2,
        binding_start: 100,
        binding_end: 102,
        vendor: 'idt',
        modifications: '/5YakYel/AC/36-TAMSp/',
      })
    );

    expect(display.modificationMarkers).toEqual([
      expect.objectContaining({ token: '/5YakYel/' }),
      expect.objectContaining({ token: '/36-TAMSp/' }),
    ]);
  });

  describe('mismatch computation respects binding.strand', () => {
    it('does not falsely report mismatches when forward primer binds forward strand', () => {
      const primerSeq = 'ACGTACGTACGTACGTACGTAC';
      const reference = 'X'.repeat(100) + primerSeq + 'X'.repeat(50);
      const row = makeRow({
        sequence: primerSeq,
        strand: 1,
        binding_start: 100,
        binding_end: 122,
      });
      const display = dbPrimerToPrimerDisplay(row, reference);
      expect(display.direction).toBe('forward');
      expect(display.mismatches).toEqual([]);
    });
  });
});
