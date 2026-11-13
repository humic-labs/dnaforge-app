import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import { createDesignOutputSchema } from './design-output-schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../../canvas/store';
import { useDesignStore } from '../../design/store';
import { resetCanvasStore } from './test-helpers';
import { createCreateDesignTool, createDesignTool } from './create-design';

const materializeMocks = vi.hoisted(() => ({
  ensureDesignArtifact: vi.fn(),
}));

vi.mock('../../design/materialize-design-artifact', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../design/materialize-design-artifact')>();
  return { ...original, ensureDesignArtifact: materializeMocks.ensureDesignArtifact };
});

function resetDesignStore() {
  useDesignStore.setState({
    designs: {},
    activeDesignId: null,
    pendingDispatchId: null,
  });
}

describe('create_design tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    materializeMocks.ensureDesignArtifact.mockResolvedValue(undefined);
    resetCanvasStore();
    resetDesignStore();
  });

  it('creates a design without opening a design tab by default', async () => {
    const result = await execDesignContract<{
      designId: string;
      name: string;
      assemblyMethod: string;
      opened: boolean;
      tabId: string | null;
      resourceUri: string;
      artifact: {
        type: string;
        designId: string;
        name: string;
        resourceUri: string;
        openAction: { tool: string; type: string; entityId: string; label: string };
      };
      mutation: {
        operationId: string;
        effect: string;
        resourceUri: string;
        beforeVersion: number | null;
        afterVersion: number | null;
        target: { type: string; id: string };
        expected: { name: string; regionCount: number };
      };
    }>(createDesignOutputSchema, createDesignTool, {
      name: 'AmpR derivative',
      assemblyMethod: 'gibson',
    });

    const design = useDesignStore.getState().designs[result.designId];
    const canvas = useCanvasStore.getState();
    const tabs = Object.values(canvas.panels).flatMap((panel) => panel.tabs);

    expect(result).toMatchObject({
      name: 'AmpR derivative',
      assemblyMethod: 'gibson',
      opened: false,
      tabId: null,
      resourceUri: `waypoint://design/${encodeURIComponent(result.designId)}`,
      artifact: {
        type: 'design',
        designId: result.designId,
        name: 'AmpR derivative',
        resourceUri: `waypoint://design/${encodeURIComponent(result.designId)}`,
        openAction: {
          tool: 'open_tab',
          type: 'design',
          entityId: result.designId,
          label: 'AmpR derivative',
        },
      },
    });
    expect(result.mutation).toMatchObject({
      operationId: 'test',
      effect: 'created_design',
      resourceUri: `waypoint://design/${encodeURIComponent(result.designId)}`,
      beforeVersion: null,
      afterVersion: 0,
      target: { type: 'design', id: result.designId },
      expected: { name: 'AmpR derivative', regionCount: 0 },
    });
    expect(design).toMatchObject({
      id: result.designId,
      name: 'AmpR derivative',
      assemblyMethod: 'gibson',
      assemblyState: 'preflight',
      regions: [],
    });
    expect(tabs).toEqual([]);
  });

  it('can open the new design when explicitly requested', async () => {
    const result = await execDesignContract<{
      designId: string;
      opened: boolean;
      tabId: string | null;
      mutation: { effect: string; afterVersion: number | null };
    }>(createDesignOutputSchema, createDesignTool, {
      name: 'Visible design',
      open: true,
    });

    const tabs = Object.values(useCanvasStore.getState().panels).flatMap((panel) => panel.tabs);

    expect(result.opened).toBe(true);
    expect(result.tabId).toEqual(expect.any(String));
    expect(tabs).toContainEqual(
      expect.objectContaining({
        id: result.tabId,
        type: 'design',
        entityId: result.designId,
        label: 'Visible design',
      })
    );
  });

  it('can create a design without opening a tab', async () => {
    const result = await execDesignContract<{
      designId: string;
      opened: boolean;
      tabId: string | null;
      mutation: { effect: string; afterVersion: number | null };
    }>(createDesignOutputSchema, createDesignTool, {
      name: 'Background design',
      open: false,
    });

    expect(result.opened).toBe(false);
    expect(result.tabId).toBeNull();
    expect(result.mutation).toMatchObject({
      effect: 'created_design',
      afterVersion: 0,
    });
    expect(useDesignStore.getState().designs[result.designId]?.name).toBe('Background design');
    expect(Object.values(useCanvasStore.getState().panels).flatMap((panel) => panel.tabs)).toEqual(
      []
    );
  });

  it('persists a production-created design in the mounted project before reporting success', async () => {
    const tool = createCreateDesignTool([
      { path: '/managed/project', name: 'Project', addedAt: 1 },
    ]);
    const result = await execDesignContract<{ designId: string }>(createDesignOutputSchema, tool, {
      name: 'Shareable design',
      open: true,
    });

    expect(materializeMocks.ensureDesignArtifact).toHaveBeenCalledWith({
      design: expect.objectContaining({ id: result.designId, name: 'Shareable design' }),
      workspaceRoot: '/managed/project',
      source: 'agent-create-design',
    });
  });

  it('requires an explicit destination before creating anything when multiple projects are open', async () => {
    const tool = createCreateDesignTool([
      { path: '/managed/my-project', name: 'My Project', addedAt: 1 },
      { path: '/managed/samples', name: 'DNAForge Samples', addedAt: 2 },
    ]);

    const result = await execDesignContract<{ created: false; code: string; error: string }>(
      createDesignOutputSchema,
      tool,
      {
        name: 'Ambiguous design',
      }
    );

    expect(result).toMatchObject({
      created: false,
      code: 'PROJECT_REQUIRED',
      error: expect.stringContaining('destinationProject'),
    });
    expect(useDesignStore.getState().designs).toEqual({});
    expect(materializeMocks.ensureDesignArtifact).not.toHaveBeenCalled();
  });

  it('persists a multi-project design in the explicitly named destination', async () => {
    const tool = createCreateDesignTool([
      { path: '/managed/my-project', name: 'My Project', addedAt: 1 },
      { path: '/managed/samples', name: 'DNAForge Samples', addedAt: 2 },
    ]);

    const result = await execDesignContract<{ designId: string; destinationProject: string }>(
      createDesignOutputSchema,
      tool,
      {
        name: 'Owned design',
        destinationProject: 'My Project',
      }
    );

    expect(result.destinationProject).toBe('My Project');
    expect(materializeMocks.ensureDesignArtifact).toHaveBeenCalledWith({
      design: expect.objectContaining({ id: result.designId, name: 'Owned design' }),
      workspaceRoot: '/managed/my-project',
      source: 'agent-create-design',
    });
  });
});

describe('create_design — Golden Gate enzyme  D18)', () => {
  beforeEach(() => {
    resetCanvasStore();
    resetDesignStore();
  });

  it('honors the requested Golden Gate enzyme instead of silently defaulting to BsaI', async () => {
                                                                                 
                                                                  
                                                                                  
                                          
    const result = await execDesignContract<{ designId: string; goldenGateEnzyme: string | null }>(
      createDesignOutputSchema,
      createDesignTool,
      { name: 'BsmBI build', assemblyMethod: 'goldengate', goldenGateEnzyme: 'BsmBI' }
    );

    const design = useDesignStore.getState().designs[result.designId];
    expect(design.goldenGateConfig?.enzyme).toBe('BsmBI');
    expect(result.goldenGateEnzyme).toBe('BsmBI');
  });

  it('canonicalizes an alias and leaves the BsaI default intact when unspecified', async () => {
    const aliased = await execDesignContract<{ designId: string }>(
      createDesignOutputSchema,
      createDesignTool,
      {
        name: 'Esp3I build',
        assemblyMethod: 'goldengate',
        goldenGateEnzyme: 'Esp3I',
      }
    );
                                                                                     
    expect(useDesignStore.getState().designs[aliased.designId].goldenGateConfig?.enzyme).toBe(
      'BsmBI'
    );

    const defaulted = await execDesignContract<{ designId: string }>(
      createDesignOutputSchema,
      createDesignTool,
      {
        name: 'Default build',
        assemblyMethod: 'goldengate',
      }
    );
    expect(useDesignStore.getState().designs[defaulted.designId].goldenGateConfig?.enzyme).toBe(
      'BsaI'
    );
  });
});
