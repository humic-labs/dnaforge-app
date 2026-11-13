// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { exportPrimersCSV, exportPrimersIDT, exportPrimersTSV } from './primer-export';
import type { Primer } from './types';

function createExportPrimer(overrides?: Partial<Primer>): Primer {
  return {
    id: 'test-1',
    catalogNumber: 'P001',
    name: 'lacZ_F1',
    sequence: 'ATCGATCGATCGATCGATCG',
    length: 20,
    tm: 58.4,
    gcPercent: 50.0,
    origin: 'manual',
    originDetails: null,
    status: 'designed',
    vendor: null,
    orderDate: null,
    application: null,
    scale: null,
    purification: null,
    modifications: null,
    stockLocation: null,
    concentration: null,
    notes: null,
    workspaceId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('exportPrimersCSV', () => {
  it('generates CSV with standard headers', () => {
    const primers = [
      createExportPrimer({ name: 'lacZ_F1' }),
      createExportPrimer({ name: 'lacZ_R1', id: 'test-2', catalogNumber: 'P002' }),
    ];
    const csv = exportPrimersCSV(primers);
    const lines = csv.split('\n');

    expect(lines[0]).toBe('Name,Sequence,Length (nt),Tm (°C),GC (%),Status');
    expect(lines).toHaveLength(3);
  });

  it('quotes fields containing commas', () => {
    const primers = [createExportPrimer({ name: 'lacZ, forward' })];
    const csv = exportPrimersCSV(primers);
    const lines = csv.split('\n');

    expect(lines[1]).toContain('"lacZ, forward"');
  });

  it('leaves unavailable RNA thermodynamics blank instead of exporting null', () => {
    const csv = exportPrimersCSV([createExportPrimer({ sequence: 'ACGU', length: 4, tm: null })]);

    expect(csv.split('\n')[1]).toContain('ACGU,4,,');
    expect(csv).not.toContain('null');
  });
});

describe('exportPrimersIDT', () => {
  it('generates IDT bulk upload format', () => {
    const primers = [
      createExportPrimer({ name: 'lacZ_F1' }),
      createExportPrimer({ name: 'lacZ_R1', id: 'test-2' }),
    ];
    const idt = exportPrimersIDT(primers);
    const lines = idt.split('\n');

    expect(lines[0]).toBe('Name,Sequence,Scale,Purification');
    expect(lines).toHaveLength(3);
  });

  it('uses 25nmol default scale', () => {
    const primers = [createExportPrimer()];
    const idt = exportPrimersIDT(primers);
    const lines = idt.split('\n');
    const dataLine = lines[1];

    expect(dataLine).toContain('25 nmol');
  });

  it('uses Standard Desalting default purification', () => {
    const primers = [createExportPrimer()];
    const idt = exportPrimersIDT(primers);
    const lines = idt.split('\n');
    const dataLine = lines[1];

    expect(dataLine).toContain('Standard Desalting');
  });

  it('overrides defaults when primer has custom scale/purification', () => {
    const primers = [createExportPrimer({ scale: '100 nmol', purification: 'PAGE' })];
    const idt = exportPrimersIDT(primers);
    const lines = idt.split('\n');
    const dataLine = lines[1];

    expect(dataLine).toContain('100 nmol');
    expect(dataLine).toContain('PAGE');
    expect(dataLine).not.toContain('25 nmol');
    expect(dataLine).not.toContain('Standard Desalting');
  });

  it('exports validated IDT modification notation ready for bulk ordering', () => {
    const notation = '/5Phos/AC/iBiodT/G/3SpC3/';
    const idt = exportPrimersIDT([
      createExportPrimer({
        sequence: 'ACTG',
        length: 4,
        vendor: 'idt',
        modifications: notation,
      }),
    ]);

    expect(idt.split('\n')[1]).toContain(`,${notation},`);
  });

  it('exports exact RNA order notation instead of collapsing it to DNA bases', () => {
    const notation = '/5Phos/rArCrG/i2FU/rC/3SpC3/';
    const idt = exportPrimersIDT([
      createExportPrimer({
        sequence: 'ACGUC',
        length: 5,
        tm: null,
        vendor: 'idt',
        modifications: notation,
        originDetails: { oligoOrderType: 'rna' },
      }),
    ]);

    expect(idt).toContain(notation);
  });

  it('exports plain RNA editor bases as vendor-ready IDT RNA notation', () => {
    const idt = exportPrimersIDT([
      createExportPrimer({
        sequence: 'ACGU',
        length: 4,
        tm: null,
        originDetails: { oligoOrderType: 'rna' },
      }),
    ]);

    expect(idt.split('\n')[1]).toContain(',rArCrGrU,');
  });

  it('preserves Affinity Plus vendor notation in an IDT bulk-order row', () => {
    const notation = '+A+C+G+T';
    const idt = exportPrimersIDT([
      createExportPrimer({
        sequence: 'ACGT',
        length: 4,
        vendor: 'idt',
        modifications: notation,
      }),
    ]);

    expect(idt.split('\n')[1]).toContain(`,${notation},`);
  });

  it('blocks a bulk-order row that violates a documented IDT incompatibility', () => {
    expect(() =>
      exportPrimersIDT([
        createExportPrimer({
          sequence: 'AC',
          length: 2,
          vendor: 'idt',
          modifications: '/5YakYel/AC/36-TAMSp/',
        }),
      ])
    ).toThrow(/does not allow Yakima Yellow and TAMRA/);
  });

  it('fails closed when a stored IDT notation disagrees with the natural sequence', () => {
    expect(() =>
      exportPrimersIDT([
        createExportPrimer({
          sequence: 'AAAA',
          length: 4,
          vendor: 'idt',
          modifications: '/5Phos/ACGT',
        }),
      ])
    ).toThrow(/do not match the primer sequence/);
  });
});

describe('exportPrimersTSV', () => {
  it('generates tab-separated output', () => {
    const primers = [
      createExportPrimer({ name: 'lacZ_F1' }),
      createExportPrimer({ name: 'lacZ_R1', id: 'test-2' }),
    ];
    const tsv = exportPrimersTSV(primers);
    const lines = tsv.split('\n');

    for (const line of lines) {
      expect(line).toContain('\t');
    }
    expect(lines).toHaveLength(3);
  });

  it('uses nucleotide units and leaves unavailable RNA thermodynamics blank', () => {
    const tsv = exportPrimersTSV([createExportPrimer({ sequence: 'ACGU', length: 4, tm: null })]);

    expect(tsv.split('\n')[0]).toContain('Length (nt)');
    expect(tsv.split('\n')[1]).toContain('ACGU\t4\t\t');
    expect(tsv).not.toContain('null');
  });
});
