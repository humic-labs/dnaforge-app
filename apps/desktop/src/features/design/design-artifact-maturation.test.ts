import { describe, expect, it, vi } from 'vitest';
import {
  assertDesignArtifactMaturationTarget,
  matureDesignArtifactToPlasmidPackage,
} from './design-artifact-maturation';

function createDeps(
  overrides: Partial<Parameters<typeof matureDesignArtifactToPlasmidPackage>[1]> = {}
): Parameters<typeof matureDesignArtifactToPlasmidPackage>[1] {
  return {
    getCurrentBinding: vi.fn(async () => ({
      path: '/lab/Construct.wpdesign.json',
      relative_path: 'Construct.wpdesign.json',
      file_kind: 'waypoint-design',
    })),
    retireMirror: vi.fn(async () => {}),
    resumeMirror: vi.fn(),
    ensureConstructBinding: vi.fn(async () => {}),
    markDesignDraftMissing: vi.fn(async () => {}),
    removeDraft: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('design artifact maturation', () => {
  it('publishes the construct as a plasmid and retires the design working copy without stealing its id', async () => {
    const order: string[] = [];
    const deps = createDeps({
      ensureConstructBinding: vi.fn(async () => {
        order.push('construct');
      }),
      retireMirror: vi.fn(async () => {
        order.push('retire');
      }),
      markDesignDraftMissing: vi.fn(async () => {
        order.push('unbind-design');
      }),
      removeDraft: vi.fn(async () => {
        order.push('remove');
      }),
    });

    await expect(
      matureDesignArtifactToPlasmidPackage(
        {
          designId: 'design-1',
          constructId: 'construct-1',
          designName: 'Construct',
          packageRoot: '/lab/Construct',
          workspaceRoot: '/lab',
          mutationToken: 'maturation-token',
        },
        deps
      )
    ).resolves.toEqual({
      state: 'matured',
      draftPath: '/lab/Construct.wpdesign.json',
      packageRoot: '/lab/Construct',
    });

    expect(order).toEqual(['construct', 'retire', 'remove', 'unbind-design']);
    expect(deps.ensureConstructBinding).toHaveBeenCalledWith({
      constructId: 'construct-1',
      packageRoot: '/lab/Construct',
      name: 'Construct',
      workspaceRoot: '/lab',
      designId: 'design-1',
      mutationToken: 'maturation-token',
    });
  });

  it('resumes mirroring when removing the working copy fails, without rewriting the design as a plasmid', async () => {
    const deps = createDeps({
      removeDraft: vi.fn(async () => {
        throw new Error('Trash unavailable');
      }),
    });

    await expect(
      matureDesignArtifactToPlasmidPackage(
        {
          designId: 'design-1',
          constructId: 'construct-1',
          packageRoot: '/lab/Construct',
          workspaceRoot: '/lab',
        },
        deps
      )
    ).rejects.toThrow('Trash unavailable');

    expect(deps.ensureConstructBinding).toHaveBeenCalled();
    expect(deps.markDesignDraftMissing).not.toHaveBeenCalled();
    expect(deps.resumeMirror).toHaveBeenCalledWith('design-1');
  });

  it('still publishes a construct when the design is store-only', async () => {
    const deps = createDeps({
      getCurrentBinding: vi.fn(async () => null),
    });

    await expect(
      matureDesignArtifactToPlasmidPackage(
        {
          designId: 'design-1',
          constructId: 'construct-1',
          packageRoot: '/lab/Construct',
          workspaceRoot: '/lab',
        },
        deps
      )
    ).resolves.toEqual({ state: 'not-file-backed' });

    expect(deps.ensureConstructBinding).toHaveBeenCalledWith(
      expect.objectContaining({ constructId: 'construct-1', designId: 'design-1' })
    );
    expect(deps.retireMirror).not.toHaveBeenCalled();
    expect(deps.removeDraft).not.toHaveBeenCalled();
  });

  it('normalizes a legacy design-bound plasmid to the stable construct without rewriting package bytes', async () => {
    const deps = createDeps({
      getCurrentBinding: vi.fn(async () => ({
        path: '/lab/Construct',
        relative_path: 'Construct',
        file_kind: 'waypoint-plasmid',
      })),
    });

    await expect(
      matureDesignArtifactToPlasmidPackage(
        {
          designId: 'design-1',
          constructId: 'construct-1',
          designName: 'Construct',
          packageRoot: '/lab/Construct',
          workspaceRoot: '/lab',
        },
        deps
      )
    ).resolves.toEqual({ state: 'already-matured', packageRoot: '/lab/Construct' });

    expect(deps.ensureConstructBinding).toHaveBeenCalledWith({
      constructId: 'construct-1',
      packageRoot: '/lab/Construct',
      name: 'Construct',
      workspaceRoot: '/lab',
      designId: 'design-1',
    });
    expect(deps.removeDraft).not.toHaveBeenCalled();
  });

  it('refuses to consume a draft when the package is outside the draft workspace', async () => {
    const deps = createDeps();

    await expect(
      matureDesignArtifactToPlasmidPackage(
        {
          designId: 'design-1',
          packageRoot: '/other-workspace/Construct',
          workspaceRoot: '/other-workspace',
        },
        deps
      )
    ).rejects.toThrow('outside its workspace');

    expect(deps.ensureConstructBinding).not.toHaveBeenCalled();
    expect(deps.removeDraft).not.toHaveBeenCalled();
  });

  it('preflights a cross-workspace destination without publishing the construct', async () => {
    const deps = createDeps();

    await expect(
      assertDesignArtifactMaturationTarget(
        {
          designId: 'design-1',
          packageRoot: '/other-workspace/Construct',
          workspaceRoot: '/other-workspace',
        },
        deps
      )
    ).rejects.toThrow('outside its workspace');

    expect(deps.ensureConstructBinding).not.toHaveBeenCalled();
  });
});
