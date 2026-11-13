import { describe, expect, it } from 'vitest';
import {
  CIDAR_MOCLO_RED_TU_DESIGN_ID,
  cidarMocloRedFluorescentTu,
} from '../../test/scenarios/assembly-real-pipeline';
import type { SequenceDesign } from './types';
import type { GoldenGateAssemblySchema } from './golden-gate-schema';
import { applyGoldenGateSchemaCommand } from './golden-gate-schema-command';

function cidarDesign(): SequenceDesign {
  const design = cidarMocloRedFluorescentTu().designs?.designs[CIDAR_MOCLO_RED_TU_DESIGN_ID];
  if (!design) throw new Error('CIDAR fixture design is unavailable.');
  return design;
}

function schema(overrides: Partial<GoldenGateAssemblySchema> = {}): GoldenGateAssemblySchema {
  return {
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
        preferredRoles: [{ label: 'RBS' }],
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
    ...overrides,
  };
}

describe('applyGoldenGateSchemaCommand', () => {
  it('requires confirmation before replacing a populated assembly', () => {
    const design = cidarDesign();
    expect(
      applyGoldenGateSchemaCommand({
        design,
        schema: schema(),
        expectedVersion: design.version,
      })
    ).toMatchObject({ status: 'rejected', code: 'confirmation-required' });
  });
  it('rejects a stale design version without returning a replacement design', () => {
    const design = cidarDesign();

    expect(
      applyGoldenGateSchemaCommand({
        design,
        schema: schema(),
        expectedVersion: design.version - 1,
      })
    ).toEqual({
      status: 'rejected',
      code: 'stale-version',
      message: `Expected design version ${design.version - 1}, but found ${design.version}.`,
    });
  });

  it('rejects schemas on non-Golden-Gate designs', () => {
    const design = { ...cidarDesign(), assemblyMethod: 'gibson' as const };

    expect(
      applyGoldenGateSchemaCommand({ design, schema: schema(), expectedVersion: design.version })
    ).toEqual({
      status: 'rejected',
      code: 'not-golden-gate',
      message: 'Golden Gate schemas can only be applied to Golden Gate assemblies.',
    });
  });

  it('returns schema validation issues instead of storing invalid physical ends', () => {
    const design = cidarDesign();
    const result = applyGoldenGateSchemaCommand({
      design,
      schema: schema({ enzyme: 'SapI' }),
      expectedVersion: design.version,
    });

    expect(result).toEqual({
      status: 'rejected',
      code: 'invalid-schema',
      message: 'Golden Gate schema is invalid.',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'overhang-length' })]),
    });
  });

  it('replaces all parts with empty slots after confirmation and invalidates derived state', () => {
    const design = cidarDesign();
    const nextSchema = schema({
      slots: [
        ...schema().slots,
        {
          id: 'auxiliary',
          label: 'Auxiliary part',
          outgoingOverhang: null,
          preferredRoles: [],
        },
      ],
    });

    const result = applyGoldenGateSchemaCommand({
      design,
      schema: nextSchema,
      expectedVersion: design.version,
      now: new Date('2026-09-01T12:00:00.000Z'),
      options: { confirmedReset: true },
    });

    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.nextDesign.regions).toHaveLength(6);
    expect(
      result.nextDesign.regions.every((region) => region.isPlaceholder && !region.sequence)
    ).toBe(true);
    expect(result.nextDesign.regions[5]).toMatchObject({
      id: 'schema-slot-cidar-level-1-tu-auxiliary',
      sourceSequenceId: 'placeholder',
      sourceSequenceName: 'Empty Auxiliary part',
      sequence: '',
      isPlaceholder: true,
      schemaSlotId: 'auxiliary',
    });
    expect(result.nextDesign.goldenGateSchema).toEqual(nextSchema);
    expect(result.nextDesign.goldenGateJunctions).toEqual([]);
    expect(result.nextDesign.designPrimers).toEqual([]);
    expect(result.nextDesign.version).toBe(design.version + 1);
    expect(result.nextDesign.updatedAt).toEqual(new Date('2026-09-01T12:00:00.000Z'));
  });

  it('refuses to shrink a schema when that would discard a real part', () => {
    const design = cidarDesign();

    expect(
      applyGoldenGateSchemaCommand({
        design,
        schema: schema({ slots: schema().slots.slice(0, 4) }),
        expectedVersion: design.version,
      })
    ).toMatchObject({
      status: 'rejected',
      code: 'confirmation-required',
    });
  });

  it('starts fresh rather than preserving occupied positions when shrinking', () => {
    const design = cidarDesign();
    const withEmptyTail: SequenceDesign = {
      ...design,
      goldenGateSchema: schema(),
      regions: [
        ...design.regions.slice(0, 4),
        {
          ...design.regions[4],
          sourceSequenceId: 'placeholder',
          sourceSequenceName: 'Empty Destination vector',
          sequence: '',
          annotations: [],
          isPlaceholder: true,
          sourceType: 'pcr',
          rdOverhangs: undefined,
          rdEnds: undefined,
        },
      ],
    };
    const smaller = schema({ slots: schema().slots.slice(0, 4) });
    const result = applyGoldenGateSchemaCommand({
      design: withEmptyTail,
      schema: smaller,
      expectedVersion: withEmptyTail.version,
      options: { confirmedReset: true },
    });

    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.nextDesign.regions).toHaveLength(4);
    expect(result.nextDesign.regions.every((region) => region.isPlaceholder)).toBe(true);
    expect(result.nextDesign.goldenGateSchema).toEqual(smaller);
  });

  it('refuses structural resizing while synthetic junction DNA is present', () => {
    const design = {
      ...cidarDesign(),
      spacers: [
        {
          id: 'spacer-1',
          junctionIndex: 0,
          sequence: 'ATGC',
        },
      ],
    };

    expect(
      applyGoldenGateSchemaCommand({
        design,
        schema: schema({ slots: schema().slots.slice(0, 4) }),
        expectedVersion: design.version,
      })
    ).toMatchObject({
      status: 'rejected',
      code: 'confirmation-required',
    });
  });

  it('does not silently replace a populated schema revision, even for role changes', () => {
    const currentSchema = schema();
    const design = { ...cidarDesign(), goldenGateSchema: currentSchema };
    const roleOnlySchema = schema({
      revision: 2,
      slots: currentSchema.slots.map((slot, index) =>
        index === 1 ? { ...slot, preferredRoles: [{ label: "5' UTR" }] } : slot
      ),
    });
    const result = applyGoldenGateSchemaCommand({
      design,
      schema: roleOnlySchema,
      expectedVersion: design.version,
    });

    expect(result).toMatchObject({ status: 'rejected', code: 'confirmation-required' });
  });

  it('clears every old draft dependency together but keeps accepted history', () => {
    const base = cidarDesign();
    const design: SequenceDesign = {
      ...base,
      spacers: [{ id: 'old-spacer', junctionIndex: 0, sequence: 'ATGC' }],
      mocloFactory: {
        runId: 'old-run',
        kitId: 'ytk',
        kitRevision: 1,
        recipeId: 'old-recipe',
        stageId: 'old-stage',
        stageInputs: [],
      },
      assemblyWorkbench: {
        junctions: [],
        primers: [],
        primerEditIntents: [],
        autoDraftPrimers: false,
      },
      assemblyMethodDrafts: {},
      acceptedAssemblyVersions: [],
      highlightRange: { start: 0, end: 4 },
    };
    const result = applyGoldenGateSchemaCommand({
      design,
      expectedVersion: design.version,
      options: { confirmedReset: true, kit: { id: 'moclo-cidar', name: 'CIDAR MoClo' } },
    });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.nextDesign).toMatchObject({
      regions: [],
      spacers: [],
      designPrimers: [],
      goldenGateJunctions: [],
      pendingGoldenGateKit: { id: 'moclo-cidar', name: 'CIDAR MoClo' },
      version: design.version + 1,
      highlightRange: null,
      backboneSequenceId: null,
    });
    for (const field of [
      'mocloFactory',
      'assemblyWorkbench',
      'assemblyMethodDrafts',
      'assemblyResult',
      'goldenGateSchema',
    ] as const) {
      expect(result.nextDesign[field]).toBeUndefined();
    }
    expect(result.nextDesign.acceptedAssemblyVersions).toBe(design.acceptedAssemblyVersions);
    expect(design.spacers).toHaveLength(1);
  });

  it('confirmation cannot overwrite a newer edit', () => {
    const design = cidarDesign();
    expect(
      applyGoldenGateSchemaCommand({
        design,
        schema: schema(),
        expectedVersion: design.version - 1,
        options: { confirmedReset: true },
      })
    ).toMatchObject({ status: 'rejected', code: 'stale-version' });
  });

  it('stores an independent schema copy without mutating the kit manifest', () => {
    const source = schema();
    const result = applyGoldenGateSchemaCommand({
      design: { ...cidarDesign(), regions: [], designPrimers: [] },
      schema: source,
      expectedVersion: cidarDesign().version,
    });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    result.nextDesign.goldenGateSchema!.slots[0].label = 'Draft edit';
    expect(source.slots[0].label).toBe('Promoter');
  });

  it('does not bump the design for the same already-persisted schema', () => {
    const currentSchema = schema();
    const design = { ...cidarDesign(), goldenGateSchema: currentSchema };

    expect(
      applyGoldenGateSchemaCommand({
        design,
        schema: schema(),
        expectedVersion: design.version,
      })
    ).toEqual({ status: 'no-op', currentDesign: design });
  });
});
