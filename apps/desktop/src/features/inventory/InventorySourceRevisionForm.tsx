import { useEffect, useRef, useState } from 'react';
import {
  INVENTORY_RECEIVE_TABLE_COLUMNS,
  MAX_INVENTORY_BATCH_COMMANDS,
  type InventoryReceiveTableFields,
  type InventorySourceRevisionChoices,
  type InventorySourceRevisionRowPreview,
  type InventoryTableSha256,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea, TextField } from '../../components/ui';
import { platform } from '../../platform';
import type {
  InventoryClient,
  InventoryMaterial,
  InventorySourceRevisionPreviewSnapshot,
} from '../../shared/inventory-client';
import { readInventoryArchiveFile } from './inventory-archive-file';
import {
  inventoryCanEdit,
  type InventoryController,
  type InventoryControllerState,
  type InventoryData,
} from './inventory-controller';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import { inventoryCustodyLabel, locationPath, vesselLocation } from './inventory-view';

interface SourceInspection {
  materialKeys: readonly string[];
  locationKeys: readonly string[];
  vesselKeys: readonly string[];
  rows: readonly InventorySourceRevisionRowPreview[];
}
interface SourceDraftFacts {
  sourceText: string;
  sourcePath: string | null;
  choices: InventorySourceRevisionChoices;
  inspection: SourceInspection;
}
type SourceDraft = SourceDraftFacts &
  (
    | { phase: 'editing' | 'reading-source' | 'previewing' }
    | { phase: 'previewed'; preview: InventorySourceRevisionPreviewSnapshot }
    | { phase: 'failed'; message: string }
  );
const emptyInspection: SourceInspection = {
  materialKeys: [],
  locationKeys: [],
  vesselKeys: [],
  rows: [],
};
const facts = (draft: SourceDraft): SourceDraftFacts => ({
  sourceText: draft.sourceText,
  sourcePath: draft.sourcePath,
  choices: draft.choices,
  inspection: draft.inspection,
});
const emptyChoices = (): InventorySourceRevisionChoices => ({
  table: { namespace: '', delimiter: ',', materials: [], locations: [], vessels: [], skips: [] },
  acknowledgements: [],
});
function replaceKey<T extends { key: string }>(items: readonly T[], key: string, value?: T): T[] {
  return [...items.filter((item) => item.key !== key), ...(value ? [value] : [])];
}

function SourceFields({
  label,
  fields,
  column,
}: {
  label: string;
  fields: InventoryReceiveTableFields | null;
  column: 'previous' | 'revised';
}) {
  return (
    <section
      className="space-y-1 rounded bg-bg-subtle p-3 text-xs"
      aria-label={label}
      data-source-column={column}
    >
      <h4 className="font-semibold">{label}</h4>
      {fields ? (
        <>
          <p className="break-words">Name: {fields.name || 'No new-vessel name'}</p>
          <p>
            Quantity:{' '}
            {fields.quantity_kind === 'unknown'
              ? 'Unknown'
              : `${fields.quantity} ${fields.unit === 'uL' ? 'µL' : fields.unit}`}
          </p>
          <p>Quality: {fields.quality}</p>
          <p className="break-words">Scientific key: {fields.material_key}</p>
          <p>Vessel kind: {fields.vessel_kind}</p>
          <p className="break-words">Vessel key: {fields.vessel_key || 'No existing-vessel key'}</p>
          <p className="break-words">
            Location key: {fields.location_key || 'No source location key'}
          </p>
          <p className="break-words">Position: {fields.slot || 'No source position'}</p>
        </>
      ) : (
        <p>Verified source fields unavailable. Current inventory is not a substitute.</p>
      )}
    </section>
  );
}

function ActualInventory({
  actual,
  data,
}: {
  actual: InventorySourceRevisionRowPreview['actual'];
  data: InventoryData;
}) {
  return (
    <section
      className="space-y-1 rounded bg-bg-subtle p-3 text-xs"
      aria-label="Actual inventory"
      data-source-column="actual"
    >
      <h4 className="font-semibold">Actual inventory</h4>
      {actual ? (
        <>
          <p className="break-words">Name: {actual.vessel.name}</p>
          <p>
            Quantity:{' '}
            {actual.stock.quantity.kind === 'unknown'
              ? 'Unknown'
              : `${actual.stock.quantity.value} ${actual.stock.quantity.unit === 'uL' ? 'µL' : actual.stock.quantity.unit}`}
          </p>
          <p>Quality: {actual.stock.quality}</p>
          <p className="break-words">
            Location: {vesselLocation(data.state, actual.vessel, actual.custody)}
          </p>
          <p>Custody: {inventoryCustodyLabel(actual.custody)}</p>
          <p>
            Held: {actual.availability.held.value} µL · Unreserved:{' '}
            {actual.availability.unreserved.kind === 'unknown'
              ? 'Unknown'
              : `${actual.availability.unreserved.value} µL`}
          </p>
          <details>
            <summary className="cursor-pointer text-accent">Bound identities</summary>
            <p className="break-all">Scientific record: {actual.stock.materialId}</p>
            <p className="break-all">Stock: {actual.stock.id}</p>
            <p className="break-all">Vessel: {actual.vessel.id}</p>
          </details>
        </>
      ) : (
        <p>Resolve the source identity to compare current inventory.</p>
      )}
    </section>
  );
}

export function InventorySourceRevisionForm({
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
    status.attempt.request.kind === 'acknowledge-table-source'
      ? status.attempt.request
      : null;
  const [draft, setDraft] = useState<SourceDraft>(() => ({
    phase: 'editing',
    sourceText: pending?.sourceText ?? '',
    sourcePath: null,
    choices: pending
      ? { table: pending.options.table, acknowledgements: pending.options.acknowledgements }
      : emptyChoices(),
    inspection: emptyInspection,
  }));
  const generation = useRef(0);
  const [query, setQuery] = useState('');
  const [materials, setMaterials] = useState<readonly InventoryMaterial[]>([]);
  const [materialError, setMaterialError] = useState<string | null>(null);
  const [vesselQuery, setVesselQuery] = useState('');
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
        status.attempt.request.kind === 'acknowledge-table-source'))
  );
  const canApply = preview?.kind === 'ready' && !stale && inventoryCanEdit(status);
  const inspectedSourceIds = new Set(draft.inspection.rows.map((row) => row.sourceId));
  const sourceBindings = Object.values(data.state.tableBindings).filter(
    (binding) =>
      binding.namespace === draft.choices.table.namespace &&
      inspectedSourceIds.has(binding.sourceId)
  );
  const boundMaterialIds = [...new Set(sourceBindings.map((binding) => binding.materialId))];
  const storage = Object.values(data.state.storage);
  const vessels = Object.values(data.state.vessels)
    .filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(vesselQuery.toLowerCase()))
    .slice(0, 100);

  useEffect(
    () => () => {
      ++generation.current;
    },
    []
  );
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void client.materials({ project: data.project.projectId, query, limit: 100 }).then(
        (page) => {
          if (!cancelled) {
            setMaterials(page.items);
            setMaterialError(null);
          }
        },
        () => {
          if (!cancelled)
            setMaterialError(
              'Scientific records could not be searched. Bound identities remain available.'
            );
        }
      );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, data.project.projectId, query]);

  function editChoices(choices: InventorySourceRevisionChoices) {
    ++generation.current;
    setDraft({ ...facts(draft), phase: 'editing', choices });
  }
  function editSource(sourceText: string, sourcePath: string | null = null) {
    ++generation.current;
    const choices = emptyChoices();
    editDraft({
      sourceText,
      sourcePath,
      choices: {
        ...choices,
        table: {
          ...choices.table,
          namespace: draft.choices.table.namespace,
          delimiter: draft.choices.table.delimiter,
        },
      },
      inspection: emptyInspection,
    });
  }
  function editDraft(value: SourceDraftFacts) {
    setDraft({ ...value, phase: 'editing' });
  }
  async function chooseFile() {
    if (busy) return;
    const before = draft;
    const current = ++generation.current;
    setDraft({ ...facts(before), phase: 'reading-source' });
    try {
      const selected = await platform().dialog.open({
        title: 'Choose revised inventory receive table',
        multiple: false,
        filters: [{ name: 'CSV or TSV table', extensions: ['csv', 'tsv', 'txt'] }],
      });
      if (generation.current !== current) return;
      if (selected === null) {
        setDraft(before);
        return;
      }
      if (Array.isArray(selected) && selected.length !== 1)
        throw new Error('Choose one revised table.');
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
  async function compare() {
    if (busy || !draft.sourceText) return;
    if (status.kind === 'refused' || status.kind === 'conflict') controller.dismiss();
    const current = ++generation.current;
    const before = facts(draft);
    setDraft({ ...before, phase: 'previewing' });
    try {
      const result = await client.previewSourceRevision({
        project: data.project.projectId,
        inventoryId: data.project.defaultInventoryId,
        format: 'receive-v1',
        sourceText: before.sourceText,
        options: before.choices,
      });
      if (generation.current !== current) return;
      if (
        result.target.projectId !== data.project.projectId ||
        result.target.inventoryId !== data.project.defaultInventoryId
      )
        throw new Error('The comparison belongs to another project or inventory.');
      const inspection: SourceInspection = result.rows.length
        ? {
            materialKeys: result.materialKeys,
            locationKeys: result.locationKeys,
            vesselKeys: result.vesselKeys,
            rows: result.rows,
          }
        : {
            ...before.inspection,
            rows: before.inspection.rows.map((row) => ({
              ...row,
              bindingKey: null,
              kind: 'blocked',
              previousRowSha256: null,
              previousFields: null,
              binding: null,
              destination: null,
              actual: null,
              reason: null,
              issues: [],
            })),
          };
      setDraft({ ...before, inspection, phase: 'previewed', preview: result });
    } catch (cause) {
      if (generation.current === current)
        setDraft({
          ...before,
          phase: 'failed',
          message: cause instanceof Error ? cause.message : String(cause),
        });
    }
  }
  function acknowledge(sourceId: string, hash: InventoryTableSha256 | null, reason: string | null) {
    editChoices({
      ...draft.choices,
      table: {
        ...draft.choices.table,
        skips: draft.choices.table.skips.filter((item) => item.sourceId !== sourceId),
      },
      acknowledgements: [
        ...draft.choices.acknowledgements.filter((item) => item.sourceId !== sourceId),
        ...(reason !== null && hash ? [{ sourceId, expectedPreviousRowSha256: hash, reason }] : []),
      ],
    });
  }
  function skip(sourceId: string, reason: string | null) {
    editChoices({
      ...draft.choices,
      acknowledgements: draft.choices.acknowledgements.filter((item) => item.sourceId !== sourceId),
      table: {
        ...draft.choices.table,
        skips: [
          ...draft.choices.table.skips.filter((item) => item.sourceId !== sourceId),
          ...(reason === null ? [] : [{ sourceId, reason }]),
        ],
      },
    });
  }
  async function apply() {
    if (!canApply || preview?.kind !== 'ready') return;
    if (
      await controller.acknowledgeSourceRevision(
        draft.sourceText,
        preview.options,
        preview.planDigest
      )
    )
      onClose();
  }

  return (
    <InventoryPhysicalDialog
      title="Acknowledge revised source"
      subtitle={data.project.name}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        void apply();
      }}
      submitLabel="Acknowledge source revision"
      disabled={!canApply}
    >
      <section
        className="space-y-4"
        data-testid="inventory-source-revision-import"
        data-preview-state={stale ? 'stale' : (preview?.kind ?? draft.phase)}
      >
        <p className="text-sm">
          Compare a revised external receive register with its accepted source history and actual
          stock. Acknowledgement keeps physical stock unchanged. It does not receive, measure,
          rename, quarantine, move or release anything.
        </p>
        <TextField
          aria-label="Source revision namespace"
          placeholder="Stable source collection"
          value={draft.choices.table.namespace}
          disabled={busy}
          onChange={(event) =>
            editChoices({
              table: { ...draft.choices.table, namespace: event.target.value },
              acknowledgements: [],
            })
          }
        />
        <Select
          ariaLabel="Source revision delimiter"
          value={draft.choices.table.delimiter}
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
                table: {
                  ...emptyChoices().table,
                  namespace: draft.choices.table.namespace,
                  delimiter: value as ',' | '\t',
                },
                acknowledgements: [],
              },
              inspection: emptyInspection,
            });
          }}
        />
        <details className="space-y-2 text-xs">
          <summary className="cursor-pointer text-accent">Declared receive-table format</summary>
          <p>
            Use the same stable source IDs and complete declared columns. Scientific and physical
            identity changes require a separate reconciliation.
          </p>
          <TextArea
            readOnly
            aria-label="Source revision table columns"
            value={INVENTORY_RECEIVE_TABLE_COLUMNS.join(',')}
            className="font-mono text-xs"
          />
        </details>
        <Button disabled={busy} onClick={() => void chooseFile()}>
          {draft.phase === 'reading-source'
            ? 'Reading source…'
            : 'Choose revised receive table file'}
        </Button>
        {draft.sourcePath ? (
          <p className="break-all text-xs">Selected file: {draft.sourcePath}</p>
        ) : null}
        <details className="space-y-2">
          <summary className="cursor-pointer text-sm text-accent">
            Paste or inspect revised source
          </summary>
          <TextArea
            aria-label="Revised receive table text"
            value={draft.sourceText}
            disabled={busy}
            onChange={(event) => editSource(event.target.value)}
            className="h-40 font-mono text-xs"
          />
        </details>
        {draft.inspection.materialKeys.length ? (
          <section className="space-y-2">
            <h3 className="font-semibold">Scientific identities</h3>
            <TextField
              aria-label="Search source revision scientific records"
              value={query}
              disabled={busy}
              onChange={(event) => setQuery(event.target.value)}
            />
            {materialError ? <Notice tone="warning">{materialError}</Notice> : null}
            {draft.inspection.materialKeys.map((key) => {
              const selected = draft.choices.table.materials.find(
                (item) => item.key === key
              )?.materialId;
              const extraIds = new Set([...boundMaterialIds, ...(selected ? [selected] : [])]);
              for (const material of materials) extraIds.delete(material.id);
              return (
                <Select
                  key={key}
                  ariaLabel={`Scientific record for ${key}`}
                  value={selected ?? ''}
                  disabled={busy}
                  options={[
                    { value: '', label: `${key} — choose the same bound scientific identity` },
                    ...[...extraIds].map((id) => ({
                      value: id,
                      label: `Bound scientific record ${id}`,
                    })),
                    ...materials.map((item) => ({
                      value: item.id,
                      label: `${item.name} · ${item.id}`,
                    })),
                  ]}
                  onValueChange={(value) =>
                    editChoices({
                      ...draft.choices,
                      table: {
                        ...draft.choices.table,
                        materials: replaceKey(
                          draft.choices.table.materials,
                          key,
                          value ? { key, materialId: value } : undefined
                        ),
                      },
                    })
                  }
                />
              );
            })}
            <p className="text-xs text-fg-muted">
              Only the existing bound scientific identity can be acknowledged. A bound archived
              record remains an identity; acknowledgement does not create or reactivate it.
            </p>
          </section>
        ) : null}
        {draft.inspection.locationKeys.length ? (
          <section className="space-y-2">
            <h3 className="font-semibold">Source location meanings</h3>
            {draft.inspection.locationKeys.map((key) => {
              const target = draft.choices.table.locations.find((item) => item.key === key)?.target;
              const selected = target
                ? target.kind === 'unplaced'
                  ? 'unplaced'
                  : `storage:${target.storageId}`
                : '';
              return (
                <Select
                  key={key}
                  ariaLabel={`Location for ${key}`}
                  value={selected}
                  disabled={busy}
                  options={[
                    { value: '', label: `${key} — choose a source location meaning` },
                    { value: 'unplaced', label: 'Explicitly unplaced' },
                    ...(target?.kind === 'storage' && !data.state.storage[target.storageId]
                      ? [{ value: selected, label: `Selected location ${target.storageId}` }]
                      : []),
                    ...storage.map((item) => ({
                      value: `storage:${item.id}`,
                      label: `${locationPath(data.state, item.id)} · ${item.id}${item.lifecycle === 'disposed' ? ' · Disposed' : ''}`,
                    })),
                  ]}
                  onValueChange={(value) =>
                    editChoices({
                      ...draft.choices,
                      table: {
                        ...draft.choices.table,
                        locations: replaceKey(
                          draft.choices.table.locations,
                          key,
                          value
                            ? {
                                key,
                                target:
                                  value === 'unplaced'
                                    ? { kind: 'unplaced' }
                                    : { kind: 'storage', storageId: value.slice(8) },
                              }
                            : undefined
                        ),
                      },
                    })
                  }
                />
              );
            })}
            <p className="text-xs text-fg-muted">
              These are source statements. Acknowledging an occupied or disposed source location
              does not move stock into it.
            </p>
          </section>
        ) : null}
        {draft.inspection.vesselKeys.length ? (
          <section className="space-y-2">
            <h3 className="font-semibold">Existing vessel identities</h3>
            <TextField
              aria-label="Search source revision vessels"
              value={vesselQuery}
              disabled={busy}
              onChange={(event) => setVesselQuery(event.target.value)}
            />
            {draft.inspection.vesselKeys.map((key) => {
              const selected = draft.choices.table.vessels.find(
                (item) => item.key === key
              )?.vesselId;
              return (
                <Select
                  key={key}
                  ariaLabel={`Existing vessel for ${key}`}
                  value={selected ?? ''}
                  disabled={busy}
                  options={[
                    { value: '', label: `${key} — choose the same bound vessel` },
                    ...(selected && !vessels.some((item) => item.id === selected)
                      ? [{ value: selected, label: `Selected vessel ${selected}` }]
                      : []),
                    ...vessels.map((item) => ({
                      value: item.id,
                      label: `${item.name} · ${vesselLocation(data.state, item)} · ${item.id}`,
                    })),
                  ]}
                  onValueChange={(value) =>
                    editChoices({
                      ...draft.choices,
                      table: {
                        ...draft.choices.table,
                        vessels: replaceKey(
                          draft.choices.table.vessels,
                          key,
                          value ? { key, vesselId: value } : undefined
                        ),
                      },
                    })
                  }
                />
              );
            })}
            <p className="text-xs text-fg-muted">
              Up to 100 matching vessels are shown. Search by ID or name. Occupied and disposed
              vessels remain identifiable; no replacement is performed.
            </p>
          </section>
        ) : null}
        {draft.inspection.rows.length ? (
          <div className="space-y-3" data-testid="inventory-source-revision-rows">
            <h3 className="font-semibold">Source comparisons</h3>
            {draft.inspection.rows.map((row) => {
              const acknowledgement = draft.choices.acknowledgements.find(
                (item) => item.sourceId === row.sourceId
              );
              const skipped = draft.choices.table.skips.find(
                (item) => item.sourceId === row.sourceId
              );
              const hash = acknowledgement?.expectedPreviousRowSha256 ?? row.previousRowSha256;
              return (
                <article
                  key={row.index}
                  className="space-y-3 rounded border border-border p-3 text-sm"
                  data-source-id={row.sourceId ?? ''}
                  data-row-kind={preview ? row.kind : 'editing'}
                >
                  <p className="break-all font-medium">
                    Row {row.index}: {row.sourceId ?? 'Unresolved source ID'}
                  </p>
                  <p>
                    {preview
                      ? row.kind
                      : 'Compare the updated choices before acknowledging this source.'}
                  </p>
                  {preview ? (
                    <>
                      <div className="grid gap-3 md:grid-cols-3">
                        <SourceFields
                          label="Previous source baseline"
                          fields={row.previousFields}
                          column="previous"
                        />
                        <SourceFields
                          label="Revised source record"
                          fields={row.revisedFields}
                          column="revised"
                        />
                        <ActualInventory actual={row.actual} data={data} />
                      </div>
                      {row.issues.map((issue, index) => (
                        <p key={index}>{issue.message}</p>
                      ))}
                    </>
                  ) : null}
                  {row.sourceId !== null ? (
                    <>
                      {row.kind !== 'unchanged' || acknowledgement ? (
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            aria-label={`Acknowledge source ${row.sourceId}`}
                            checked={Boolean(acknowledgement)}
                            disabled={busy || (!acknowledgement && (!hash || !row.previousFields))}
                            onChange={(event) =>
                              acknowledge(
                                row.sourceId!,
                                hash,
                                event.target.checked ? (acknowledgement?.reason ?? '') : null
                              )
                            }
                          />
                          Acknowledge the revised source; keep physical stock unchanged
                        </label>
                      ) : (
                        <p>This row already matches its accepted source baseline.</p>
                      )}
                      {acknowledgement ? (
                        <>
                          <TextField
                            readOnly
                            aria-label={`Previous source hash for ${row.sourceId}`}
                            value={acknowledgement.expectedPreviousRowSha256}
                            className="font-mono text-xs"
                          />
                          <TextField
                            aria-label={`Reason for source revision ${row.sourceId}`}
                            value={acknowledgement.reason}
                            disabled={busy}
                            onChange={(event) =>
                              acknowledge(
                                row.sourceId!,
                                acknowledgement.expectedPreviousRowSha256,
                                event.target.value
                              )
                            }
                          />
                        </>
                      ) : null}
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          aria-label={`Skip source ${row.sourceId}`}
                          checked={Boolean(skipped)}
                          disabled={busy}
                          onChange={(event) =>
                            skip(
                              row.sourceId!,
                              event.target.checked ? (skipped?.reason ?? '') : null
                            )
                          }
                        />
                        Skip this source row with a reason
                      </label>
                      {skipped ? (
                        <TextField
                          aria-label={`Skip reason for source ${row.sourceId}`}
                          value={skipped.reason}
                          disabled={busy}
                          onChange={(event) => skip(row.sourceId!, event.target.value)}
                        />
                      ) : null}
                    </>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : null}
        <Button disabled={busy || !draft.sourceText} onClick={() => void compare()}>
          {draft.phase === 'previewing' ? 'Comparing…' : 'Compare revised source'}
        </Button>
        {draft.phase === 'failed' ? <Notice tone="error">{draft.message}</Notice> : null}
        {stale ? (
          <Notice tone="warning">
            This comparison is stale. Compare the retained source and choices again before
            acknowledging it.
          </Notice>
        ) : null}
        {preview ? (
          <section
            className="space-y-3"
            data-testid="inventory-source-revision-preview"
            data-plan-digest={preview.planDigest ?? ''}
          >
            <p className="font-semibold">
              {stale
                ? 'Stale comparison'
                : preview.kind === 'ready'
                  ? 'Ready to acknowledge source revisions'
                  : preview.kind === 'no-change'
                    ? 'No source revisions to acknowledge'
                    : preview.kind === 'needs-acknowledgement'
                      ? 'Explicit acknowledgement required'
                      : 'Resolution required'}
            </p>
            <p>
              {preview.rows.filter((row) => row.kind === 'proposed').length} proposed source
              revisions · {preview.rows.filter((row) => row.kind === 'unchanged').length} unchanged
              · {preview.rows.filter((row) => row.kind === 'skipped').length} explicitly skipped
            </p>
            <p className="text-xs">
              Up to {MAX_INVENTORY_BATCH_COMMANDS} acknowledgements commit in one atomic operation.
              A refusal accepts none. Physical inventory changes: zero. Use stocktake to apply an
              actual measurement or custody correction.
            </p>
            {preview.issues.map((issue, index) => (
              <Notice
                key={`${issue.code}:${index}`}
                tone="warning"
                testId="inventory-source-revision-issue"
              >
                {issue.message}
              </Notice>
            ))}
            <details className="space-y-2 text-xs">
              <summary className="cursor-pointer text-accent">Source and plan identity</summary>
              <p className="break-all">Source: {preview.sourceSha256}</p>
              {preview.planDigest ? <p className="break-all">Plan: {preview.planDigest}</p> : null}
            </details>
          </section>
        ) : null}
      </section>
    </InventoryPhysicalDialog>
  );
}
