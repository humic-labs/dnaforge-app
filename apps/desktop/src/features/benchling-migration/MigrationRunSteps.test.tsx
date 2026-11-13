import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BenchlingMigrationRunView } from '../../shared/benchling-migration-ipc';
import { ProgressStep } from './MigrationRunSteps';

describe('the single import screen', () => {
  it('keeps one layout across preparation, installation and final checks', () => {
    const { rerender } = render(<ProgressStep />);
    const panel = screen.getByTestId('benchling-migration-progress');
    expect(screen.getByText('Preparing your import')).toBeVisible();
    for (const [state, label] of [
      ['parsing', 'Preparing your import'],
      ['offline_resolution', 'Preparing your import'],
      ['projecting', 'Importing your items'],
      ['validating', 'Finishing up'],
      ['ready_to_unlock', 'Finishing up'],
    ] as const) {
      rerender(<ProgressStep run={{ state, localBundleState: 'ready' }} />);
      expect(screen.getByTestId('benchling-migration-progress')).toBe(panel);
      expect(screen.getByText(label)).toBeVisible();
      expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
      expect(panel).not.toHaveTextContent(/Step \d|native|projecting|validating/i);
    }
  });

  it('only shows a measured item count during actual destination writes', () => {
    const recovery: NonNullable<BenchlingMigrationRunView['linkedItemRecovery']> = {
      schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
      attemptId: 'append-1',
      mode: 'workspace_append',
      state: 'parsing',
      selectedFileCount: 1,
      processedFileCount: 1,
      recoveredUniqueObjectCount: 0,
      repairedRelationshipCount: 0,
      retainedExistingObjectCount: 0,
      retainedExistingObjects: [],
      corroboratedExistingObjectCount: 0,
      updatedAt: '2026-08-30T00:00:00Z',
      work: { kind: 'write_objects', completed: 12, total: 663 },
    };
    const { rerender } = render(<ProgressStep recovery={recovery} />);
    expect(screen.getByText('Preparing your import')).toBeVisible();
    expect(screen.queryByText('12 of 663 items')).not.toBeInTheDocument();
    rerender(<ProgressStep recovery={{ ...recovery, state: 'reconciling' }} />);
    expect(screen.getByText('Importing your items')).toBeVisible();
    expect(screen.getByText('12 of 663 items')).toBeVisible();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '12');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '663');
    rerender(
      <ProgressStep
        recovery={{
          ...recovery,
          state: 'validating',
          work: { kind: 'validate_saved_objects', completed: 12, total: 663 },
        }}
      />
    );
    expect(screen.getByText('Finishing up')).toBeVisible();
    expect(screen.queryByText('12 of 663 items')).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  });
});
