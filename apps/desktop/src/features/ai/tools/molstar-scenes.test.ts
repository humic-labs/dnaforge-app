import { describe, expect, it, vi } from 'vitest';
import { asSchema } from 'ai';
import {
  createMolApplySceneTool,
  createMolAlignStructuresTool,
  createMolGetSceneTool,
  createMolSaveViewTool,
  createMolShowInteractionContextTool,
  molApplySceneSchema,
  molSaveViewSchema,
  molAlignStructuresSchema,
} from './molstar-scenes';
import { toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { registerMolecularHydrogenRequest } from '../molecular-hydrogen-request';

const options = { toolCallId: 'scene-test', messages: [] };
describe('shared MolViewSpec agent tools', () => {
  it('keeps an automatically attached saved view out of duplicate private Markdown links', () => {
    expect(createMolSaveViewTool().description).toContain('documentReference');
    expect(createMolSaveViewTool().description).toContain('native document chips automatically');
  });
  it('advertises the exact active-view precondition before saving', () => {
    const description = createMolSaveViewTool().description;
    expect(description).toContain('mol_activate_view');
    expect(description).toContain('mol_get_state');
    expect(description).toContain('viewerStatus');
  });
  it('advertises the required evidence array and preserves explicit empty evidence validation', () => {
    const input = { structureViewId: 'technical-view', title: 'Saved view', caption: '' };
    expect(molSaveViewSchema.safeParse(input).success).toBe(false);
    expect(molSaveViewSchema.safeParse({ ...input, evidence: [] }).success).toBe(true);
    const schema = asSchema(molSaveViewSchema).jsonSchema as {
      required?: string[];
      properties?: Record<string, { description?: string }>;
    };
    expect(schema.required).toContain('evidence');
    expect(schema.properties?.evidence.description).toMatch(/required/i);
    expect(schema.properties?.evidence.description).toContain('[]');
    expect(createMolSaveViewTool().description).toContain('evidence: []');
  });
  it('projects the existing HTTP(S) evidence restriction and keeps private app URLs invalid', () => {
    const input = { structureViewId: 'technical-view', title: 'Saved view', caption: '' };
    expect(
      molSaveViewSchema.safeParse({
        ...input,
        evidence: [
          { title: 'Raw-read observations', url: 'waypoint://read_variant_observations.json' },
        ],
      }).success
    ).toBe(false);
    expect(
      molSaveViewSchema.safeParse({
        ...input,
        evidence: [{ title: 'Actual deposited DNA', url: 'https://www.rcsb.org/structure/1BNA' }],
      }).success
    ).toBe(true);
    const schema = asSchema(molSaveViewSchema).jsonSchema as {
      properties?: {
        evidence?: {
          items?: { properties?: { url?: { pattern?: string; description?: string } } };
        };
      };
    };
    const url = schema.properties?.evidence?.items?.properties?.url;
    expect(url?.pattern).toBeDefined();
    expect(new RegExp(url!.pattern!).test('waypoint://read_variant_observations.json')).toBe(false);
    expect(new RegExp(url!.pattern!).test('https://www.rcsb.org/structure/1BNA')).toBe(true);
    expect(url?.description).toContain('HTTP(S)');
  });
  it('passes only the actual host turn request as private hydrogen display authority', async () => {
    const applyScene = vi.fn(async () => toolSuccess({ rendered: true }));
    const clear = registerMolecularHydrogenRequest('hydrogen-user-turn', 'Show hydrogen atoms.');
    try {
      const input = { structureViewId: 'view', scene: '{}' };
      await createMolApplySceneTool({ applyScene, getScene: vi.fn() }, { turnId: 'unrelated' })
        .execute!(input, options);
      expect(applyScene).toHaveBeenLastCalledWith(input);
      await createMolApplySceneTool(
        { applyScene, getScene: vi.fn() },
        { turnId: 'hydrogen-user-turn' }
      ).execute!(input, options);
      expect(applyScene).toHaveBeenLastCalledWith(input, 'Show hydrogen atoms');
    } finally {
      clear();
    }
  });
  it('dispatches declared alignment regions without inventing a transform in the route', async () => {
    const input = {
      structureViewId: 'view',
      referenceStructureRef: 'a',
      mobileStructureRef: 'b',
      referenceRegion: { auth_asym_id: 'A', beg_auth_seq_id: 1, end_auth_seq_id: 20 },
      mobileRegion: { label_asym_id: 'C' },
      maximumRmsd: 2,
    };
    const alignStructures = vi.fn(async () => toolSuccess({ alignment: { rmsd: 0.3 } }));
    const tool = createMolAlignStructuresTool({ alignStructures });
    await expect(tool.execute!(input, options)).resolves.toMatchObject({
      ok: true,
      alignment: { rmsd: 0.3 },
    });
    expect(alignStructures).toHaveBeenCalledWith(input);
    expect(molAlignStructuresSchema.safeParse({ ...input, mobileRegion: {} }).success).toBe(false);
  });
  it('waits for interaction-context rendering and preserves the exact caller controls', async () => {
    let complete!: () => void;
    const rendering = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const showInteractionContext = vi.fn(async () => {
      await rendering;
      return toolSuccess({ rendered: true, radius: 5 });
    });
    const tool = createMolShowInteractionContextTool({ showInteractionContext });
    const input = {
      structureViewId: 'view',
      selection: 'chain A and resi 42',
      measurements: false,
      focus: false,
      renderProfile: 'native' as const,
    };
    let settled = false;
    const result = tool.execute!(input, options) as Promise<unknown>;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(showInteractionContext).toHaveBeenCalledExactlyOnceWith(input);
    complete();
    await expect(result).resolves.toEqual({ ok: true, rendered: true, radius: 5 });
    expect(tool.resultContract).toBe('explicit-v1');
  });

  it('preserves factual interaction-context failures for every tool consumer', async () => {
    const failure = toolFailure({
      code: 'EMPTY_SELECTION',
      error: 'The selection matched no atoms.',
      retriable: false,
      stateChanged: false,
      partialEffects: [],
    });
    const tool = createMolShowInteractionContextTool({
      showInteractionContext: vi.fn(async () => failure),
    });
    await expect(
      tool.execute!({ bindingId: 'binding', selection: 'resi 99999' }, options)
    ).resolves.toEqual(failure);
  });

  it('requires one exact logical target and a complete bounded scene document', () => {
    expect(molApplySceneSchema.safeParse({ scene: '{}' }).success).toBe(false);
    expect(
      molApplySceneSchema.safeParse({ structureViewId: 'view', viewerId: 'legacy', scene: '{}' })
        .success
    ).toBe(false);
    expect(
      molApplySceneSchema.safeParse({ structureViewId: 'view', scene: 'x'.repeat(2_000_001) })
        .success
    ).toBe(false);
    expect(molApplySceneSchema.safeParse({ structureViewId: 'view', scene: '{}' }).success).toBe(
      true
    );
    expect(
      molApplySceneSchema.safeParse({
        structureViewId: 'view',
        scene: '{}',
        reapplyUnchanged: true,
      }).success
    ).toBe(true);
    expect(molApplySceneSchema.parse({ structureViewId: 'view', scene: '{}' })).not.toHaveProperty(
      'discardInteractionContext'
    );
    expect(
      molApplySceneSchema.safeParse({
        structureViewId: 'view',
        scene: '{}',
        discardInteractionContext: true,
      }).success
    ).toBe(false);
    expect(
      molApplySceneSchema.safeParse({
        structureViewId: 'view',
        scene: '{}',
        discardInteractionContext: 'true',
      }).success
    ).toBe(false);
  });

  it('waits for native rendering instead of reporting success when the request is sent', async () => {
    let complete!: () => void;
    const rendering = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const applyScene = vi.fn(async () => {
      await rendering;
      return toolSuccess({ rendered: true });
    });
    const tool = createMolApplySceneTool({ applyScene, getScene: vi.fn() });
    let settled = false;
    const result = tool.execute!(
      { structureViewId: 'view', scene: '{}' },
      options
    ) as Promise<unknown>;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    complete();
    await expect(result).resolves.toEqual({ ok: true, rendered: true });
    expect(tool.resultContract).toBe('explicit-v1');
  });

  it('passes explicit root authoring through the same canonical scene command', async () => {
    const applyScene = vi.fn(async () => toolSuccess({ rendered: true }));
    const tool = createMolApplySceneTool({ applyScene, getScene: vi.fn() });
    const input = { structureViewId: 'view', root: { kind: 'root', children: [] } };
    await expect(tool.execute!(molApplySceneSchema.parse(input), options)).resolves.toEqual({
      ok: true,
      rendered: true,
    });
    expect(applyScene).toHaveBeenCalledWith(input);
  });

  it('preserves explicit unsupported-feature failures for every consumer', async () => {
    const failure = toolFailure({
      code: 'MVS_UNSUPPORTED_RESOURCE',
      error: 'External assets are not implemented.',
      retriable: false,
      stateChanged: false,
      partialEffects: [],
    });
    const getScene = vi.fn(async () => failure);
    const tool = createMolGetSceneTool({ getScene, applyScene: vi.fn() });
    await expect(tool.execute!({ structureViewId: 'view' }, options)).resolves.toEqual(failure);
    expect(getScene).toHaveBeenCalledWith({ structureViewId: 'view' });
  });
});
