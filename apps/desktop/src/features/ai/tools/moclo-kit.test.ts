import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import { getMocloKitOutputSchema, saveMocloKitOutputSchema } from './design-output-schemas';
import { describe, expect, it, vi } from 'vitest';
import { createGetMocloKitTool, createSaveMocloKitTool, saveMocloKitSchema } from './moclo-kit';
import { parseMocloKitDefinition } from '../../design/moclo-kit-definition';
import CIDAR from '../../../../resources/sample-workspaces/standard-samples/workspace/.forge/moclo-kits/cidar.json?raw';

const folders = [
  { path: '/project-a', name: 'A', addedAt: 1 },
  { path: '/project-b', name: 'B', addedAt: 2 },
];
function dependencies() {
  return {
    loadDefinitions: vi.fn(async () => [parseMocloKitDefinition(CIDAR)]),
    saveKit: vi.fn(async () => ({
      kitId: 'test-kit',
      kitRevision: 1,
      path: '/project-b/.forge/moclo-kits/test-kit.json',
      contentHash: 'saved',
    })),
  };
}
describe('agent kit authoring without an assembly', () => {
  it('passes explicit maintenance removals to the same project-scoped writer', async () => {
    const deps = dependencies();
    const removals = {
      removeMemberPackageIds: ['sample-package'],
      removePartTypeIds: ['old-type'],
      removeSchemaIds: ['old-schema'],
    };
    const input = saveMocloKitSchema.parse({
      project: 'B',
      kitId: 'test-kit',
      expectedKitRevision: 1,
      ...removals,
    });
    await execDesignContract(
      saveMocloKitOutputSchema,
      createSaveMocloKitTool(folders, deps),
      input
    );
    expect(deps.saveKit).toHaveBeenCalledExactlyOnceWith({
      projectRoot: '/project-b',
      kitId: 'test-kit',
      expectedKitRevision: 1,
      ...removals,
    });
  });
  it('marks save rejections as failures for the shared agent bridge', async () => {
    const deps = dependencies();
    deps.saveKit.mockRejectedValue(new Error('The kit changed. Read it again.'));
    const result = await execDesignContract(
      saveMocloKitOutputSchema,
      createSaveMocloKitTool(folders, deps),
      {
        project: 'B',
        kitId: 'test-kit',
        expectedKitRevision: 1,
      }
    );
    expect(result).toMatchObject({
      ok: false,
      status: 'rejected',
      error: expect.stringMatching(/changed/),
    });
  });
  it('saves reusable schemas with kit members through the existing tool', async () => {
    const deps = dependencies();
    const assemblySchemas = parseMocloKitDefinition(CIDAR).assemblySchemas;
    const input = saveMocloKitSchema.parse({
      project: 'B',
      kitId: 'test-kit',
      expectedKitRevision: 0,
      name: 'Test kit',
      description: 'Reviewed parts and layouts',
      members: [{ sequencePackageId: 'sample-package' }],
      assemblySchemas,
    });
    const result = await execDesignContract(
      saveMocloKitOutputSchema,
      createSaveMocloKitTool(folders, deps),
      input
    );
    expect(result).toMatchObject({ status: 'saved', kitRevision: 1 });
    expect(deps.saveKit).toHaveBeenCalledExactlyOnceWith({
      projectRoot: '/project-b',
      kitId: 'test-kit',
      expectedKitRevision: 0,
      name: 'Test kit',
      description: 'Reviewed parts and layouts',
      members: [{ sequencePackageId: 'sample-package' }],
      assemblySchemas,
    });
  });
  it('reads full declared kit membership and roles in the explicit project regardless of folder order', async () => {
    const deps = dependencies();
    for (const roots of [folders, [...folders].reverse()]) {
      const result = await execDesignContract(
        getMocloKitOutputSchema,
        createGetMocloKitTool(roots, deps),
        {
          project: 'B',
          kitId: 'moclo-cidar',
        }
      );
      expect(result).toMatchObject({
        status: 'ready',
        kit: { id: 'moclo-cidar', members: expect.any(Array) },
      });
      expect(deps.loadDefinitions).toHaveBeenLastCalledWith('/project-b');
    }
  });
  it('saves through the shared domain writer and returns no private file path', async () => {
    const deps = dependencies();
    const result = await execDesignContract(
      saveMocloKitOutputSchema,
      createSaveMocloKitTool(folders, deps),
      {
        project: 'B',
        kitId: 'test-kit',
        expectedKitRevision: 0,
        name: 'Test kit',
        description: 'Reviewed parts',
        members: [{ sequencePackageId: 'sample-package', partTypeId: null }],
      }
    );
    expect(deps.saveKit).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: '/project-b',
        members: [{ sequencePackageId: 'sample-package', partTypeId: null }],
      })
    );
    expect(result).toEqual({
      ok: true,
      status: 'saved',
      kitId: 'test-kit',
      kitRevision: 1,
      contentHash: 'saved',
    });
  });
  it('rejects an unknown, ambiguous or pinned project instead of choosing the first project', async () => {
    const deps = dependencies();
    for (const roots of [
      folders,
      folders.map((f) => ({ ...f, name: 'duplicate' })),
      [{ ...folders[0], pinned: true }],
    ]) {
      const result = await execDesignContract(
        saveMocloKitOutputSchema,
        createSaveMocloKitTool(roots, deps),
        {
          project: roots === folders ? 'missing' : roots.length === 2 ? 'duplicate' : 'A',
          kitId: 'test-kit',
          expectedKitRevision: 0,
        }
      );
      expect(result).toMatchObject({
        status: 'rejected',
        error: expect.stringMatching(/project.*ambiguous/i),
      });
    }
    expect(deps.saveKit).not.toHaveBeenCalled();
  });
  it('does not accept competing member names, sequence bytes or path fields', () => {
    for (const extra of [
      { name: 'invented.gb' },
      { sequence: 'ATGC' },
      { workspacePath: 'repo/part/part.gb' },
    ]) {
      expect(
        saveMocloKitSchema.safeParse({
          project: 'B',
          kitId: 'test-kit',
          expectedKitRevision: 0,
          members: [{ sequencePackageId: 'package', ...extra }],
        }).success
      ).toBe(false);
    }
  });
});
