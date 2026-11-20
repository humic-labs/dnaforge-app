import { beforeEach, expect, it, vi } from 'vitest';
import {
  reportPrimerReconcileFailures,
  reportPrimerRecoveryInventory,
} from './workspace-reconcile-report';
import {
  getLatestPrimerRecoveryInventory,
  refreshPrimerRecoveryInventory,
} from '../features/primers/public/primer-recovery-report';
import { useToastStore } from '../stores/toast-store';
import type { PrimerRecoveryInventory } from '../features/primers/public/primer-recovery-report';

vi.mock('../features/primers/public/primer-recovery-report', () => ({
  getLatestPrimerRecoveryInventory: vi.fn(() => null),
  refreshPrimerRecoveryInventory: vi.fn(),
}));

const restore = vi.hoisted(() => vi.fn());
vi.mock('../features/primers/primer-artifact-service', () => ({
  restoreSavedPrimerDocument: restore,
}));

const unresolved = {
  status: 'unresolved' as const,
  reason: 'identity-not-recorded' as const,
  message: 'The original My Project has not been identified.',
};

it('shows each affected primer once across startup and project scans, then clears resolved records', () => {
  const message = 'The saved primer file is missing. Restore it from project history or a backup.';
  const entries = ['Forward', 'Reverse'].map((name) => ({
    ...orphan,
    name,
    id: name,
    workspaceId: 4,
    message,
  }));
  const scan = {
    scanned: 0,
    registered: 0,
    repaired: 0,
    missing: 0,
    externalMovesRelinked: 0,
    externalMovesAmbiguous: 0,
    primerArtifactsDiscovered: 0,
    primerArtifactsReconciled: 0,
    errors: [],
    primerArtifactErrors: entries.map((e) => ({
      path: 'registry:' + e.id,
      primerName: e.name,
      message,
    })),
  };
  const notices = () =>
    useToastStore.getState().toasts.filter((t) => t.definition === 'primer-recovery-failed');
  vi.mocked(getLatestPrimerRecoveryInventory).mockReturnValue(null);
  reportPrimerReconcileFailures('/projects/one', scan);
  const report = inventory(entries);
  vi.mocked(getLatestPrimerRecoveryInventory).mockReturnValue(report);
  reportPrimerRecoveryInventory(report);
  reportPrimerReconcileFailures('/projects/one', scan);
  expect(notices()).toHaveLength(1);
  expect(notices()[0].message).toContain('Forward');
  expect(notices()[0].message).toContain('Reverse');
  expect(notices()[0].message).toContain(message);
  reportPrimerRecoveryInventory(
    inventory(entries.map((e) => ({ ...e, status: 'document-backed' })))
  );
  expect(notices()).toHaveLength(0);
  vi.mocked(getLatestPrimerRecoveryInventory).mockReturnValue(null);
});
const orphan: PrimerRecoveryInventory['entries'][number] = {
  id: 'legacy-primer-1',
  name: 'Historical primer',
  source: 'legacy',
  workspaceId: null,
  projectUuid: null,
  status: 'needs-review',
  message: unresolved.message,
};
const inventory = (
  entries: PrimerRecoveryInventory['entries'],
  originalProject: PrimerRecoveryInventory['originalProject'] = unresolved
): PrimerRecoveryInventory => ({
  schema: 'dnaforge.primer-recovery-inventory/v1',
  recordedAt: 1,
  entries,
  originalProject,
});
const recoveryNotices = () =>
  useToastStore
    .getState()
    .toasts.filter((toast) => toast.definition === 'original-project-recovery-needed');

beforeEach(() => useToastStore.getState().clearToasts());

it.each([
  { entries: [] },
  { entries: [{ ...orphan, workspaceId: 1, projectUuid: 'assigned-project' }] },
  { entries: [{ ...orphan, status: 'trashed' as const }] },
])(
  'does not request original-project recovery without unassigned records needing review: %j',
  ({ entries }) => {
    reportPrimerRecoveryInventory(inventory(entries));
    expect(recoveryNotices()).toEqual([]);
  }
);

it('does not interrupt for unassigned records when recovery demand appears or disappears', () => {
  reportPrimerRecoveryInventory(inventory([orphan]));
  expect(recoveryNotices()).toEqual([]);
  reportPrimerRecoveryInventory({
    schema: 'dnaforge.primer-recovery-inventory/v1',
    recordedAt: 2,
    entries: [],
  });
  expect(recoveryNotices()).toEqual([]);
});

it('suppresses the ownership prompt for 375 primers, preserving unrelated failures', () => {
  const entries = Array.from({ length: 375 }, (_, index) => ({
    ...orphan,
    id: `primer-${index}`,
    name: index === 0 ? 'POP5_R' : `Primer ${index}`,
  }));
  reportPrimerRecoveryInventory(
    inventory([
      ...entries,
      { ...orphan, id: 'damaged', workspaceId: 2, message: 'A saved primer file is invalid.' },
    ])
  );
  expect(recoveryNotices()).toEqual([]);
  const failures = useToastStore
    .getState()
    .toasts.filter((toast) => toast.definition === 'primer-recovery-failed');
  expect(failures).toHaveLength(1);
  expect(failures[0].message).not.toContain('POP5_R');
  expect(failures[0].message).toContain('1 issue');
});

it('keeps one actionable notice for a failed restore and clears it when retry succeeds', async () => {
  const selection = {
    id: 'retry-target',
    root: '/project',
    relativePath: 'primer.json',
    sha256: 'a'.repeat(64),
  };
  const missing = {
    ...orphan,
    id: selection.id,
    workspaceId: 4,
    name: 'Retry target',
    restore: selection,
  };
  const current = () => useToastStore.getState().toasts;
  const report = inventory([missing]);
  restore.mockRejectedValueOnce(new Error('occupied')).mockResolvedValueOnce(undefined);
  vi.mocked(refreshPrimerRecoveryInventory)
    .mockResolvedValueOnce(report)
    .mockResolvedValueOnce(inventory([{ ...missing, status: 'document-backed' }]));
  reportPrimerRecoveryInventory(report);
  expect(current()).toHaveLength(1);
  useToastStore.getState().invokeToastAction(current()[0].id, 0);
  await vi.waitFor(() => {
    expect(current()).toHaveLength(1);
    expect(current()[0].message).toContain('could not be restored');
    expect(current()[0].actions?.[0].label).toBe('Restore saved copies');
  });
  useToastStore.getState().invokeToastAction(current()[0].id, 0);
  await vi.waitFor(() => expect(current()).toHaveLength(0));
  expect(restore).toHaveBeenCalledTimes(2);
});
