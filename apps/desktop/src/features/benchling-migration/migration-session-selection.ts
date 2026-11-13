export type MigrationInitialView = 'summary' | 'missing_dependencies';

export type MigrationSessionSelection =
  | Readonly<{
      mode: 'new';
      observedRunId: undefined;
      selectedRunId: undefined;
      initialView: 'summary';
    }>
  | Readonly<{
      mode: 'existing';
      observedRunId: string | undefined;
      selectedRunId: string | undefined;
      initialView: MigrationInitialView;
    }>;

export type MigrationSessionSelectionEvent =
  | Readonly<{ type: 'run_observed'; runId: string | undefined }>
  | Readonly<{ type: 'modal_closed' }>
  | Readonly<{ type: 'new_migration_opened' }>
  | Readonly<{ type: 'active_migration_opened' }>
  | Readonly<{ type: 'history_opened'; runId: string }>
  | Readonly<{ type: 'missing_dependencies_opened'; runId: string }>
  | Readonly<{ type: 'workspace_opened' }>;

export type MigrationSessionOpenEvent = Extract<
  MigrationSessionSelectionEvent,
  {
    type:
      | 'new_migration_opened'
      | 'active_migration_opened'
      | 'history_opened'
      | 'missing_dependencies_opened';
  }
>;

export const initialMigrationSessionSelection: MigrationSessionSelection = {
  mode: 'existing',
  observedRunId: undefined,
  selectedRunId: undefined,
  initialView: 'summary',
};

const newMigrationSessionSelection: MigrationSessionSelection = {
  mode: 'new',
  observedRunId: undefined,
  selectedRunId: undefined,
  initialView: 'summary',
};

export function reduceMigrationSessionSelection(
  state: MigrationSessionSelection,
  event: MigrationSessionSelectionEvent
): MigrationSessionSelection {
  switch (event.type) {
    case 'run_observed': {
      if (state.mode === 'new' && event.runId === undefined) return state;
      return {
        mode: 'existing',
        observedRunId: event.runId,
        selectedRunId: state.mode === 'existing' ? state.selectedRunId : undefined,
        initialView: state.mode === 'existing' ? state.initialView : 'summary',
      };
    }
    case 'modal_closed':
      if (state.mode === 'new') return state;
      return { ...state, selectedRunId: state.observedRunId };
    case 'new_migration_opened':
      return newMigrationSessionSelection;
    case 'active_migration_opened':
      return initialMigrationSessionSelection;
    case 'history_opened':
      return {
        mode: 'existing',
        observedRunId: event.runId,
        selectedRunId: event.runId,
        initialView: 'summary',
      };
    case 'missing_dependencies_opened':
      return {
        mode: 'existing',
        observedRunId: event.runId,
        selectedRunId: event.runId,
        initialView: 'missing_dependencies',
      };
    case 'workspace_opened':
      return initialMigrationSessionSelection;
  }
}
