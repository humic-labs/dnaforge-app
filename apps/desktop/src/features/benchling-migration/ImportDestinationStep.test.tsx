import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImportDestinationStep } from './ImportDestinationStep';
import type { BenchlingImportDestinationSelection } from './types';

function selection(
  candidates: BenchlingImportDestinationSelection['candidates']
): BenchlingImportDestinationSelection {
  return {
    sourcePath: '/Users/test/Downloads/sundew_export_2.zip',
    archiveName: 'sundew_export_2.zip',
    archiveObjectCount: 663,
    candidates,
  };
}

describe('Benchling import destination step', () => {
  it('does not offer to create an empty workspace from source-only tables', () => {
    const table = {
      archiveSha256: 'a'.repeat(64),
      entryPath: 'Notes.csv',
      entrySha256: 'b'.repeat(64),
      entrySizeBytes: 10,
      status: 'ready' as const,
      headersSha256: 'c'.repeat(64),
      headers: ['Note'],
      rowCount: 1,
      previewRows: [['Text']],
    };
    render(
      <ImportDestinationStep
        selection={{ ...selection([]), archiveObjectCount: 0, registryTables: [table] }}
        pending={false}
        onBack={vi.fn()}
        onImport={vi.fn()}
      />
    );
    expect(screen.getByRole('heading', { name: /1 table to review/ })).toBeVisible();
    fireEvent.change(screen.getByRole('combobox', { name: 'How to import Notes.csv' }), {
      target: { value: 'source_only' },
    });
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Reason for keeping Notes.csv in the original ZIP' }),
      { target: { value: 'Not records' } }
    );
    expect(screen.getByTestId('benchling-import-confirm-destination')).toBeDisabled();
    expect(screen.getByText(/Choose at least one table as Registry records/)).toBeVisible();
  });
  it('requires explicit table review on the existing destination screen and submits ordered column choices', () => {
    const onImport = vi.fn();
    const registryTables = [
      {
        archiveSha256: 'a'.repeat(64),
        entryPath: 'Records.csv',
        entrySha256: 'b'.repeat(64),
        entrySizeBytes: 48,
        status: 'ready' as const,
        headersSha256: 'c'.repeat(64),
        headers: ['Name', 'Amount', 'Amount', ''],
        rowCount: 2,
        previewRows: [['Same', '0', '007', 'α']],
      },
    ];
    render(
      <ImportDestinationStep
        selection={{ ...selection([]), registryTables }}
        pending={false}
        onBack={vi.fn()}
        onImport={onImport}
      />
    );
    const confirm = screen.getByTestId('benchling-import-confirm-destination');
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox', { name: 'How to import Records.csv' }), {
      target: { value: 'records' },
    });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Column 1 role' }), {
      target: { value: 'name' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Column 2 role' }), {
      target: { value: 'number' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Column 3 role' }), {
      target: { value: 'text' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Column 4 role' }), {
      target: { value: 'source_only' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Column 4 reason' }), {
      target: { value: 'Keep original note' },
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onImport).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewedTables: [
          expect.objectContaining({
            outcome: {
              kind: 'records',
              headersSha256: 'c'.repeat(64),
              rowCount: 2,
              columns: [
                { kind: 'name' },
                { kind: 'field', label: 'Amount', type: 'number' },
                { kind: 'field', label: 'Amount', type: 'text' },
                { kind: 'source_only', reason: 'Keep original note' },
              ],
            },
          }),
        ],
      })
    );
  });

  it('requires a reason before keeping an unreadable table source-only', () => {
    const onImport = vi.fn();
    const table = {
      archiveSha256: 'a'.repeat(64),
      entryPath: 'Large.csv',
      entrySha256: 'b'.repeat(64),
      entrySizeBytes: 20000000,
      status: 'unavailable' as const,
      reason: 'Table exceeds the conversion limit',
    };
    render(
      <ImportDestinationStep
        selection={{ ...selection([]), registryTables: [table] }}
        pending={false}
        onBack={vi.fn()}
        onImport={onImport}
      />
    );
    const confirm = screen.getByTestId('benchling-import-confirm-destination');
    expect(confirm).toBeDisabled();
    expect(screen.getByText(table.reason)).toBeVisible();
    fireEvent.change(screen.getByRole('combobox', { name: 'How to import Large.csv' }), {
      target: { value: 'source_only' },
    });
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Reason for keeping Large.csv in the original ZIP' }),
      { target: { value: 'Not a record list' } }
    );
    fireEvent.click(confirm);
    expect(onImport).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewedTables: [
          expect.objectContaining({
            outcome: { kind: 'source_only', reason: 'Not a record list' },
          }),
        ],
      })
    );
  });
  it('keeps a busy workspace visible with its overlap and a confirmation-time availability note', () => {
    render(
      <ImportDestinationStep
        selection={selection([
          {
            workspaceDbId: 1,
            workspaceName: 'Sundew',
            repoUuid: null,
            overlapCount: 663,
            busy: true,
          },
        ])}
        pending={false}
        onBack={vi.fn()}
        onImport={vi.fn()}
      />
    );
    expect(screen.queryByText('No existing projects found.')).not.toBeInTheDocument();
    expect(screen.getByText(/Finishing another task/)).toBeVisible();
    const choice = screen.getByRole('radio', { name: 'Sundew 663 of 663 entities have a match' });
    expect(choice).toBeChecked();
    expect(choice).toHaveAccessibleDescription(
      'Finishing another task. Availability is checked again when you import.'
    );
  });
  function chooseNewWorkspace() {
    fireEvent.click(screen.getByRole('button', { name: 'Create a new project' }));
  }

  it('ranks by overlap, shows exact counts, and preselects the strongest match', () => {
    render(
      <ImportDestinationStep
        selection={selection([
          {
            workspaceDbId: 2,
            workspaceName: 'DNAForge Samples',
            repoUuid: 'repo-samples',
            overlapCount: 0,
          },
          {
            workspaceDbId: 1,
            workspaceName: 'Sundew localization',
            repoUuid: 'repo-sundew',
            overlapCount: 412,
          },
          {
            workspaceDbId: 3,
            workspaceName: 'Single match',
            repoUuid: 'repo-single',
            overlapCount: 1,
          },
        ])}
        pending={false}
        onBack={vi.fn()}
        onImport={vi.fn()}
      />
    );

    expect(
      screen.getByRole('heading', { name: '663 entities found in sundew_export_2.zip' })
    ).toBeVisible();
    expect(
      screen.getByText('Choose an existing project to migrate into, or create a new one.')
    ).toBeVisible();
    expect(screen.getByTestId('benchling-import-destination-options')).toHaveClass('space-y-5');
    expect(screen.getByTestId('benchling-import-destination-options')).not.toHaveClass(
      'md:grid-cols-2'
    );
    expect(screen.getByRole('button', { name: 'Create a new project' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Project name' })).toBeVisible();
    expect(screen.queryByText('Where does this export belong?')).not.toBeInTheDocument();

    expect(screen.getByTestId('benchling-import-existing-workspaces')).toBeVisible();
    expect(screen.getByText('Best match')).toBeVisible();
    expect(screen.getByText('Other projects')).toBeVisible();
    const choices = screen.getAllByRole('radio');
    expect(within(choices[0].closest('label')!).getByText('Sundew localization')).toBeVisible();
    expect(within(choices[1].closest('label')!).getByText('Single match')).toBeVisible();
    expect(within(choices[2].closest('label')!).getByText('DNAForge Samples')).toBeVisible();
    expect(screen.getByText('412 of 663 entities have a match')).toBeVisible();
    expect(screen.getByText('1 of 663 entities has a match')).toBeVisible();
    expect(screen.getByText('No matching entities')).toBeVisible();
    expect(screen.getByRole('radio', { name: /Sundew localization/u })).toBeChecked();
  });

  it('shows the new-workspace controls beside the existing choices and selects them on demand', () => {
    render(
      <ImportDestinationStep
        selection={selection([
          {
            workspaceDbId: 1,
            workspaceName: 'Sundew localization',
            repoUuid: 'repo-sundew',
            overlapCount: 412,
          },
        ])}
        pending={false}
        onBack={vi.fn()}
        onImport={vi.fn()}
      />
    );

    const workspaceName = screen.getByRole('textbox', { name: 'Project name' });
    expect(workspaceName).toBeVisible();
    expect(screen.getByRole('radio', { name: /Sundew localization/u })).toBeVisible();
    expect(screen.getByTestId('benchling-import-confirm-destination')).toHaveTextContent(
      'Import into Sundew localization'
    );

    chooseNewWorkspace();

    fireEvent.change(workspaceName, { target: { value: 'My Benchling migration' } });

    expect(screen.getByTestId('benchling-import-confirm-destination')).toHaveTextContent(
      'Create project & import'
    );
  });

  it('allows a new workspace when every existing destination has zero overlap', () => {
    render(
      <ImportDestinationStep
        selection={selection([
          {
            workspaceDbId: 2,
            workspaceName: 'DNAForge Samples',
            repoUuid: 'repo-samples',
            overlapCount: 0,
          },
        ])}
        pending={false}
        onBack={vi.fn()}
        onImport={vi.fn()}
      />
    );

    chooseNewWorkspace();

    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue('sundew_export_2');
  });

  it('imports a new workspace with the edited trimmed name', () => {
    const onImport = vi.fn();
    render(
      <ImportDestinationStep
        selection={selection([])}
        pending={false}
        onBack={vi.fn()}
        onImport={onImport}
      />
    );

    chooseNewWorkspace();

    fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
      target: { value: '  Sundew localization  ' },
    });
    fireEvent.click(screen.getByTestId('benchling-import-confirm-destination'));

    expect(onImport).toHaveBeenCalledWith({
      kind: 'new_workspace',
      workspaceName: 'Sundew localization',
    });
  });

  it('does not import a new workspace with a blank name', () => {
    render(
      <ImportDestinationStep
        selection={selection([])}
        pending={false}
        onBack={vi.fn()}
        onImport={vi.fn()}
      />
    );

    chooseNewWorkspace();

    fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
      target: { value: '   ' },
    });

    expect(screen.getByTestId('benchling-import-confirm-destination')).toBeDisabled();
  });

  it('suggests a unique workspace name and refuses an existing name', () => {
    const onImport = vi.fn();
    render(
      <ImportDestinationStep
        selection={selection([
          {
            workspaceDbId: 1,
            workspaceName: 'sundew_export_2',
            repoUuid: 'repo-existing',
            overlapCount: 0,
          },
        ])}
        pending={false}
        onBack={vi.fn()}
        onImport={onImport}
      />
    );

    chooseNewWorkspace();

    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue(
      'sundew_export_2 (2)'
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
      target: { value: '  SUNDEW_EXPORT_2  ' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('A project with this name already exists.');
    expect(screen.getByTestId('benchling-import-confirm-destination')).toBeDisabled();
    expect(onImport).not.toHaveBeenCalled();
  });

  it('warns about duplicate entries before creating another copy', () => {
    render(
      <ImportDestinationStep
        selection={selection([
          {
            workspaceDbId: 1,
            workspaceName: 'Sundew localization',
            repoUuid: 'repo-sundew',
            overlapCount: 412,
          },
        ])}
        pending={false}
        onBack={vi.fn()}
        onImport={vi.fn()}
      />
    );

    expect(screen.queryByTestId('benchling-import-ambiguity-warning')).not.toBeInTheDocument();
    chooseNewWorkspace();
    expect(screen.getByTestId('benchling-import-ambiguity-warning')).toHaveTextContent(
      'Warning: This would create 412 duplicate entries'
    );
    expect(screen.getByTestId('benchling-import-confirm-destination')).toHaveTextContent(
      'Create project & import'
    );
  });

  it('sends the database identity for a workspace without a repository UUID', () => {
    const onImport = vi.fn();
    render(
      <ImportDestinationStep
        selection={selection([
          {
            workspaceDbId: 1,
            workspaceName: 'Sundew localization',
            repoUuid: null,
            overlapCount: 412,
          },
        ])}
        pending={false}
        onBack={vi.fn()}
        onImport={onImport}
      />
    );

    fireEvent.click(screen.getByTestId('benchling-import-confirm-destination'));
    expect(onImport).toHaveBeenCalledWith({
      kind: 'existing_workspace',
      workspaceDbId: 1,
    });
  });

  it('keeps a long alternate-workspace list compact until the user reveals it', () => {
    render(
      <ImportDestinationStep
        selection={selection([
          {
            workspaceDbId: 1,
            workspaceName: 'Best match',
            repoUuid: 'repo-best',
            overlapCount: 500,
          },
          ...Array.from({ length: 6 }, (_, index) => ({
            workspaceDbId: index + 2,
            workspaceName: `Alternate ${index + 1}`,
            repoUuid: `repo-alternate-${index + 1}`,
            overlapCount: 60 - index,
          })),
        ])}
        pending={false}
        onBack={vi.fn()}
        onImport={vi.fn()}
      />
    );

    expect(screen.getByRole('radio', { name: /Alternate 1/u })).toBeVisible();
    expect(screen.getByRole('radio', { name: /Alternate 3/u })).toBeVisible();
    expect(screen.queryByRole('radio', { name: /Alternate 4/u })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show 3 more projects' }));

    expect(screen.getByRole('radio', { name: /Alternate 4/u })).toBeVisible();
    expect(screen.getByRole('radio', { name: /Alternate 6/u })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Show fewer projects' })).toBeVisible();
    expect(screen.getByRole('radio', { name: /Best match/u })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Show fewer projects' }));

    expect(screen.queryByRole('radio', { name: /Alternate 4/u })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show 3 more projects' })).toBeVisible();
  });
});
