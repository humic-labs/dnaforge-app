// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  initialMigrationSessionSelection,
  reduceMigrationSessionSelection,
} from './migration-session-selection';

describe('Benchling migration session selection', () => {
  it('reopens the last observed durable run after an ordinary close', () => {
    const observed = reduceMigrationSessionSelection(initialMigrationSessionSelection, {
      type: 'run_observed',
      runId: 'run-1',
    });
    const closed = reduceMigrationSessionSelection(observed, { type: 'modal_closed' });

    expect(closed).toEqual({
      mode: 'existing',
      observedRunId: 'run-1',
      selectedRunId: 'run-1',
      initialView: 'summary',
    });
  });

  it('clears the remembered run when the workspace opens', () => {
    const current = {
      mode: 'existing' as const,
      observedRunId: 'run-1',
      selectedRunId: 'run-1',
      initialView: 'summary' as const,
    };

    expect(reduceMigrationSessionSelection(current, { type: 'workspace_opened' })).toEqual(
      initialMigrationSessionSelection
    );
  });

  it('pins an explicitly selected historical run', () => {
    expect(
      reduceMigrationSessionSelection(initialMigrationSessionSelection, {
        type: 'history_opened',
        runId: 'run-history',
      })
    ).toEqual({
      mode: 'existing',
      observedRunId: 'run-history',
      selectedRunId: 'run-history',
      initialView: 'summary',
    });
  });

  it('opens missing-dependency recovery only through its explicit history action', () => {
    expect(
      reduceMigrationSessionSelection(initialMigrationSessionSelection, {
        type: 'missing_dependencies_opened',
        runId: 'run-history',
      })
    ).toEqual({
      mode: 'existing',
      observedRunId: 'run-history',
      selectedRunId: 'run-history',
      initialView: 'missing_dependencies',
    });
  });

  it('does not carry a previously viewed run into an explicit new migration', () => {
    const previous = {
      mode: 'existing' as const,
      observedRunId: 'run-failed',
      selectedRunId: 'run-failed',
      initialView: 'summary' as const,
    };

    expect(reduceMigrationSessionSelection(previous, { type: 'new_migration_opened' })).toEqual({
      observedRunId: undefined,
      selectedRunId: undefined,
      mode: 'new',
      initialView: 'summary',
    });
  });
});
