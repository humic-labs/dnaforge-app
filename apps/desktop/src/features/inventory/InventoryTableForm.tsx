import { useEffect, useRef, useState } from 'react';
import {
  INVENTORY_RECEIVE_TABLE_COLUMNS,
  MAX_INVENTORY_BATCH_COMMANDS,
  type InventoryTableChoices,
  type InventoryTableRowPreview,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea, TextField } from '../../components/ui';
import { platform } from '../../platform';
import type {
  InventoryClient,
  InventoryMaterial,
  InventoryTablePreviewSnapshot,
} from '../../shared/inventory-client';
import { readInventoryArchiveFile } from './inventory-archive-file';
import {
  inventoryCanEdit,
  type InventoryController,
  type InventoryControllerState,
  type InventoryData,
} from './inventory-controller';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import { locationPath, vesselLocation } from './inventory-view';

interface TableInspection {
  materialKeys: readonly string[];
  locationKeys: readonly string[];
  vesselKeys: readonly string[];
  rows: readonly InventoryTableRowPreview[];
}
interface TableDraftFacts {
  sourceText: string;
  sourcePath: string | null;
  choices: InventoryTableChoices;
  inspection: TableInspection;
}
type TableDraft = TableDraftFacts &
  (
    | { phase: 'editing' | 'reading-source' | 'previewing' }
    | { phase: 'previewed'; preview: InventoryTablePreviewSnapshot }
    | { phase: 'failed'; message: string }
  );
const emptyInspection: TableInspection = {
  materialKeys: [],
  locationKeys: [],
  vesselKeys: [],
  rows: [],
};
const facts = (draft: TableDraft): TableDraftFacts => ({
  sourceText: draft.sourceText,
  sourcePath: draft.sourcePath,
  choices: draft.choices,
  inspection: draft.inspection,
});
const emptyChoices = (): InventoryTableChoices => ({
  namespace: '',
  delimiter: ',',
  materials: [],
  locations: [],
  vessels: [],
  skips: [],
});
function replaceKey<T extends { key: string }>(items: readonly T[], key: string, value?: T): T[] {
  return [...items.filter((item) => item.key !== key), ...(value ? [value] : [])];
}

export function InventoryTableForm({
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
    status.attempt.request.kind === 'receive-table'
      ? status.attempt.request
      : null;
  const [draft, setDraft] = useState<TableDraft>(() => ({
    phase: 'editing',
    sourceText: pending?.sourceText ?? '',
    sourcePath: null,
    choices: pending
      ? {
          ...pending.options,
          materials: pending.options.materials.map(({ key, materialId }) => ({ key, materialId })),
        }
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
        status.attempt.request.kind === 'receive-table'))
  );
  const canApply = preview?.kind === 'ready' && !stale && inventoryCanEdit(status);
  const inspectedSourceIds = new Set(draft.inspection.rows.map((row) => row.sourceId));
  const sourceBindings = Object.values(data.state.tableBindings).filter(
    (binding) =>
      binding.namespace === draft.choices.namespace && inspectedSourceIds.has(binding.sourceId)
  );
  const boundVesselIds = new Set(
    sourceBindings
      .filter((binding) => binding.destination.kind === 'existing-vessel')
      .map((binding) => binding.vesselId)
  );
  const boundStorageIds = new Set(
    sourceBindings.flatMap((binding) =>
      binding.destination.kind === 'new-vessel' && binding.destination.placement.kind === 'located'
        ? [binding.destination.placement.storageId]
        : []
    )
  );
  const storage = Object.values(data.state.storage).filter(
    (item) => item.lifecycle === 'active' || boundStorageIds.has(item.id)
  );
  const occupiedVessels = new Set(Object.values(data.state.stocks).map((stock) => stock.vesselId));
  const vessels = Object.values(data.state.vessels)
    .filter(
      (item) =>
        ((item.lifecycle === 'active' && !occupiedVessels.has(item.id)) ||
          boundVesselIds.has(item.id)) &&
        `${item.name} ${item.id}`.toLowerCase().includes(vesselQuery.toLowerCase())
    )
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
      void client
        .materials({ project: data.project.projectId, query, limit: 100 })
        .then((page) => {
          if (!cancelled) {
            setMaterials(page.items);
            setMaterialError(null);
          }
        })
        .catch(() => {
          if (!cancelled)
            setMaterialError('Scientific records could not be searched. Retry the search.');
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, data.project.projectId, query]);

  function editChoices(choices: InventoryTableChoices) {
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
        title: 'Choose inventory receive table',
        multiple: false,
        filters: [{ name: 'CSV or TSV table', extensions: ['csv', 'tsv', 'txt'] }],
      });
      if (generation.current !== current) return;
      if (selected === null) {
        setDraft(before);
        return;
      }
      if (Array.isArray(selected) && selected.length !== 1)
        throw new Error('Choose one receive table.');
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
      const result = await client.previewTable({
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
        throw new Error('The table preview belongs to another project or inventory.');
      setDraft({
        ...before,
        phase: 'previewed',
        inspection: result,
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
    if (await controller.receiveTable(draft.sourceText, preview.options, preview.planDigest))
      onClose();
  }
  function skip(sourceId: string, reason: string | null) {
    const skips = [
      ...draft.choices.skips.filter((item) => item.sourceId !== sourceId),
      ...(reason === null ? [] : [{ sourceId, reason }]),
    ];
    const skippedIds = new Set(skips.map((item) => item.sourceId));
    const retained = draft.inspection.rows.filter(
      (row) => row.sourceId === null || !skippedIds.has(row.sourceId)
    );
    const materialKeys = new Set(retained.map((row) => row.fields?.material_key));
    const locationKeys = new Set(retained.map((row) => row.fields?.location_key));
    const vesselKeys = new Set(retained.map((row) => row.fields?.vessel_key));
    editChoices({
      ...draft.choices,
      skips,
      materials: draft.choices.materials.filter((item) => materialKeys.has(item.key)),
      locations: draft.choices.locations.filter((item) => locationKeys.has(item.key)),
      vessels: draft.choices.vessels.filter((item) => vesselKeys.has(item.key)),
    });
  }

  return (
    <InventoryPhysicalDialog
      title="Receive inventory table"
      subtitle={data.project.name}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        void apply();
      }}
      submitLabel="Receive table stocks"
      disabled={!canApply}
    >
      <section
        className="space-y-4"
        data-testid="inventory-table-import"
        data-preview-state={stale ? 'stale' : (preview?.kind ?? draft.phase)}
      >
        <p className="text-sm">
          Receive stock from the canonical CSV or TSV format. Choose scientific records and
          destinations explicitly. Previewing changes nothing; applying commits the whole proposal
          in one operation.
        </p>
        <label className="flex flex-col gap-2 text-xs font-medium">
          Stable source namespace
          <TextField
            aria-label="Source namespace"
            maxLength={256}
            value={draft.choices.namespace}
            disabled={busy}
            onChange={(event) => editChoices({ ...draft.choices, namespace: event.target.value })}
          />
        </label>
        <p className="text-xs text-fg-muted">
          Identify the source collection, such as a stock register. Keep this namespace and each
          source_id when revising or sorting a file. Changing them can describe different stock.
        </p>
        <Select
          ariaLabel="Delimiter"
          value={draft.choices.delimiter}
          disabled={busy}
          options={[
            { value: ',', label: 'CSV — comma separated' },
            { value: '\t', label: 'TSV — tab separated' },
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
        <details>
          <summary className="cursor-pointer text-sm">Canonical format and example</summary>
          <p className="mt-2 text-xs">
            Every header is required exactly once. Additional columns need an explicit adapter.
            Known quantity requires a decimal and L, mL, uL or nL; unknown quantity requires blank
            quantity and unit. Quality is usable or quarantined.
          </p>
          <p className="mt-2 text-xs">
            A new vessel requires a name, blank vessel_key and an explicit location_key. Select
            unplaced or an existing location for that key; slot must match the selected location. An
            existing empty vessel or permanent well requires vessel_key and blank name, location_key
            and slot. Receiving never renames or moves an existing vessel.
          </p>
          <TextArea
            readOnly
            aria-label="Canonical receive table example"
            value={`${INVENTORY_RECEIVE_TABLE_COLUMNS.join(',')}\n001,Tube A,sample,known,0,uL,usable,new,,bench,\n002,,sample,unknown,,,quarantined,existing,well-a1,,`}
            className="mt-2 h-24 font-mono text-xs"
          />
          <p className="mt-2 text-xs text-fg-muted">
            This format does not imply Benchling header compatibility. Lots, labels and other
            columns require separate supported workflows.
          </p>
        </details>
        <Button disabled={busy} onClick={() => void chooseFile()}>
          {draft.phase === 'reading-source' ? 'Reading table…' : 'Choose receive table file'}
        </Button>
        {draft.sourcePath ? <p className="break-all text-xs">{draft.sourcePath}</p> : null}
        <details>
          <summary className="cursor-pointer text-sm">Paste or inspect table text</summary>
          <TextArea
            aria-label="Table source text"
            data-testid="inventory-table-source"
            value={draft.sourceText}
            onChange={(event) => editSource(event.target.value)}
            disabled={busy}
            className="mt-2 h-36 font-mono text-xs"
          />
        </details>
        {draft.inspection.materialKeys.length ? (
          <div className="space-y-3">
            <h3 className="font-semibold">Scientific records</h3>
            <TextField
              aria-label="Search table scientific records"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              disabled={busy}
            />
            {materialError ? <Notice tone="error">{materialError}</Notice> : null}
            {draft.inspection.materialKeys.map((key) => {
              const selected = draft.choices.materials.find((item) => item.key === key)?.materialId;
              return (
                <Select
                  key={key}
                  ariaLabel={`Scientific record for ${key}`}
                  value={selected ?? ''}
                  disabled={busy}
                  options={[
                    { value: '', label: `${key} — choose a scientific record` },
                    ...(selected && !materials.some((item) => item.id === selected)
                      ? [{ value: selected, label: `Selected record ${selected}` }]
                      : []),
                    ...materials.map((item) => ({
                      value: item.id,
                      label: `${item.name} · ${item.id}`,
                    })),
                  ]}
                  onValueChange={(value) =>
                    editChoices({
                      ...draft.choices,
                      materials: replaceKey(
                        draft.choices.materials,
                        key,
                        value ? { key, materialId: value } : undefined
                      ),
                    })
                  }
                />
              );
            })}
          </div>
        ) : null}
        {draft.inspection.locationKeys.length ? (
          <div className="space-y-3">
            <h3 className="font-semibold">New vessel destinations</h3>
            {draft.inspection.locationKeys.map((key) => {
              const target = draft.choices.locations.find((item) => item.key === key)?.target;
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
                    { value: '', label: `${key} — choose an explicit destination` },
                    { value: 'unplaced', label: 'Explicitly unplaced' },
                    ...(target?.kind === 'storage' &&
                    !storage.some((item) => item.id === target.storageId)
                      ? [{ value: selected, label: `Selected location ${target.storageId}` }]
                      : []),
                    ...storage.map((item) => ({
                      value: `storage:${item.id}`,
                      label: `${locationPath(data.state, item.id)} · ${item.id}${item.lifecycle === 'disposed' ? ' · Original source destination' : ''}`,
                    })),
                  ]}
                  onValueChange={(value) =>
                    editChoices({
                      ...draft.choices,
                      locations: replaceKey(
                        draft.choices.locations,
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
                    })
                  }
                />
              );
            })}
          </div>
        ) : null}
        {draft.inspection.vesselKeys.length ? (
          <div className="space-y-3">
            <h3 className="font-semibold">Existing empty vessels and permanent wells</h3>
            <TextField
              aria-label="Search table destination vessels"
              value={vesselQuery}
              onChange={(event) => setVesselQuery(event.target.value)}
              disabled={busy}
            />
            <p className="text-xs text-fg-muted">
              Up to 100 matching empty vessels or vessels already bound to this source are shown.
              Search by name or ID. The owner checks present custody, placement and physical
              constraints when receiving new stock.
            </p>
            {draft.inspection.vesselKeys.map((key) => {
              const selected = draft.choices.vessels.find((item) => item.key === key)?.vesselId;
              return (
                <Select
                  key={key}
                  ariaLabel={`Existing vessel for ${key}`}
                  value={selected ?? ''}
                  disabled={busy}
                  options={[
                    { value: '', label: `${key} — choose an existing empty vessel` },
                    ...(selected && !vessels.some((item) => item.id === selected)
                      ? [{ value: selected, label: `Selected vessel ${selected}` }]
                      : []),
                    ...vessels.map((item) => ({
                      value: item.id,
                      label: `${item.name} · ${vesselLocation(data.state, item)} · ${item.id}${boundVesselIds.has(item.id) ? ' · Already bound to this source' : ''}`,
                    })),
                  ]}
                  onValueChange={(value) =>
                    editChoices({
                      ...draft.choices,
                      vessels: replaceKey(
                        draft.choices.vessels,
                        key,
                        value ? { key, vesselId: value } : undefined
                      ),
                    })
                  }
                />
              );
            })}
          </div>
        ) : null}
        {draft.inspection.rows.length ? (
          <div className="space-y-3" data-testid="inventory-table-rows">
            <h3 className="font-semibold">Row decisions</h3>
            {draft.inspection.rows.map((row) => {
              const skipped = draft.choices.skips.find((item) => item.sourceId === row.sourceId);
              return (
                <div
                  key={row.index}
                  className="space-y-2 rounded border border-border p-3 text-xs"
                  data-source-id={row.sourceId ?? ''}
                  data-row-kind={preview ? row.kind : 'needs-preview'}
                >
                  <p className="break-all font-medium">
                    Row {row.index}: {row.sourceId === null ? 'Unresolved source ID' : row.sourceId}
                  </p>
                  {row.fields ? (
                    <p className="break-words">
                      {row.fields.name || row.fields.vessel_key} · {row.fields.material_key} ·{' '}
                      {row.fields.quantity_kind === 'unknown'
                        ? 'Unknown quantity'
                        : `${row.fields.quantity} ${row.fields.unit}`}
                    </p>
                  ) : null}
                  <p>{preview ? row.kind : 'Preview the updated choices to resolve this row.'}</p>
                  {row.reason ? <p>{row.reason}</p> : null}
                  {row.stockId ? <p className="break-all">Stock: {row.stockId}</p> : null}
                  {row.vesselId ? <p className="break-all">Vessel: {row.vesselId}</p> : null}
                  {preview
                    ? row.issues.map((issue, index) => <p key={index}>{issue.message}</p>)
                    : null}
                  {row.sourceId !== null ? (
                    <>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          aria-label={`Skip table source ${row.sourceId}`}
                          checked={Boolean(skipped)}
                          disabled={busy}
                          onChange={(event) =>
                            skip(row.sourceId!, event.target.checked ? '' : null)
                          }
                        />
                        Skip this source row with a reason
                      </label>
                      {skipped ? (
                        <TextField
                          aria-label={`Skip reason for table source ${row.sourceId}`}
                          value={skipped.reason}
                          disabled={busy}
                          onChange={(event) => skip(row.sourceId!, event.target.value)}
                        />
                      ) : null}
                    </>
                  ) : null}
                </div>
              );
            })}
            <p className="text-xs text-fg-muted">
              Skipping does not delete stock or mark it missing. A proposal with no new rows writes
              no operation or skip history. Already imported rows never reset later use, movement or
              condition changes. Changed source facts require separate reconciliation.
            </p>
          </div>
        ) : null}
        <Button disabled={busy || !draft.sourceText} onClick={() => void inspect()}>
          {draft.phase === 'previewing' ? 'Previewing…' : 'Preview table'}
        </Button>
        {draft.phase === 'failed' ? <Notice tone="error">{draft.message}</Notice> : null}
        {stale ? (
          <Notice tone="warning">
            This table preview is stale. Preview the retained source and choices again before
            receiving stock.
          </Notice>
        ) : null}
        {preview ? (
          <div
            className="space-y-3"
            data-testid="inventory-table-preview"
            data-plan-digest={preview.planDigest ?? ''}
          >
            <p className="font-semibold">
              {stale
                ? 'Stale preview'
                : preview.kind === 'ready'
                  ? 'Ready for atomic receiving'
                  : preview.kind === 'no-change'
                    ? 'No new stock to receive'
                    : 'Resolution required'}
            </p>
            <p className="break-all text-xs">Source SHA-256: {preview.sourceSha256}</p>
            <p className="text-xs">
              {preview.rows.filter((row) => row.kind === 'create').length} new rows ·{' '}
              {preview.rows.filter((row) => row.kind === 'unchanged').length} already imported ·{' '}
              {preview.rows.filter((row) => row.kind === 'skipped').length} explicitly skipped
            </p>
            <p className="text-xs">
              {preview.commands.length} of {MAX_INVENTORY_BATCH_COMMANDS} supported commands in one
              atomic operation. A refusal applies none of them. No automatic splitting occurs.
            </p>
            {preview.issues.map((issue, index) => (
              <Notice key={`${issue.code}:${index}`} tone="warning" testId="inventory-table-issue">
                {issue.message}
                <span className="mt-1 block break-all font-mono text-xs">{issue.pointer}</span>
              </Notice>
            ))}
            {preview.kind === 'ready' ? (
              <p className="break-all text-xs">Plan: {preview.planDigest}</p>
            ) : null}
          </div>
        ) : null}
      </section>
    </InventoryPhysicalDialog>
  );
}
