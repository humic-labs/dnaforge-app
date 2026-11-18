import { TextField } from '../../components/ui';
import { useMemo, useState } from 'react';
import { FolderOpenIcon, PlusIcon } from '../../components/icons/glyphs';
import type {
  BenchlingImportDestinationChoice,
  BenchlingImportDestinationSelection,
} from './types';
import { PrimaryButton, SecondaryButton } from './WizardPrimitives';
import { RegistryTableReview } from './RegistryTableReview';
import type { RegistryTableMappingDecision } from '../../shared/benchling-registry-table-review';

const NEW_WORKSPACE_VALUE = 'new_workspace';
const MAX_WORKSPACE_NAME_LENGTH = 120;
const INITIAL_ALTERNATE_WORKSPACE_COUNT = 3;

function suggestedWorkspaceName(archiveName: string, existingNames: readonly string[]): string {
  const withoutExtension = archiveName.replace(/\.[^.]+$/u, '').trim();
  const baseName = withoutExtension || 'Benchling import';
  const normalizedExistingNames = new Set(existingNames.map(normalizeWorkspaceName));
  if (!normalizedExistingNames.has(normalizeWorkspaceName(baseName))) return baseName;
  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const candidate = `${baseName} (${suffix})`;
    if (!normalizedExistingNames.has(normalizeWorkspaceName(candidate))) return candidate;
  }
  return `${baseName} (new)`;
}

function normalizeWorkspaceName(name: string): string {
  return name.trim().toLowerCase();
}

function formatWorkspaceMatchCount({
  matchingEntityCount,
  archiveEntityCount,
}: {
  matchingEntityCount: number;
  archiveEntityCount: number;
}): string {
  if (matchingEntityCount === 0) return 'No matching entities';
  const entityNoun = archiveEntityCount === 1 ? 'entity' : 'entities';
  const verb = matchingEntityCount === 1 ? 'has' : 'have';
  return `${matchingEntityCount.toLocaleString()} of ${archiveEntityCount.toLocaleString()} ${entityNoun} ${verb} a match`;
}

export function ImportDestinationStep({
  selection,
  pending,
  onBack,
  onImport,
}: {
  selection: BenchlingImportDestinationSelection;
  pending: boolean;
  onBack(): void;
  onImport(destination: BenchlingImportDestinationChoice): void | Promise<unknown>;
}) {
  const candidates = useMemo(
    () =>
      [...selection.candidates].sort(
        (left, right) =>
          right.overlapCount - left.overlapCount || left.workspaceDbId - right.workspaceDbId
      ),
    [selection.candidates]
  );
  const maxOverlap = candidates[0]?.overlapCount ?? 0;
  const recommendedCandidate = maxOverlap > 0 ? candidates[0] : null;
  const alternateCandidates = recommendedCandidate ? candidates.slice(1) : candidates;
  const defaultValue = recommendedCandidate
    ? String(recommendedCandidate.workspaceDbId)
    : NEW_WORKSPACE_VALUE;
  const [selectedValue, setSelectedValue] = useState(defaultValue);
  const [showAllAlternates, setShowAllAlternates] = useState(false);
  const [workspaceName, setWorkspaceName] = useState(() =>
    suggestedWorkspaceName(
      selection.archiveName,
      selection.candidates.map((candidate) => candidate.workspaceName)
    )
  );
  const trimmedWorkspaceName = workspaceName.trim();
  const [tableAnswers, setTableAnswers] = useState<
    ReadonlyMap<string, RegistryTableMappingDecision>
  >(new Map());
  const tables = selection.registryTables ?? [];
  const reviewedTables = tables.flatMap((table) => {
    const answer = tableAnswers.get(`${table.archiveSha256}:${table.entryPath}`);
    return answer ? [answer] : [];
  });
  const allTablesReviewed = reviewedTables.length === tables.length;
  const hasImportableContent =
    selection.archiveObjectCount > 0 ||
    reviewedTables.some((table) => table.outcome.kind === 'records' && table.outcome.rowCount > 0);
  const workspaceNameAlreadyExists = candidates.some(
    (candidate) =>
      normalizeWorkspaceName(candidate.workspaceName) === normalizeWorkspaceName(workspaceName)
  );
  const selectedCandidate = useMemo(
    () => candidates.find((candidate) => String(candidate.workspaceDbId) === selectedValue),
    [candidates, selectedValue]
  );
  const creatingNewWorkspace = selectedValue === NEW_WORKSPACE_VALUE;
  const choice: BenchlingImportDestinationChoice | null = creatingNewWorkspace
    ? { kind: 'new_workspace', workspaceName: trimmedWorkspaceName }
    : selectedCandidate
      ? { kind: 'existing_workspace', workspaceDbId: selectedCandidate.workspaceDbId }
      : null;
  const visibleAlternateCandidates = showAllAlternates
    ? alternateCandidates
    : alternateCandidates.slice(0, INITIAL_ALTERNATE_WORKSPACE_COUNT);
  const hiddenAlternateCount = alternateCandidates.length - visibleAlternateCandidates.length;
  const canCollapseAlternates =
    showAllAlternates && alternateCandidates.length > INITIAL_ALTERNATE_WORKSPACE_COUNT;

  return (
    <section className="space-y-5" data-testid="benchling-import-destination-step">
      <div className="mx-auto max-w-3xl text-center">
        <h3 className="break-words text-2xl font-semibold tracking-tight text-fg">
          <span className="text-accent">
            {selection.archiveObjectCount === 0 && tables.length > 0
              ? `${tables.length} ${tables.length === 1 ? 'table' : 'tables'} to review`
              : `${selection.archiveObjectCount.toLocaleString()} ${selection.archiveObjectCount === 1 ? 'entity' : 'entities'} found`}
          </span>{' '}
          in {selection.archiveName}
        </h3>
        <p className="mt-2 text-sm text-fg-muted">
          Choose an existing project to migrate into, or create a new one.
        </p>
      </div>

      <div
        data-testid="benchling-import-destination-options"
        className="mx-auto w-full max-w-4xl space-y-5"
      >
        <div data-testid="benchling-import-existing-workspaces" className="min-w-0 space-y-3">
          <div className="flex items-center gap-2">
            <span
              className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-bg-muted text-fg-muted"
              aria-hidden="true"
            >
              <FolderOpenIcon className="h-4 w-4" />
            </span>
            <h4 className="text-sm font-semibold text-fg">Existing projects</h4>
          </div>
          {candidates.length > 0 ? (
            <fieldset className="space-y-2" disabled={pending}>
              <legend className="sr-only">Existing projects</legend>
              {recommendedCandidate ? (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-success">
                    Best match
                  </p>
                  <DestinationRadioRow
                    candidate={recommendedCandidate}
                    archiveObjectCount={selection.archiveObjectCount}
                    selected={selectedValue === String(recommendedCandidate.workspaceDbId)}
                    onSelect={setSelectedValue}
                  />
                </div>
              ) : null}

              {alternateCandidates.length > 0 ? (
                <div className="space-y-1.5 pt-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
                    Other projects
                  </p>
                  <div className="space-y-2">
                    {visibleAlternateCandidates.map((candidate) => (
                      <DestinationRadioRow
                        key={candidate.workspaceDbId}
                        candidate={candidate}
                        archiveObjectCount={selection.archiveObjectCount}
                        selected={selectedValue === String(candidate.workspaceDbId)}
                        onSelect={setSelectedValue}
                      />
                    ))}
                    {hiddenAlternateCount > 0 || canCollapseAlternates ? (
                      <button
                        type="button"
                        onClick={() => setShowAllAlternates((visible) => !visible)}
                        className="w-full rounded px-3 py-2 text-left text-xs font-medium text-fg-muted wp-interactive "
                      >
                        {canCollapseAlternates ? (
                          'Show fewer projects'
                        ) : (
                          <>
                            Show {hiddenAlternateCount} more project
                            {hiddenAlternateCount === 1 ? '' : 's'}
                          </>
                        )}
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </fieldset>
          ) : (
            <div className="rounded-xl border border-border bg-bg-muted/30 p-4">
              <p className="mt-1 text-xs text-fg-muted">No existing projects found.</p>
            </div>
          )}
        </div>

        <div
          data-testid="benchling-import-new-workspace"
          className={`min-w-0 space-y-4 rounded-xl border p-4 transition-colors ${
            creatingNewWorkspace ? 'border-accent bg-accent/[0.035]' : 'border-border bg-bg'
          }`}
        >
          <button
            type="button"
            disabled={pending}
            aria-pressed={creatingNewWorkspace}
            aria-label="Create a new project"
            onClick={() => setSelectedValue(NEW_WORKSPACE_VALUE)}
            className="flex w-full items-center gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span
              className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent/10 text-accent"
              aria-hidden="true"
            >
              <PlusIcon className="h-4 w-4" />
            </span>
            <span>
              <span className="block text-sm font-semibold text-fg">Create a new project</span>
              <span className="mt-0.5 block text-xs text-fg-muted">
                Choose its name before importing.
              </span>
            </span>
          </button>

          <div className="space-y-1.5">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-fg">Project name</span>
              <TextField
                type="text"
                value={workspaceName}
                maxLength={MAX_WORKSPACE_NAME_LENGTH}
                disabled={pending}
                onFocus={() => setSelectedValue(NEW_WORKSPACE_VALUE)}
                onChange={(event) => {
                  setSelectedValue(NEW_WORKSPACE_VALUE);
                  setWorkspaceName(event.target.value);
                }}
                aria-invalid={workspaceNameAlreadyExists}
                aria-describedby={workspaceNameAlreadyExists ? 'workspace-name-error' : undefined}
              />
            </label>
            {workspaceNameAlreadyExists ? (
              <p id="workspace-name-error" role="alert" className="text-xs text-error">
                A project with this name already exists. Choose a different name.
              </p>
            ) : null}
          </div>

          {creatingNewWorkspace && maxOverlap > 0 ? (
            <div
              role="alert"
              data-testid="benchling-import-ambiguity-warning"
              className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs leading-relaxed text-fg"
            >
              Warning: This would create {maxOverlap.toLocaleString()} duplicate{' '}
              {maxOverlap === 1 ? 'entry' : 'entries'}
            </div>
          ) : null}
        </div>
      </div>

      {tables.length > 0 ? (
        <section aria-label="Review exported tables" className="mx-auto max-w-4xl space-y-3">
          <h4 className="text-sm font-semibold text-fg">Review exported tables</h4>
          <p className="text-sm text-fg-muted">
            These tables have no schema. Choose what to turn into editable Registry records.
          </p>
          {tables.map((table) => {
            const key = `${table.archiveSha256}:${table.entryPath}`;
            return (
              <RegistryTableReview
                key={key}
                candidate={table}
                pending={pending}
                onChange={(decision) =>
                  setTableAnswers((previous) => {
                    const next = new Map(previous);
                    if (decision) next.set(key, decision);
                    else next.delete(key);
                    return next;
                  })
                }
              />
            );
          })}
        </section>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        {allTablesReviewed && !hasImportableContent && tables.length > 0 ? (
          <p role="status" className="mr-auto text-xs text-fg-muted">
            Choose at least one table as Registry records, or go back. Source-only tables stay in
            the original ZIP.
          </p>
        ) : null}
        <SecondaryButton label="Back" pending={pending} onClick={onBack} />
        {choice ? (
          <PrimaryButton
            dataTestId="benchling-import-confirm-destination"
            label={
              choice.kind === 'existing_workspace' && selectedCandidate
                ? `Import into ${selectedCandidate.workspaceName}`
                : 'Create project & import'
            }
            pendingLabel={
              choice.kind === 'existing_workspace' ? 'Starting import' : 'Creating project'
            }
            pending={pending}
            disabled={
              !allTablesReviewed ||
              !hasImportableContent ||
              (choice.kind === 'new_workspace' &&
                (trimmedWorkspaceName === '' || workspaceNameAlreadyExists))
            }
            onClick={() => onImport(tables.length ? { ...choice, reviewedTables } : choice)}
          />
        ) : null}
      </div>
    </section>
  );
}

function DestinationRadioRow({
  candidate,
  archiveObjectCount,
  selected,
  onSelect,
}: {
  candidate: BenchlingImportDestinationSelection['candidates'][number];
  archiveObjectCount: number;
  selected: boolean;
  onSelect(workspaceDbId: string): void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center justify-between gap-4 rounded-lg border px-3 py-3 transition-colors ${
        selected ? 'border-accent bg-accent/[0.035]' : 'border-border wp-interactive'
      }`}
    >
      <span className="flex min-w-0 items-center gap-3">
        <input
          type="radio"
          name="benchling-import-destination"
          value={candidate.workspaceDbId}
          checked={selected}
          onChange={() => onSelect(String(candidate.workspaceDbId))}
        />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-fg">
            {candidate.workspaceName}
          </span>
          {candidate.busy ? (
            <span className="block text-xs text-fg-muted">
              Finishing another task. Availability is checked again when you import.
            </span>
          ) : null}
        </span>
      </span>
      <span className="flex-none text-xs text-fg-muted">
        {formatWorkspaceMatchCount({
          matchingEntityCount: candidate.overlapCount,
          archiveEntityCount: archiveObjectCount,
        })}
      </span>
    </label>
  );
}
