import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  validateTrackViewDocument,
  type SavedTrackView,
  type TrackViewDocument,
} from '../../shared/track-view';
import { trackViewFixture } from '../../shared/track-view-fixture';

const mocks = vi.hoisted(() => ({
  writeProjection: vi.fn(),
}));

vi.mock('../../db/entity-substrate/track-view-adapter', () => ({
  trackViewAdapter: { writeProjection: mocks.writeProjection },
}));

import { projectSavedTrackView } from './track-view-library';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function savedView(overrides: Partial<SavedTrackView> = {}): SavedTrackView {
  return {
    document: validateTrackViewDocument(trackViewFixture()),
    path: '/project/Genes.dnaforge-track-view.json',
    workspaceRoot: '/project',
    revision: 'a'.repeat(64),
    ...overrides,
  };
}

beforeEach(() => vi.resetAllMocks());

describe('Track view Registry projection scheduling', () => {
  it('coalesces simultaneous projection requests for the same saved file', async () => {
    let finishProjection: (() => void) | undefined;
    mocks.writeProjection.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishProjection = resolve;
        })
    );
    const saved: SavedTrackView = {
      document: validateTrackViewDocument(trackViewFixture()),
      path: '/profile/Track views/Genes.dnaforge-track-view.json',
      workspaceRoot: null,
      revision: 'a'.repeat(64),
    };

    const first = projectSavedTrackView(saved);
    const second = projectSavedTrackView(saved);

    expect(mocks.writeProjection).toHaveBeenCalledOnce();
    finishProjection?.();
    await Promise.all([first, second]);

    mocks.writeProjection.mockResolvedValueOnce(undefined);
    await projectSavedTrackView(saved);
    expect(mocks.writeProjection).toHaveBeenCalledTimes(2);
  });

  it.each(['newest revision', 'return to an earlier revision'])(
    'projects saved revisions in order and leaves the Registry at the %s',
    async (lastRevision) => {
      const firstGate = deferred();
      const first = savedView();
      const second = savedView({
        document: { ...first.document, name: 'Coverage' },
        revision: 'b'.repeat(64),
      });
      const last =
        lastRevision === 'newest revision'
          ? savedView({
              document: { ...first.document, name: 'Latest signals' },
              revision: 'c'.repeat(64),
            })
          : first;
      const started: string[] = [];
      const published: string[] = [];
      let registryName: string | undefined;
      mocks.writeProjection.mockImplementation(async (document: TrackViewDocument) => {
        started.push(document.name);
        if (started.length === 1) await firstGate.promise;
        registryName = document.name;
        published.push(document.name);
      });

      const pendingFirst = projectSavedTrackView(first);
      const pendingSecond = projectSavedTrackView(second);
      const pendingDuplicate = projectSavedTrackView({ ...second });
      const pendingLast = projectSavedTrackView(last);
      expect(started).toEqual([first.document.name]);
      expect(published).toEqual([]);
      firstGate.resolve();
      await Promise.all([pendingFirst, pendingSecond, pendingDuplicate, pendingLast]);

      expect(published).toEqual([first.document.name, second.document.name, last.document.name]);
      expect(registryName).toBe(last.document.name);
    }
  );

  it.each(['revision', 'path', 'workspaceRoot'] as const)(
    'projects a changed %s after the previous request fails without inheriting its failure',
    async (changed) => {
      const firstGate = deferred();
      const first = savedView();
      const current = savedView({
        [changed]:
          changed === 'revision'
            ? 'b'.repeat(64)
            : changed === 'path'
              ? '/project/Renamed.dnaforge-track-view.json'
              : '/project-parent',
      });
      let registryBinding: { name: string; path: string; workspaceRoot: string | null } | undefined;
      mocks.writeProjection
        .mockImplementationOnce(() => firstGate.promise)
        .mockImplementationOnce(
          async (
            document: TrackViewDocument,
            _id: string,
            _updatedAt: number,
            path: string,
            context: { workspaceRoot: string | null }
          ) => {
            registryBinding = { name: document.name, path, workspaceRoot: context.workspaceRoot };
          }
        );
      const failure = new Error('Previous projection failed');
      const failed = projectSavedTrackView(first).catch((error: unknown) => error);
      const pending = projectSavedTrackView(current).then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error })
      );
      expect(registryBinding).toBeUndefined();
      firstGate.reject(failure);

      expect(await failed).toBe(failure);
      expect(await pending).toEqual({ ok: true });
      expect(registryBinding).toEqual({
        name: current.document.name,
        path: current.path,
        workspaceRoot: current.workspaceRoot,
      });
    }
  );

  it('projects an independent document while another document is waiting', async () => {
    const firstGate = deferred();
    const first = savedView();
    const independent = savedView({
      document: validateTrackViewDocument(trackViewFixture('track-view-22222222')),
    });
    const published: string[] = [];
    mocks.writeProjection.mockImplementation(async (document: TrackViewDocument) => {
      if (document.id === first.document.id) await firstGate.promise;
      published.push(document.id);
    });
    const pendingFirst = projectSavedTrackView(first);
    try {
      await projectSavedTrackView(independent);
      expect(published).toEqual([independent.document.id]);
    } finally {
      firstGate.resolve();
      await pendingFirst;
    }
  });
});
