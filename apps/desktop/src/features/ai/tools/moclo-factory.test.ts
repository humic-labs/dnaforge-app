import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import {
  applyMocloSchemaOutputSchema,
  getMocloFactoryOutputSchema,
  listMocloSchemasOutputSchema,
  saveMocloSchemaOutputSchema,
  searchMocloPartsOutputSchema,
  setMocloFactoryStageOutputSchema,
} from './design-output-schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import YTK_DEFINITION_RAW from '../../../../resources/sample-workspaces/standard-samples/workspace/.forge/moclo-kits/ytk.json?raw';
import CIDAR_DEFINITION_RAW from '../../../../resources/sample-workspaces/standard-samples/workspace/.forge/moclo-kits/cidar.json?raw';
import { parseMocloKitDefinition } from '../../design/moclo-kit-definition';
import { useDesignStore } from '../../design/store';
import {
  createApplyMocloSchemaTool,
  createGetMocloFactoryTool,
  createListMocloSchemasTool,
  createSaveMocloSchemaTool,
  createSearchMocloPartsTool,
  createSetMocloFactoryStageTool,
} from './moclo-factory';

const YTK = parseMocloKitDefinition(YTK_DEFINITION_RAW, 'ytk.json');
const FOLDERS = [{ path: '/workspace', name: 'Workspace', addedAt: 1 }];
const dependencies = {
  loadDefinitions: async () => [YTK],
  resolveWorkspaceRoot: async () => '/workspace',
};

describe('AI-native MoClo factory tools', () => {
  it('saves the exact reviewed schema in its owning project and refuses a stale preview', async () => {
    const designId = useDesignStore
      .getState()
      .createDesign('Schema preview', 'circular', 'goldengate');
    await execDesignContract(
      applyMocloSchemaOutputSchema,
      createApplyMocloSchemaTool(FOLDERS, dependencies),
      {
        designId,
        expectedDesignVersion: 0,
        kitId: 'ytk',
        recipeId: 'ytk-multigene-device',
        stageId: 'expression-cassette',
      }
    );
    const before = structuredClone(useDesignStore.getState().designs[designId]);
    const saveSchema = vi.fn<typeof import('../../design/moclo-schema-catalog').saveMocloSchema>(
      async (_input, _fs, assertCurrent) => {
        assertCurrent?.();
        return {
          schemaId: 'my-kit:reporter',
          kitId: 'my-kit',
          kitRevision: 1,
          path: '/workspace/.forge/moclo-kits/my-kit.json',
          contentHash: 'hash',
        };
      }
    );
    const save = createSaveMocloSchemaTool(FOLDERS, { ...dependencies, saveSchema });
    const input = {
      designId,
      expectedDesignVersion: before.version,
      kitId: 'my-kit',
      kitName: 'My kit',
      expectedKitRevision: 0,
      templateId: 'reporter',
      name: 'Reporter',
      description: 'Reviewed reporter layout.',
    };
    expect(await execDesignContract(saveMocloSchemaOutputSchema, save, input)).toMatchObject({
      status: 'saved',
      schemaId: 'my-kit:reporter',
    });
    expect(saveSchema).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: '/workspace', schema: before.goldenGateSchema }),
      undefined,
      expect.any(Function)
    );
    expect(useDesignStore.getState().designs[designId]).toEqual(before);
    useDesignStore.getState().updateDesign(designId, { name: 'Changed preview' });
    expect(await execDesignContract(saveMocloSchemaOutputSchema, save, input)).toMatchObject({
      status: 'rejected',
      error: expect.stringMatching(/preview changed/i),
    });
    expect(saveSchema).toHaveBeenCalledOnce();
  });

  it('lists and applies a kit schema without any recipe identity', async () => {
    const kit = parseMocloKitDefinition(CIDAR_DEFINITION_RAW);
    const deps = { ...dependencies, loadDefinitions: async () => [kit] };
    const designId = useDesignStore
      .getState()
      .createDesign('CIDAR schema test', 'circular', 'goldengate');
    const listed = await execDesignContract<{
      schemas: Array<{ kitId: string; schemaId: string }>;
    }>(listMocloSchemasOutputSchema, createListMocloSchemasTool(FOLDERS, deps), { designId });
    expect(listed.schemas).toHaveLength(1);
    const selected = listed.schemas[0];
    const applied = await execDesignContract<{ status: string; slotCount: number }>(
      applyMocloSchemaOutputSchema,
      createApplyMocloSchemaTool(FOLDERS, deps),
      {
        designId,
        expectedDesignVersion: 0,
        kitId: selected.kitId,
        schemaId: selected.schemaId,
      }
    );
    expect(applied).toMatchObject({ status: 'applied', slotCount: 5 });
    expect(useDesignStore.getState().designs[designId].mocloFactory).toBeUndefined();
  });

  beforeEach(() => {
    useDesignStore.setState({ designs: {}, activeDesignId: null, pendingDispatchId: null });
  });

  it('exposes real kit membership, recipes, stages, dependencies, and current selection', async () => {
    const designId = useDesignStore
      .getState()
      .createDesign('Agent YTK factory', 'circular', 'goldengate');
    const result = await execDesignContract<{
      kits: Array<{
        id: string;
        memberCount: number;
        recipes: Array<{ id: string; stages: Array<{ id: string; inputsFromStages: string[] }> }>;
      }>;
      current: unknown;
    }>(getMocloFactoryOutputSchema, createGetMocloFactoryTool(FOLDERS, dependencies), { designId });

    expect(result.kits).toEqual([
      expect.objectContaining({
        id: 'ytk',
        memberCount: 96,
        recipes: [
          expect.objectContaining({
            id: 'ytk-multigene-device',
            stages: [
              expect.objectContaining({ id: 'cassette-vector', inputsFromStages: [] }),
              expect.objectContaining({
                id: 'expression-cassette',
                inputsFromStages: ['cassette-vector'],
              }),
              expect.objectContaining({
                id: 'multigene-device',
                inputsFromStages: ['expression-cassette'],
              }),
            ],
          }),
        ],
      }),
    ]);
    expect(result.current).toBeNull();
  });

  it('lists the reusable schemas without requiring factory-run concepts', async () => {
    const designId = useDesignStore
      .getState()
      .createDesign('Agent schema discovery', 'circular', 'goldengate');
    const result = await execDesignContract<{
      schemas: Array<{
        kitId: string;
        recipeId: string;
        stageId: string;
        name: string;
        slotCount: number;
      }>;
    }>(listMocloSchemasOutputSchema, createListMocloSchemasTool(FOLDERS, dependencies), {
      designId,
    });

    expect(result.schemas).toEqual([
      expect.objectContaining({
        kitId: 'ytk',
        recipeId: 'ytk-multigene-device',
        stageId: 'cassette-vector',
        name: 'Cassette vector',
        slotCount: 7,
      }),
      expect.objectContaining({
        kitId: 'ytk',
        recipeId: 'ytk-multigene-device',
        stageId: 'expression-cassette',
        name: 'Expression cassette',
        slotCount: 4,
      }),
      expect.objectContaining({
        kitId: 'ytk',
        recipeId: 'ytk-multigene-device',
        stageId: 'multigene-device',
        name: 'Multigene device',
        slotCount: 3,
      }),
    ]);
  });

  it('selects a stage through the shared versioned factory command', async () => {
    const designId = useDesignStore
      .getState()
      .createDesign('Agent YTK factory', 'circular', 'goldengate');
    const before = useDesignStore.getState().designs[designId];
    const result = await execDesignContract<{
      status: string;
      designVersion: number;
      stage: { id: string; enzyme: string; slotCount: number };
      mutation: { effect: string; changed: boolean };
    }>(setMocloFactoryStageOutputSchema, createSetMocloFactoryStageTool(FOLDERS, dependencies), {
      designId,
      expectedDesignVersion: before.version,
      kitId: 'ytk',
      recipeId: 'ytk-multigene-device',
      stageId: 'cassette-vector',
      runId: 'agent-factory-run-1',
    });

    expect(result).toMatchObject({
      status: 'applied',
      designVersion: before.version + 1,
      stage: { id: 'cassette-vector', enzyme: 'BsaI', slotCount: 7 },
      mutation: { effect: 'set_moclo_factory_stage', changed: true },
    });
    expect(useDesignStore.getState().designs[designId]).toMatchObject({
      mocloFactory: {
        runId: 'agent-factory-run-1',
        kitId: 'ytk',
        recipeId: 'ytk-multigene-device',
        stageId: 'cassette-vector',
        stageInputs: [],
      },
      goldenGateSchema: expect.objectContaining({
        id: 'ytk:ytk-multigene-device:cassette-vector',
      }),
    });
  });

  it('applies and searches a reusable schema without creating factory-run state', async () => {
    const designId = useDesignStore
      .getState()
      .createDesign('Agent schema assembly', 'circular', 'goldengate');
    const applied = await execDesignContract<{
      status: string;
      slotCount: number;
      schema: { id: string };
    }>(applyMocloSchemaOutputSchema, createApplyMocloSchemaTool(FOLDERS, dependencies), {
      designId,
      expectedDesignVersion: 0,
      kitId: 'ytk',
      recipeId: 'ytk-multigene-device',
      stageId: 'cassette-vector',
    });

    expect(applied).toMatchObject({
      status: 'applied',
      slotCount: 7,
      schema: { id: 'ytk:ytk-multigene-device:cassette-vector' },
    });
    expect(useDesignStore.getState().designs[designId].mocloFactory).toBeUndefined();

    const loadCandidates = vi.fn().mockResolvedValue({ candidates: [], skippedSourceCount: 0 });
    const search = await execDesignContract<{
      status: string;
      slot: { id: string };
      targetSlot: { slotIndex: number; regionId: string; isEmpty: boolean };
    }>(
      searchMocloPartsOutputSchema,
      createSearchMocloPartsTool(FOLDERS, { ...dependencies, loadCandidates }),
      {
        designId,
        slotId: 'type-1',
      }
    );
    expect(search).toMatchObject({
      status: 'ready',
      slot: { id: 'type-1' },
      targetSlot: { slotIndex: 0, isEmpty: true },
    });
    expect(search.targetSlot.regionId).toBe(
      useDesignStore.getState().designs[designId].regions[0].id
    );
    expect(loadCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: '/workspace', enzymeName: 'BsaI' })
    );
  });

  it('refuses an unknown kit or a stale design version without mutation', async () => {
    const designId = useDesignStore
      .getState()
      .createDesign('Agent YTK factory', 'circular', 'goldengate');
    const tool = createSetMocloFactoryStageTool(FOLDERS, dependencies);
    const unknown = await execDesignContract<{ status: string; code: string }>(
      setMocloFactoryStageOutputSchema,
      tool,
      {
        designId,
        expectedDesignVersion: 0,
        kitId: 'missing',
        recipeId: 'recipe',
        stageId: 'stage',
      }
    );
    expect(unknown).toMatchObject({ status: 'rejected', code: 'kit-not-found' });

    await execDesignContract(setMocloFactoryStageOutputSchema, tool, {
      designId,
      expectedDesignVersion: 0,
      kitId: 'ytk',
      recipeId: 'ytk-multigene-device',
      stageId: 'cassette-vector',
    });
    const stale = await execDesignContract<{ status: string; code: string }>(
      setMocloFactoryStageOutputSchema,
      tool,
      {
        designId,
        expectedDesignVersion: 0,
        kitId: 'ytk',
        recipeId: 'ytk-multigene-device',
        stageId: 'expression-cassette',
      }
    );
    expect(stale).toMatchObject({ status: 'rejected', code: 'stale-version' });
  });

  it('searches kit-part slots through the shared catalog and refuses stage-output substitution', async () => {
    const designId = useDesignStore
      .getState()
      .createDesign('Agent YTK factory', 'circular', 'goldengate');
    await execDesignContract(
      setMocloFactoryStageOutputSchema,
      createSetMocloFactoryStageTool(FOLDERS, dependencies),
      {
        designId,
        expectedDesignVersion: 0,
        kitId: 'ytk',
        recipeId: 'ytk-multigene-device',
        stageId: 'expression-cassette',
        runId: 'agent-factory-run-search',
      }
    );
    const loadCandidates = vi.fn().mockResolvedValue({
      candidates: [],
      skippedSourceCount: 0,
    });
    const tool = createSearchMocloPartsTool(FOLDERS, {
      ...dependencies,
      loadCandidates,
    });

    const search = await execDesignContract<{
      status: string;
      enzyme: string;
      slot: { id: string; label: string };
      resultCount: number;
    }>(searchMocloPartsOutputSchema, tool, { designId, slotId: 'type-3', query: 'GFP' });
    expect(search).toMatchObject({
      status: 'ready',
      enzyme: 'BsaI',
      slot: { id: 'type-3', label: 'Type 3 coding sequence' },
      resultCount: 0,
    });
    expect(loadCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: '/workspace',
        enzymeName: 'BsaI',
        kitDefinitions: [YTK],
      })
    );

    const stageOutput = await execDesignContract<{
      status: string;
      code: string;
      requiredStageId: string;
    }>(searchMocloPartsOutputSchema, tool, { designId, slotId: 'cassette-vector-output' });
    expect(stageOutput).toMatchObject({
      status: 'rejected',
      code: 'stage-output-required',
      requiredStageId: 'cassette-vector',
    });
    expect(loadCandidates).toHaveBeenCalledTimes(1);
  });
});
