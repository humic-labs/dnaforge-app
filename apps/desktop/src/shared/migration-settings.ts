export type MigrationTone = 'neutral' | 'progress' | 'success' | 'warning' | 'error';

export type MigrationSourceView = Readonly<{
  id: string;
  name: string;
  description: string;
  actionLabel: string;
  onStart(): void;
}>;

export type ActiveMigrationView = Readonly<{
  id: string;
  sourceId: string;
  sourceName: string;
  phase: string;
  completed: string;
  eta: string;
  warnings: readonly string[];
  message: string | null;
  tone: MigrationTone;
  onOpen(): void;
}>;

export type MigrationHistoryEntryView = Readonly<{
  id: string;
  sourceId: string;
  sourceName: string;
  title: string;
  occurredAt: string;
  stateLabel: string;
  createdObjectCount: number;
  workspaceAction:
    | Readonly<{ kind: 'available'; onOpen(): void }>
    | Readonly<{ kind: 'unavailable' }>;
  missingDependencies:
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'available'; count: number; onImport(): void }>
    | Readonly<{ kind: 'unavailable'; count: number }>;
  onOpenDetails(): void;
}>;

export type MigrationSettingsView = Readonly<{
  sources: readonly MigrationSourceView[];
  activeMigration: ActiveMigrationView | null;
  history: readonly MigrationHistoryEntryView[];
  historyError: string | null;
}>;
