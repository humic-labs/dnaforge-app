import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  activeLease: false,
  readonly: false,
  events: [] as string[],
  reconcile: vi.fn(),
  entities: vi.fn(),
  migrate: vi.fn(),
  begin: vi.fn(),
  end: vi.fn(),
}));
vi.mock('../platform', () => ({
  platform: () => ({
    fs: {
      exists: async () => true,
      beginWorkspaceMutation: mocks.begin,
      endWorkspaceMutation: mocks.end,
    },
    db: {
      select: async () => [
        { id: 1, path: '/project', access_mode: mocks.readonly ? 'reference' : 'writable' },
      ],
    },
    notebook: { migrateLegacyProjectFiles: mocks.migrate },
    shell: { execute: async () => ({ code: 0, stdout: '', stderr: '' }) },
  }),
}));
vi.mock('./workspace-reconcile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workspace-reconcile')>()),
  reconcileWorkspaceRoot: mocks.reconcile,
}));
vi.mock('../db/entity-substrate/reconcile-entities', () => ({
  reconcileWorkspaceEntities: mocks.entities,
}));
vi.mock('./reconcile-scientific-projections', () => ({
  reconcileAcceptedScientificProjections: async () => ({ paths: [], resourceIds: [] }),
}));

import { reconcileMountedWorkspaceRoot } from './mounted-workspace-reconcile';

const root = '/project';
function result(path = '/project/original.entity.json') {
  return {
    scanned: 1,
    registered: 1,
    repaired: 0,
    missing: 0,
    externalMovesRelinked: 0,
    externalMovesAmbiguous: 0,
    primerArtifactsDiscovered: 0,
    primerArtifactsReconciled: 0,
    primerArtifactErrors: [],
    entityArtifactCandidatePaths: [path],
    errors: [],
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeLease = false;
  mocks.readonly = false;
  mocks.events.length = 0;
  mocks.begin.mockImplementation(async () => {
    expect(mocks.activeLease).toBe(false);
    mocks.activeLease = true;
    mocks.events.push('lease-enter');
    return 'outer-token';
  });
  mocks.end.mockImplementation(async () => {
    mocks.activeLease = false;
    mocks.events.push('lease-release');
  });
  mocks.reconcile.mockImplementation(async () => {
    mocks.events.push('catalog');
    return result();
  });
  mocks.entities.mockResolvedValue({
    scanned: 1,
    reconciled: 1,
    skipped: 0,
    conflicts: 0,
    errors: [],
  });
  mocks.migrate.mockImplementation(async () => {
    expect(
      mocks.activeLease,
      'notebook native owner must acquire its own released project lease'
    ).toBe(false);
    mocks.events.push('notebook-migrate');
    return {
      migrated: 1,
      issues: [],
      gitChanged: true,
      mutatedGitFiles: ['Notes/Notes.md'],
      expectedContentSha256: {},
    };
  });
});

describe('mounted reconstruction settles notebook migration outside the caller lease', () => {
  it('releases first, invokes the native owner, then reconstructs the new working files without healing again', async () => {
    mocks.reconcile
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result('/project/Notes/.forge/notebook.json'));
    const actual = await reconcileMountedWorkspaceRoot(root, { healManagedHead: true });
    expect(mocks.migrate).toHaveBeenCalledExactlyOnceWith({ workspaceRoot: root });
    expect(mocks.events.indexOf('lease-release')).toBeLessThan(
      mocks.events.indexOf('notebook-migrate')
    );
    expect(mocks.reconcile).toHaveBeenCalledTimes(2);
    expect(mocks.reconcile.mock.calls[1][1]).toMatchObject({
      catalogSource: 'working-tree',
      healManagedHead: false,
    });
    expect(actual.result.entityArtifactCandidatePaths).toContain(
      '/project/Notes/.forge/notebook.json'
    );
    expect(mocks.activeLease).toBe(false);
  });

  it.each(['healing-disabled', 'caller-token', 'readonly'] as const)(
    'does not start a second native writer for %s',
    async (state) => {
      mocks.readonly = state === 'readonly';
      await reconcileMountedWorkspaceRoot(root, {
        healManagedHead: state !== 'healing-disabled',
        ...(state === 'caller-token' ? { mutationToken: 'retained-caller-token' } : {}),
      });
      expect(mocks.migrate).not.toHaveBeenCalled();
      expect(mocks.reconcile).toHaveBeenCalledOnce();
    }
  );
});
