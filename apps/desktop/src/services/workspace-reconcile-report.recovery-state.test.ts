import { beforeEach, expect, it, vi } from 'vitest';
import { reportPrimerRecoveryInventory } from './workspace-reconcile-report';
import { useToastStore } from '../stores/toast-store';
import type { PrimerRecoveryInventory } from '../features/primers/public/primer-recovery-report';

vi.mock('../features/primers/public/primer-recovery-report', () => ({
  getLatestPrimerRecoveryInventory: () => null,
}));

const unresolved = {
  status: 'unresolved' as const,
  reason: 'identity-not-recorded' as const,
  message: 'The original My Project has not been identified.',
};
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
