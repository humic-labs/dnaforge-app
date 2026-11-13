import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BenchlingMigrationRunView } from '../../shared/benchling-migration-ipc';
import type { ValidationLinkedItemRecoveryEvidence } from '../../shared/benchling-migration';
import {
  LinkedItemRecoveryPanel,
  linkedItemRecoveryProgressLabel,
  LinkedItemRecoveryMeasuredProgress,
  type LinkedItemRecoveryAutomationAdapter,
} from './LinkedItemRecoveryPanel';

vi.mock('../../platform', () => ({
  platform: () => ({
    workspace: {
      getPathForFile: (file: File) => (file as File & { path?: string }).path ?? '',
    },
  }),
}));

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LinkedItemRecoveryPanel', () => {
  it('labels source preparation separately and keeps the actual work phases monotonic', () => {
    const progress = {
      schema: 'dnaforge.benchling.linked-item-recovery-progress.v1' as const,
      mode: 'workspace_append' as const,
      attemptId: 'attempt',
      state: 'parsing' as const,
      selectedFileCount: 1,
      processedFileCount: 0,
      recoveredUniqueObjectCount: 0,
      repairedRelationshipCount: 0,
      retainedExistingObjectCount: 0,
      retainedExistingObjects: [],
      corroboratedExistingObjectCount: 0,
      updatedAt: '2026-08-30T00:00:00.000Z',
      work: { kind: 'write_objects' as const, completed: 2, total: 3 },
    };
    expect(linkedItemRecoveryProgressLabel(progress)).toBe(
      'Preparing source objects (Step 2 of 7)'
    );
    render(<LinkedItemRecoveryMeasuredProgress progress={progress} />);
    expect(screen.getByText('2 of 3 source objects prepared')).toBeVisible();
    const labels = [
      linkedItemRecoveryProgressLabel(progress),
      linkedItemRecoveryProgressLabel({
        ...progress,
        state: 'reconciling',
        work: { kind: 'resolve_links', completed: 0, total: 3 },
      }),
      linkedItemRecoveryProgressLabel({ ...progress, state: 'reconciling' }),
      linkedItemRecoveryProgressLabel({
        ...progress,
        state: 'validating',
        work: { kind: 'validate_objects', completed: 0, total: 3 },
      }),
      linkedItemRecoveryProgressLabel({
        ...progress,
        state: 'validating',
        work: { kind: 'validate_source_files', completed: 0, total: 3 },
      }),
      linkedItemRecoveryProgressLabel({
        ...progress,
        state: 'validating',
        work: { kind: 'finalize_workspace' },
      }),
    ];
    expect(labels.map((label) => Number(label.match(/Step (\d+)/)?.[1]))).toEqual([
      2, 3, 4, 5, 6, 7,
    ]);
    expect(linkedItemRecoveryProgressLabel({ ...progress, state: 'copying' }, 'external_zip')).toBe(
      'Verifying ZIP files (Step 1 of 7)'
    );
  });
  it('shows the manual export workflow immediately without a Chrome companion', () => {
    renderPanel();

    expect(screen.getByText('Open Data Export')).toBeVisible();
    expect(screen.getByText('Choose All Items and HTML')).toBeVisible();
    expect(screen.getByText('Add these folders to your Benchling export')).toBeVisible();
    expect(screen.getByText('Add the HTML export')).toBeVisible();
    expect(screen.queryByText('Prepare this export automatically')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Prepare export in Benchling' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Do it manually')).not.toBeInTheDocument();
  });

  it('accepts an optional automation adapter without hiding the manual fallback', () => {
    const Panel = vi.fn(({ runId }: { runId: string }) => (
      <aside data-testid="linked-item-automation-adapter">Automation for {runId}</aside>
    ));
    const automation: LinkedItemRecoveryAutomationAdapter = {
      kind: 'linked_item_export_automation',
      Panel,
    };

    renderPanel({ automation });

    expect(screen.getByTestId('linked-item-automation-adapter')).toHaveTextContent(
      'Automation for run-1'
    );
    expect(Panel).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1' }), {});
    expect(screen.getByText('Open Data Export')).toBeVisible();
    expect(screen.getByText('Drop your Benchling export here')).toBeVisible();
  });

  it('shows the full HTML export guide and upload area on one screen', async () => {
    const open = vi.fn();
    renderPanel({ onOpenLocation: open });

    const recoveryHeading = screen.getByRole('heading', { name: 'Import linked items' });
    expect(recoveryHeading).toBeVisible();
    expect(screen.queryByText(/Step \d of \d/)).not.toBeInTheDocument();
    expect(screen.getByText('Prepare one HTML export')).toBeVisible();
    expect(screen.getByText('Open Data Export')).toBeVisible();
    expect(screen.getByText('Data Export')).toBeVisible();
    expect(screen.getByText(/profile icon in the bottom-left/)).toBeVisible();
    expect(screen.getByText('All Items')).toBeVisible();
    const tutorialTrigger = screen.getByRole('button', {
      name: 'Watch how to export',
    });
    expect(tutorialTrigger).toBeVisible();
    expect(screen.getByTestId('benchling-migration-linked-item-recovery')).toContainElement(
      tutorialTrigger
    );
    expect(screen.getByText('Add locations')).toBeVisible();
    expect(screen.getByText('Choose All Items and HTML')).toBeVisible();
    expect(screen.getByText(/Remain on/).closest('li')).toHaveTextContent(
      'Remain on All Items and select HTML.'
    );
    expect(screen.queryByText('Do not choose PDF.')).not.toBeInTheDocument();

    const instructions = screen.getByText('Open Data Export').closest('ol');
    expect(instructions).not.toBeNull();
    const steps = within(instructions!).getAllByRole('listitem');
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveTextContent('1Open Data Export');
    expect(within(steps[0]).queryByRole('button')).not.toBeInTheDocument();
    expect(steps[1]).toHaveTextContent('2Choose All Items and HTML');

    const folderInstructions = screen.getByText(
      'Add these folders to your Benchling export'
    ).parentElement;
    expect(folderInstructions).not.toBeNull();
    expect(folderInstructions).toHaveTextContent(
      'Use Add locations in Benchling to search for each folder below.'
    );
    expect(folderInstructions).toHaveTextContent(
      'If several folders have the same name, use Find correct folder in DNAForge to open the right one and check its parent.'
    );
    const folderInstructionLines = folderInstructions!.querySelectorAll('p');
    expect(folderInstructionLines).toHaveLength(2);
    expect(folderInstructionLines[0]).toHaveTextContent(
      'Use Add locations in Benchling to search for each folder below.'
    );
    expect(folderInstructionLines[1]).toHaveTextContent(
      'If several folders have the same name, use Find correct folder in DNAForge to open the right one and check its parent.'
    );
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/of 2 added/)).not.toBeInTheDocument();
    expect(screen.getByTestId('benchling-migration-linked-export-dropzone')).toBeVisible();
    expect(screen.getByText('Plasmid Sequencing Results')).toBeVisible();
    expect(screen.getAllByText('2 linked items')).toHaveLength(1);
    expect(screen.getByText('Protocols')).toBeVisible();
    expect(screen.getAllByText('1 linked item')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Find correct folder' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /Copy folder name:/ })).toHaveLength(2);
    expect(screen.getByText('Click the Export button')).toBeVisible();
    const exportStep = screen.getByText('Click the Export button').closest('li');
    expect(exportStep).not.toBeNull();
    expect(exportStep).toHaveTextContent('In Benchling, click Export.');
    expect(within(exportStep!).getByText('3')).toHaveClass('text-accent');
    expect(exportStep!.querySelector('p')).not.toHaveClass('text-warning');
    expect(screen.queryByText(/unresolved links/)).not.toBeInTheDocument();
    expect(screen.queryByText(/DNAForge does not connect/)).not.toBeInTheDocument();

    const panel = screen.getByTestId('benchling-migration-linked-item-recovery');
    expect(panel).not.toHaveTextContent('lib_folder_a');
    expect(panel).not.toHaveTextContent('seq_target_a');
    expect(panel).not.toHaveTextContent('relationship-1');

    fireEvent.click(screen.getAllByRole('button', { name: 'Find correct folder' })[0]);
    expect(open).toHaveBeenCalledWith('folder', 'lib_folder_a');

    fireEvent.click(
      screen.getByRole('button', { name: 'Copy folder name: Plasmid Sequencing Results' })
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Plasmid Sequencing Results');
    await waitFor(() =>
      expect(
        screen.getByRole('button', {
          name: 'Copy folder name: Plasmid Sequencing Results',
        })
      ).toHaveTextContent('Copied')
    );

    expect(screen.getByText('Add the HTML export')).toBeVisible();
    const uploadStep = screen.getByText('Add the HTML export').closest('li');
    expect(uploadStep).not.toBeNull();
    expect(within(uploadStep!).getByText('4')).toHaveClass('text-accent');
    expect(screen.getByText('Drop your Benchling export here')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Choose files or folders…' })).toBeVisible();
    expect(screen.getByText('Add these folders to your Benchling export')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Continue to upload' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back to instructions' })).not.toBeInTheDocument();
  });

  it('shows and copies folder names exactly as given, with no word-specific rewriting', async () => {
    const evidence = recoveryEvidence();
    renderPanel({
      evidence: {
        ...evidence,
        folders: [
          { ...evidence.folders[0], name: 'Example assembly demo vector' },
          { ...evidence.folders[1], name: 'Test-primers set' },
        ],
      },
    });
    expect(screen.getByText('Example assembly demo vector')).toBeVisible();
    expect(screen.getByText('Test-primers set')).toBeVisible();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Copy folder name: Example assembly demo vector',
      })
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Example assembly demo vector');
    await waitFor(() =>
      expect(
        screen.getByRole('button', {
          name: 'Copy folder name: Example assembly demo vector',
        })
      ).toHaveTextContent('Copied')
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy folder name: Test-primers set' }));
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('Test-primers set');
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Copy folder name: Test-primers set' })
      ).toHaveTextContent('Copied')
    );
  });

  it('explains when the folder name could not be copied', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    renderPanel();
    fireEvent.click(
      screen.getByRole('button', { name: 'Copy folder name: Plasmid Sequencing Results' })
    );

    expect(
      await screen.findByText('Could not copy. Select the folder name above and copy it manually.')
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Copy folder name: Plasmid Sequencing Results' })
    ).toHaveTextContent('Copy failed');
  });

  it('shows each folder count once without checkboxes or expandable target rows', () => {
    renderPanel();

    const firstFolder = screen.getByText('Plasmid Sequencing Results').closest('article');
    if (!firstFolder) throw new Error('Expected recovery folder card.');
    expect(within(firstFolder).getAllByText('2 linked items')).toHaveLength(1);
    expect(within(firstFolder).queryByText('See 2 linked items')).not.toBeInTheDocument();
    expect(
      within(firstFolder).queryByRole('button', { name: /Open item/ })
    ).not.toBeInTheDocument();
    expect(within(firstFolder).queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('adds several dropped ZIP files in one operation', async () => {
    const add = vi.fn(async () => undefined);
    renderPanel({ onAddExports: add });

    fireEvent.drop(screen.getByTestId('benchling-migration-linked-export-dropzone'), {
      dataTransfer: {
        files: [
          zipFile('Folder A.zip', '/Users/x/Downloads/Folder A.zip'),
          zipFile('Folder B.zip', '/Users/x/Downloads/Folder B.zip'),
        ],
        types: ['Files'],
      },
    });

    await waitFor(() =>
      expect(add).toHaveBeenCalledWith([
        '/Users/x/Downloads/Folder A.zip',
        '/Users/x/Downloads/Folder B.zip',
      ])
    );
  });

  it('passes a dropped unzipped export folder to main for validation and preparation', async () => {
    const add = vi.fn();
    renderPanel({ onAddExports: add });
    const folder = new File([], 'Benchling export');
    Object.defineProperty(folder, 'path', { value: '/Users/x/Downloads/Benchling export' });

    fireEvent.drop(screen.getByTestId('benchling-migration-linked-export-dropzone'), {
      dataTransfer: { files: [folder], types: ['Files'] },
    });

    await waitFor(() => expect(add).toHaveBeenCalledWith(['/Users/x/Downloads/Benchling export']));
  });

  it('shows durable progress and disables new selection while processing', () => {
    renderPanel({
      run: {
        ...runView(),
        linkedItemRecovery: {
          schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
          attemptId: 'attempt-1',
          state: 'parsing',
          selectedFileCount: 5,
          processedFileCount: 2,
          recoveredUniqueObjectCount: 1,
          repairedRelationshipCount: 1,
          startedAt: '2026-08-13T10:00:00.000Z',
          updatedAt: '2026-08-13T10:01:00.000Z',
        },
      },
    });

    expect(screen.getByText('Prepare one HTML export')).toBeVisible();
    expect(screen.getByText('Reading linked items (Step 2 of 7)')).toBeVisible();
    expect(screen.getByText('2 of 5 ZIP files read')).toBeVisible();
    expect(screen.queryByText(/Elapsed/)).not.toBeInTheDocument();
    expect(
      screen.getByText('Finish or retry this ZIP batch before opening the notebook.')
    ).toBeVisible();
    expect(screen.queryByText(/You can also open the notebook now/)).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('benchling-migration-choose-linked-exports')
    ).not.toBeInTheDocument();
  });

  it('shows a determinate bar only from measured work', () => {
    renderPanel({
      run: {
        ...runView(),
        linkedItemRecovery: {
          schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
          attemptId: 'attempt-large-copy',
          state: 'copying',
          selectedFileCount: 1,
          processedFileCount: 0,
          recoveredUniqueObjectCount: 0,
          repairedRelationshipCount: 0,
          retainedExistingObjectCount: 0,
          retainedExistingObjects: [],
          corroboratedExistingObjectCount: 0,
          startedAt: '2026-08-13T10:00:00.000Z',
          updatedAt: '2026-08-13T10:01:20.000Z',
          work: {
            kind: 'copy_bytes',
            completed: 1_400_000_000,
            total: 2_800_000_000,
          },
        },
      },
    });

    expect(screen.getByText('Copying Benchling export (Step 1 of 7)')).toBeVisible();
    expect(screen.getByText('1.4 GB of 2.8 GB copied')).toBeVisible();
    expect(screen.queryByText(/Elapsed/)).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    expect(screen.queryByText('0 of 1 ZIP files read')).not.toBeInTheDocument();
  });

  it('reports the exact number of objects checked during validation', () => {
    renderPanel({
      run: {
        ...runView(),
        linkedItemRecovery: {
          schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
          attemptId: 'attempt-large-validation',
          state: 'validating',
          selectedFileCount: 1,
          processedFileCount: 1,
          recoveredUniqueObjectCount: 17_474,
          repairedRelationshipCount: 67,
          retainedExistingObjectCount: 0,
          retainedExistingObjects: [],
          corroboratedExistingObjectCount: 0,
          startedAt: '2026-08-13T10:00:00.000Z',
          updatedAt: '2026-08-13T10:02:59.000Z',
          work: {
            kind: 'validate_objects',
            completed: 512,
            total: 18_025,
          },
        },
      },
    });

    expect(screen.getByText('Checking every object (Step 5 of 7)')).toBeVisible();
    expect(screen.getByText('512 of 18,025 objects checked')).toBeVisible();
    expect(screen.queryByText(/Elapsed/)).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
  });

  it('reports exact destination receipt progress before object validation', () => {
    renderPanel({
      run: {
        ...runView(),
        linkedItemRecovery: {
          schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
          attemptId: 'attempt-destination-validation',
          state: 'validating',
          selectedFileCount: 1,
          processedFileCount: 1,
          recoveredUniqueObjectCount: 17_474,
          repairedRelationshipCount: 67,
          retainedExistingObjectCount: 0,
          retainedExistingObjects: [],
          corroboratedExistingObjectCount: 0,
          startedAt: '2026-08-13T10:00:00.000Z',
          updatedAt: '2026-08-13T10:00:30.000Z',
          work: {
            kind: 'validate_saved_objects',
            completed: 9_013,
            total: 18_025,
          },
        },
      },
    });

    expect(screen.getByText('Checking saved objects (Step 5 of 7)')).toBeVisible();
    expect(screen.getByText('9,013 of 18,025 saved objects checked')).toBeVisible();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });

  it('reports exact source-file persistence after object validation', () => {
    renderPanel({
      run: {
        ...runView(),
        linkedItemRecovery: {
          schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
          attemptId: 'attempt-source-files',
          state: 'validating',
          selectedFileCount: 1,
          processedFileCount: 1,
          recoveredUniqueObjectCount: 17_474,
          repairedRelationshipCount: 284,
          retainedExistingObjectCount: 0,
          retainedExistingObjects: [],
          corroboratedExistingObjectCount: 0,
          startedAt: '2026-08-13T10:00:00.000Z',
          updatedAt: '2026-08-13T10:03:00.000Z',
          work: {
            kind: 'persist_source_files',
            completed: 8_590,
            total: 17_474,
          },
        },
      },
    });

    expect(screen.getByText('Saving source files (Step 6 of 7)')).toBeVisible();
    expect(screen.getByText('8,590 of 17,474 source files saved')).toBeVisible();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '49');
  });

  it('shows the final atomic workspace phase after source-file validation', () => {
    renderPanel({
      run: {
        ...runView(),
        linkedItemRecovery: {
          schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
          attemptId: 'attempt-finalize-workspace',
          state: 'validating',
          selectedFileCount: 1,
          processedFileCount: 1,
          recoveredUniqueObjectCount: 17_474,
          repairedRelationshipCount: 284,
          retainedExistingObjectCount: 0,
          retainedExistingObjects: [],
          corroboratedExistingObjectCount: 0,
          startedAt: '2026-08-13T10:00:00.000Z',
          updatedAt: '2026-08-13T10:03:00.000Z',
          work: { kind: 'finalize_workspace', completed: 0, total: 0 },
        },
      },
    });

    expect(screen.getByText('Finishing project (Step 7 of 7)')).toBeVisible();
    expect(screen.getByText('Saving the validated project')).toBeVisible();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('collapses into a completion summary when every target is recovered', () => {
    const evidence = recoveryEvidence();
    renderPanel({
      evidence: {
        ...evidence,
        recoveredUniqueObjectCount: 3,
        remainingUniqueObjectCount: 0,
        repairedRelationshipCount: 4,
        remainingRelationshipCount: 0,
        folders: evidence.folders.map((folder) => ({
          ...folder,
          recoveredTargetCount: folder.targetCount,
        })),
        targets: evidence.targets.map((target) => ({ ...target, recovered: true })),
      },
    });

    expect(screen.getByText('All 3 linked items were added')).toBeVisible();
    expect(screen.getByText('4 native relationships were added.')).toBeVisible();
    expect(
      screen.queryByTestId('benchling-migration-linked-export-dropzone')
    ).not.toBeInTheDocument();
  });

  it('keeps later dependency import available without showing replacement guarantees', () => {
    renderPanel({
      run: { ...runView(), state: 'unlocked', unlockedAt: '2026-08-13T11:00:00.000Z' },
    });

    expect(screen.getByTestId('benchling-migration-linked-export-dropzone')).toBeVisible();
    expect(
      screen.queryByText(/Existing notebook content and later edits are not replaced/)
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/You can also open the notebook now/)).not.toBeInTheDocument();
  });

  it('explains a safe zero-match batch without blocking another try or unlock', () => {
    const evidence = recoveryEvidence();
    renderPanel({
      evidence: {
        ...evidence,
        attempts: [
          {
            attemptId: 'attempt-hidden',
            selectedFileCount: 2,
            acceptedFileCount: 2,
            duplicateFileCount: 0,
            rejectedFileCount: 0,
            recoveredTargetCount: 0,
            repairedRelationshipCount: 0,
            outcome: 'failed',
            completedAt: '2026-08-13T11:00:00.000Z',
          },
        ],
      },
    });

    expect(screen.getByText(/imported the supported entities in that ZIP/)).toBeVisible();
    expect(screen.getByTestId('benchling-migration-linked-item-recovery')).toHaveTextContent(
      'confirm that the export included the folders listed above'
    );
    expect(screen.getByTestId('benchling-migration-linked-item-recovery')).not.toHaveTextContent(
      'not PDF'
    );
    expect(screen.getByTestId('benchling-migration-choose-linked-exports')).toBeEnabled();
    expect(screen.getByTestId('benchling-migration-linked-item-recovery')).not.toHaveTextContent(
      'attempt-hidden'
    );
  });

  it('distinguishes a rejected ZIP from a valid ZIP with no matching linked items', () => {
    const evidence = recoveryEvidence();
    renderPanel({
      evidence: {
        ...evidence,
        attempts: [
          {
            attemptId: 'attempt-rejected',
            selectedFileCount: 1,
            acceptedFileCount: 0,
            duplicateFileCount: 0,
            rejectedFileCount: 1,
            recoveredTargetCount: 0,
            repairedRelationshipCount: 0,
            outcome: 'failed',
            completedAt: '2026-08-25T21:20:34.753Z',
          },
        ],
      },
    });

    expect(screen.getByText(/could not read that export/)).toBeVisible();
    expect(screen.queryByText(/none matched the linked items/)).not.toBeInTheDocument();
    expect(screen.getByTestId('benchling-migration-choose-linked-exports')).toBeEnabled();
  });

  it('never carries a prior partial-batch result into the next upload screen', () => {
    const evidence = recoveryEvidence();
    renderPanel({
      evidence: {
        ...evidence,
        attempts: [
          {
            attemptId: 'attempt-prior-partial',
            selectedFileCount: 1,
            acceptedFileCount: 1,
            duplicateFileCount: 0,
            rejectedFileCount: 0,
            recoveredTargetCount: 50,
            repairedRelationshipCount: 67,
            outcome: 'partial',
            completedAt: '2026-08-13T11:00:00.000Z',
          },
        ],
      },
    });

    const panel = screen.getByTestId('benchling-migration-linked-item-recovery');
    expect(panel).not.toHaveTextContent('The last ZIP batch');
    expect(panel).not.toHaveTextContent('added 50 linked items');
    expect(panel).not.toHaveTextContent('repaired 67 links');
  });
});

function renderPanel({
  run = runView(),
  evidence = recoveryEvidence(),
  onAddExports = vi.fn(),
  onOpenLocation = vi.fn(),
  automation,
}: {
  run?: BenchlingMigrationRunView;
  evidence?: ValidationLinkedItemRecoveryEvidence;
  onAddExports?: (paths?: string[]) => Promise<unknown> | void;
  onOpenLocation?: (kind: 'folder' | 'target', sourceId: string) => Promise<unknown> | void;
  automation?: LinkedItemRecoveryAutomationAdapter;
} = {}) {
  return render(
    <LinkedItemRecoveryPanel
      run={run}
      evidence={evidence}
      pending={false}
      onAddExports={onAddExports}
      onOpenLocation={onOpenLocation}
      automation={automation}
    />
  );
}

function zipFile(name: string, path: string): File {
  const file = new File(['zip-bytes'], name, { type: 'application/zip' });
  Object.defineProperty(file, 'path', { value: path });
  return file;
}

function runView(): BenchlingMigrationRunView {
  return {
    version: 1,
    id: 'run-1',
    workspaceId: 'workspace-1',
    displayName: 'Benchling migration',
    scope: {
      version: 1,
      kind: 'folder',
      folder: {
        id: 'lib_selected',
        url: 'https://benchling.com/exampleuser/f_/lib_selected-selected-folder',
        objectType: 'folder',
      },
      includeChildren: false,
      includeArchived: false,
      acquisition: 'local_bundle',
    },
    binding: null,
    state: 'ready_to_unlock',
    resumeState: null,
    attempt: 1,
    converterVersions: { projection: '1' },
    createdAt: '2026-08-13T10:00:00.000Z',
    updatedAt: '2026-08-13T10:01:00.000Z',
    startedAt: '2026-08-13T10:00:01.000Z',
    unlockedAt: null,
    lastError: null,
    sourceArtifact: {
      kind: 'local_bundle',
      format: 'zip',
      fileName: 'Original.zip',
      sha256: `sha256:${'a'.repeat(64)}`,
      sizeBytes: 100,
    },
    localBundleState: 'ready',
  };
}

function recoveryEvidence(): ValidationLinkedItemRecoveryEvidence {
  return {
    schema: 'dnaforge.benchling.linked-item-recovery-validation.v1',
    organizationBaseUrl: 'https://benchling.com/exampleuser',
    relationshipCount: 4,
    uniqueTargetCount: 3,
    folderCount: 2,
    recoveredUniqueObjectCount: 0,
    remainingUniqueObjectCount: 3,
    repairedRelationshipCount: 0,
    remainingRelationshipCount: 4,
    folders: [
      {
        sourceId: 'lib_folder_a',
        name: 'Plasmid Sequencing Results',
        sourceUrl: 'https://benchling.com/exampleuser/f_/lib_folder_a-plasmid-results',
        targetCount: 2,
        relationshipCount: 2,
        countsByType: { dna_rna_sequence: 2, protein: 0, protocol: 0, other: 0 },
        recoveredTargetCount: 0,
      },
      {
        sourceId: 'lib_folder_b',
        name: 'Protocols',
        sourceUrl: 'https://benchling.com/exampleuser/f_/lib_folder_b-protocols',
        targetCount: 1,
        relationshipCount: 2,
        countsByType: { dna_rna_sequence: 0, protein: 0, protocol: 1, other: 0 },
        recoveredTargetCount: 0,
      },
    ],
    targets: [
      {
        sourceId: 'seq_target_a',
        name: 'Test AnsB sequence',
        sourceUrl:
          'https://benchling.com/exampleuser/f_/lib_folder_a-plasmids/seq_target_a-test-target',
        objectType: 'dna_rna_sequence',
        folderId: 'lib_folder_a',
        relationshipCount: 1,
        relationshipIds: ['relationship-1'],
        recovered: false,
      },
      {
        sourceId: 'seq_target_b',
        name: 'Plasmid sequence',
        sourceUrl:
          'https://benchling.com/exampleuser/f_/lib_folder_a-plasmids/seq_target_b-plasmid',
        objectType: 'dna_rna_sequence',
        folderId: 'lib_folder_a',
        relationshipCount: 1,
        relationshipIds: ['relationship-2'],
        recovered: false,
      },
      {
        sourceId: 'prt_target_c',
        name: 'Assembly protocol',
        sourceUrl:
          'https://benchling.com/exampleuser/f_/lib_folder_b-protocols/prt_target_c-assembly',
        objectType: 'protocol',
        folderId: 'lib_folder_b',
        relationshipCount: 2,
        relationshipIds: ['relationship-3', 'relationship-4'],
        recovered: false,
      },
    ],
    attempts: [],
  };
}
