import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import { setGoldenGateSchemaOutputSchema } from './design-output-schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import { useDesignStore } from '../../design/store';
import { createSetGoldenGateSchemaTool } from './set-golden-gate-schema';

const SCHEMA_INPUT = {
  id: 'custom-two-slot',
  name: 'Custom two-slot schema',
  revision: 1,
  origin: { type: 'custom' as const },
  enzyme: 'BsaI' as const,
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
      outgoingOverhang: 'GGAG',
      preferredRoles: [{ id: 'SO:0000139', label: 'Ribosome entry site' }, { label: 'RBS' }],
    },
  ],
};

type SchemaToolResult = {
  status: string;
  code?: string;
  error?: string;
  designId: string;
  previousVersion?: number;
  designVersion?: number;
  currentVersion?: number;
  schema?: typeof SCHEMA_INPUT;
  issues?: Array<{ code: string; slotId?: string }>;
  mutation?: {
    effect: string;
    changed: boolean;
    beforeVersion: number;
    afterVersion: number;
  };
};

describe('set_golden_gate_schema', () => {
  beforeEach(() => {
    useDesignStore.setState({ designs: {}, activeDesignId: null, pendingDispatchId: null });
  });

  it('applies the exact shared schema command and returns a versioned mutation claim', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Agent schema target', 'circular', 'goldengate');
    const before = useDesignStore.getState().designs[designId];

    const result = await execDesignContract<SchemaToolResult>(
      setGoldenGateSchemaOutputSchema,
      createSetGoldenGateSchemaTool(),
      {
        designId,
        expectedDesignVersion: before.version,
        schema: SCHEMA_INPUT,
      }
    );

    expect(result).toMatchObject({
      status: 'applied',
      designId,
      previousVersion: before.version,
      designVersion: before.version + 1,
      schema: SCHEMA_INPUT,
      mutation: {
        effect: 'set_golden_gate_schema',
        changed: true,
        beforeVersion: before.version,
        afterVersion: before.version + 1,
      },
    });
    expect(useDesignStore.getState().designs[designId].goldenGateSchema).toEqual(SCHEMA_INPUT);
    expect(useDesignStore.getState().designs[designId].regions).toHaveLength(2);
  });

  it('refuses a stale agent write and leaves the exact current schema untouched', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Stale schema target', 'circular', 'goldengate');
    const staleVersion = useDesignStore.getState().designs[designId].version;
    const first = await execDesignContract<SchemaToolResult>(
      setGoldenGateSchemaOutputSchema,
      createSetGoldenGateSchemaTool(),
      {
        designId,
        expectedDesignVersion: staleVersion,
        schema: SCHEMA_INPUT,
      }
    );

    const attemptedReplacement = {
      ...SCHEMA_INPUT,
      revision: 2,
      name: 'Stale replacement',
    };
    const stale = await execDesignContract<SchemaToolResult>(
      setGoldenGateSchemaOutputSchema,
      createSetGoldenGateSchemaTool(),
      {
        designId,
        expectedDesignVersion: staleVersion,
        schema: attemptedReplacement,
      }
    );

    expect(first.status).toBe('applied');
    expect(stale).toMatchObject({
      status: 'rejected',
      code: 'stale-version',
      currentVersion: staleVersion + 1,
    });
    expect(useDesignStore.getState().designs[designId].goldenGateSchema).toEqual(SCHEMA_INPUT);
  });

  it('returns domain validation issues instead of storing an invalid overhang', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Invalid schema target', 'circular', 'goldengate');
    const version = useDesignStore.getState().designs[designId].version;
    const result = await execDesignContract<SchemaToolResult>(
      setGoldenGateSchemaOutputSchema,
      createSetGoldenGateSchemaTool(),
      {
        designId,
        expectedDesignVersion: version,
        schema: {
          ...SCHEMA_INPUT,
          slots: SCHEMA_INPUT.slots.map((slot, index) =>
            index === 0 ? { ...slot, outgoingOverhang: 'TOO-LONG' } : slot
          ),
        },
      }
    );

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'invalid-schema',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'overhang-length', slotId: 'promoter' }),
        expect.objectContaining({ code: 'overhang-alphabet', slotId: 'promoter' }),
      ]),
    });
    expect(useDesignStore.getState().designs[designId].goldenGateSchema).toBeUndefined();
    expect(useDesignStore.getState().designs[designId].version).toBe(version);
  });

  it('returns an explicit no-op mutation claim for an exact retry at the current version', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('No-op schema target', 'circular', 'goldengate');
    await execDesignContract(setGoldenGateSchemaOutputSchema, createSetGoldenGateSchemaTool(), {
      designId,
      expectedDesignVersion: 0,
      schema: SCHEMA_INPUT,
    });
    const currentVersion = useDesignStore.getState().designs[designId].version;

    const retry = await execDesignContract<SchemaToolResult>(
      setGoldenGateSchemaOutputSchema,
      createSetGoldenGateSchemaTool(),
      {
        designId,
        expectedDesignVersion: currentVersion,
        schema: SCHEMA_INPUT,
      }
    );

    expect(retry).toMatchObject({
      status: 'no-op',
      previousVersion: currentVersion,
      designVersion: currentVersion,
      mutation: {
        effect: 'set_golden_gate_schema',
        changed: false,
        beforeVersion: currentVersion,
        afterVersion: currentVersion,
      },
    });
  });
});
