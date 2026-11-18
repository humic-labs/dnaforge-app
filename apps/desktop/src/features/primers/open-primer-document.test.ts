/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectEditFolder } from '../workspace-loader/public/project-edit-folders';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  present: vi.fn(),
  catalogEntity: vi.fn(),
  mounted: [{ path: '/other-project', name: 'Other project' }],
}));
vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ folders: mocks.mounted }) },
}));
vi.mock('../canvas/public/present-document', () => ({ presentDocument: mocks.present }));
vi.mock('../../db/workspace-catalog', () => ({ getCatalogEntityForFilePath: mocks.catalogEntity }));
vi.mock('../workspace-loader/public/project-edit-folders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace-loader/public/project-edit-folders')>()),
  listProjectEditFolders: mocks.list,
}));

import { openPrimerDocument } from './open-primer-document';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.catalogEntity.mockReset();
  mocks.catalogEntity.mockResolvedValue(null);
  mocks.mounted = [{ path: '/other-project', name: 'Other project' }];
  mocks.list.mockResolvedValue([
    { path: '/saved-home', name: 'Saved home', lifecycle: 'active', pinned: false },
  ]);
  mocks.present.mockReturnValue({
    status: 'presented',
    tabId: 'primer-tab',
    panelId: 'main',
    tabType: 'primer',
    disposition: 'created',
    content: 'loading',
  });
});

describe('saved primer opening uses durable project ownership', () => {
  it('presents a known saved RNA oligo with its entity kind before the editor loads', async () => {
    mocks.catalogEntity.mockResolvedValue({
      type: 'primer',
      metadata: JSON.stringify({ entitySchema: { name: 'rna_oligo' } }),
    });
    await openPrimerDocument({
      target: { kind: 'file', path: '/saved-home/p.primer.json', tabType: 'primer' },
      label: 'Saved oligo',
    });
    expect(mocks.catalogEntity).toHaveBeenCalledWith('/saved-home/p.primer.json');
    expect(mocks.present).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'primer', entityKind: 'rna_oligo' }),
      undefined
    );
  });

  it('opens its registered home without mounting it or borrowing the active project', async () => {
    const folders = structuredClone(mocks.mounted);
    await expect(
      openPrimerDocument({
        target: { kind: 'file', path: '/saved-home/primers/p.primer.json', tabType: 'primer' },
        label: 'Saved primer',
      })
    ).resolves.toMatchObject({ status: 'presented' });
    expect(mocks.present).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: '/saved-home/primers/p.primer.json',
        readOnly: false,
        artifactDocument: expect.objectContaining({
          workspaceRoot: '/saved-home',
          destinationPath: '/saved-home/primers',
          artifactPath: '/saved-home/primers/p.primer.json',
        }),
      }),
      undefined
    );
    expect(mocks.mounted).toEqual(folders);
  });

  it.each(['archived', 'trashed', 'restoring'] as const)(
    'keeps a %s home read-only despite a stale writable sidebar entry',
    async (lifecycle) => {
      mocks.mounted = [{ path: '/saved-home', name: 'Stale mounted home' }];
      mocks.list.mockResolvedValue([
        { path: '/saved-home', lifecycle, pinned: false },
      ] satisfies ProjectEditFolder[]);
      await openPrimerDocument({
        target: { kind: 'file', path: '/saved-home/p.primer.json', tabType: 'primer' },
        label: 'Saved primer',
      });
      expect(mocks.present).toHaveBeenCalledWith(
        expect.objectContaining({ readOnly: true }),
        undefined
      );
    }
  );

  it('keeps a registered reference home read-only', async () => {
    mocks.list.mockResolvedValue([{ path: '/saved-home', lifecycle: 'active', pinned: true }]);
    await openPrimerDocument({
      target: { kind: 'file', path: '/saved-home/p.primer.json', tabType: 'primer' },
      label: 'Reference primer',
    });
    expect(mocks.present).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
      undefined
    );
  });

  it('does not infer an owner for a file outside every known project', async () => {
    const result = await openPrimerDocument({
      target: { kind: 'file', path: '/unknown/p.primer.json', tabType: 'primer' },
      label: 'Unknown primer',
    });
    expect(result.status).toBe('blocked');
    expect(mocks.present).not.toHaveBeenCalled();
  });

  it('does not present a document after cancellation during project discovery', async () => {
    const controller = new AbortController();
    mocks.list.mockImplementation(async () => {
      controller.abort();
      return [{ path: '/saved-home', lifecycle: 'active', pinned: false }];
    });
    expect(
      (
        await openPrimerDocument({
          target: { kind: 'file', path: '/saved-home/p.primer.json', tabType: 'primer' },
          label: 'Cancelled primer',
          signal: controller.signal,
        })
      ).status
    ).toBe('cancelled');
    expect(mocks.present).not.toHaveBeenCalled();
  });
});
