import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  BenchlingMigrationReportView,
  BenchlingMigrationRunView,
} from '../../shared/benchling-migration-ipc';
import type { ValidationLinkedItemRecoveryEvidence } from '../../shared/benchling-migration';
import { ValidationStep } from './MigrationValidationStep';

describe('MigrationValidationStep', () => {
  it.each(['verified', 'stale-action', 'failed-source'] as const)(
    'checks the new workspace external ZIP receipt before unlock: %s',
    (evidence) => {
      const run: BenchlingMigrationRunView = {
        ...runView(),
        workspaceOrigin: 'migration_created',
        scope: { ...runView().scope, acquisition: 'local_bundle' },
        state: 'ready_to_unlock',
        sourceArtifact: undefined,
      };
      const report = reportView();
      if (report.version !== 2) throw new Error('Expected v2 fixture.');
      report.scope = run.scope;
      report.nativeImport = {
        actionId: evidence === 'stale-action' ? 'old-action' : run.id,
        history: 'new_workspace',
        providerVersions: null,
        exactNativeMatches: [],
        structuralDecisions: [],
        externalSources: [
          {
            sourceId: 'external-source',
            state: evidence === 'failed-source' ? 'verification_failed' : 'verified_at_import',
            checkedAt: '2026-08-29T12:00:00.000Z',
          },
        ],
      };
      render(
        <ValidationStep
          run={run}
          report={report}
          pending={false}
          onUnlock={() => undefined}
          onOpenWorkspace={() => undefined}
        />
      );
      const button = screen.getByTestId('benchling-migration-unlock');
      if (evidence === 'verified') {
        expect(screen.queryByText('ZIP verification failed')).not.toBeInTheDocument();
        expect(screen.getByTestId('benchling-migration-import-complete')).toBeVisible();
        expect(button).toBeEnabled();
      } else {
        expect(button).toBeDisabled();
      }
    }
  );

  it.each(
    (['adopted_existing', 'migration_created'] as const).flatMap((origin) =>
      (
        [
          'verified',
          'stale-action',
          'wrong-run',
          'failed-source',
          'missing-sources',
          'stale-original',
          'incomplete',
        ] as const
      ).map((evidence) => ({ origin, evidence }))
    )
  )('checks the current native append receipt: $origin / $evidence', ({ origin, evidence }) => {
    const run: BenchlingMigrationRunView = {
      ...runView(),
      workspaceOrigin: origin,
      scope: { ...runView().scope, acquisition: 'local_bundle' },
      state: 'unlocked',
      linkedItemRecovery: {
        schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
        mode: 'workspace_append',
        attemptId: 'native-action',
        state: evidence === 'incomplete' ? 'validating' : 'completed',
        selectedFileCount: 1,
        processedFileCount: 1,
        recoveredUniqueObjectCount: 1,
        repairedRelationshipCount: 0,
        retainedExistingObjectCount: 0,
        retainedExistingObjects: [],
        corroboratedExistingObjectCount: 0,
        updatedAt: '2026-08-29T12:00:00.000Z',
      },
    };
    const report = reportView();
    if (report.version !== 2) throw new Error('Expected v2 fixture.');
    report.scope = run.scope;
    if (evidence === 'wrong-run') report.runId = 'different-run';
    report.nativeImport = {
      actionId:
        evidence === 'stale-original'
          ? run.id
          : evidence === 'stale-action'
            ? 'old-action'
            : 'native-action',
      history:
        evidence === 'stale-original'
          ? 'new_workspace'
          : origin === 'adopted_existing'
            ? 'adopted_history_created'
            : 'existing_history',
      providerVersions: null,
      exactNativeMatches: [],
      structuralDecisions: [],
      externalSources:
        evidence === 'missing-sources'
          ? []
          : [
              {
                sourceId: 'external-source',
                state: evidence === 'failed-source' ? 'verification_failed' : 'verified_at_import',
                checkedAt: '2026-08-29T12:00:00.000Z',
              },
            ],
    };
    render(
      <ValidationStep
        run={run}
        report={report}
        pending={false}
        onUnlock={() => undefined}
        onOpenWorkspace={() => undefined}
      />
    );
    if (evidence === 'verified') {
      expect(screen.queryByText('ZIP verification failed')).not.toBeInTheDocument();
      expect(screen.getByTestId('benchling-migration-open-workspace')).toBeEnabled();
    } else {
      expect(screen.getByText('ZIP verification failed')).toBeVisible();
      expect(screen.getByTestId('benchling-migration-open-workspace')).toBeDisabled();
    }
  });

  it('does not call a conversion failure a ZIP verification failure', () => {
    const run: BenchlingMigrationRunView = {
      ...runView(),
      workspaceOrigin: 'migration_created',
      scope: { ...runView().scope, acquisition: 'local_bundle' },
      state: 'action_required',
      sourceArtifact: undefined,
    };
    const report = reportView();
    if (report.version !== 2) throw new Error('Expected v2 fixture.');
    report.scope = run.scope;
    report.passed = false;
    report.issues = [
      {
        code: 'validation_failed',
        message: 'Product routing selected page, not text.',
        blocking: true,
        sourceObjectId: 'etr_DEMOET01',
      },
    ];
    report.rendering = {
      expected: 45,
      actual: 44,
      passed: false,
      issues: report.issues,
    };
    report.nativeImport = {
      actionId: run.id,
      history: 'new_workspace',
      providerVersions: null,
      exactNativeMatches: [],
      structuralDecisions: [],
      externalSources: [
        {
          sourceId: 'external-zip-601a701a13f96008909d99ec',
          state: 'verified_at_import',
          checkedAt: '2026-09-12T02:31:22.593Z',
        },
      ],
    };

    render(<ValidationStep run={run} report={report} pending={false} onUnlock={() => undefined} />);

    expect(screen.getByText('Some of your notebook did not come across')).toBeInTheDocument();
    expect(screen.queryByText('ZIP verification failed')).not.toBeInTheDocument();
  });

  it('distinguishes reviewed import decisions from provider version outcomes', () => {
    const report = reportView();
    if (report.version !== 2) throw new Error('Expected report v2.');
    report.nativeImport = {
      actionId: 'test-action',
      destinationChanges: { added: 0, updated: 0, retained: 2 },
      history: 'adopted_history_created',
      providerVersions: null,
      exactNativeMatches: [
        { sourceObjectId: 'seq_A', candidateEntityId: 'ws1::local', choice: 'link_existing' },
        { sourceObjectId: 'seq_B', candidateEntityId: 'ws1::other', choice: 'import_separate' },
      ],
      structuralDecisions: [
        { relativePath: 'Yeast', choice: 'rename_incoming' },
        { relativePath: 'Other', choice: 'replace_existing' },
      ],
      externalSources: [
        {
          sourceId: 'external-source',
          state: 'verified_at_import',
          checkedAt: '2026-08-29T12:00:00.000Z',
        },
      ],
    };
    render(
      <ValidationStep run={runView()} report={report} pending={false} onUnlock={() => undefined} />
    );
    const details = screen.getByTestId('benchling-native-import-decisions');
    expect(details).toHaveTextContent('Migration history was added to this existing project.');
    expect(details).toHaveTextContent('1 existing item linked');
    expect(details).toHaveTextContent('1 exact match imported as separate copies');
    expect(details).toHaveTextContent('1 incoming path renamed');
    expect(details).toHaveTextContent('1 conflicting path replaced');
    expect(details).not.toHaveTextContent('Original ZIP verified for this import');
    expect(details).not.toHaveTextContent('Source preview requires the unchanged ZIP');
    expect(screen.queryByTestId('import-receipt-added')).not.toBeInTheDocument();
    expect(screen.getByTestId('import-receipt-reused')).toHaveTextContent('2');
  });

  it('keeps internal provider and converter evidence out of the final screen', () => {
    render(
      <ValidationStep
        run={runView()}
        report={reportView()}
        pending={false}
        onUnlock={() => undefined}
      />
    );

    expect(screen.queryByText('Source and capture evidence')).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-provider-activity')).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-version-provenance')).not.toBeInTheDocument();
  });

  it('removes provider accounting warnings from the final screen and keeps unlock available', () => {
    const report = reportView();
    if (report.version !== 2 || !report.providerActivity) {
      throw new Error('Expected v2 provider activity fixture.');
    }
    const boundedWarning = {
      code: 'validation_failed' as const,
      blocking: false,
      message:
        'Read-only provider activity is bounded to 0–1 network requests; the exact count is unavailable.',
    };
    report.providerActivity = {
      ...report.providerActivity,
      coverageGaps: 2,
      countsAreExact: false,
      countsAreBounded: true,
      networkRequestUpperBound: 6,
      cacheHitUpperBound: 6,
      issues: [boundedWarning],
    };
    report.issues = [boundedWarning];

    render(
      <ValidationStep run={runView()} report={report} pending={false} onUnlock={() => undefined} />
    );

    expect(screen.queryByTestId('benchling-migration-provider-activity')).not.toBeInTheDocument();
    expect(screen.queryByText(boundedWarning.message)).not.toBeInTheDocument();
    expect(screen.getByTestId('benchling-migration-unlock')).toBeEnabled();
  });

  it('keeps earlier non-exact provider accounting hidden', () => {
    const report = reportView();
    if (report.version !== 2 || !report.providerActivity) {
      throw new Error('Expected v2 provider activity fixture.');
    }
    report.providerActivity = {
      ...report.providerActivity,
      coverageGaps: 1,
      countsAreExact: false,
    };

    render(
      <ValidationStep run={runView()} report={report} pending={false} onUnlock={() => undefined} />
    );

    expect(screen.queryByTestId('benchling-migration-provider-activity')).not.toBeInTheDocument();
  });

  it('keeps live Direct Folder capture attestation out of the final screen', () => {
    render(
      <ValidationStep
        run={directFolderRunView()}
        report={directFolderReportView()}
        pending={false}
        onUnlock={() => undefined}
      />
    );

    expect(
      screen.queryByTestId('benchling-migration-direct-folder-attestation')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('benchling-migration-direct-folder-import-scope')
    ).not.toBeInTheDocument();
  });

  it('keeps incomplete live Direct Folder attestation out of the final screen', () => {
    const report = directFolderReportView();
    if (report.version !== 2 || !report.directFolderCapture) {
      throw new Error('Expected Direct Folder validation fixture.');
    }
    report.passed = false;
    report.directFolderCapture = {
      expected: 1,
      actual: 0,
      passed: false,
      issues: [],
      evidence: null,
    };
    render(
      <ValidationStep
        run={directFolderRunView()}
        report={report}
        pending={false}
        onUnlock={() => undefined}
      />
    );

    expect(
      screen.queryByTestId('benchling-migration-direct-folder-attestation')
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('benchling-migration-unlock')).toBeDisabled();
  });

  it('shows a compact local ZIP completion state instead of technical inventory', () => {
    render(
      <ValidationStep
        run={localFolderRunView()}
        report={localFolderReportView()}
        pending={false}
        onUnlock={() => undefined}
      />
    );

    expect(screen.queryByText('Source and capture evidence')).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-provider-activity')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('benchling-migration-local-export-verification')
    ).not.toBeInTheDocument();
    expect(screen.queryByText('SHA-256')).not.toBeInTheDocument();
    expect(screen.queryByText('Network')).not.toBeInTheDocument();
    expect(screen.getByText('Import complete')).toBeVisible();
    expect(screen.getByText('2 entities in this export were checked.')).toBeVisible();
    expect(screen.queryByTestId('benchling-migration-native-outcomes')).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-history-overview')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open project' })).toBeEnabled();
    expect(
      screen.queryByTestId('benchling-migration-native-folder-zip-inventory')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('benchling-migration-direct-folder-attestation')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('benchling-migration-direct-folder-import-scope')
    ).not.toBeInTheDocument();
  });

  it('names the preserved file in one concise partial-import receipt', () => {
    const run = localFolderRunView();
    const report = localFolderReportView();
    if (report.version !== 2) throw new Error('Expected v2 report.');
    report.nativeImport = {
      actionId: run.id,
      destinationChanges: { added: 2, updated: 0, retained: 0 },
      fileOutcomes: {
        preserved: [
          {
            fileName: 'Bad sequence (seq_BADSEQ12).gb',
            reason: 'Could not become an editable record.',
          },
        ],
        failed: [],
      },
      history: 'new_workspace',
      providerVersions: null,
      exactNativeMatches: [],
      structuralDecisions: [],
      externalSources: [
        { sourceId: 'zip-1', state: 'verified_at_import', checkedAt: report.generatedAt },
      ],
    };

    render(<ValidationStep run={run} report={report} pending={false} onUnlock={() => undefined} />);

    expect(screen.getByText('Imported with warnings')).toBeVisible();
    expect(screen.getByTestId('benchling-migration-import-summary')).toHaveTextContent(
      '2 imported · 1 kept as files · 0 failed'
    );
    expect(screen.getByTestId('benchling-migration-import-warnings')).toHaveTextContent(
      'Bad sequence (seq_BADSEQ12).gb: Could not become an editable record.'
    );
    expect(screen.queryByTestId('benchling-migration-native-exceptions')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open project' })).toBeEnabled();
  });

  it('shows an explicit Direct Folder dependency mismatch and keeps unlock disabled', () => {
    const report = localFolderReportView();
    if (report.version !== 2 || !report.directFolderImportScope?.evidence) {
      throw new Error('Expected Direct Folder import-scope fixture.');
    }
    report.passed = false;
    report.directFolderImportScope = {
      ...report.directFolderImportScope,
      actual: 0,
      passed: false,
      evidence: {
        ...report.directFolderImportScope.evidence,
        importedOneHopDependencySourceObjectIds: [],
      },
    };

    render(
      <ValidationStep
        run={localFolderRunView()}
        report={report}
        pending={false}
        onUnlock={() => undefined}
      />
    );

    const importScope = within(
      screen.getByTestId('benchling-migration-direct-folder-import-scope')
    );
    expect(
      importScope.getByText('The imported items did not match the expected folder')
    ).toBeInTheDocument();
    expect(importScope.getByText('Linked items in the ZIP').nextElementSibling).toHaveTextContent(
      '1'
    );
    expect(importScope.getByText('Linked items imported').nextElementSibling).toHaveTextContent(
      '0'
    );
    expect(screen.getByTestId('benchling-migration-unlock')).toBeDisabled();
  });

  it('keeps live Folder Tree capture attestation out of the final screen', () => {
    render(
      <ValidationStep
        run={folderTreeRunView()}
        report={folderTreeReportView()}
        pending={false}
        onUnlock={() => undefined}
      />
    );

    expect(
      screen.queryByTestId('benchling-migration-folder-tree-attestation')
    ).not.toBeInTheDocument();
  });

  it('keeps incomplete live Folder Tree attestation out of the final screen', () => {
    const report = folderTreeReportView();
    if (report.version !== 2 || !report.folderTreeCapture) {
      throw new Error('Expected Folder Tree validation fixture.');
    }
    report.passed = false;
    report.folderTreeCapture = {
      expected: 2,
      actual: 0,
      passed: false,
      issues: [],
      evidence: null,
    };
    render(
      <ValidationStep
        run={folderTreeRunView()}
        report={report}
        pending={false}
        onUnlock={() => undefined}
      />
    );

    expect(
      screen.queryByTestId('benchling-migration-folder-tree-attestation')
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('benchling-migration-unlock')).toBeDisabled();
  });

  it('keeps a verified local Folder Tree ZIP equally compact', () => {
    const run = localFolderRunView();
    run.scope = { ...folderTreeScope, acquisition: 'local_bundle' };
    const report = localFolderReportView();
    report.scope = run.scope;

    render(<ValidationStep run={run} report={report} pending={false} onUnlock={() => undefined} />);

    expect(screen.getByText('Import complete')).toBeVisible();
    expect(screen.getByText('2 entities in this export were checked.')).toBeVisible();
    expect(
      screen.queryByTestId('benchling-migration-native-folder-zip-inventory')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('benchling-migration-folder-tree-attestation')
    ).not.toBeInTheDocument();
  });

  it('fails closed when a local ZIP report does not match the selected archive', () => {
    const report = localFolderReportView();
    if (report.version !== 2 || !report.localExport) {
      throw new Error('Expected local export validation fixture.');
    }
    report.localExport.evidence.sha256 = `sha256:${'0'.repeat(64)}`;

    render(
      <ValidationStep
        run={localFolderRunView()}
        report={report}
        pending={false}
        onUnlock={() => undefined}
      />
    );

    expect(screen.getByText('ZIP verification failed')).toBeInTheDocument();
    expect(screen.getByTestId('benchling-migration-unlock')).toBeDisabled();
  });

  it('explains a verification failure for a single-file local export', () => {
    const baseRun = runView();
    const run: BenchlingMigrationRunView = {
      ...baseRun,
      scope: { ...baseRun.scope, acquisition: 'local_bundle' },
      sourceArtifact: localArtifact,
      localBundleState: 'ready',
    };
    const report = localFolderReportView();
    report.scope = run.scope;
    if (report.version !== 2 || !report.localExport) {
      throw new Error('Expected local export validation fixture.');
    }
    report.localExport.evidence.sha256 = `sha256:${'0'.repeat(64)}`;

    render(<ValidationStep run={run} report={report} pending={false} onUnlock={() => undefined} />);

    expect(screen.getByText('ZIP verification failed')).toBeInTheDocument();
    expect(screen.getByTestId('benchling-migration-unlock')).toBeDisabled();
  });

  it('fails closed when a local Folder report has lost its selected archive identity', () => {
    const run = localFolderRunView();
    run.sourceArtifact = undefined;

    render(
      <ValidationStep
        run={run}
        report={localFolderReportView()}
        pending={false}
        onUnlock={() => undefined}
      />
    );

    expect(screen.getByText('ZIP verification failed')).toBeInTheDocument();
    expect(
      screen.queryByTestId('benchling-migration-direct-folder-attestation')
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('benchling-migration-unlock')).toBeDisabled();
  });

  it('keeps an older Folder Tree report readable without internal attestation detail', () => {
    const report = reportView();
    report.scope = folderTreeScope;

    render(
      <ValidationStep
        run={folderTreeRunView()}
        report={report}
        pending={false}
        onUnlock={() => undefined}
      />
    );

    expect(
      screen.queryByTestId('benchling-migration-folder-tree-attestation')
    ).not.toBeInTheDocument();
  });

  it('keeps offline relationship placeholders out of the completion summary', () => {
    const report = localFolderReportView();
    report.issues = Array.from({ length: 41 }, (_, index) => ({
      code: 'required_target_missing' as const,
      blocking: false,
      message: `Relationship rel_${index} is retained as an offline placeholder.`,
      relationshipId: `rel_${index}`,
    }));

    render(
      <ValidationStep
        run={localFolderRunView()}
        report={report}
        pending={false}
        onUnlock={() => undefined}
      />
    );

    expect(
      screen.queryByTestId('benchling-migration-missing-linked-items')
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/41 linked items/)).not.toBeInTheDocument();
    expect(screen.queryByText(/offline placeholders/)).not.toBeInTheDocument();
    expect(screen.queryByText(/rel_0/)).not.toBeInTheDocument();
    expect(screen.queryByText(/rel_1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/rel_2/)).not.toBeInTheDocument();
    expect(screen.queryByText(/rel_40/)).not.toBeInTheDocument();
  });

  it('does not show raw object IDs for skipped objects or native conversion exceptions', () => {
    const report = localFolderReportView();
    if (report.version !== 2 || !report.localExport?.evidence.nativeFolderZipInventory) {
      throw new Error('Expected local ZIP inventory fixture.');
    }
    report.localExport.evidence.nativeFolderZipInventory.canonicalObjects.skipped = [
      { sourceObjectId: 'seq_PRIVATE1', reason: 'The canonical file was incomplete.' },
      { sourceObjectId: 'seq_PRIVATE2', reason: 'The canonical file was incomplete.' },
    ];
    report.issues = [
      {
        code: 'projection_failed',
        blocking: false,
        sourceObjectId: 'etr_PRIVATE1',
        message: 'Native conversion exception: Preserved the source artifact.',
      },
    ];

    render(
      <ValidationStep
        run={localFolderRunView()}
        report={report}
        pending={false}
        onUnlock={() => undefined}
      />
    );

    expect(screen.getByText('Imported with warnings')).toBeVisible();
    expect(screen.getByTestId('benchling-migration-import-summary')).toHaveTextContent(
      '2 imported · 0 kept as files · 2 failed'
    );
    expect(screen.getAllByText('The canonical file was incomplete.')).toHaveLength(2);
    expect(screen.queryByTestId('benchling-migration-native-exceptions')).not.toBeInTheDocument();
    expect(screen.queryByText(/Native conversion exception/)).not.toBeInTheDocument();
    expect(screen.queryByText(/seq_PRIVATE/)).not.toBeInTheDocument();
    expect(screen.queryByText(/etr_PRIVATE/)).not.toBeInTheDocument();
  });

  it('hides missing dependencies on completion and opens recovery only from history', () => {
    const report = localFolderReportView();
    if (report.version !== 2) throw new Error('Expected v2 validation fixture.');
    const evidence = linkedItemRecoveryEvidence();
    report.linkedItemRecovery = {
      expected: 3,
      actual: 3,
      passed: true,
      issues: [],
      evidence: {
        ...evidence,
        attempts: [
          {
            attemptId: 'attempt-1',
            selectedFileCount: 1,
            acceptedFileCount: 1,
            duplicateFileCount: 0,
            rejectedFileCount: 0,
            recoveredTargetCount: 1,
            repairedRelationshipCount: 1,
            outcome: 'partial',
            completedAt: '2026-08-24T12:00:00.000Z',
          },
        ],
      },
    };

    const run = localFolderRunView();
    run.state = 'unlocked';
    run.unlockedAt = '2026-08-24T11:59:00.000Z';
    run.linkedItemRecovery = {
      schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
      attemptId: 'attempt-1',
      state: 'completed',
      selectedFileCount: 1,
      processedFileCount: 1,
      recoveredUniqueObjectCount: 1,
      repairedRelationshipCount: 1,
      retainedExistingObjectCount: 0,
      retainedExistingObjects: [],
      corroboratedExistingObjectCount: 0,
      updatedAt: '2026-08-24T12:00:00.000Z',
    };

    const onViewMigrationDetails = vi.fn();
    const props = {
      run,
      report,
      pending: false,
      createdObjects: [
        { id: 'object-1', type: 'notebook' as const, name: 'Notebook A', path: 'Notebook A.md' },
      ],
      onUnlock: vi.fn(),
      onViewMigrationDetails,
      onAddLinkedItemExports: vi.fn(),
      onOpenLinkedItemRecoveryLocation: vi.fn(),
    };
    const { unmount } = render(<ValidationStep {...props} />);

    expect(screen.getByText('Import complete')).toBeVisible();
    expect(screen.getByText('2 entities in this export were checked.')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'View migration details' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/linked items? (?:was|were) not imported/iu)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import linked items' })).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('benchling-migration-linked-item-recovery')
    ).not.toBeInTheDocument();

    unmount();
    render(<ValidationStep {...props} initialLinkedItemRecoveryOpen />);

    expect(screen.getByTestId('benchling-migration-linked-item-recovery')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Back to migration history' }));
    expect(onViewMigrationDetails).toHaveBeenCalledOnce();
    expect(screen.getByText('Open Data Export')).toBeVisible();
    expect(screen.getByText('Choose All Items and HTML')).toBeVisible();
    expect(screen.queryByTestId('benchling-migration-import-complete')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('benchling-migration-missing-linked-items')
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-import-receipt')).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-created-objects')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import linked items' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-linked-item-success')).not.toBeInTheDocument();
  });

  it('replaces linked-item instructions with a focused success screen after a new batch completes', async () => {
    const initialReport = localFolderReportView();
    if (initialReport.version !== 2) throw new Error('Expected v2 validation fixture.');
    initialReport.linkedItemRecovery = {
      expected: 3,
      actual: 3,
      passed: true,
      issues: [],
      evidence: linkedItemRecoveryEvidence(),
    };
    const initialRun = localFolderRunView();
    initialRun.state = 'unlocked';
    initialRun.unlockedAt = '2026-08-24T11:59:00.000Z';
    const openWorkspace = vi.fn();
    const props = {
      pending: false,
      onUnlock: vi.fn(),
      onOpenWorkspace: openWorkspace,
      onAddLinkedItemExports: vi.fn(),
      onOpenLinkedItemRecoveryLocation: vi.fn(),
    };
    const { rerender } = render(
      <ValidationStep
        run={initialRun}
        report={initialReport}
        initialLinkedItemRecoveryOpen
        {...props}
      />
    );

    expect(screen.getByTestId('benchling-migration-linked-item-recovery')).toBeVisible();

    const completedReport = localFolderReportView();
    if (completedReport.version !== 2) throw new Error('Expected v2 validation fixture.');
    const completedEvidence = linkedItemRecoveryEvidence();
    completedReport.linkedItemRecovery = {
      expected: 3,
      actual: 3,
      passed: true,
      issues: [],
      evidence: {
        ...completedEvidence,
        recoveredUniqueObjectCount: 2,
        remainingUniqueObjectCount: 1,
        repairedRelationshipCount: 2,
        remainingRelationshipCount: 1,
        attempts: [
          {
            attemptId: 'attempt-2',
            selectedFileCount: 1,
            acceptedFileCount: 1,
            duplicateFileCount: 0,
            rejectedFileCount: 0,
            recoveredTargetCount: 2,
            repairedRelationshipCount: 2,
            outcome: 'partial',
            completedAt: '2026-08-24T12:05:00.000Z',
          },
        ],
      },
    };
    rerender(
      <ValidationStep
        run={{
          ...initialRun,
          linkedItemRecovery: {
            schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
            mode: 'linked_item_recovery',
            attemptId: 'attempt-2',
            state: 'completed',
            selectedFileCount: 1,
            processedFileCount: 1,
            recoveredUniqueObjectCount: 2,
            repairedRelationshipCount: 2,
            retainedExistingObjectCount: 0,
            retainedExistingObjects: [],
            corroboratedExistingObjectCount: 0,
            updatedAt: '2026-08-24T12:05:00.000Z',
          },
        }}
        report={completedReport}
        {...props}
      />
    );

    expect(screen.getByTestId('benchling-migration-linked-item-success')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Linked items imported' })).toBeVisible();
    expect(
      screen.getByText('2 linked items were imported and 2 links were repaired.')
    ).toBeVisible();
    expect(
      screen.getByText('1 linked item is still missing. You can import it later.')
    ).toBeVisible();
    expect(screen.queryByText('Prepare this export automatically')).not.toBeInTheDocument();
    expect(screen.queryByText('Back to import summary')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open project' }));
    expect(openWorkspace).toHaveBeenCalledTimes(1);

    openWorkspace.mockClear();
    props.onUnlock.mockClear();
    rerender(
      <ValidationStep
        run={{
          ...initialRun,
          state: 'ready_to_unlock',
          unlockedAt: null,
          linkedItemRecovery: {
            schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
            mode: 'linked_item_recovery',
            attemptId: 'attempt-2',
            state: 'completed',
            selectedFileCount: 1,
            processedFileCount: 1,
            recoveredUniqueObjectCount: 2,
            repairedRelationshipCount: 2,
            retainedExistingObjectCount: 0,
            retainedExistingObjects: [],
            corroboratedExistingObjectCount: 0,
            updatedAt: '2026-08-24T12:05:00.000Z',
          },
        }}
        report={completedReport}
        {...props}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open project' }));
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(props.onUnlock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Import another export' }));
    expect(screen.getByTestId('benchling-migration-linked-item-recovery')).toBeVisible();
    expect(screen.queryByTestId('benchling-migration-linked-item-success')).not.toBeInTheDocument();
  });

  it('keeps linked-item recovery out of the general completion layout', () => {
    const report = localFolderReportView();
    if (report.version !== 2 || !report.localExport) {
      throw new Error('Expected v2 local export fixture.');
    }
    report.localExport = {
      ...report.localExport,
      evidence: {
        ...report.localExport.evidence,
        nativeFolderZipInventory: undefined,
      },
    };
    report.linkedItemRecovery = {
      expected: 3,
      actual: 3,
      passed: true,
      issues: [],
      evidence: linkedItemRecoveryEvidence(),
    };

    render(
      <ValidationStep
        run={localFolderRunView()}
        report={report}
        pending={false}
        onUnlock={() => undefined}
        onAddLinkedItemExports={() => undefined}
        onOpenLinkedItemRecoveryLocation={() => undefined}
      />
    );

    expect(screen.queryByTestId('benchling-migration-history-overview')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('benchling-migration-missing-linked-items')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('benchling-migration-linked-item-recovery')
    ).not.toBeInTheDocument();

    expect(screen.queryByText(/2 linked items/)).not.toBeInTheDocument();
  });

  it('locks the notebook only while linked-item recovery is unsafe to interrupt', () => {
    const run = localFolderRunView();
    run.linkedItemRecovery = {
      schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
      attemptId: 'attempt-1',
      state: 'reconciling',
      selectedFileCount: 2,
      processedFileCount: 2,
      recoveredUniqueObjectCount: 1,
      repairedRelationshipCount: 1,
      updatedAt: '2026-08-13T10:01:00.000Z',
    };
    const report = localFolderReportView();
    if (report.version !== 2) throw new Error('Expected v2 validation fixture.');
    report.linkedItemRecovery = {
      expected: 3,
      actual: 3,
      passed: true,
      issues: [],
      evidence: linkedItemRecoveryEvidence(),
    };
    const props = {
      report,
      pending: false,
      onUnlock: () => undefined,
      onAddLinkedItemExports: () => undefined,
      onOpenLinkedItemRecoveryLocation: () => undefined,
    };
    const { rerender } = render(<ValidationStep run={run} {...props} />);

    expect(screen.getByTestId('benchling-migration-linked-item-recovery')).toBeVisible();
    expect(screen.queryByTestId('benchling-migration-unlock')).not.toBeInTheDocument();
    expect(screen.getByText('Repairing notebook links (Step 3 of 7)')).toBeVisible();
    expect(screen.getByText('Prepare one HTML export')).toBeVisible();
    expect(screen.getByText(/Finish or retry this ZIP batch/)).toBeVisible();

    rerender(
      <ValidationStep
        run={{
          ...run,
          linkedItemRecovery: { ...run.linkedItemRecovery, state: 'completed' },
        }}
        {...props}
      />
    );
    expect(screen.getByTestId('benchling-migration-unlock')).toBeEnabled();
    expect(
      screen.queryByTestId('benchling-migration-linked-item-recovery')
    ).not.toBeInTheDocument();
  });
});

const directFolderScope = {
  version: 1 as const,
  kind: 'folder' as const,
  folder: {
    id: 'lib_DIRECT',
    url: 'https://benchling.com/exampleuser/f/lib_DIRECT-direct-folder',
    objectType: 'folder',
  },
  includeChildren: false as const,
};

const folderTreeScope = {
  version: 1 as const,
  kind: 'folder_tree' as const,
  roots: [
    {
      id: 'lib_TREE',
      url: 'https://benchling.com/exampleuser/f/lib_TREE-folder-tree',
      objectType: 'folder',
    },
  ],
  includeChildren: true as const,
};

describe('provider reference details', () => {
  it('does not expose internal reference accounting in the completion modal', () => {
    render(
      <ValidationStep
        run={localFolderRunView()}
        report={{
          ...reportView(),
          providerReferences: {
            schema: 'dnaforge.benchling.provider-reference-outcomes.v1',
            counts: {
              resolved: 3,
              pending: 2,
              ambiguous: 1,
              external: 1,
              source_broken: 1,
            },
            total: 8,
            details: [],
            truncated: false,
          },
        }}
        pending={false}
        onUnlock={() => undefined}
      />
    );

    expect(screen.queryByTestId('benchling-migration-reference-outcomes')).not.toBeInTheDocument();
    expect(screen.queryByText('8 references in this notebook')).not.toBeInTheDocument();
    expect(screen.queryByText('In this project')).not.toBeInTheDocument();
    expect(screen.queryByText('Not imported yet')).not.toBeInTheDocument();
    expect(screen.queryByText('Outside this project')).not.toBeInTheDocument();
  });
});

describe('the completed import', () => {
  it('counts preserved-file warnings when the native receipt has no file outcomes', () => {
    const run = localFolderRunView();
    const report = localFolderReportView();
    if (report.version !== 2) throw new Error('Expected a v2 report.');
    report.nativeImport = {
      actionId: run.id,
      destinationChanges: { added: 2, updated: 0, retained: 0 },
      fileOutcomes: { preserved: [], failed: [] },
      history: 'new_workspace',
      providerVersions: null,
      exactNativeMatches: [],
      structuralDecisions: [],
      externalSources: [
        { sourceId: 'zip-1', state: 'verified_at_import', checkedAt: report.generatedAt },
      ],
    };
    report.issues = [
      {
        code: 'local_export_warning',
        blocking: false,
        message:
          'Empty DNA was preserved as a file because it could not become an editable record.',
      },
      {
        code: 'local_export_warning',
        blocking: false,
        message: 'Metadata was preserved as a file because it could not become an editable record.',
      },
    ];

    render(<ValidationStep run={run} report={report} pending={false} onUnlock={() => undefined} />);

    expect(screen.getByTestId('benchling-migration-import-summary')).toHaveTextContent(
      '2 imported · 2 kept as files · 0 failed'
    );
  });

  it('shows the verified imported and skipped counts for a first import', () => {
    const report = localFolderReportView();
    if (report.version !== 2 || !report.localExport?.evidence.nativeFolderZipInventory) {
      throw new Error('Expected a native Folder ZIP inventory.');
    }
    report.localExport.evidence.nativeFolderZipInventory = {
      ...report.localExport.evidence.nativeFolderZipInventory,
      canonicalObjects: {
        ...report.localExport.evidence.nativeFolderZipInventory.canonicalObjects,
        selectedTotal: 47,
        importedTotal: 45,
        skipped: [
          {
            sourceObjectId: 'seq_EMPTY',
            canonicalClass: 'dna_rna',
            reasonCode: 'empty_sequence',
            reason: 'The sequence has no bases.',
          },
          {
            sourceObjectId: 'etr_UNSUPPORTED',
            canonicalClass: 'notebook',
            reasonCode: 'unsupported_content',
            reason: 'The notebook content is unsupported.',
          },
        ],
      },
    };

    render(
      <ValidationStep
        run={localFolderRunView()}
        report={report}
        pending={false}
        onUnlock={() => undefined}
      />
    );

    expect(screen.queryByText('What this import changed')).not.toBeInTheDocument();
    expect(screen.getByText('Imported with warnings')).toBeVisible();
    expect(screen.getByTestId('benchling-migration-import-summary')).toHaveTextContent(
      '45 imported · 0 kept as files · 2 failed'
    );
  });

  it('keeps the original import counts visible after a linked-item attempt fails', () => {
    const run = localFolderRunView();
    run.linkedItemRecovery = {
      schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
      mode: 'linked_item_recovery',
      attemptId: 'attempt-failed',
      state: 'failed',
      selectedFileCount: 1,
      processedFileCount: 1,
      recoveredUniqueObjectCount: 0,
      repairedRelationshipCount: 19,
      retainedExistingObjectCount: 0,
      retainedExistingObjects: [],
      corroboratedExistingObjectCount: 0,
      updatedAt: '2026-08-27T22:34:15.728Z',
      errorMessage: 'The notebook did not pass validation.',
    };

    render(
      <ValidationStep
        run={run}
        report={localFolderReportView()}
        pending={false}
        onUnlock={() => undefined}
      />
    );

    expect(screen.queryByText('What this import changed')).not.toBeInTheDocument();
    expect(screen.getByTestId('import-receipt-imported')).toHaveTextContent('2entities imported');
    expect(screen.queryByTestId('import-receipt-skipped')).not.toBeInTheDocument();
  });

  it('does not crash when an obsolete saved report lacks native representation counts', () => {
    const report = localFolderReportView();
    delete (report.projections as Partial<typeof report.projections>).nativeRepresentations;

    expect(() =>
      render(
        <ValidationStep
          run={localFolderRunView()}
          report={report}
          pending={false}
          onUnlock={() => undefined}
        />
      )
    ).not.toThrow();
    expect(screen.queryByTestId('benchling-migration-native-outcomes')).not.toBeInTheDocument();
  });

  it('shows only actionable incomplete-DNA information and omits successful native counts', () => {
    const report = localFolderReportView();
    report.projections = {
      ...report.projections,
      native: 4_911,
      nativeRepresentations: {
        dnaSequence: 31,
        strain: 4_868,
        needsSequence: 12,
      },
      fallback: 0,
      artifact: 0,
      exceptions: 0,
    };

    render(
      <ValidationStep
        run={localFolderRunView()}
        report={report}
        pending={false}
        onUnlock={() => undefined}
      />
    );

    expect(screen.queryByTestId('benchling-migration-native-outcomes')).not.toBeInTheDocument();
    expect(screen.queryByText('4899')).not.toBeInTheDocument();
    expect(screen.queryByText('native records imported')).not.toBeInTheDocument();
    expect(screen.queryByText('native conversion exceptions')).not.toBeInTheDocument();
    expect(screen.getByTestId('benchling-migration-incomplete-dna')).toHaveTextContent(
      '12 DNA records were imported without sequence data.'
    );
    expect(4_899 + 12).toBe(report.projections.native);
    expect(screen.queryByTestId('benchling-migration-native-exceptions')).not.toBeInTheDocument();
    expect(screen.queryByText(/fallback file/iu)).not.toBeInTheDocument();
  });

  it('shows one attempt-local accounting equation after appending to an existing workspace', () => {
    const run = localFolderRunView();
    run.state = 'unlocked';
    run.linkedItemRecovery = {
      schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
      mode: 'workspace_append',
      attemptId: 'workspace-append-1',
      state: 'completed',
      selectedFileCount: 1,
      processedFileCount: 1,
      recoveredUniqueObjectCount: 0,
      repairedRelationshipCount: 0,
      retainedExistingObjectCount: 132,
      retainedExistingObjects: Array.from({ length: 132 }, (_, index) => ({
        stableId: `seq_${index}`,
        name: `Sequence ${index}`,
      })),
      corroboratedExistingObjectCount: 419,
      versionConflictResolution: {
        kind: 'resolved',
        policy: 'keep_existing',
        conflictCount: 132,
      },
      updatedAt: '2026-08-24T12:00:00.000Z',
    };

    render(
      <ValidationStep
        run={run}
        report={localFolderReportView()}
        createdObjects={[
          { id: 'folder-1', type: 'folder', name: 'Folder', path: 'Folder' },
          { id: 'seq-1', type: 'sequence', name: 'Sequence', path: 'Sequence' },
        ]}
        pending={false}
        onUnlock={() => undefined}
        onOpenWorkspace={() => undefined}
        onAddLinkedItemExports={() => undefined}
        onOpenLinkedItemRecoveryLocation={() => undefined}
      />
    );

    expect(screen.getByText('Import complete')).toBeVisible();
    expect(screen.getByText('551 entities in this export were checked.')).toBeVisible();
    expect(screen.queryByText('2 entities were imported.')).not.toBeInTheDocument();
    expect(screen.queryByText('What this export changed')).not.toBeInTheDocument();
    expect(screen.queryByTestId('import-receipt-added')).not.toBeInTheDocument();
    const reused = within(screen.getByTestId('import-receipt-reused'));
    expect(reused.getByText('419')).toBeVisible();
    expect(reused.getByText('identical entities already here')).toBeVisible();
    const retained = within(screen.getByTestId('import-receipt-retained'));
    expect(retained.getByText('132')).toBeVisible();
    expect(retained.getByText('different versions; existing versions kept')).toBeVisible();
    expect(screen.queryByText(/The export carried a different version/iu)).not.toBeInTheDocument();
    expect(screen.queryByText(/Created in DNAForge/iu)).not.toBeInTheDocument();
  });

  it('returns directly to factual linked-item progress while an import is active', () => {
    const run = localFolderRunView();
    const report = localFolderReportView();
    if (report.version !== 2) throw new Error('Expected v2 validation fixture.');
    report.linkedItemRecovery = {
      expected: 3,
      actual: 3,
      passed: true,
      issues: [],
      evidence: linkedItemRecoveryEvidence(),
    };
    run.state = 'unlocked';
    run.linkedItemRecovery = {
      schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
      mode: 'linked_item_recovery',
      attemptId: 'attempt-1',
      state: 'parsing',
      selectedFileCount: 1,
      processedFileCount: 1,
      recoveredUniqueObjectCount: 0,
      repairedRelationshipCount: 0,
      retainedExistingObjectCount: 0,
      retainedExistingObjects: [],
      corroboratedExistingObjectCount: 0,
      updatedAt: '2026-08-24T12:00:00.000Z',
      startedAt: '2026-08-24T11:59:00.000Z',
      work: { kind: 'read_and_classify_objects', completed: 8_192, total: 17_604 },
    };

    render(
      <ValidationStep
        run={run}
        report={report}
        pending={false}
        onUnlock={() => undefined}
        onOpenWorkspace={() => undefined}
        onAddLinkedItemExports={() => undefined}
        onOpenLinkedItemRecoveryLocation={() => undefined}
      />
    );

    expect(screen.getByTestId('benchling-migration-linked-item-recovery')).toBeVisible();
    expect(screen.getByText('Reading and classifying objects (Step 2 of 7)')).toBeVisible();
    expect(screen.getByText('8,192 of 17,604 objects read')).toBeVisible();
    expect(screen.queryByText('What this import changed')).not.toBeInTheDocument();
    expect(screen.queryByText('Project unlocked')).not.toBeInTheDocument();
  });

  it('keeps the completed review open until the user chooses to open the workspace', () => {
    const onOpenWorkspace = vi.fn();
    const legacyAppendProps = { onAppendWorkspaceExports: vi.fn() };
    render(
      <ValidationStep
        {...legacyAppendProps}
        run={{ ...localFolderRunView(), state: 'unlocked' }}
        report={localFolderReportView()}
        pending={false}
        onUnlock={() => undefined}
        onOpenWorkspace={onOpenWorkspace}
      />
    );

    expect(screen.getByText('2 entities in this export were checked.')).toBeVisible();
    expect(screen.queryByText('Project unlocked')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('benchling-migration-append-workspace-exports')
    ).not.toBeInTheDocument();
    const openButton = screen.getByTestId('benchling-migration-open-workspace');
    expect(
      screen.queryByRole('button', { name: 'View migration details' })
    ).not.toBeInTheDocument();
    expect(onOpenWorkspace).not.toHaveBeenCalled();

    fireEvent.click(openButton);

    expect(onOpenWorkspace).toHaveBeenCalledOnce();
  });

  it('does not offer a separate add-another-export card after unlock', () => {
    const legacyAppendProps = { onAppendWorkspaceExports: vi.fn() };
    render(
      <ValidationStep
        {...legacyAppendProps}
        run={{ ...localFolderRunView(), state: 'unlocked' }}
        report={reportView()}
        pending={false}
        onUnlock={() => undefined}
        onAddLinkedItemExports={() => undefined}
        onOpenLinkedItemRecoveryLocation={() => undefined}
      />
    );

    expect(
      screen.queryByTestId('benchling-migration-append-workspace-exports')
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Entities already here are reused/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: 'Add another Benchling export to this project',
      })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Project remains locked')).not.toBeInTheDocument();
  });
});

function runView(): BenchlingMigrationRunView {
  return {
    version: 1,
    id: 'run-1',
    workspaceId: 'workspace-1',
    displayName: 'Benchling migration',
    scope: {
      version: 1,
      kind: 'file',
      source: { id: 'entry-1', url: 'https://example.benchling.com/entry-1' },
    },
    binding: null,
    state: 'ready_to_unlock',
    resumeState: null,
    attempt: 1,
    converterVersions: { artifact: '1' },
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:01:00.000Z',
    startedAt: '2026-07-18T00:00:01.000Z',
    unlockedAt: null,
    lastError: null,
  };
}

function reportView(): BenchlingMigrationReportView {
  const section = { expected: 0, actual: 0, passed: true, issues: [] };
  return {
    version: 2,
    converterVersions: {
      app: '0.6.4',
      bundle: 'benchling-migration-bundle-v1',
      projection: 'benchling-migration-v1',
    },
    runId: 'run-1',
    scope: runView().scope,
    snapshotId: 'snapshot-1',
    generatedAt: '2026-07-18T00:01:00.000Z',
    passed: true,
    sourceObjects: section,
    attachments: section,
    memberships: section,
    relationships: {
      ...section,
      countsByClass: {
        exact: 0,
        heuristic: 0,
        ambiguous: 0,
        unresolved: 0,
        external: 0,
        source_broken: 0,
      },
    },
    projections: {
      ...section,
      native: 0,
      nativeRepresentations: { dnaSequence: 0, strain: 0, needsSequence: 0 },
      artifact: 0,
      exceptions: 0,
    },
    hashes: section,
    rendering: section,
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
    formulas: { ...section, supported: 0, unsupported: 0, stale: 0, evidence: [] },
    nativeConversionExceptions: { ...section, evidence: [] },
    collections: {
      ...section,
      expectedMemberships: 0,
      actualMemberships: 0,
      selectedRootSourceIds: [],
      evidence: [],
    },
    providerActivity: {
      ...section,
      networkRequests: 4,
      cacheHits: 2,
      coverageGaps: 0,
      countsAreExact: true,
      networkRequestsByClass: {
        export_submit: 1,
        export_task_status: 1,
        gmail_receipt_page: 0,
        export_archive_metadata: 2,
        export_archive_range: 0,
        export_archive_download: 0,
        targeted_read: 0,
      },
      cacheHitsByClass: {
        export_submit: 1,
        export_task_status: 1,
        gmail_receipt_page: 0,
        export_archive_metadata: 0,
        export_archive_range: 0,
        export_archive_download: 0,
        targeted_read: 0,
      },
      evidence: [],
    },
    issues: [],
  };
}

function directFolderRunView(): BenchlingMigrationRunView {
  return { ...runView(), scope: directFolderScope };
}

const localArtifact = {
  kind: 'local_bundle' as const,
  format: 'zip' as const,
  fileName: 'Export_-_2026-08-04.zip',
  sha256: `sha256:${'9'.repeat(64)}`,
  sizeBytes: 63_235_789,
};

function localFolderRunView(): BenchlingMigrationRunView {
  return {
    ...directFolderRunView(),
    scope: { ...directFolderScope, acquisition: 'local_bundle' },
    binding: null,
    sourceArtifact: localArtifact,
    localBundleState: 'ready',
  };
}

function localFolderReportView(): BenchlingMigrationReportView {
  const report = reportView();
  if (report.version !== 2) throw new Error('Expected v2 validation fixture.');
  return {
    ...report,
    scope: localFolderRunView().scope,
    directFolderImportScope: {
      expected: 1,
      actual: 1,
      passed: true,
      issues: [],
      evidence: {
        schema: 'dnaforge.migration.direct-folder-import-scope.v1',
        selectedSourceObjectIds: ['etr_ROOT'],
        approvedOneHopDependencySourceObjectIds: ['etr_TARGET'],
        importedOneHopDependencySourceObjectIds: ['etr_TARGET'],
      },
    },
    localExport: {
      expected: 1,
      actual: 1,
      passed: true,
      issues: [],
      evidence: {
        schema: 'dnaforge.benchling.local-export-validation.v1',
        format: localArtifact.format,
        logicalFilename: localArtifact.fileName,
        sha256: localArtifact.sha256,
        sizeBytes: localArtifact.sizeBytes,
        resourceCount: 0,
        resourceBytes: 0,
        networkRequests: 0,
        nativeFolderZipInventory: {
          schema: 'dnaforge.benchling.local-native-folder-zip-inventory.v1',
          catalog: {
            physicalEntryCount: 727,
            uniqueEntryCount: 703,
          },
          canonicalObjects: {
            archiveTotal: 291,
            archiveByClass: { notebook: 46, dna_rna: 241, protein: 4 },
            selectedTotal: 2,
            selectedByClass: { notebook: 1, dna_rna: 1, protein: 0 },
            importedTotal: 2,
            importedByClass: { notebook: 1, dna_rna: 1, protein: 0 },
            excludedByScopeTotal: 289,
            archiveMembershipTotal: 291,
            selectedMembershipTotal: 2,
            importedMembershipTotal: 2,
            skipped: [],
          },
          selectedAttachments: {
            total: 0,
            byClass: { png: 0, jpg: 0, pdf: 0, ab1: 0, gbk: 0, seq: 0, other: 0 },
          },
          archiveRepresentations: {
            alternateTotal: 327,
            alternateByClass: {
              sequence_txt: 241,
              sequence_html: 76,
              protein_txt: 4,
              protein_gp: 4,
              protein_html: 2,
            },
            supportTotal: 1,
            supportByClass: { benchling_css: 1 },
            collapsedIdenticalSupportDuplicateCount: 24,
          },
          folders: {
            inferredCount: 27,
            explicitDirectoryEntryCount: 0,
            emptyFoldersNotPreservableBecauseArchiveOmitsDirectoryEntries: true,
          },
          rootBinding: {
            archiveDisplayRoot: 'ARBR Lab Work',
            selectedStableFolderId: 'lib_DIRECT',
            selectedStableFolderIdSource: 'pasted_projects_route_or_user_selection',
            archiveContainsSelectedStableFolderId: false,
            associationVerification: 'user_asserted_not_archive_verified',
          },
        },
      },
    },
  };
}

function linkedItemRecoveryEvidence(): ValidationLinkedItemRecoveryEvidence {
  return {
    schema: 'dnaforge.benchling.linked-item-recovery-validation.v1',
    organizationBaseUrl: 'https://benchling.com/exampleuser',
    relationshipCount: 3,
    uniqueTargetCount: 3,
    folderCount: 1,
    recoveredUniqueObjectCount: 1,
    remainingUniqueObjectCount: 2,
    repairedRelationshipCount: 1,
    remainingRelationshipCount: 2,
    folders: [
      {
        sourceId: 'lib_LINKED',
        name: 'Linked sequences',
        sourceUrl: 'https://benchling.com/exampleuser/f_/lib_LINKED-linked-sequences',
        targetCount: 3,
        relationshipCount: 3,
        countsByType: { dna_rna_sequence: 3, protein: 0, protocol: 0, other: 0 },
        recoveredTargetCount: 1,
      },
    ],
    targets: [0, 1, 2].map((index) => ({
      sourceId: `seq_LINKED_${index}`,
      name: `Linked sequence ${index + 1}`,
      sourceUrl: `https://benchling.com/exampleuser/f_/lib_LINKED-linked/seq_LINKED_${index}-sequence`,
      objectType: 'dna_rna_sequence' as const,
      folderId: 'lib_LINKED',
      relationshipCount: 1,
      relationshipIds: [`rel-${index}`],
      recovered: index === 0,
    })),
    attempts: [],
  };
}

function directFolderReportView(): BenchlingMigrationReportView {
  const report = reportView();
  if (report.version !== 2) throw new Error('Expected v2 validation fixture.');
  const capturePlanDigest = `sha256:${'a'.repeat(64)}`;
  const traversalJournalDigest = `sha256:${'b'.repeat(64)}`;
  const authority = {
    schema: 'dnaforge.benchling.direct-folder-export-authority.v1' as const,
    capturePlanDigest,
    traversalJournalDigest,
    selectedRootId: 'lib_DIRECT',
    sourceItemId: 'etr_DIRECT_NOTEBOOK',
    sourceItemType: 'entry',
    sourceFolderIds: ['lib_DIRECT'] as [string],
    requestCapabilityId: 'benchling.notebook-entry-html-export.v1' as const,
  };
  return {
    ...report,
    scope: directFolderScope,
    directFolderCapture: {
      expected: 1,
      actual: 1,
      passed: true,
      issues: [],
      evidence: {
        schema: 'dnaforge.migration.direct-folder-capture-attestation.v1',
        capturePlanDigest,
        traversalJournalDigest,
        sourceAccountHash: `sha256:${'c'.repeat(64)}`,
        selectedRootId: 'lib_DIRECT',
        boundaryCanonicalSha256: `sha256:${'d'.repeat(64)}`,
        authorityManifestSha256: `sha256:${'e'.repeat(64)}`,
        lineageManifestSha256: `sha256:${'f'.repeat(64)}`,
        plannedItemCount: 1,
        successfulLeafCount: 1,
        items: [
          {
            sourceItemId: 'etr_DIRECT_NOTEBOOK',
            initialJobId: 'export:direct-folder:notebook:1',
            successfulLeafJobId: 'export:direct-folder:notebook:1',
            chainJobIds: ['export:direct-folder:notebook:1'],
            authority,
            authoritySha256: `sha256:${'0'.repeat(64)}`,
          },
        ],
      },
    },
  };
}

function folderTreeRunView(): BenchlingMigrationRunView {
  return { ...runView(), scope: folderTreeScope };
}

function folderTreeReportView(): BenchlingMigrationReportView {
  const report = reportView();
  if (report.version !== 2) throw new Error('Expected v2 validation fixture.');
  const capturePlanDigest = `sha256:${'1'.repeat(64)}`;
  const traversalJournalDigest = `sha256:${'2'.repeat(64)}`;
  const authority = {
    schema: 'dnaforge.benchling.folder-tree-export-authority.v1' as const,
    capturePlanDigest,
    traversalJournalDigest,
    selectedRootId: 'lib_TREE',
    sourceItemId: 'etr_TREE_NOTEBOOK_1',
    sourceItemType: 'entry' as const,
    sourceFolderIds: ['lib_TREE', 'lib_TREE_CHILD'],
    maximumFolderDepth: 2,
    requestCapabilityId: 'benchling.notebook-entry-html-export.v1' as const,
  };
  return {
    ...report,
    scope: folderTreeScope,
    folderTreeCapture: {
      expected: 2,
      actual: 2,
      passed: true,
      issues: [],
      evidence: {
        schema: 'dnaforge.migration.folder-tree-capture-attestation.v1',
        capturePlanDigest,
        traversalJournalDigest,
        sourceAccountHash: `sha256:${'3'.repeat(64)}`,
        selectedRootId: 'lib_TREE',
        boundaryCanonicalSha256: `sha256:${'4'.repeat(64)}`,
        authorityManifestSha256: `sha256:${'5'.repeat(64)}`,
        lineageManifestSha256: `sha256:${'6'.repeat(64)}`,
        maximumFolderDepth: 2,
        includedFolderIds: ['lib_TREE', 'lib_TREE_CHILD', 'lib_TREE_GRANDCHILD'],
        excludedFolderIds: ['lib_OUTSIDE'],
        plannedItemCount: 2,
        successfulLeafCount: 2,
        items: [
          {
            sourceItemId: 'etr_TREE_NOTEBOOK_1',
            sourceFolderIds: ['lib_TREE', 'lib_TREE_CHILD'],
            initialJobId: 'export:folder-tree:notebook:1',
            successfulLeafJobId: 'export:folder-tree:notebook:1',
            chainJobIds: ['export:folder-tree:notebook:1'],
            authority,
            authoritySha256: `sha256:${'7'.repeat(64)}`,
          },
          {
            sourceItemId: 'etr_TREE_NOTEBOOK_2',
            sourceFolderIds: ['lib_TREE_GRANDCHILD'],
            initialJobId: 'export:folder-tree:notebook:2',
            successfulLeafJobId: 'export:folder-tree:notebook:2',
            chainJobIds: ['export:folder-tree:notebook:2'],
            authority: {
              ...authority,
              sourceItemId: 'etr_TREE_NOTEBOOK_2',
              sourceFolderIds: ['lib_TREE_GRANDCHILD'],
            },
            authoritySha256: `sha256:${'8'.repeat(64)}`,
          },
        ],
      },
    },
  };
}
