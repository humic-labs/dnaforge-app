// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { reverseComplement } from '@waypoint/sequence-utils';
import { dbPrimerToPrimerDisplay } from './adapters';
import type { DbBoundPrimerRow } from './types';

function row(sequence: string, start: number, end: number, strand: 1 | -1): DbBoundPrimerRow {
  return {
    id: 'oligo',
    catalog_number: 'P1',
    name: 'assembly-primer',
    sequence,
    length: sequence.length,
    tm: 60,
    gc_percent: 50,
    origin: 'assembly',
    origin_details: null,
    status: 'designed',
    vendor: null,
    order_date: null,
    application: 'pcr',
    scale: null,
    purification: null,
    modifications: null,
    stock_location: null,
    concentration: null,
    notes: null,
    workspace_id: 1,
    created_at: 0,
    updated_at: 0,
    binding_id: 'placement',
    binding_start: start,
    binding_end: end,
    strand,
    source: 'manual',
    binding_created_at: 0,
    binding_updated_at: 0,
  };
}

describe('attached assembly primers with 5-prime tails', () => {
  const pbs = 'ACGTCCTAGTCA';
  const tail = 'TTTTGG';
  const oligo = tail + pbs;

  it.each([1, -1] as const)(
    'retains all bases and compares only the bound suffix on strand %s',
    (strand) => {
      const template =
        'C'.repeat(30) + (strand === 1 ? pbs : reverseComplement(pbs)) + 'A'.repeat(30);
      const display = dbPrimerToPrimerDisplay(row(oligo, 30, 42, strand), template);
      expect(display.bases).toBe(oligo);
      expect(display.overhangLength).toBe(6);
      expect(display.start).toBe(strand === 1 ? 24 : 30);
      expect(display.end).toBe(strand === 1 ? 42 : 48);
      expect(display.mismatches).toEqual([]);
    }
  );

  it.each([1, -1] as const)(
    'locates a real PBS mismatch in full canvas coordinates on strand %s',
    (strand) => {
      const authoredPbs = 'ACGTACTAGTCA';
      const template =
        'C'.repeat(30) + (strand === 1 ? pbs : reverseComplement(pbs)) + 'A'.repeat(30);
      const display = dbPrimerToPrimerDisplay(row(tail + authoredPbs, 30, 42, strand), template);
      expect(display.mismatches).toEqual([
        {
          position: strand === 1 ? 10 : 7,
          oligoBase: 'A',
          templateBase: 'C',
        },
      ]);
    }
  );

  it('keeps the 3-prime binding alignment when the binding interval wraps the origin', () => {
    const template = pbs.slice(5) + 'G'.repeat(20) + pbs.slice(0, 5);
    const display = dbPrimerToPrimerDisplay(row(oligo, 27, 7, 1), template, { circular: true });
    expect(display).toMatchObject({
      bases: oligo,
      start: 21,
      end: 7,
      overhangLength: 6,
      mismatches: [],
    });
  });

  it.each([1, -1] as const)('wraps only the tail at a circular boundary on strand %s', (strand) => {
    const template = strand === 1 ? pbs + 'G'.repeat(20) : 'G'.repeat(20) + reverseComplement(pbs);
    const display = dbPrimerToPrimerDisplay(
      row(oligo, strand === 1 ? 0 : 20, strand === 1 ? 12 : 32, strand),
      template,
      { circular: true }
    );
    expect(display).toMatchObject({
      bases: oligo,
      start: strand === 1 ? 26 : 20,
      end: strand === 1 ? 12 : 6,
      overhangLength: 6,
      mismatches: [],
    });
  });

  it('does not move a linear 5-prime extension to the far end of the template', () => {
    const display = dbPrimerToPrimerDisplay(row(oligo, 0, 12, 1), pbs + 'G'.repeat(20));
    expect(display).toMatchObject({
      bases: oligo,
      start: -6,
      end: 12,
      overhangLength: 6,
      mismatches: [],
    });
  });
});
