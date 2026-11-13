// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  isWorkspaceSyncDatabaseBusyError,
  WORKSPACE_SYNC_DATABASE_BUSY_MESSAGE,
} from './workspace-sync-errors';

describe('workspace sync errors', () => {
  it('recognizes the canonical main-process error and Electron invoke wrapper', () => {
    expect(isWorkspaceSyncDatabaseBusyError(new Error(WORKSPACE_SYNC_DATABASE_BUSY_MESSAGE))).toBe(
      true
    );
    expect(
      isWorkspaceSyncDatabaseBusyError(
        `Error invoking remote method 'db:execute': Error: ${WORKSPACE_SYNC_DATABASE_BUSY_MESSAGE}`
      )
    ).toBe(true);
    expect(
      isWorkspaceSyncDatabaseBusyError(
        `binding: Error invoking remote method 'db:execute': Error: ${WORKSPACE_SYNC_DATABASE_BUSY_MESSAGE}`
      )
    ).toBe(true);
  });

  it('does not retry an ordinary failure whose path merely contains the busy code', () => {
    expect(
      isWorkspaceSyncDatabaseBusyError(
        "ENOENT: no such file or directory, open '/tmp/WORKSPACE_SYNC_DATABASE_BUSY/notebook/meta.json'"
      )
    ).toBe(false);
    expect(
      isWorkspaceSyncDatabaseBusyError(`${WORKSPACE_SYNC_DATABASE_BUSY_MESSAGE} unrelated failure`)
    ).toBe(false);
    expect(
      isWorkspaceSyncDatabaseBusyError(
        `Native workspace catalog reconstruction failed: Workspace manifest entity is missing its authoritative path: ${WORKSPACE_SYNC_DATABASE_BUSY_MESSAGE}`
      )
    ).toBe(false);
  });
});
