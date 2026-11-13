// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  classifyGoldenGateCandidate,
  deriveGoldenGateSlotEnds,
  isGoldenGateSchemaStructureLocked,
  validateGoldenGateSchema,
} from './golden-gate-schema';
import type { GoldenGateAssemblySchema, GoldenGatePartCandidate } from './golden-gate-schema';

const CIDAR_SCHEMA: GoldenGateAssemblySchema = {
  id: 'cidar-level-1-tu',
  name: 'CIDAR Level 1 transcription unit',
  revision: 1,
  origin: { type: 'kit', kitId: 'cidar-moclo', kitName: 'CIDAR MoClo' },
  enzyme: 'BsaI',
  slots: [
    {
      id: 'promoter',
      label: 'Promoter',
      outgoingOverhang: 'TACT',
      preferredRoles: [{ label: 'Promoter' }],
    },
    {
      id: 'rbs',
      label: 'RBS',
      outgoingOverhang: 'AATG',
      preferredRoles: [{ label: 'RBS' }, { label: "5' UTR" }],
    },
    {
      id: 'cds',
      label: 'CDS',
      outgoingOverhang: 'AGGT',
      preferredRoles: [{ label: 'CDS' }],
    },
    {
      id: 'terminator',
      label: 'Terminator',
      outgoingOverhang: 'GCTT',
      preferredRoles: [{ label: 'Terminator' }],
    },
    {
      id: 'destination-vector',
      label: 'Destination vector',
      outgoingOverhang: 'GGAG',
      preferredRoles: [{ label: 'Destination vector' }],
    },
  ],
};

function digestCandidate(
  overrides: Partial<GoldenGatePartCandidate> = {}
): GoldenGatePartCandidate {
  return {
    id: 'candidate-b0034',
    name: 'B0034m',
    route: 'restriction-digest',
    upstreamOverhang: 'TACT',
    downstreamOverhang: 'AATG',
    roleEvidence: [{ label: 'RBS', source: 'genbank-keyword' }],
    kit: { id: 'cidar-moclo', name: 'CIDAR MoClo' },
    ...overrides,
  };
}

describe('Golden Gate assembly schema', () => {
  it('locks reusable schemas while leaving free-form and custom schemas editable', () => {
    expect(isGoldenGateSchemaStructureLocked(undefined)).toBe(false);
    expect(isGoldenGateSchemaStructureLocked({ ...CIDAR_SCHEMA, origin: { type: 'custom' } })).toBe(
      false
    );
    expect(isGoldenGateSchemaStructureLocked(CIDAR_SCHEMA)).toBe(true);
    expect(
      isGoldenGateSchemaStructureLocked({
        ...CIDAR_SCHEMA,
        origin: { type: 'imported', sourceLabel: 'Imported schema' },
      })
    ).toBe(true);
  });

  it('stores every circular junction once, on the slot immediately before it', () => {
    expect(deriveGoldenGateSlotEnds(CIDAR_SCHEMA, 0, 'circular')).toEqual({
      incomingOverhang: 'GGAG',
      outgoingOverhang: 'TACT',
    });
    expect(deriveGoldenGateSlotEnds(CIDAR_SCHEMA, 1, 'circular')).toEqual({
      incomingOverhang: 'TACT',
      outgoingOverhang: 'AATG',
    });
  });

  it('leaves the two external ends unconstrained for a linear assembly', () => {
    const linear = {
      ...CIDAR_SCHEMA,
      slots: CIDAR_SCHEMA.slots.slice(0, 2).map((slot, index) => ({
        ...slot,
        outgoingOverhang: index === 0 ? 'TACT' : null,
      })),
    };

    expect(deriveGoldenGateSlotEnds(linear, 0, 'linear')).toEqual({
      incomingOverhang: null,
      outgoingOverhang: 'TACT',
    });
    expect(deriveGoldenGateSlotEnds(linear, 1, 'linear')).toEqual({
      incomingOverhang: 'TACT',
      outgoingOverhang: null,
    });
  });

  it('validates overhang length from the selected enzyme without a second enzyme table', () => {
    expect(validateGoldenGateSchema(CIDAR_SCHEMA, 'circular')).toEqual({ ok: true });

    expect(
      validateGoldenGateSchema(
        {
          ...CIDAR_SCHEMA,
          enzyme: 'SapI',
        },
        'circular'
      )
    ).toEqual({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'overhang-length', slotId: 'promoter' }),
      ]),
    });
  });

  it('rejects duplicate slot identities without forcing a custom schema to be complete', () => {
    expect(
      validateGoldenGateSchema(
        {
          ...CIDAR_SCHEMA,
          slots: [
            CIDAR_SCHEMA.slots[0],
            { ...CIDAR_SCHEMA.slots[1], id: CIDAR_SCHEMA.slots[0].id },
            { ...CIDAR_SCHEMA.slots[2], outgoingOverhang: null },
          ],
        },
        'circular'
      )
    ).toEqual({
      ok: false,
      issues: [expect.objectContaining({ code: 'duplicate-slot-id' })],
    });
  });

  it('accepts an unspecified circular junction as an honest unconstrained position', () => {
    expect(
      validateGoldenGateSchema(
        {
          ...CIDAR_SCHEMA,
          slots: CIDAR_SCHEMA.slots.map((slot, index) =>
            index === 2 ? { ...slot, outgoingOverhang: null } : slot
          ),
        },
        'circular'
      )
    ).toEqual({ ok: true });
  });
});

describe('Golden Gate slot candidate compatibility', () => {
  it('classifies a same-kit RBS digest fragment as exact physical and role compatibility', () => {
    expect(classifyGoldenGateCandidate(CIDAR_SCHEMA, 1, 'circular', digestCandidate())).toEqual({
      physical: { type: 'exact' },
      role: {
        type: 'match',
        matchedPreferredRole: { label: 'RBS' },
        matchedEvidence: { label: 'RBS', source: 'genbank-keyword' },
      },
    });
  });

  it('matches the same part type by label when catalog evidence lacks the schema ontology id', () => {
    const schema = {
      ...CIDAR_SCHEMA,
      slots: CIDAR_SCHEMA.slots.map((slot, index) =>
        index === 3
          ? {
              ...slot,
              preferredRoles: [{ id: 'ytk:terminator', label: 'Terminator' }],
            }
          : slot
      ),
    };
    const candidate = digestCandidate({
      upstreamOverhang: 'AGGT',
      downstreamOverhang: 'GCTT',
      roleEvidence: [{ label: 'Terminator', source: 'GenBank terminator annotation' }],
    });

    expect(classifyGoldenGateCandidate(schema, 3, 'circular', candidate).role).toEqual({
      type: 'match',
      matchedPreferredRole: { id: 'ytk:terminator', label: 'Terminator' },
      matchedEvidence: { label: 'Terminator', source: 'GenBank terminator annotation' },
    });
  });

  it('keeps a physically compatible destination vector visible with an ontology warning', () => {
    expect(
      classifyGoldenGateCandidate(
        CIDAR_SCHEMA,
        1,
        'circular',
        digestCandidate({
          id: 'candidate-dva',
          name: 'DVA_AE',
          roleEvidence: [{ label: 'Destination vector', source: 'genbank-definition' }],
        })
      )
    ).toEqual({
      physical: { type: 'exact' },
      role: {
        type: 'mismatch',
        preferredRoles: [{ label: 'RBS' }, { label: "5' UTR" }],
        observedRoles: [{ label: 'Destination vector', source: 'genbank-definition' }],
      },
    });
  });

  it('distinguishes unknown ontology from a known mismatch', () => {
    expect(
      classifyGoldenGateCandidate(
        CIDAR_SCHEMA,
        1,
        'circular',
        digestCandidate({ roleEvidence: [] })
      ).role
    ).toEqual({
      type: 'unknown',
      preferredRoles: [{ label: 'RBS' }, { label: "5' UTR" }],
    });
  });

  it('classifies an arbitrary PCR source as adaptable instead of falsely exact', () => {
    expect(
      classifyGoldenGateCandidate(CIDAR_SCHEMA, 1, 'circular', {
        id: 'candidate-pcr-rbs',
        name: 'custom RBS source',
        route: 'pcr',
        upstreamOverhang: null,
        downstreamOverhang: null,
        roleEvidence: [{ label: 'RBS', source: 'annotation' }],
        kit: null,
      }).physical
    ).toEqual({
      type: 'pcr-adaptable',
      requiredUpstreamOverhang: 'TACT',
      requiredDownstreamOverhang: 'AATG',
    });
  });

  it('reports both incompatible digest ends without hiding the candidate', () => {
    expect(
      classifyGoldenGateCandidate(
        CIDAR_SCHEMA,
        1,
        'circular',
        digestCandidate({ upstreamOverhang: 'AAAA', downstreamOverhang: 'CCCC' })
      ).physical
    ).toEqual({
      type: 'incompatible',
      mismatches: [
        { end: 'upstream', expected: 'TACT', actual: 'AAAA' },
        { end: 'downstream', expected: 'AATG', actual: 'CCCC' },
      ],
    });
  });

  it('does not use kit membership as an admission rule', () => {
    expect(
      classifyGoldenGateCandidate(
        CIDAR_SCHEMA,
        1,
        'circular',
        digestCandidate({ kit: { id: 'ecoflex', name: 'EcoFlex' } })
      ).physical
    ).toEqual({ type: 'exact' });
  });
});
