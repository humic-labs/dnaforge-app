import { beforeEach, describe, expect, it } from 'vitest';
import { useDesignStore } from './store';
import {
  resolveMocloFactoryWorkspaceRoot,
  selectDesignWorkspaceRoot,
} from './materialize-design-artifact';

describe('resolveMocloFactoryWorkspaceRoot', () => {
  beforeEach(() => {
    useDesignStore.setState({ designs: {}, activeDesignId: null, pendingDispatchId: null });
  });

  it('resolves an empty saved assembly from its own file, independent of mounted-project order', async () => {
    const designId = useDesignStore
      .getState()
      .createDesign('Saved kit draft', 'circular', 'goldengate');
    const design = useDesignStore.getState().designs[designId]!;
    const roots = [
      { path: '/other-project', name: 'Other', addedAt: 1 },
      { path: '/owning-project', name: 'Owner', addedAt: 2 },
    ];
    const dependencies = {
      getCurrentFileForEntity: async (id: string) =>
        id === designId ? { path: '/owning-project/assemblies/saved-kit.design.json' } : null,
      resolveObject: async () => null,
      workspaceHasKit: async () => false,
    };
    for (const folders of [roots, [...roots].reverse()]) {
      await expect(
        resolveMocloFactoryWorkspaceRoot(design, [design], folders, dependencies)
      ).resolves.toBe('/owning-project');
    }
    await expect(
      resolveMocloFactoryWorkspaceRoot(design, [design], [roots[0]!], dependencies)
    ).resolves.toBeNull();
    await expect(
      resolveMocloFactoryWorkspaceRoot(
        design,
        [design],
        [{ ...roots[1]!, pinned: true }],
        dependencies
      )
    ).resolves.toBeNull();
  });

  it('keeps a blank later stage in the workspace that owns an earlier stable package identity', async () => {
    const sourceId = useDesignStore
      .getState()
      .createDesign('Expression cassette', 'circular', 'goldengate');
    const blankId = useDesignStore
      .getState()
      .createDesign('Multigene device', 'circular', 'goldengate');
    const context = {
      runId: 'factory-run',
      kitId: 'ytk',
      kitRevision: 1,
      recipeId: 'ytk-multigene-device',
    } as const;
    const designs = useDesignStore.getState().designs;
    const sourceBase = designs[sourceId];
    const blankBase = designs[blankId];
    if (!sourceBase || !blankBase) throw new Error('Factory test designs were not created.');
    const source = {
      ...sourceBase,
      mocloFactory: { ...context, stageId: 'expression-cassette', stageInputs: [] },
      regions: [
        {
          id: 'promoter',
          sourceSequenceId: 'sample-4e461e72',
          sourceSequenceName: 'pYTK009',
          sourceStart: 0,
          sourceEnd: 100,
          sequence: 'A'.repeat(100),
          annotations: [],
          sourceType: 'rd' as const,
        },
      ],
    };
    const blank = {
      ...blankBase,
      mocloFactory: {
        ...context,
        stageId: 'multigene-device',
        stageInputs: [{ slotId: 'cassette', sourceStageId: 'expression-cassette' }],
      },
    };

    await expect(
      resolveMocloFactoryWorkspaceRoot(
        blank,
        [source, blank],
        [
          { path: '/workspace-a', name: 'A', addedAt: 1 },
          { path: '/workspace-b', name: 'B', addedAt: 2 },
        ],
        {
          getCurrentFileForEntity: async (entityId) =>
            entityId === 'sample-4e461e72'
              ? { path: '/workspace-b/sequences/kits/moclo-ytk/pYTK009' }
              : null,
          resolveObject: async () => null,
          workspaceHasKit: async () => false,
        }
      )
    ).resolves.toBe('/workspace-b');
  });

  it('uses immutable object identity before consulting kit manifests', async () => {
    const designId = useDesignStore
      .getState()
      .createDesign('Expression cassette', 'circular', 'goldengate');
    const base = useDesignStore.getState().designs[designId];
    if (!base) throw new Error('Factory test design was not created.');
    const design = {
      ...base,
      mocloFactory: {
        runId: 'factory-run',
        kitId: 'ytk',
        kitRevision: 1,
        recipeId: 'ytk-multigene-device',
        stageId: 'expression-cassette',
        stageInputs: [],
      },
      regions: [
        {
          id: 'promoter',
          sourceSequenceId: '0689bec3-7586-4eb3-b44b-42bd986cfce8',
          sourceSequenceName: 'pYTK009',
          sourceStart: 0,
          sourceEnd: 100,
          sequence: 'A'.repeat(100),
          annotations: [],
          sourceType: 'rd' as const,
        },
      ],
    };

    await expect(
      resolveMocloFactoryWorkspaceRoot(
        design,
        [design],
        [
          { path: '/unrelated-first-workspace', name: 'Unrelated', addedAt: 1 },
          { path: '/workspace-containing-ytk', name: 'YTK', addedAt: 2 },
        ],
        {
          getCurrentFileForEntity: async () => null,
          resolveObject: async (objectUuid) =>
            objectUuid === '0689bec3-7586-4eb3-b44b-42bd986cfce8'
              ? {
                  absolutePath: '/workspace-containing-ytk/sequences/kits/moclo-ytk/pYTK051',
                }
              : null,
          workspaceHasKit: async () => false,
        }
      )
    ).resolves.toBe('/workspace-containing-ytk');
  });

  it('does not let mounted-project order break a duplicated package identity tie', async () => {
    const designId = useDesignStore
      .getState()
      .createDesign('Expression cassette', 'circular', 'goldengate');
    const base = useDesignStore.getState().designs[designId];
    if (!base) throw new Error('Factory test design was not created.');
    const design = {
      ...base,
      mocloFactory: {
        runId: 'factory-run',
        kitId: 'ytk',
        kitRevision: 1,
        recipeId: 'ytk-multigene-device',
        stageId: 'expression-cassette',
        stageInputs: [],
      },
      regions: [
        {
          id: 'promoter',
          sourceSequenceId: 'shared-package-object',
          sourceSequenceName: 'pYTK009',
          sourceStart: 0,
          sourceEnd: 100,
          sequence: 'A'.repeat(100),
          annotations: [],
          sourceType: 'rd' as const,
        },
      ],
    };
    const roots = [
      { path: '/project-a', name: 'A', addedAt: 1 },
      { path: '/project-b', name: 'B', addedAt: 2 },
    ];
    const dependencies = {
      getCurrentFileForEntity: async (entityId: string) =>
        entityId === 'shared-package-object' ? { path: '/project-b/sequences/pYTK009' } : null,
      resolveObject: async (objectUuid: string) =>
        objectUuid === 'shared-package-object'
          ? { absolutePath: '/project-a/sequences/pYTK009' }
          : null,
      workspaceHasKit: async (workspaceRoot: string) => workspaceRoot === '/project-a',
    };

    await expect(
      resolveMocloFactoryWorkspaceRoot(design, [design], roots, dependencies)
    ).resolves.toBeNull();
    await expect(
      resolveMocloFactoryWorkspaceRoot(design, [design], [...roots].reverse(), dependencies)
    ).resolves.toBeNull();
  });

  it('selects the only workspace that owns the factory kit instead of guessing by order', async () => {
    const designId = useDesignStore
      .getState()
      .createDesign('Expression cassette', 'circular', 'goldengate');
    const base = useDesignStore.getState().designs[designId];
    if (!base) throw new Error('Factory test design was not created.');
    const design = {
      ...base,
      mocloFactory: {
        runId: 'factory-run',
        kitId: 'ytk',
        kitRevision: 1,
        recipeId: 'ytk-multigene-device',
        stageId: 'expression-cassette',
        stageInputs: [],
      },
    };

    await expect(
      resolveMocloFactoryWorkspaceRoot(
        design,
        [design],
        [
          { path: '/unrelated-first-workspace', name: 'Unrelated', addedAt: 1 },
          { path: '/workspace-containing-ytk', name: 'YTK', addedAt: 2 },
        ],
        {
          getCurrentFileForEntity: async () => null,
          resolveObject: async () => null,
          workspaceHasKit: async (workspaceRoot, kitId, kitRevision) =>
            workspaceRoot === '/workspace-containing-ytk' && kitId === 'ytk' && kitRevision === 1,
        }
      )
    ).resolves.toBe('/workspace-containing-ytk');
  });

  it('refuses to choose when the same kit exists in multiple unowned workspaces', async () => {
    const designId = useDesignStore
      .getState()
      .createDesign('Expression cassette', 'circular', 'goldengate');
    const base = useDesignStore.getState().designs[designId];
    if (!base) throw new Error('Factory test design was not created.');
    const design = {
      ...base,
      mocloFactory: {
        runId: 'factory-run',
        kitId: 'ytk',
        kitRevision: 1,
        recipeId: 'ytk-multigene-device',
        stageId: 'expression-cassette',
        stageInputs: [],
      },
    };

    await expect(
      resolveMocloFactoryWorkspaceRoot(
        design,
        [design],
        [
          { path: '/workspace-a', name: 'A', addedAt: 1 },
          { path: '/workspace-b', name: 'B', addedAt: 2 },
        ],
        {
          getCurrentFileForEntity: async () => null,
          resolveObject: async () => null,
          workspaceHasKit: async () => true,
        }
      )
    ).resolves.toBeNull();
  });

  it('does not choose another project when one kit inventory is incomplete', async () => {
    const designId = useDesignStore
      .getState()
      .createDesign('Expression cassette', 'circular', 'goldengate');
    const base = useDesignStore.getState().designs[designId];
    if (!base) throw new Error('Factory test design was not created.');
    const design = {
      ...base,
      mocloFactory: {
        runId: 'factory-run',
        kitId: 'ytk',
        kitRevision: 1,
        recipeId: 'ytk-multigene-device',
        stageId: 'expression-cassette',
        stageInputs: [],
      },
    };
    const roots = [
      { path: '/project-with-broken-manifest', name: 'Broken', addedAt: 1 },
      { path: '/project-with-valid-kit', name: 'Valid', addedAt: 2 },
    ];
    const dependencies = {
      getCurrentFileForEntity: async () => null,
      resolveObject: async () => null,
      workspaceHasKit: async (workspaceRoot: string) => {
        if (workspaceRoot === '/project-with-broken-manifest') {
          throw new Error('A MoClo kit definition could not be loaded.');
        }
        return true;
      },
    };

    await expect(
      resolveMocloFactoryWorkspaceRoot(design, [design], roots, dependencies)
    ).rejects.toThrow(/could not be loaded/i);
    await expect(
      resolveMocloFactoryWorkspaceRoot(design, [design], [...roots].reverse(), dependencies)
    ).rejects.toThrow(/could not be loaded/i);
  });
});

describe('selectDesignWorkspaceRoot', () => {
  it('never assigns an unowned design to the first mounted project', () => {
    const designId = useDesignStore
      .getState()
      .createDesign('Unowned design', 'circular', 'goldengate');
    const design = useDesignStore.getState().designs[designId];
    if (!design) throw new Error('Design fixture was not created.');

    expect(
      selectDesignWorkspaceRoot(design, [
        { path: '/project-a', name: 'A', addedAt: 1 },
        { path: '/project-b', name: 'B', addedAt: 2 },
      ])
    ).toBeNull();
    expect(
      selectDesignWorkspaceRoot(design, [{ path: '/only-project', name: 'Only', addedAt: 1 }])
    ).toBe('/only-project');
  });

  it('does not assign a mixed-project design to whichever source region appears first', () => {
    const designId = useDesignStore
      .getState()
      .createDesign('Mixed source design', 'circular', 'goldengate');
    const base = useDesignStore.getState().designs[designId];
    if (!base) throw new Error('Design fixture was not created.');
    const design = {
      ...base,
      regions: [
        { ...base.regions[0], sourceSequenceId: '/project-a/a.gb' },
        { ...base.regions[0], id: 'region-b', sourceSequenceId: '/project-b/b.gb' },
      ],
    };
    const roots = [
      { path: '/project-a', name: 'A', addedAt: 1 },
      { path: '/project-b', name: 'B', addedAt: 2 },
    ];

    expect(selectDesignWorkspaceRoot(design, roots)).toBeNull();
    expect(selectDesignWorkspaceRoot(design, [...roots].reverse())).toBeNull();
  });
});
