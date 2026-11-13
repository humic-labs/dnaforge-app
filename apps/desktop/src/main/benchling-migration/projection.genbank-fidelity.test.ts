import { parseGenBankFull } from '@waypoint/sequence-utils';
import { describe, expect, it } from 'vitest';

import type { SourceObject } from '../../shared/benchling-migration';
import { buildProjectionPlan } from './projection';

describe('Benchling GenBank fidelity projection', () => {
  it('preserves quotes, slash-leading wraps, repeats, translations, and compound locations', () => {
    const longSlashValue = `${'A'.repeat(58)}/the/provider/path/remains-source-text`;
    const source: SourceObject = {
      id: 'seq_FIDELITY',
      stableId: 'seq_FIDELITY',
      sourceType: 'dna_sequence',
      name: 'Synthetic fidelity sequence',
      aliases: [],
      sourceUrl: 'urn:dnaforge:test:seq_FIDELITY',
      sourcePath: 'Registry/Synthetic fidelity sequence (seq_FIDELITY).gb',
      attachmentHashes: [],
      memberships: [],
      metadata: {},
      content: {
        moleculeType: 'DNA',
        bases: 'ACGT'.repeat(60),
        topology: 'linear',
        annotations: [
          {
            type: 'misc_feature',
            label: 'Quoted feature',
            start: 1,
            end: 20,
            strand: 0,
            qualifiers: {
              label: ['Quoted feature'],
              note: ['contains "quoted" source text', longSlashValue],
              db_xref: ['synthetic:first', 'synthetic:second'],
            },
            translations: [],
          },
          {
            type: 'CDS',
            label: 'Joined CDS',
            start: 30,
            end: 90,
            strand: 1,
            qualifiers: {
              _locationString: ['join(30..45,70..90)'],
              label: ['Joined CDS'],
              translation: ['M?*'],
            },
            translations: ['M?*'],
          },
          {
            type: 'CDS',
            label: 'Complemented joined CDS',
            start: 150,
            end: 230,
            strand: -1,
            qualifiers: {
              _locationString: ['complement(join(150..170,200..230))'],
              label: ['Complemented joined CDS'],
            },
            translations: [],
          },
        ],
      },
      relationships: [],
    };

    const plan = buildProjectionPlan(source, {
      runId: 'migration-genbank-fidelity',
      capturedAt: '2026-08-26T00:00:00.000Z',
      converterVersion: 'test',
    });

    expect(plan.projection, plan.exception ?? '').toBe('native');
    const file = plan.files.find(({ relativePath }) => relativePath.endsWith('.gb'));
    if (!file || file.text === undefined) throw new Error('Native GenBank was not projected.');
    const reparsed = parseGenBankFull(file.text);
    expect(reparsed.annotations[0].qualifiers?.note).toEqual([
      'contains "quoted" source text',
      longSlashValue,
    ]);
    expect(reparsed.annotations[0].qualifiers?.db_xref).toEqual([
      'synthetic:first',
      'synthetic:second',
    ]);
    expect(reparsed.annotations[1].qualifiers?.translation).toEqual(['M?*']);
    expect(reparsed.annotations[1].segments).toEqual([
      { start: 30, end: 45 },
      { start: 70, end: 90 },
    ]);
    expect(reparsed.annotations[2].segments).toEqual([
      { start: 150, end: 170 },
      { start: 200, end: 230 },
    ]);
  });
});
