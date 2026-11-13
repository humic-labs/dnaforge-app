// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  parseBenchlingMigrationImportLocalBundleRequest,
  parseBenchlingMigrationResolveImportDecisionRequest,
  parseBenchlingMigrationAppendWorkspaceExportsRequest,
  parseBenchlingMigrationAddLinkedItemExportsRequest,
} from './benchling-migration-ipc';

describe('Benchling migration local-bundle IPC contract', () => {
  it('accepts only an opaque failed run ID for a file-skipping retry', () => {
    expect(
      parseBenchlingMigrationImportLocalBundleRequest({ retryFailedRunId: 'migration-run_1' })
    ).toEqual({ retryFailedRunId: 'migration-run_1' });
    expect(() =>
      parseBenchlingMigrationImportLocalBundleRequest({
        retryFailedRunId: 'migration-run_1',
        sourcePath: '/tmp/other.zip',
      })
    ).toThrow(/cannot be combined/u);
    expect(() =>
      parseBenchlingMigrationImportLocalBundleRequest({ retryFailedRunId: '../other' })
    ).toThrow(/opaque ID/u);
  });
  const mapping = {
    kind: 'registry_table_mapping',
    version: 1,
    source: {
      archiveSha256: 'a'.repeat(64),
      entrySha256: 'b'.repeat(64),
      entryPath: 'Records.csv',
      entrySizeBytes: 42,
    },
    outcome: { kind: 'source_only', reason: 'Keep original table' },
  };
  it('accepts reviewed table choices only on the initial export requests', () => {
    const request = { sourcePath: '/tmp/reviewed.zip', reviewedTables: [mapping] };
    expect(parseBenchlingMigrationImportLocalBundleRequest(request)).toEqual(request);
    for (const parse of [
      parseBenchlingMigrationAppendWorkspaceExportsRequest,
      parseBenchlingMigrationAddLinkedItemExportsRequest,
    ]) {
      const append = {
        runId: 'run-1',
        sourcePaths: ['/tmp/reviewed.zip'],
        reviewedTables: [mapping],
      };
      expect(parse(append)).toEqual(append);
    }
    expect(() =>
      parseBenchlingMigrationResolveImportDecisionRequest({
        runId: 'run-1',
        attemptId: 'attempt-1',
        decision: mapping,
      })
    ).toThrow(/decision/i);
  });
  it('rejects duplicate or oversized reviewed-table decision lists at the IPC boundary', () => {
    for (const reviewedTables of [
      [mapping, mapping],
      Array.from({ length: 6401 }, () => mapping),
      { mapping },
    ]) {
      expect(() =>
        parseBenchlingMigrationImportLocalBundleRequest({
          sourcePath: '/tmp/reviewed.zip',
          reviewedTables,
        })
      ).toThrow(/reviewedTables/i);
    }
  });
  it('accepts and normalizes a workspace name for a new import', () => {
    expect(
      parseBenchlingMigrationImportLocalBundleRequest({
        sourcePath: '/Users/test/Downloads/export.zip',
        workspaceName: '  Sundew   localization  ',
      })
    ).toEqual({
      sourcePath: '/Users/test/Downloads/export.zip',
      workspaceName: 'Sundew localization',
    });
  });

  it('accepts only a positive integer existing-workspace identity', () => {
    expect(
      parseBenchlingMigrationImportLocalBundleRequest({
        sourcePath: '/Users/test/Downloads/export.zip',
        workspaceDbId: 28,
      })
    ).toEqual({
      sourcePath: '/Users/test/Downloads/export.zip',
      workspaceDbId: 28,
    });
    for (const workspaceDbId of [0, -1, 1.5, '28']) {
      expect(() => parseBenchlingMigrationImportLocalBundleRequest({ workspaceDbId })).toThrow(
        'workspaceDbId'
      );
    }
  });

  it.each(['', '   ', 'a'.repeat(121), 'Lab/Project', 'Lab\\Project', 'Lab\u0000Project'])(
    'rejects an invalid workspace name: %j',
    (workspaceName) => {
      expect(() =>
        parseBenchlingMigrationImportLocalBundleRequest({
          sourcePath: '/Users/test/Downloads/export.zip',
          workspaceName,
        })
      ).toThrow('workspaceName');
    }
  );

  it('rejects a workspace name when replacing an existing run export', () => {
    expect(() =>
      parseBenchlingMigrationImportLocalBundleRequest({
        runId: 'run-1',
        sourcePath: '/Users/test/Downloads/export.zip',
        workspaceName: 'Wrong target',
      })
    ).toThrow('workspaceName');
  });

  it('accepts only an exact import-wide version choice', () => {
    expect(
      parseBenchlingMigrationResolveImportDecisionRequest({
        runId: 'run-1',
        attemptId: 'attempt-1',
        decision: { kind: 'provider_version_conflict', policy: 'use_incoming' },
      })
    ).toEqual({
      runId: 'run-1',
      attemptId: 'attempt-1',
      decision: { kind: 'provider_version_conflict', policy: 'use_incoming' },
    });
    expect(() =>
      parseBenchlingMigrationResolveImportDecisionRequest({
        runId: 'run-1',
        attemptId: 'attempt-1',
        decision: { kind: 'provider_version_conflict', policy: 'merge' },
      })
    ).toThrow('decision');
  });
});
