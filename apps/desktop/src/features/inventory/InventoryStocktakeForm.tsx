import { useEffect, useRef, useState } from 'react';
import {
  INVENTORY_STOCKTAKE_COLUMNS,
  MAX_INVENTORY_BATCH_COMMANDS,
  type InventoryObservationSubject,
  type InventoryQuantityInput,
  type InventoryStocktakeChoices,
  type InventoryStocktakeRowPreview,
  type InventoryStocktakeSubjectSnapshot,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea, TextField } from '../../components/ui';
import { platform } from '../../platform';
import type {
  InventoryClient,
  InventoryStocktakePreviewSnapshot,
} from '../../shared/inventory-client';
import { readInventoryArchiveFile } from './inventory-archive-file';
import {
  inventoryCanEdit,
  type InventoryController,
  type InventoryControllerState,
  type InventoryData,
} from './inventory-controller';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import {
  inventoryAmountLabel,
  inventoryCustodyLabel,
  locationPath,
  vesselLocation,
} from './inventory-view';

interface StocktakeInspection {
  subjectKeys: readonly string[];
  locationKeys: readonly string[];
  rows: readonly InventoryStocktakeRowPreview[];
}
interface StocktakeDraftFacts {
  sourceText: string;
  sourcePath: string | null;
  choices: InventoryStocktakeChoices;
  inspection: StocktakeInspection;
}
type StocktakeDraft = StocktakeDraftFacts &
  (
    | { phase: 'editing' | 'reading-source' | 'previewing' }
    | { phase: 'previewed'; preview: InventoryStocktakePreviewSnapshot }
    | { phase: 'failed'; message: string }
  );
const emptyInspection: StocktakeInspection = { subjectKeys: [], locationKeys: [], rows: [] };
const facts = (draft: StocktakeDraft): StocktakeDraftFacts => ({
  sourceText: draft.sourceText,
  sourcePath: draft.sourcePath,
  choices: draft.choices,
  inspection: draft.inspection,
});
const emptyChoices = (): InventoryStocktakeChoices => ({
  namespace: '',
  delimiter: ',',
  subjects: [],
  locations: [],
  decisions: [],
});
const subjectValue = (subject: InventoryObservationSubject): string =>
  subject.kind === 'stock' ? `stock:${subject.stockId}` : `${subject.item.kind}:${subject.item.id}`;
const quantityLabel = (quantity: InventoryQuantityInput | null): string =>
  quantity === null ? 'Not observed' : inventoryAmountLabel(quantity);
function replaceKey<T extends { key: string }>(items: readonly T[], key: string, value?: T): T[] {
  return [...items.filter((item) => item.key !== key), ...(value ? [value] : [])];
}

function StocktakeSnapshot({
  label,
  snapshot,
}: {
  label: string;
  snapshot: InventoryStocktakeSubjectSnapshot | null;
}) {
  if (!snapshot) return null;
  return (
    <div className="space-y-1 rounded bg-bg-subtle p-2" data-snapshot={label}>
      <p className="font-medium">{label}</p>
      {snapshot.quantity ? <p>Quantity: {quantityLabel(snapshot.quantity)}</p> : null}
      {snapshot.custody ? <p>Custody: {inventoryCustodyLabel(snapshot.custody)}</p> : null}
      {snapshot.availability ? (
        <p>
          Held: {inventoryAmountLabel(snapshot.availability.held)} · Unreserved:{' '}
          {quantityLabel(snapshot.availability.unreserved)}
        </p>
      ) : null}
    </div>
  );
}

export function InventoryStocktakeForm({
  data,
  controller,
  status,
  client,
  onClose,
}: {
  data: InventoryData;
  controller: InventoryController;
  status: InventoryControllerState;
  client: InventoryClient;
  onClose(): void;
}) {
  const pending =
    'attempt' in status &&
    status.attempt &&
    'kind' in status.attempt.request &&
    status.attempt.request.kind === 'apply-stocktake'
      ? status.attempt.request
      : null;
  const [draft, setDraft] = useState<StocktakeDraft>(() => ({
    phase: 'editing',
    sourceText: pending?.sourceText ?? '',
    sourcePath: null,
    choices: pending?.options ?? emptyChoices(),
    inspection: emptyInspection,
  }));
  const generation = useRef(0);
  const [subjectQuery, setSubjectQuery] = useState('');
  const activeAttempt =
    status.kind === 'submitting' ||
    status.kind === 'outcome-unknown' ||
    status.kind === 'committed-refresh-failed';
  const busy = activeAttempt || draft.phase === 'reading-source' || draft.phase === 'previewing';
  const preview = draft.phase === 'previewed' ? draft.preview : null;
  const stale = Boolean(
    preview &&
    (preview.target.projectId !== data.project.projectId ||
      preview.target.inventoryId !== data.project.defaultInventoryId ||
      preview.target.revision !== data.state.revision ||
      ((status.kind === 'refused' || status.kind === 'conflict') &&
        status.attempt &&
        'kind' in status.attempt.request &&
        status.attempt.request.kind === 'apply-stocktake'))
  );
  const canApply = preview?.kind === 'ready' && !stale && inventoryCanEdit(status);
  const inspectedIds = new Set(draft.inspection.rows.map((row) => row.observationId));
  const recorded = Object.values(data.state.observations).filter(
    (observation) =>
      observation.namespace === draft.choices.namespace &&
      inspectedIds.has(observation.observationId)
  );
  const recordedSubjects = new Set(
    recorded.map((observation) => subjectValue(observation.subject))
  );
  const subjectCandidates: {
    value: string;
    label: string;
    subject: InventoryObservationSubject;
  }[] = [
    ...Object.values(data.state.stocks).map((stock) => ({
      value: `stock:${stock.id}`,
      label: `Stock: ${data.state.vessels[stock.vesselId]?.name ?? stock.vesselId} · ${quantityLabel(stock.quantity)} · ${stock.id}`,
      subject: { kind: 'stock' as const, stockId: stock.id },
    })),
    ...Object.values(data.state.storage).map((item) => ({
      value: `storage:${item.id}`,
      label: `Location: ${locationPath(data.state, item.id)} · ${item.id}${item.lifecycle === 'disposed' ? ' · Disposed' : ''}`,
      subject: { kind: 'item' as const, item: { kind: 'storage' as const, id: item.id } },
    })),
    ...Object.values(data.state.vessels).map((item) => ({
      value: `vessel:${item.id}`,
      label: `${item.kind === 'fixed-well' ? 'Permanent well' : 'Container'}: ${item.name} · ${vesselLocation(data.state, item)} · ${item.id}${item.lifecycle === 'disposed' ? ' · Disposed' : ''}`,
      subject: { kind: 'item' as const, item: { kind: 'vessel' as const, id: item.id } },
    })),
  ];
  const matches = subjectCandidates.filter((item) =>
    item.label.toLowerCase().includes(subjectQuery.toLowerCase())
  );
  const subjects = [
    ...matches.filter((item) => recordedSubjects.has(item.value)),
    ...matches.filter((item) => !recordedSubjects.has(item.value)),
  ].slice(0, 100);
  const boundLocations = new Set(
    recorded.flatMap((observation) =>
      observation.fact.kind === 'presence' && observation.fact.value === 'found'
        ? observation.fact.destination.kind === 'located'
          ? [observation.fact.destination.storageId]
          : observation.fact.destination.kind === 'stack-top'
            ? [observation.fact.destination.stackId]
            : []
        : []
    )
  );
  const storage = Object.values(data.state.storage).filter(
    (item) => item.lifecycle === 'active' || boundLocations.has(item.id)
  );
  const skippedIds = new Set(
    draft.choices.decisions
      .filter((item) => item.choice.kind === 'skip')
      .map((item) => item.observationId)
  );
  const retainedRows = draft.inspection.rows.filter(
    (row) => row.observationId === null || !skippedIds.has(row.observationId)
  );
  const subjectKeys = [
    ...new Set(
      retainedRows
        .map((row) => row.fields?.subject_key)
        .filter((key): key is string => Boolean(key))
    ),
  ];
  const locationKeys = [
    ...new Set(
      retainedRows
        .map((row) => row.fields?.location_key)
        .filter((key): key is string => Boolean(key))
    ),
  ];

  useEffect(
    () => () => {
      ++generation.current;
    },
    []
  );

  function editChoices(choices: InventoryStocktakeChoices) {
    ++generation.current;
    setDraft({ ...facts(draft), phase: 'editing', choices });
  }
  function editSource(sourceText: string, sourcePath: string | null = null) {
    ++generation.current;
    setDraft({
      phase: 'editing',
      sourceText,
      sourcePath,
      choices: {
        ...emptyChoices(),
        namespace: draft.choices.namespace,
        delimiter: draft.choices.delimiter,
      },
      inspection: emptyInspection,
    });
  }
  async function chooseFile() {
    if (busy) return;
    const before = draft;
    const current = ++generation.current;
    setDraft({ ...facts(before), phase: 'reading-source' });
    try {
      const selected = await platform().dialog.open({
        title: 'Choose inventory stocktake table',
        multiple: false,
        filters: [{ name: 'CSV or TSV table', extensions: ['csv', 'tsv', 'txt'] }],
      });
      if (generation.current !== current) return;
      if (selected === null) {
        setDraft(before);
        return;
      }
      if (Array.isArray(selected) && selected.length !== 1)
        throw new Error('Choose one stocktake table.');
      const path = Array.isArray(selected) ? selected[0] : selected;
      const sourceText = await readInventoryArchiveFile(path);
      if (generation.current === current) editSource(sourceText, path);
    } catch (cause) {
      if (generation.current === current)
        setDraft({
          ...facts(before),
          phase: 'failed',
          message: cause instanceof Error ? cause.message : String(cause),
        });
    }
  }
  async function inspect() {
    if (busy || !draft.sourceText) return;
    if (status.kind === 'refused' || status.kind === 'conflict') controller.dismiss();
    const current = ++generation.current;
    const before = facts(draft);
    setDraft({ ...before, phase: 'previewing' });
    try {
      const result = await client.previewStocktake({
        project: data.project.projectId,
        inventoryId: data.project.defaultInventoryId,
        format: 'stocktake-v1',
        sourceText: before.sourceText,
        options: before.choices,
      });
      if (generation.current !== current) return;
      if (
        result.target.projectId !== data.project.projectId ||
        result.target.inventoryId !== data.project.defaultInventoryId
      )
        throw new Error('The stocktake preview belongs to another project or inventory.');
      setDraft({
        ...before,
        phase: 'previewed',
        inspection:
          result.rows.length || !before.inspection.rows.length
            ? result
            : {
                ...before.inspection,
                rows: before.inspection.rows.map((row) => ({
                  ...row,
                  kind: 'blocked' as const,
                  observationKey: null,
                  subject: null,
                  fact: null,
                  observedAt: null,
                  existing: null,
                  before: null,
                  after: null,
                  issues: [],
                })),
              },
        preview: result,
      });
    } catch (cause) {
      if (generation.current === current)
        setDraft({
          ...before,
          phase: 'failed',
          message: cause instanceof Error ? cause.message : String(cause),
        });
    }
  }
  async function apply() {
    if (!canApply || preview?.kind !== 'ready') return;
    if (await controller.applyStocktake(draft.sourceText, preview.options, preview.planDigest))
      onClose();
  }
  function decide(
    observationId: string,
    choice?: InventoryStocktakeChoices['decisions'][number]['choice']
  ) {
    const decisions = [
      ...draft.choices.decisions.filter((item) => item.observationId !== observationId),
      ...(choice ? [{ observationId, choice }] : []),
    ];
    const skipped = new Set(
      decisions.filter((item) => item.choice.kind === 'skip').map((item) => item.observationId)
    );
    const retained = draft.inspection.rows.filter(
      (row) => row.observationId === null || !skipped.has(row.observationId)
    );
    const subjectKeys = new Set(retained.map((row) => row.fields?.subject_key));
    const locationKeys = new Set(retained.map((row) => row.fields?.location_key));
    editChoices({
      ...draft.choices,
      decisions,
      subjects: draft.choices.subjects.filter((item) => subjectKeys.has(item.key)),
      locations: draft.choices.locations.filter((item) => locationKeys.has(item.key)),
    });
  }
  function chooseLocation(key: string, value: string) {
    const target: InventoryStocktakeChoices['locations'][number]['target'] | undefined =
      value === 'root'
        ? { kind: 'root' }
        : value === 'unplaced'
          ? { kind: 'unplaced' }
          : value.startsWith('storage:')
            ? { kind: 'storage', storageId: value.slice(8) }
            : value.startsWith('stack-top:')
              ? { kind: 'stack-top', stackId: value.slice(10) }
              : undefined;
    editChoices({
      ...draft.choices,
      locations: replaceKey(draft.choices.locations, key, target ? { key, target } : undefined),
    });
  }

  return (
    <InventoryPhysicalDialog
      title="Import stocktake observations"
      subtitle={data.project.name}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        void apply();
      }}
      submitLabel="Record stocktake observations"
      disabled={!canApply}
    >
      <section
        className="space-y-4"
        data-testid="inventory-stocktake-import"
        data-preview-state={stale ? 'stale' : (preview?.kind ?? draft.phase)}
      >
        <p className="text-sm">
          Record what was observed, then choose separately whether to correct inventory. Previewing
          changes nothing. A source row omitted from this table does not mean missing stock.
        </p>
        <label className="block text-sm">
          Stable observation source namespace
          <TextField
            aria-label="Stocktake source namespace"
            className="mt-1"
            value={draft.choices.namespace}
            disabled={busy}
            onChange={(event) => editChoices({ ...draft.choices, namespace: event.target.value })}
          />
        </label>
        <p className="text-xs text-fg-muted">
          Keep the namespace and observation ID when retrying or importing the same measurement. A
          new measurement needs a new observation ID.
        </p>
        <Select
          ariaLabel="Stocktake delimiter"
          value={draft.choices.delimiter}
          disabled={busy}
          options={[
            { value: ',', label: 'CSV (comma)' },
            { value: '\t', label: 'TSV (tab)' },
          ]}
          onValueChange={(value) => {
            ++generation.current;
            setDraft({
              ...facts(draft),
              phase: 'editing',
              choices: {
                ...emptyChoices(),
                namespace: draft.choices.namespace,
                delimiter: value === '\t' ? '\t' : ',',
              },
              inspection: emptyInspection,
            });
          }}
        />
        <details className="space-y-2 text-xs">
          <summary className="cursor-pointer text-accent">
            Declared stocktake format and example
          </summary>
          <p>
            Every column appears exactly once. Use known or unknown quantity for a stock subject,
            with presence not-observed. Use quantity_kind not-observed and presence missing or found
            for a physical item. Found observations need an explicit destination. A permanent well
            never stands in for its plate.
          </p>
          <p>
            observed_at is unknown or a UTC timestamp such as 2026-11-16T10:00:00.000Z. This source
            time is separate from when the app records it.
          </p>
          <TextArea
            readOnly
            aria-label="Canonical stocktake example"
            value={`${INVENTORY_STOCKTAKE_COLUMNS.join(',')}\nmeasurement-001,sample,unknown,known,20,uL,not-observed,,,Measured remaining volume\nmissing-001,tube,unknown,not-observed,,,missing,,,Item absent during stocktake\nfound-001,tube,unknown,not-observed,,,found,freezer,A1,Item found in this position\n`}
            className="h-40 font-mono text-xs"
          />
        </details>
        <Button disabled={busy} onClick={() => void chooseFile()}>
          {draft.phase === 'reading-source' ? 'Reading stocktake…' : 'Choose stocktake file'}
        </Button>
        {draft.sourcePath ? (
          <p className="break-all text-xs">Source file: {draft.sourcePath}</p>
        ) : null}
        <details className="space-y-2">
          <summary className="cursor-pointer text-sm text-accent">
            Paste or inspect stocktake text
          </summary>
          <TextArea
            aria-label="Stocktake source text"
            data-testid="inventory-stocktake-source"
            className="h-48 font-mono text-xs"
            value={draft.sourceText}
            disabled={busy}
            onChange={(event) => editSource(event.target.value)}
          />
        </details>
        {subjectKeys.length ? (
          <div className="space-y-3">
            <h3 className="font-semibold">Explicit subjects</h3>
            <TextField
              aria-label="Search stocktake subjects"
              value={subjectQuery}
              onChange={(event) => setSubjectQuery(event.target.value)}
              disabled={busy}
            />
            <p className="text-xs text-fg-muted">
              Choose Stock for a quantity observation. Choose a Location, Container or Permanent
              well for an item observation. Up to 100 matching subjects are shown; search by name or
              ID.
            </p>
            {subjectKeys.map((key) => {
              const selected = draft.choices.subjects.find((item) => item.key === key)?.subject;
              const value = selected ? subjectValue(selected) : '';
              return (
                <Select
                  key={key}
                  ariaLabel={`Subject for ${key}`}
                  value={value}
                  disabled={busy}
                  options={[
                    { value: '', label: `${key} — choose the exact stock or physical item` },
                    ...(selected && !subjects.some((item) => item.value === value)
                      ? [
                          {
                            value,
                            label:
                              subjectCandidates.find((item) => item.value === value)?.label ??
                              `Selected subject ${value}`,
                          },
                        ]
                      : []),
                    ...subjects.map((item) => ({
                      value: item.value,
                      label: `${item.label}${recordedSubjects.has(item.value) ? ' · Previously observed' : ''}`,
                    })),
                  ]}
                  onValueChange={(value) => {
                    const selected = subjectCandidates.find((item) => item.value === value);
                    editChoices({
                      ...draft.choices,
                      subjects: replaceKey(
                        draft.choices.subjects,
                        key,
                        selected ? { key, subject: selected.subject } : undefined
                      ),
                    });
                  }}
                />
              );
            })}
          </div>
        ) : null}
        {locationKeys.length ? (
          <div className="space-y-3">
            <h3 className="font-semibold">Found destinations</h3>
            {locationKeys.map((key) => {
              const target = draft.choices.locations.find((item) => item.key === key)?.target;
              const value = !target
                ? ''
                : target.kind === 'root' || target.kind === 'unplaced'
                  ? target.kind
                  : target.kind === 'storage'
                    ? `storage:${target.storageId}`
                    : `stack-top:${target.stackId}`;
              return (
                <Select
                  key={key}
                  ariaLabel={`Stocktake location for ${key}`}
                  value={value}
                  disabled={busy}
                  options={[
                    { value: '', label: `${key} — choose an explicit destination` },
                    { value: 'root', label: 'Top level (location)' },
                    { value: 'unplaced', label: 'Explicitly unplaced (container)' },
                    ...storage.map((item) => ({
                      value: `storage:${item.id}`,
                      label: `${locationPath(data.state, item.id)} · ${item.id}`,
                    })),
                    ...storage
                      .filter((item) => item.layout.kind === 'stack')
                      .map((item) => ({
                        value: `stack-top:${item.id}`,
                        label: `Top of stack: ${locationPath(data.state, item.id)} · ${item.id}`,
                      })),
                  ]}
                  onValueChange={(value) => chooseLocation(key, value)}
                />
              );
            })}
          </div>
        ) : null}
        {draft.inspection.rows.length ? (
          <div className="space-y-3" data-testid="inventory-stocktake-rows">
            <h3 className="font-semibold">Observation decisions</h3>
            {draft.inspection.rows.map((row) => {
              const choice = draft.choices.decisions.find(
                (item) => item.observationId === row.observationId
              )?.choice;
              const afterShortfall = row.after?.availability?.blockers.some(
                (blocker) => blocker.code === 'ALLOCATION_SHORTFALL'
              );
              return (
                <div
                  key={row.index}
                  className="space-y-2 rounded border border-border p-3 text-xs"
                  data-observation-id={row.observationId ?? ''}
                  data-row-kind={preview ? row.kind : 'needs-preview'}
                >
                  <p className="break-all font-medium">
                    Row {row.index}: {row.observationId ?? 'Unresolved observation ID'}
                  </p>
                  {row.fields ? (
                    <>
                      <p>
                        Subject key: {row.fields.subject_key} · Source time:{' '}
                        {row.fields.observed_at}
                      </p>
                      <p>
                        {row.fields.quantity_kind === 'not-observed'
                          ? `Presence: ${row.fields.presence}`
                          : row.fields.quantity_kind === 'unknown'
                            ? 'Quantity: Unknown'
                            : `Quantity: ${row.fields.quantity} ${row.fields.unit}`}
                      </p>
                      <p className="break-words">Observation reason: {row.fields.reason}</p>
                    </>
                  ) : null}
                  {row.existing ? (
                    <p>
                      Previously recorded ·{' '}
                      {row.existing.application.kind === 'applied'
                        ? 'Correction already applied'
                        : 'Correction not applied'}
                    </p>
                  ) : null}
                  <p>
                    {preview
                      ? row.kind === 'record'
                        ? 'Record a new observation'
                        : row.kind === 'apply'
                          ? 'Apply the observed correction'
                          : row.kind === 'unchanged'
                            ? 'Already recorded; no repeated correction'
                            : row.kind === 'skipped'
                              ? 'Explicitly skipped'
                              : 'Resolution required'
                      : 'Preview the updated choices to resolve this observation.'}
                  </p>
                  {preview ? (
                    <>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <StocktakeSnapshot label="Before proposal" snapshot={row.before} />
                        <StocktakeSnapshot label="After proposal" snapshot={row.after} />
                      </div>
                      {afterShortfall ? (
                        <Notice tone="warning" testId="inventory-stocktake-shortfall">
                          The observed quantity is below the active held quantity. The holds remain
                          active; an allocation shortfall will be visible.
                        </Notice>
                      ) : null}
                      {row.issues.map((issue, index) => (
                        <p key={index}>{issue.message}</p>
                      ))}
                    </>
                  ) : null}
                  {row.observationId !== null ? (
                    <>
                      <Select
                        ariaLabel={`Decision for ${row.observationId}`}
                        value={choice?.kind ?? ''}
                        disabled={busy}
                        options={[
                          { value: '', label: 'Choose what to do with this observation' },
                          { value: 'record-only', label: 'Record only' },
                          { value: 'apply', label: 'Apply observed correction' },
                          { value: 'skip', label: 'Skip with reason' },
                        ]}
                        onValueChange={(value) =>
                          decide(
                            row.observationId!,
                            value === 'record-only'
                              ? { kind: 'record-only' }
                              : value === 'apply' || value === 'skip'
                                ? {
                                    kind: value,
                                    reason: choice && 'reason' in choice ? choice.reason : '',
                                  }
                                : undefined
                          )
                        }
                      />
                      {choice && 'reason' in choice ? (
                        <TextField
                          aria-label={`${choice.kind === 'apply' ? 'Apply' : 'Skip'} reason for observation ${row.observationId}`}
                          value={choice.reason}
                          disabled={busy}
                          onChange={(event) =>
                            decide(row.observationId!, {
                              kind: choice.kind,
                              reason: event.target.value,
                            })
                          }
                        />
                      ) : null}
                    </>
                  ) : null}
                </div>
              );
            })}
            <p className="text-xs text-fg-muted">
              Record only preserves an observation without changing quantity or custody. Apply uses
              the existing correction rules and preserves holds. Already applied observations never
              reset later use or movement. Skipping does not delete stock or mark it missing;
              all-skipped proposals create no operation.
            </p>
          </div>
        ) : null}
        <Button disabled={busy || !draft.sourceText} onClick={() => void inspect()}>
          {draft.phase === 'previewing' ? 'Previewing…' : 'Preview stocktake'}
        </Button>
        {draft.phase === 'failed' ? <Notice tone="error">{draft.message}</Notice> : null}
        {stale ? (
          <Notice tone="warning">
            This stocktake preview is stale. Preview the retained source and choices again before
            recording observations.
          </Notice>
        ) : null}
        {preview ? (
          <div
            className="space-y-3"
            data-testid="inventory-stocktake-preview"
            data-plan-digest={preview.planDigest ?? ''}
          >
            <p className="font-semibold">
              {stale
                ? 'Stale preview'
                : preview.kind === 'ready'
                  ? 'Ready to record the complete proposal'
                  : preview.kind === 'no-change'
                    ? 'No new observations or corrections'
                    : 'Resolution required'}
            </p>
            <p className="text-xs">
              {preview.rows.filter((row) => row.kind === 'record').length} record only ·{' '}
              {preview.rows.filter((row) => row.kind === 'apply').length} corrections ·{' '}
              {preview.rows.filter((row) => row.kind === 'unchanged').length} unchanged ·{' '}
              {preview.rows.filter((row) => row.kind === 'skipped').length} explicitly skipped
            </p>
            <p className="text-xs">
              {preview.commands.length} of {MAX_INVENTORY_BATCH_COMMANDS} supported commands in one
              atomic operation. A refusal applies none of its observations or corrections. No
              automatic splitting occurs.
            </p>
            {preview.issues.map((issue, index) => (
              <Notice
                key={`${issue.code}:${index}`}
                tone="warning"
                testId="inventory-stocktake-issue"
              >
                {issue.message}
                <span className="mt-1 block break-all font-mono text-xs">{issue.pointer}</span>
              </Notice>
            ))}
            <details className="space-y-2 text-xs">
              <summary className="cursor-pointer text-accent">Source and plan identity</summary>
              <p className="break-all">Source SHA-256: {preview.sourceSha256}</p>
              {preview.kind === 'ready' ? (
                <p className="break-all">Plan: {preview.planDigest}</p>
              ) : null}
            </details>
          </div>
        ) : null}
      </section>
    </InventoryPhysicalDialog>
  );
}
