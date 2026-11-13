import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isLocalNativeFolderZipInventory,
  type LocalNativeFolderZipInventory,
  type MigrationRun,
  type ValidationReportV2,
} from '../../shared/benchling-migration';
import {
  BENCHLING_MIGRATION_TELEMETRY_COUNT_MAX,
  benchlingMigrationAttemptFinishedProperties,
  benchlingMigrationIssueSummaryProperties,
  createBenchlingMigrationAttemptIdentity,
  projectBenchlingMigrationTerminal,
} from './telemetry';

function run(): MigrationRun {
  return {
    version: 1,
    id: 'migration-private-customer-id',
    workspaceId: 'workspace-private-customer-id',
    workspacePath: '/Users/customer/Secret Notebook',
    displayName: 'Secret Notebook',
    scope: {
      version: 1,
      kind: 'folder',
      acquisition: 'local_bundle',
      folder: {
        id: 'fld_private',
        url: 'https://private.benchling.com/private/fld_private',
      },
      includeChildren: false,
    },
    binding: null,
    state: 'action_required',
    resumeState: 'validating',
    attempt: 1,
    converterVersions: { app: '1.0.0' },
    createdAt: '2026-09-02T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:06.000Z',
    startedAt: '2026-09-02T10:00:00.000Z',
    unlockedAt: null,
    lastError: {
      code: 'validation_failed',
      message: 'Secret sequence ACTG at /Users/customer/Secret Notebook failed.',
      blocking: true,
      sourceObjectId: 'seq_private',
      details: { providerBody: 'private body' },
    },
  };
}

function report(): ValidationReportV2 {
  const section = { expected: 2, actual: 2, passed: false, issues: [] };
  return {
    version: 2,
    runId: 'migration-private-customer-id',
    scope: run().scope,
    snapshotId: 'snapshot-private',
    accountHash: 'sha256:private',
    generatedAt: '2026-09-02T10:00:06.000Z',
    passed: false,
    sourceObjects: section,
    attachments: { ...section, expected: 3, actual: 3 },
    memberships: section,
    relationships: {
      ...section,
      countsByClass: {
        exact: 4,
        heuristic: 1,
        unresolved: 2,
        external: 1,
        ambiguous: 3,
        source_broken: 1,
      },
    },
    projections: {
      ...section,
      actual: 1,
      native: 1,
      nativeRepresentations: { dnaSequence: 1, strain: 0, needsSequence: 0 },
      artifact: 0,
      exceptions: 1,
    },
    hashes: section,
    rendering: section,
    issues: [
      {
        code: 'validation_failed',
        message: 'Private object name',
        blocking: true,
      },
      {
        code: 'local_export_warning',
        message: 'Private filename',
        blocking: false,
      },
    ],
    exportJobs: {
      ...section,
      planned: 0,
      captured: 0,
      failedWithSuccessfulReplacement: 0,
      jobs: [],
    },
    snapshotParts: {
      ...section,
      exportArchives: 0,
      targetedReads: 0,
      superseded: 0,
      parts: [],
    },
    formulas: { ...section, supported: 5, unsupported: 2, stale: 1, evidence: [] },
    nativeConversionExceptions: { ...section, actual: 1, evidence: [] },
    collections: {
      ...section,
      expectedMemberships: 0,
      actualMemberships: 0,
      selectedRootSourceIds: [],
      evidence: [],
    },
  } as ValidationReportV2;
}

describe('Benchling operational telemetry projector', () => {
  it('projects bounded aggregate facts and excludes every content-bearing source field', () => {
    const identity = createBenchlingMigrationAttemptIdentity({
      runId: run().id,
      sourceAttemptReference: 'initial_import:1',
      attemptSequence: 1,
      operation: 'initial_import',
      startedAt: '2026-09-02T10:00:00.000Z',
    });
    const receipt = projectBenchlingMigrationTerminal({
      identity,
      run: run(),
      outcome: 'needs_action',
      terminalStage: 'validation',
      terminalAt: '2026-09-02T10:00:06.000Z',
      report: report(),
    });
    const terminal = benchlingMigrationAttemptFinishedProperties(receipt);
    const issueEvents = benchlingMigrationIssueSummaryProperties(receipt);

    expect(terminal).toMatchObject({
      operation: 'initial_import',
      outcome: 'needs_action',
      usable_result: true,
      terminal_stage: 'validation',
      imported_object_count: 1,
      resolved_relationship_count: 5,
      unresolved_relationship_count: 3,
      ambiguous_relationship_count: 3,
      broken_relationship_count: 1,
      primary_issue_code: 'validation_failed',
    });
    expect(issueEvents.map(({ issue_code, count }) => ({ issue_code, count }))).toEqual([
      { issue_code: 'validation_failed', count: 1 },
      { issue_code: 'local_export_warning', count: 1 },
    ]);
    expect(new Set(issueEvents.map((event) => event.$insert_id)).size).toBe(2);
    expect(issueEvents.every((event) => event.attempt_correlation_id === identity.attemptId)).toBe(
      true
    );
    const egress = JSON.stringify({ receipt, terminal, issueEvents });
    for (const forbidden of [
      'Secret Notebook',
      '/Users/customer',
      'private.benchling.com',
      'fld_private',
      'seq_private',
      'ACTG',
      'providerBody',
      'sha256:private',
      'migration-private-customer-id',
    ]) {
      expect(egress).not.toContain(forbidden);
    }
  });

  it('uses an explicit overflow sentinel and count_overflow instead of a silent clamp', () => {
    const source = run();
    const selectedTotal = BENCHLING_MIGRATION_TELEMETRY_COUNT_MAX + 50;
    const inventory: LocalNativeFolderZipInventory = {
      schema: 'dnaforge.benchling.local-native-folder-zip-inventory.v1',
      catalog: {
        physicalEntryCount: selectedTotal,
        uniqueEntryCount: selectedTotal,
      },
      canonicalObjects: {
        archiveTotal: selectedTotal,
        archiveByClass: { notebook: 1, dna_rna: selectedTotal - 1, protein: 0 },
        selectedTotal,
        selectedByClass: { notebook: 1, dna_rna: selectedTotal - 1, protein: 0 },
        importedTotal: 1,
        importedByClass: { notebook: 1, dna_rna: 0, protein: 0 },
        excludedByScopeTotal: 0,
        archiveMembershipTotal: selectedTotal,
        selectedMembershipTotal: selectedTotal,
        importedMembershipTotal: 1,
        skipped: Array.from(
          { length: selectedTotal - 1 },
          (_, index): LocalNativeFolderZipInventory['canonicalObjects']['skipped'][number] => ({
            sourceObjectId: `seq_overflow${index}`,
            canonicalClass: 'dna_rna',
            reasonCode: 'unsupported_content',
            reason: 'Canonical content is unsupported.',
          })
        ),
      },
      selectedAttachments: {
        total: 0,
        uniqueOwnerContentTotal: 0,
        byClass: { png: 0, jpg: 0, pdf: 0, ab1: 0, gbk: 0, seq: 0, other: 0 },
      },
      archiveRepresentations: {
        alternateTotal: 0,
        alternateByClass: {
          sequence_txt: 0,
          sequence_html: 0,
          protein_txt: 0,
          protein_gp: 0,
          protein_html: 0,
        },
        supportTotal: 0,
        supportByClass: { benchling_css: 0 },
        collapsedIdenticalSupportDuplicateCount: 0,
      },
      folders: {
        inferredCount: 1,
        explicitDirectoryEntryCount: 0,
        emptyFoldersNotPreservableBecauseArchiveOmitsDirectoryEntries: true,
      },
      rootBinding: {
        archiveDisplayRoot: 'Overflow fixture',
        selectedStableFolderId: 'fld_overflow',
        selectedStableFolderIdSource: 'pasted_projects_route_or_user_selection',
        archiveContainsSelectedStableFolderId: false,
        associationVerification: 'user_asserted_not_archive_verified',
      },
    };
    expect(isLocalNativeFolderZipInventory(inventory)).toBe(true);
    const receipt = projectBenchlingMigrationTerminal({
      identity: createBenchlingMigrationAttemptIdentity({
        runId: source.id,
        sourceAttemptReference: 'initial_import:1',
        attemptSequence: 1,
        operation: 'initial_import',
        startedAt: source.createdAt,
        uuid: randomUUID,
      }),
      run: source,
      outcome: 'needs_action',
      terminalStage: 'validation',
      terminalAt: source.updatedAt,
      report: report(),
      inventory,
    });
    expect(receipt.countOverflow).toBe(true);
    expect(receipt.counts.sourceObject).toBe(BENCHLING_MIGRATION_TELEMETRY_COUNT_MAX + 1);
  });
});
