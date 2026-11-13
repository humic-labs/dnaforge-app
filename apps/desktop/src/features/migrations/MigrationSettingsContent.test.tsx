import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MigrationSettingsContent } from './MigrationSettingsContent';
import type { MigrationSettingsView } from '../../shared/migration-settings';

function makeView(overrides: Partial<MigrationSettingsView> = {}): MigrationSettingsView {
  return {
    sources: [
      {
        id: 'benchling',
        name: 'Benchling',
        description: 'Import Benchling data.',
        actionLabel: 'Migrate from Benchling',
        onStart: vi.fn(),
      },
    ],
    activeMigration: null,
    history: [],
    historyError: null,
    ...overrides,
  };
}

describe('MigrationSettingsContent', () => {
  it('uses the shared Settings hierarchy for subsection titles', () => {
    render(
      <MigrationSettingsContent
        view={makeView({
          activeMigration: {
            id: 'run-active',
            sourceId: 'benchling',
            sourceName: 'Benchling',
            phase: 'Importing',
            completed: '1 of 2',
            eta: 'Soon',
            warnings: [],
            message: null,
            tone: 'progress',
            onOpen: vi.fn(),
          },
        })}
      />
    );

    for (const name of ['Import from another system', 'Current migration', 'Migration history']) {
      const heading = screen.getByRole('heading', { name });
      expect(heading).toHaveClass('text-xl', 'font-semibold', 'tracking-tight');
      expect(heading).not.toHaveClass('text-sm');
    }
  });

  it('renders every configured source without provider-specific UI changes', () => {
    const startBenchling = vi.fn();
    const startOther = vi.fn();
    render(
      <MigrationSettingsContent
        view={makeView({
          sources: [
            {
              id: 'benchling',
              name: 'Benchling',
              description: 'Import Benchling data.',
              actionLabel: 'Migrate from Benchling',
              onStart: startBenchling,
            },
            {
              id: 'other-eln',
              name: 'Other ELN',
              description: 'Import another source.',
              actionLabel: 'Migrate from Other ELN',
              onStart: startOther,
            },
          ],
        })}
      />
    );

    fireEvent.click(screen.getByTestId('migration-source-start-benchling'));
    fireEvent.click(screen.getByTestId('migration-source-start-other-eln'));

    expect(startBenchling).toHaveBeenCalledTimes(1);
    expect(startOther).toHaveBeenCalledTimes(1);
  });

  it('shows current status and opens the active migration', () => {
    const onOpen = vi.fn();
    render(
      <MigrationSettingsContent
        view={makeView({
          activeMigration: {
            id: 'run-active',
            sourceId: 'benchling',
            sourceName: 'Benchling',
            phase: 'Validating the workspace',
            completed: '45 of 45',
            eta: 'Calculating',
            warnings: ['One linked item is missing.'],
            message: 'Native objects have been written.',
            tone: 'progress',
            onOpen,
          },
        })}
      />
    );

    expect(screen.getByTestId('active-migration')).toHaveTextContent('Benchling');
    expect(screen.getByTestId('active-migration')).toHaveTextContent('45 of 45');
    expect(screen.getByTestId('active-migration')).toHaveTextContent('One linked item is missing.');
    fireEvent.click(screen.getByTestId('active-migration-open'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows provider-labelled history and opens a selected run', () => {
    const onOpenDetails = vi.fn();
    const onOpenWorkspace = vi.fn();
    const onImportMissingDependencies = vi.fn();
    render(
      <MigrationSettingsContent
        view={makeView({
          history: [
            {
              id: 'run-history',
              sourceId: 'benchling',
              sourceName: 'Benchling',
              title: 'Notebook export.zip',
              occurredAt: '2026-08-17T18:00:00.000Z',
              stateLabel: 'Completed',
              createdObjectCount: 46,
              workspaceAction: { kind: 'available', onOpen: onOpenWorkspace },
              missingDependencies: {
                kind: 'available',
                count: 39,
                onImport: onImportMissingDependencies,
              },
              onOpenDetails,
            },
          ],
        })}
      />
    );

    const row = screen.getByTestId('migration-history-benchling-run-history');
    expect(row).toHaveTextContent('Benchling');
    expect(row).toHaveTextContent('Notebook export.zip');
    expect(row).toHaveTextContent('46 entities');
    expect(row).not.toHaveTextContent('Links to 39 entities in other folders');
    fireEvent.click(row);
    expect(onOpenDetails).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Open project' }));
    expect(onOpenWorkspace).toHaveBeenCalledTimes(1);
    expect(onOpenDetails).toHaveBeenCalledTimes(1);

    expect(
      screen.queryByRole('button', { name: 'Import linked entities' })
    ).not.toBeInTheDocument();
    expect(onImportMissingDependencies).not.toHaveBeenCalled();
    expect(screen.getByText('Review what was imported.')).toBeVisible();
    expect(screen.queryByText(/linked from other folders/iu)).not.toBeInTheDocument();
  });

  it('does not offer workspace or dependency actions for an incomplete migration', () => {
    render(
      <MigrationSettingsContent
        view={makeView({
          history: [
            {
              id: 'run-failed',
              sourceId: 'benchling',
              sourceName: 'Benchling',
              title: 'Failed export.zip',
              occurredAt: '2026-08-17T18:00:00.000Z',
              stateLabel: 'Failed',
              createdObjectCount: 0,
              workspaceAction: { kind: 'unavailable' },
              missingDependencies: { kind: 'unavailable', count: 3 },
              onOpenDetails: vi.fn(),
            },
          ],
        })}
      />
    );

    expect(screen.queryByText('Links to 3 entities in other folders')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open project' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Import linked entities' })
    ).not.toBeInTheDocument();
  });
});
