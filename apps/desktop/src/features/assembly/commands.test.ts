// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { ASSEMBLY_COMMAND_TYPES, assemblyCommands, parseAssemblyCommand } from './commands';

describe('assembly commands', () => {
  it('parses every valid editor and lifecycle command', () => {
    const validCommands = [
      assemblyCommands.setBackbone('design-1', 'seq-backbone'),
      assemblyCommands.addFragment('design-1', 'seq-fragment', { slot: 0 }),
      assemblyCommands.removeFragment('design-1', 'fragment-1'),
      assemblyCommands.reorderFragments('design-1', ['fragment-2', 'fragment-1']),
      assemblyCommands.setEnzymeStrategy('design-1', { method: 'gibson' }),
      assemblyCommands.setEnzymeStrategy('design-1', { method: 'goldengate', enzyme: 'BsmBI' }),
      assemblyCommands.validate('design-1'),
      assemblyCommands.run('design-1'),
      assemblyCommands.reset('design-1'),
    ];

    for (const command of validCommands) {
      const parsed = parseAssemblyCommand(command);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(ASSEMBLY_COMMAND_TYPES).toContain(parsed.value.type);
        expect(parsed.value.designId).toBe('design-1');
      }
    }
  });

  it('returns structured bad_input refusals for invalid command shapes', () => {
    const invalidCommands = [
      null,
      { type: 'missing', designId: 'design-1' },
      { type: 'setBackbone', designId: 'design-1' },
      { type: 'addFragment', designId: 'design-1', sequenceId: 'seq-1', slot: -1 },
      {
        type: 'addFragment',
        designId: 'design-1',
        sequenceId: 'seq-1',
        region: {
          sourceSequenceId: 'seq-1',
          sourceSequenceName: 'Sequence 1',
          sourceStart: 0,
          sourceEnd: 12,
          sequence: 42,
          annotations: [],
        },
      },
      {
        type: 'addFragment',
        designId: 'design-1',
        sequenceId: 'seq-1',
        region: {
          sourceSequenceId: 'seq-1',
          sourceSequenceName: 'Sequence 1',
          sourceStart: 0,
          sourceEnd: 12,
          sequence: 'ATGCATGCATGC',
          annotations: [{ name: 'CDS', type: 'CDS', start: 0, end: 12, strand: 'sideways' }],
        },
      },
      { type: 'removeFragment', designId: 'design-1', fragmentId: '' },
      { type: 'reorderFragments', designId: 'design-1', order: [1] },
      { type: 'setEnzymeStrategy', designId: 'design-1', strategy: { method: 'gateway' } },
      {
        type: 'setEnzymeStrategy',
        designId: 'design-1',
        strategy: { method: 'goldengate', enzyme: 'EcoRI' },
      },
      { type: 'validate', designId: 'design-1', expectedVersion: -1 },
      { type: 'run', designId: 'design-1', idempotencyKey: 123 },
    ];

    for (const command of invalidCommands) {
      const parsed = parseAssemblyCommand(command);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.kind).toBe('bad_input');
        expect(parsed.error.message.length).toBeGreaterThan(0);
      }
    }
  });

  it('preserves expectedVersion and idempotencyKey on valid commands', () => {
    const parsed = parseAssemblyCommand(
      assemblyCommands.validate('design-1', {
        expectedVersion: 2,
        idempotencyKey: 'validate-once',
      })
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.expectedVersion).toBe(2);
      expect(parsed.value.idempotencyKey).toBe('validate-once');
    }
  });

  it('strips unknown fields from parsed fragment regions', () => {
    const parsed = parseAssemblyCommand({
      type: 'addFragment',
      designId: 'design-1',
      sequenceId: 'seq-1',
      region: {
        sourceSequenceId: 'seq-1',
        sourceSequenceName: 'Sequence 1',
        sourceStart: 0,
        sourceEnd: 12,
        sequence: 'ATGCATGCATGC',
        annotations: [
          {
            name: 'CDS',
            type: 'CDS',
            start: 0,
            end: 12,
            strand: 'forward',
            extraAnnotationField: 'should be stripped',
          },
        ],
        sourceType: 'pcr',
        extraField: 'should be stripped',
      },
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.type).toBe('addFragment');
      if (parsed.value.type === 'addFragment') {
        expect(parsed.value.region).not.toHaveProperty('extraField');
        expect(parsed.value.region?.annotations[0]).not.toHaveProperty('extraAnnotationField');
      }
    }
  });
});
