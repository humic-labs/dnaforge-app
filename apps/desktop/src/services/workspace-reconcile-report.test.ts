import { useNotebookConflictStore } from '../features/page/public/notebook-conflict';
import { expectToastCall } from '../test/toast-assertions';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addToast: vi.fn(),
  addRichToast: vi.fn(),
  removeToast: vi.fn(),
  toasts: [] as Array<{ id: string; message: string; phase: string }>,
}));

vi.mock('../stores/toast-store', () => ({
  useToastStore: {
    getState: () => ({
      addToast: mocks.addToast,
      addRichToast: mocks.addRichToast,
      removeToast: mocks.removeToast,
      toasts: mocks.toasts,
    }),
  },
}));

import {
  reportEntityReconcileConflicts,
  reportPrimerReconcileFailures,
  reportPrimerRecoveryInventory,
} from './workspace-reconcile-report';

const reportUnassignedRecovery = (
  originalProject: import('../shared/first-project').OriginalDefaultProjectResolution
) =>
  reportPrimerRecoveryInventory({
    schema: 'dnaforge.primer-recovery-inventory/v1',
    recordedAt: 1,
    originalProject,
    entries: [
      {
        id: 'historical-primer',
        name: 'Historical primer',
        source: 'legacy',
        workspaceId: null,
        projectUuid: null,
        status: 'needs-review',
      },
    ],
  });

it('suppresses the recurring identification toast and keeps archived-project guidance without actions', () => {
  const toastsBefore = mocks.addRichToast.mock.calls.length;
  reportUnassignedRecovery({
    status: 'unresolved',
    reason: 'identity-not-recorded',
    message: 'Identify the original.',
  });
  expect(mocks.addRichToast.mock.calls).toHaveLength(toastsBefore);
  reportUnassignedRecovery({
    status: 'unresolved',
    reason: 'project-archived',
    message: 'Restore the original.',
  });
  expect(mocks.addRichToast.mock.calls.at(-1)?.[0].actions).toBeUndefined();
});

const base = {
  scanned: 0,
  registered: 0,
  repaired: 0,
  missing: 0,
  externalMovesRelinked: 0,
  externalMovesAmbiguous: 0,
  primerArtifactsDiscovered: 0,
  primerArtifactsReconciled: 0,
  entityArtifactCandidatePaths: [],
};

describe('reportPrimerReconcileFailures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('surfaces a primer registry failure in plain language, naming the offending file', () => {
    const error = { path: '/lab/project/primers/bad.primer.json', message: 'duplicate id' };
    reportPrimerReconcileFailures('/lab/project', {
      ...base,
      scanned: 2,
      primerArtifactsDiscovered: 2,
      primerArtifactsReconciled: 1,
      primerArtifactErrors: [error],
      errors: [error],
    });

    expectToastCall(
      mocks.addToast,
      expect.stringMatching(
        /primer file "primers\/bad\.primer\.json" couldn't be added to your primer registry/i
      ),
      'error'
    );
    const [message] = mocks.addToast.mock.calls[0];
    expect(message).not.toMatch(/rebuilt into the registry/i);
  });

  it('names one example file and the count when several primers fail', () => {
    reportPrimerReconcileFailures('/lab/project', {
      ...base,
      scanned: 3,
      primerArtifactsDiscovered: 3,
      primerArtifactsReconciled: 1,
      primerArtifactErrors: [
        { path: '/lab/project/primers/a.primer.json', message: 'duplicate id' },
        { path: '/lab/project/primers/b.primer.json', message: 'malformed' },
      ],
      errors: [],
    });
    expectToastCall(
      mocks.addToast,
      expect.stringMatching(
        /2 primer files couldn't be added to your primer registry.*a\.primer\.json/i
      ),
      'error'
    );
  });

  it.each(['registry:existing-primer', 'legacy-primer:existing-primer'])(
    'surfaces a recovery failure for %s with its reason',
    (path) => {
      const error = { path, message: 'The original My Project is unavailable on this device.' };
      reportPrimerReconcileFailures('/lab/project', {
        ...base,
        primerArtifactErrors: [error],
        errors: [error],
      });
      expectToastCall(
        mocks.addToast,
        expect.stringMatching(/primer recovery.*original My Project is unavailable/i),
        'error'
      );
    }
  );

  it('does NOT toast for discovery-infrastructure errors (scan cap / unreadable dir)', () => {
    const error = {
      path: '/lab/project/huge-dir',
      message: 'Primer discovery stopped at the workspace scan safety limit.',
    };
    reportPrimerReconcileFailures('/lab/project', {
      ...base,
      primerArtifactErrors: [error],
      errors: [error],
    });
    expect(mocks.addToast).not.toHaveBeenCalled();
  });
});

describe('reportEntityReconcileConflicts', () => {
  const root = '/lab/content-conflict-project';
  const clean = { scanned: 1, reconciled: 0, conflicts: 0, errors: [] };
  const conflict = {
    ...clean,
    conflicts: 1,
    conflictDetails: [
      {
        id: 'record-1',
        path: `${root}/records/changed.entity.json`,
        reason: 'both-changed' as const,
      },
    ],
  };
  beforeEach(() => {
    reportEntityReconcileConflicts(root, clean);
    mocks.toasts = [];
    vi.clearAllMocks();
    mocks.addToast.mockImplementation((message: string) => {
      const id = `conflict-toast-${crypto.randomUUID()}`;
      mocks.toasts.push({ id, message, phase: 'visible' });
      return id;
    });
    mocks.removeToast.mockImplementation((id: string) => {
      mocks.toasts = mocks.toasts.filter((toast) => toast.id !== id);
    });
  });

  it('names the saved file in a persistent conflict notice and retains both versions', () => {
    reportEntityReconcileConflicts(root, conflict);
    expect(mocks.addToast).toHaveBeenCalledWith(
      expect.stringMatching(/records\/changed\.entity\.json.*both versions are retained/i),
      { definition: 'entity-reconcile-conflict' }
    );
    reportEntityReconcileConflicts(root, conflict);
    expect(mocks.addToast).toHaveBeenCalledOnce();
  });

  it('opens a closed notebook comparison from the persistent conflict notice', () => {
    reportEntityReconcileConflicts(root, {
      ...conflict,
      conflictDetails: [
        {
          id: 'scoped::notebook',
          path: `${root}/Report/.forge/notebook.json`,
          reason: 'both-changed',
        },
      ],
    });
    const toast = mocks.addRichToast.mock.calls.at(-1)?.[0];
    expect(toast.actions[0].label).toBe('Compare versions');
    toast.actions[0].onClick();
    expect(useNotebookConflictStore.getState().documentId).toBe('scoped::notebook');
    useNotebookConflictStore.getState().close();
  });

  it('clears resolved notices and surfaces a new conflict in the same project', () => {
    reportEntityReconcileConflicts(root, conflict);
    const toastId = mocks.toasts[0].id;
    reportEntityReconcileConflicts(root, clean);
    expect(mocks.removeToast).toHaveBeenCalledWith(toastId);
    expect(mocks.toasts).toEqual([]);
    reportEntityReconcileConflicts(root, conflict);
    expect(mocks.addToast).toHaveBeenCalledTimes(2);
  });

  it('replaces the notice when the unresolved file or count changes', () => {
    reportEntityReconcileConflicts(root, conflict);
    reportEntityReconcileConflicts(root, { ...conflict, conflicts: 2 });
    expect(mocks.toasts).toHaveLength(1);
    expect(mocks.toasts[0].message).toContain('2 document conflicts');
  });
});
