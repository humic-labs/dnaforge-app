import { toUserMessage } from '@waypoint/user-messages';
import type { MigrationSettingsView, MigrationTone } from '../../shared/migration-settings';
import {
  SETTINGS_PRIMARY_BUTTON_CLASS,
  SETTINGS_SECONDARY_BUTTON_CLASS,
  SETTINGS_SURFACE_CLASS,
  SettingsSubsectionHeader,
} from '../../components/SettingsSubsection';

const TONE_CLASSES: Record<MigrationTone, string> = {
  neutral: SETTINGS_SURFACE_CLASS,
  progress: 'bg-accent/5',
  success: 'bg-success/5',
  warning: 'bg-warning/5',
  error: 'bg-error/5',
};

export function MigrationSettingsContent({ view }: { view: MigrationSettingsView }) {
  return (
    <div className="space-y-6" data-testid="migration-settings-content">
      <section aria-labelledby="migration-sources-heading">
        <SettingsSubsectionHeader
          headingId="migration-sources-heading"
          title="Import from another system"
          description="Start a new migration from any supported source. Each source keeps its own import rules, while history and results use the same DNAForge view."
        />
        <div className="mt-3 space-y-3">
          {view.sources.map((source) => (
            <article
              key={source.id}
              data-testid={`migration-source-${source.id}`}
              className={`flex min-w-0 items-start justify-between gap-4 rounded-md p-4 ${SETTINGS_SURFACE_CLASS}`}
            >
              <div className="min-w-0">
                <h5 className="text-sm font-medium text-fg">{source.name}</h5>
                <p className="mt-1 text-xs leading-5 text-fg-muted">{source.description}</p>
              </div>
              <button
                type="button"
                data-testid={`migration-source-start-${source.id}`}
                onClick={source.onStart}
                className={`${SETTINGS_PRIMARY_BUTTON_CLASS} flex-none`}
              >
                {source.actionLabel}
              </button>
            </article>
          ))}
        </div>
      </section>

      {view.activeMigration ? (
        <section aria-labelledby="active-migration-heading">
          <SettingsSubsectionHeader
            headingId="active-migration-heading"
            title="Current migration"
          />
          <article
            data-testid="active-migration"
            className={`mt-3 rounded-md p-4 ${TONE_CLASSES[view.activeMigration.tone]}`}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-fg-subtle">
                  {view.activeMigration.sourceName}
                </div>
                <h5 className="mt-1 text-sm font-semibold text-fg">{view.activeMigration.phase}</h5>
              </div>
              <button
                type="button"
                data-testid="active-migration-open"
                onClick={view.activeMigration.onOpen}
                className={`${SETTINGS_SECONDARY_BUTTON_CLASS} flex-none`}
              >
                Open migration
              </button>
            </div>
            <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-fg-subtle">Completed</dt>
                <dd className="mt-0.5 font-medium text-fg" data-testid="active-migration-completed">
                  {view.activeMigration.completed}
                </dd>
              </div>
              <div>
                <dt className="text-fg-subtle">ETA</dt>
                <dd className="mt-0.5 font-medium text-fg" data-testid="active-migration-eta">
                  {view.activeMigration.eta}
                </dd>
              </div>
              <div>
                <dt className="text-fg-subtle">Warnings</dt>
                <dd className="mt-0.5 font-medium text-fg">
                  {view.activeMigration.warnings.length === 0
                    ? 'None'
                    : `${view.activeMigration.warnings.length} warning${
                        view.activeMigration.warnings.length === 1 ? '' : 's'
                      }`}
                </dd>
              </div>
            </dl>
            {view.activeMigration.warnings.length > 0 ? (
              <ul className="mt-3 space-y-1 rounded-md bg-warning/5 p-3 text-xs leading-5 text-fg-muted">
                {view.activeMigration.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            {view.activeMigration.message ? (
              <div className="mt-3 rounded-md bg-black/[0.025] p-3 text-xs dark:bg-white/[0.035]">
                <div className="text-[10px] font-medium uppercase tracking-wide text-fg-subtle">
                  Latest update
                </div>
                <p className="mt-1 leading-5 text-fg-muted">
                  {toUserMessage(view.activeMigration.message, 'operation.failed')}
                </p>
              </div>
            ) : null}
          </article>
        </section>
      ) : null}

      <section aria-labelledby="migration-history-heading">
        <SettingsSubsectionHeader
          headingId="migration-history-heading"
          title="Migration history"
          description="Review what was imported."
          trailing={
            <span className="text-xs tabular-nums text-fg-subtle">{view.history.length}</span>
          }
        />
        {view.historyError ? (
          <p className="mt-3 rounded-md bg-error/5 p-3 text-xs text-error">{view.historyError}</p>
        ) : view.history.length === 0 ? (
          <p className="mt-3 py-5 text-center text-xs text-fg-muted">No past migrations yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {view.history.map((entry) => (
              <li key={`${entry.sourceId}:${entry.id}`}>
                <article className={`rounded-md px-4 py-3 ${SETTINGS_SURFACE_CLASS}`}>
                  <button
                    type="button"
                    data-testid={`migration-history-${entry.sourceId}-${entry.id}`}
                    onClick={entry.onOpenDetails}
                    className="w-full rounded text-left transition-colors wp-interactive "
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="rounded bg-bg-muted px-1.5 py-0.5 text-[10px] font-medium text-fg-muted">
                            {entry.sourceName}
                          </span>
                          <span className="truncate text-sm font-medium text-fg">
                            {entry.title}
                          </span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-muted">
                          <span>{entry.stateLabel}</span>
                          <span>{entry.createdObjectCount} entities</span>
                          {}
                        </div>
                      </div>
                      <time
                        dateTime={entry.occurredAt}
                        className="flex-none text-xs text-fg-subtle"
                      >
                        {formatHistoryDate(entry.occurredAt)}
                      </time>
                    </div>
                  </button>
                  {entry.workspaceAction.kind === 'available' ? (
                    <div className="mt-3 flex flex-wrap gap-2 pt-2">
                      <button
                        type="button"
                        onClick={entry.workspaceAction.onOpen}
                        className={SETTINGS_PRIMARY_BUTTON_CLASS}
                      >
                        Open project
                      </button>
                    </div>
                  ) : null}
                </article>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function formatHistoryDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Unknown date';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    timestamp
  );
}
