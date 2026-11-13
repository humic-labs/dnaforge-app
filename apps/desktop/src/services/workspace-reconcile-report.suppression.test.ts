import { expect, it, vi } from 'vitest';
import { reportPrimerRecoveryInventory } from './workspace-reconcile-report';
import { useToastStore } from '../stores/toast-store';
import type { PrimerRecoveryInventory } from '../features/primers/public/primer-recovery-report';

vi.mock('../features/primers/public/primer-recovery-report', () => ({
  getLatestPrimerRecoveryInventory: () => null,
}));

it('keeps 375 unassigned primers available without recurring ownership toasts', () => {
  const originalProject = {
    status: 'unresolved' as const,
    reason: 'identity-not-recorded' as const,
    message: 'The original My Project has not been identified.',
  };
  const report: PrimerRecoveryInventory = {
    schema: 'dnaforge.primer-recovery-inventory/v1',
    recordedAt: 1,
    originalProject,
    entries: Array.from({ length: 375 }, (_, index) => ({
      id: `unassigned-${index}`,
      name: `Primer ${index}`,
      source: 'legacy' as const,
      workspaceId: null,
      projectUuid: null,
      status: 'needs-review' as const,
      message: originalProject.message,
    })),
  };
  const before = structuredClone(report);
  useToastStore.getState().clearToasts();
  useToastStore.getState().addRichToast({ definition: 'original-project-recovery-needed' });
  reportPrimerRecoveryInventory(report);
  reportPrimerRecoveryInventory(report);
  expect(useToastStore.getState().toasts).toEqual([]);
  expect(report).toEqual(before);
});
