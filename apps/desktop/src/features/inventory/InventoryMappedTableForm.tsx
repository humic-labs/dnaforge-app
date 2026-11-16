import { useEffect, useRef, useState } from 'react';
import {
  MAX_INVENTORY_BATCH_COMMANDS,
  inventoryStoragePositions,
  type InventoryMappedSourcePlate,
  type InventoryMappedTableChoices,
  type InventoryMappedTableRowPreview,
  type InventoryQuality,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea, TextField } from '../../components/ui';
import { platform } from '../../platform';
import type {
  InventoryClient,
  InventoryMappedTablePreviewSnapshot,
  InventoryMaterial,
} from '../../shared/inventory-client';
import { readInventoryArchiveFile } from './inventory-archive-file';
import {
  inventoryCanEdit,
  type InventoryController,
  type InventoryControllerState,
  type InventoryData,
} from './inventory-controller';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import { locationPath } from './inventory-view';

interface MappedInspection {
  readonly headers: readonly string[];
  readonly sourceIds: readonly string[];
  readonly sourcePlates: readonly InventoryMappedSourcePlate[];
  readonly rows: readonly InventoryMappedTableRowPreview[];
}
interface MappedDraftFacts {
  readonly sourceText: string;
  readonly sourcePath: string | null;
  readonly choices: InventoryMappedTableChoices;
  readonly quantityDeclared: boolean;
  readonly inspection: MappedInspection;
}
type MappedDraft = MappedDraftFacts &
  (
    | { phase: 'editing' | 'reading-source' | 'previewing' }
    | { phase: 'previewed'; preview: InventoryMappedTablePreviewSnapshot }
    | { phase: 'failed'; message: string }
  );
const emptyInspection: MappedInspection = {
  headers: [],
  sourceIds: [],
  sourcePlates: [],
  rows: [],
};
const emptyChoices = (): InventoryMappedTableChoices => ({
  namespace: '',
  delimiter: ',',
  columns: { sourceId: '', plate: '', well: '' },
  materials: [],
  plates: [],
  quantity: { kind: 'unknown', reason: '' },
  qualities: [],
  evidenceOnlyColumns: [],
  skips: [],
});
const facts = ({
  sourceText,
  sourcePath,
  choices,
  quantityDeclared,
  inspection,
}: MappedDraft): MappedDraftFacts => ({
  sourceText,
  sourcePath,
  choices,
  quantityDeclared,
  inspection,
});
function replaceSource<T extends { readonly sourceId: string }>(
  values: readonly T[],
  sourceId: string,
  value?: T
): readonly T[] {
  return [...values.filter((item) => item.sourceId !== sourceId), ...(value ? [value] : [])];
}
const rowLabels = {
  create: 'Receive this stock into the selected permanent well',
  unchanged: 'Already imported; keep current inventory',
  skipped: 'Explicitly skipped',
  blocked: 'Resolve this row before receiving',
} as const;

export function InventoryMappedTableForm({
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
    status.attempt.request.kind === 'receive-mapped-table'
      ? status.attempt.request
      : null;
  const [draft, setDraft] = useState<MappedDraft>(() => ({
    phase: 'editing',
    sourceText: pending?.sourceText ?? '',
    sourcePath: null,
    choices: pending
      ? {
          ...pending.options,
          materials: pending.options.materials.map(({ sourceId, materialId }) => ({
            sourceId,
            materialId,
          })),
        }
      : emptyChoices(),
    quantityDeclared: Boolean(pending),
    inspection: emptyInspection,
  }));
  const [query, setQuery] = useState('');
  const [materials, setMaterials] = useState<readonly InventoryMaterial[]>([]);
  const [materialError, setMaterialError] = useState<string | null>(null);
  const [evidenceReason, setEvidenceReason] = useState('');
  const generation = useRef(0);
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
        status.attempt.request.kind === 'receive-mapped-table'))
  );
  const canApply =
    preview?.kind === 'ready' && !stale && draft.quantityDeclared && inventoryCanEdit(status);
  const plates = Object.values(data.state.storage).filter(
    (item) => item.layout.kind === 'fixed-well'
  );
  const roleColumns = new Set(Object.values(draft.choices.columns));
  const evidenceColumns = draft.inspection.headers.filter((column) => !roleColumns.has(column));
  const skipped = new Set(draft.choices.skips.map((item) => item.sourceId));
  const sourceBindings = Object.values(data.state.tableBindings).filter(
    (item) => item.namespace === draft.choices.namespace
  );

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

  function editChoices(
    choices: InventoryMappedTableChoices,
    quantityDeclared = draft.quantityDeclared
  ) {
    ++generation.current;
    setDraft({ ...facts(draft), choices, quantityDeclared, phase: 'editing' });
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
      quantityDeclared: false,
      inspection: emptyInspection,
    });
  }
  function editColumn(role: keyof InventoryMappedTableChoices['columns'], column: string) {
    ++generation.current;
    const columns = { ...draft.choices.columns, [role]: column };
    setDraft({
      ...facts(draft),
      phase: 'editing',
      choices: {
        ...draft.choices,
        columns,
        materials: [],
        plates: [],
        qualities: [],
        skips: [],
        evidenceOnlyColumns: draft.choices.evidenceOnlyColumns.filter(
          (item) => !Object.values(columns).includes(item.column)
        ),
      },
      inspection: { ...emptyInspection, headers: draft.inspection.headers },
    });
  }
  async function chooseFile() {
    if (busy) return;
    const before = draft;
    const current = ++generation.current;
    setDraft({ ...facts(before), phase: 'reading-source' });
    try {
      const selected = await platform().dialog.open({
        title: 'Choose plate spreadsheet',
        multiple: false,
        filters: [{ name: 'CSV or TSV spreadsheet', extensions: ['csv', 'tsv', 'txt'] }],
      });
      if (generation.current !== current) return;
      if (selected === null) {
        setDraft(before);
        return;
      }
      if (Array.isArray(selected) && selected.length !== 1)
        throw new Error('Choose one spreadsheet.');
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
      const result = await client.previewMappedTable({
        project: data.project.projectId,
        inventoryId: data.project.defaultInventoryId,
        format: 'mapped-plate-v1',
        sourceText: before.sourceText,
        options: before.choices,
      });
      if (generation.current !== current) return;
      if (
        result.target.projectId !== data.project.projectId ||
        result.target.inventoryId !== data.project.defaultInventoryId
      )
        throw new Error('The mapped preview belongs to another project or inventory.');
      const inspection: MappedInspection =
        result.rows.length || !before.inspection.rows.length
          ? result
          : {
              ...before.inspection,
              rows: before.inspection.rows.map((row) => ({
                ...row,
                kind: 'blocked',
                materialId: null,
                vesselId: null,
                position: null,
                quality: null,
                fields: null,
                stockId: null,
                issues: [],
              })),
            };
      setDraft({ ...before, phase: 'previewed', inspection, preview: result });
    } catch (cause) {
      if (generation.current === current)
        setDraft({
          ...before,
          phase: 'failed',
          message: cause instanceof Error ? cause.message : String(cause),
        });
    }
  }
  function setPlate(sourcePlate: string, storageId: string) {
    editChoices({
      ...draft.choices,
      plates: [
        ...draft.choices.plates.filter((item) => item.sourcePlate !== sourcePlate),
        ...(storageId ? [{ sourcePlate, storageId, positions: [] }] : []),
      ],
    });
  }
  function setPosition(sourcePlate: string, sourceWell: string, position: string) {
    editChoices({
      ...draft.choices,
      plates: draft.choices.plates.map((plate) =>
        plate.sourcePlate === sourcePlate
          ? {
              ...plate,
              positions: [
                ...plate.positions.filter((item) => item.sourceWell !== sourceWell),
                ...(position ? [{ sourceWell, position }] : []),
              ],
            }
          : plate
      ),
    });
  }
  function skip(sourceId: string, reason: string | null) {
    const skips = replaceSource(
      draft.choices.skips,
      sourceId,
      reason === null ? undefined : { sourceId, reason }
    );
    const selected = new Set(skips.map((item) => item.sourceId));
    const activeRows = draft.inspection.rows.filter(
      (row) => row.sourceId !== null && !selected.has(row.sourceId)
    );
    const usedPositions = new Map<string, Set<string>>();
    for (const row of activeRows) {
      if (row.sourcePlate === null || row.sourceWell === null) continue;
      const wells = usedPositions.get(row.sourcePlate) ?? new Set<string>();
      wells.add(row.sourceWell);
      usedPositions.set(row.sourcePlate, wells);
    }
    editChoices({
      ...draft.choices,
      skips,
      plates: draft.choices.plates
        .filter((plate) => usedPositions.has(plate.sourcePlate))
        .map((plate) => ({
          ...plate,
          positions: plate.positions.filter((position) =>
            usedPositions.get(plate.sourcePlate)!.has(position.sourceWell)
          ),
        })),
      materials: draft.choices.materials.filter((item) => !selected.has(item.sourceId)),
      qualities: draft.choices.qualities.filter((item) => !selected.has(item.sourceId)),
    });
  }
  async function apply() {
    if (!canApply || preview?.kind !== 'ready') return;
    if (await controller.receiveMappedTable(draft.sourceText, preview.options, preview.planDigest))
      onClose();
  }

  return (
    <InventoryPhysicalDialog
      title="Map plate spreadsheet"
      subtitle={data.project.name}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={() => void apply()}
      submitLabel="Receive mapped stocks"
      disabled={!canApply}
    >
      <section
        className="space-y-4"
        data-testid="inventory-mapped-import"
        data-preview-state={stale ? 'stale' : (preview?.kind ?? draft.phase)}
      >
        <p>
          Map original spreadsheet rows to existing scientific records and permanent wells.
          Scientific publication and plate creation are separate steps. Every column and physical
          interpretation requires an explicit decision.
        </p>
        <TextField
          aria-label="Mapped source namespace"
          value={draft.choices.namespace}
          disabled={busy}
          onChange={(event) => editChoices({ ...draft.choices, namespace: event.target.value })}
        />
        <p className="text-xs text-fg-muted">
          Keep this source namespace and each source ID stable when the spreadsheet is sorted or
          revised.
        </p>
        <Select
          ariaLabel="Mapped delimiter"
          value={draft.choices.delimiter}
          disabled={busy}
          options={[
            { value: ',', label: 'CSV (comma)' },
            { value: '\t', label: 'TSV (tab)' },
          ]}
          onValueChange={(delimiter) => {
            ++generation.current;
            setDraft({
              ...facts(draft),
              phase: 'editing',
              choices: {
                ...emptyChoices(),
                namespace: draft.choices.namespace,
                delimiter: delimiter as ',' | '\t',
              },
              quantityDeclared: false,
              inspection: emptyInspection,
            });
          }}
        />
        <Button disabled={busy} onClick={() => void chooseFile()}>
          {draft.phase === 'reading-source' ? 'Reading spreadsheet…' : 'Choose spreadsheet file'}
        </Button>
        {draft.sourcePath ? (
          <p className="break-all text-xs">Source file: {draft.sourcePath}</p>
        ) : null}
        <details>
          <summary className="cursor-pointer text-sm text-accent">
            Paste or inspect original spreadsheet
          </summary>
          <TextArea
            aria-label="Original spreadsheet text"
            value={draft.sourceText}
            disabled={busy}
            onChange={(event) => editSource(event.target.value)}
            className="mt-2 h-40 font-mono text-xs"
          />
        </details>
        {draft.inspection.headers.length ? (
          <section className="space-y-3">
            <h3 className="font-semibold">Source columns</h3>
            {(
              [
                ['sourceId', 'Source ID column'],
                ['plate', 'Plate column'],
                ['well', 'Well column'],
              ] as const
            ).map(([role, label]) => (
              <Select
                key={role}
                ariaLabel={label}
                value={draft.choices.columns[role]}
                disabled={busy}
                options={[
                  { value: '', label: `Choose ${label.toLowerCase()}` },
                  ...draft.inspection.headers.map((column) => ({ value: column, label: column })),
                ]}
                onValueChange={(column) => editColumn(role, column)}
              />
            ))}
            <TextField
              aria-label="Reason for evidence-only columns"
              value={evidenceReason}
              disabled={busy}
              onChange={(event) => setEvidenceReason(event.target.value)}
            />
            <Button
              disabled={
                busy ||
                !evidenceReason.trim() ||
                !draft.choices.columns.sourceId ||
                !draft.choices.columns.plate ||
                !draft.choices.columns.well
              }
              onClick={() =>
                editChoices({
                  ...draft.choices,
                  evidenceOnlyColumns: evidenceColumns.map((column) => ({
                    column,
                    reason: evidenceReason,
                  })),
                })
              }
            >
              Retain remaining columns as evidence
            </Button>
            <p className="text-xs text-fg-muted">
              These columns remain in the complete original source. QC labels do not choose quality;
              box labels do not establish a freezer or parent location.
            </p>
            {evidenceColumns.map((column) => {
              const disposition = draft.choices.evidenceOnlyColumns.find(
                (item) => item.column === column
              );
              return (
                <div key={column} className="rounded border border-border p-2 text-sm">
                  <p>
                    {column}: {disposition ? 'Evidence only' : 'Disposition required'}
                  </p>
                  {disposition ? (
                    <TextField
                      aria-label={`Evidence reason for ${column}`}
                      value={disposition.reason}
                      disabled={busy}
                      onChange={(event) =>
                        editChoices({
                          ...draft.choices,
                          evidenceOnlyColumns: draft.choices.evidenceOnlyColumns.map((item) =>
                            item.column === column ? { ...item, reason: event.target.value } : item
                          ),
                        })
                      }
                    />
                  ) : null}
                </div>
              );
            })}
          </section>
        ) : null}
        <section className="space-y-2">
          <h3 className="font-semibold">Quantity interpretation</h3>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              aria-label="Declare unknown quantity"
              checked={draft.quantityDeclared}
              disabled={busy}
              onChange={(event) =>
                editChoices(
                  { ...draft.choices, quantity: { kind: 'unknown', reason: '' } },
                  event.target.checked
                )
              }
            />
            Declare every received quantity unknown
          </label>
          {draft.quantityDeclared ? (
            <TextField
              aria-label="Reason for unknown quantity"
              value={draft.choices.quantity.reason}
              disabled={busy}
              onChange={(event) =>
                editChoices({
                  ...draft.choices,
                  quantity: { kind: 'unknown', reason: event.target.value },
                })
              }
            />
          ) : null}
          <p className="text-xs text-fg-muted">
            This adapter receives no invented volume. Use a measured stocktake separately when an
            amount is known.
          </p>
        </section>
        {draft.inspection.sourcePlates.length ? (
          <section className="space-y-3">
            <h3 className="font-semibold">Plate and position decisions</h3>
            {draft.inspection.sourcePlates.map(({ sourcePlate, sourceWells }) => {
              const selected = draft.choices.plates.find(
                (item) => item.sourcePlate === sourcePlate
              );
              const destination = selected ? data.state.storage[selected.storageId] : undefined;
              return (
                <article key={sourcePlate} className="space-y-2 rounded border border-border p-3">
                  <p className="font-medium">Source plate: {sourcePlate}</p>
                  <Select
                    ariaLabel={`Destination plate for ${sourcePlate}`}
                    value={selected?.storageId ?? ''}
                    disabled={busy}
                    options={[
                      { value: '', label: 'Choose an existing permanent-well plate' },
                      ...(selected && !plates.some((plate) => plate.id === selected.storageId)
                        ? [
                            {
                              value: selected.storageId,
                              label: `Selected plate ${selected.storageId}`,
                            },
                          ]
                        : []),
                      ...plates.map((plate) => ({
                        value: plate.id,
                        label: `${plate.name} · ${locationPath(data.state, plate.id)} · ${plate.id}`,
                      })),
                    ]}
                    onValueChange={(storageId) => setPlate(sourcePlate, storageId)}
                  />
                  {sourceWells.map((sourceWell) => (
                    <Select
                      key={sourceWell}
                      ariaLabel={`Position for ${sourcePlate} / ${sourceWell}`}
                      value={
                        selected?.positions.find((item) => item.sourceWell === sourceWell)
                          ?.position ?? ''
                      }
                      disabled={busy || !destination}
                      options={[
                        {
                          value: '',
                          label: `${sourceWell} — choose an exact destination position`,
                        },
                        ...(destination?.layout.kind === 'fixed-well'
                          ? inventoryStoragePositions(destination).map((position) => ({
                              value: position,
                              label: position,
                            }))
                          : []),
                      ]}
                      onValueChange={(position) => setPosition(sourcePlate, sourceWell, position)}
                    />
                  ))}
                </article>
              );
            })}
            <p className="text-xs text-fg-muted">
              A01 and A1 are different source labels. No position translation or plate size is
              assumed.
            </p>
          </section>
        ) : null}
        {draft.inspection.rows.length ? (
          <section className="space-y-3">
            <h3 className="font-semibold">Rows and scientific identities</h3>
            <TextField
              aria-label="Search mapped scientific records"
              value={query}
              disabled={busy}
              onChange={(event) => setQuery(event.target.value)}
            />
            {materialError ? <Notice tone="error">{materialError}</Notice> : null}
            <div className="space-y-3" data-testid="inventory-mapped-rows">
              {draft.inspection.rows.map((row) => {
                const sourceId = row.sourceId;
                const material = draft.choices.materials.find((item) => item.sourceId === sourceId);
                const quality = draft.choices.qualities.find((item) => item.sourceId === sourceId);
                const excluded =
                  sourceId === null
                    ? undefined
                    : draft.choices.skips.find((item) => item.sourceId === sourceId);
                const boundMaterial = sourceBindings.find(
                  (item) => item.sourceId === sourceId
                )?.materialId;
                const choices = [...materials];
                for (const id of [material?.materialId, boundMaterial])
                  if (id && !choices.some((item) => item.id === id))
                    choices.push({ id, name: `Bound scientific record ${id}`, registryId: null });
                return (
                  <article
                    key={row.index}
                    className="space-y-3 rounded border border-border p-3 text-sm"
                    data-source-id={sourceId ?? ''}
                    data-row-kind={preview ? row.kind : 'editing'}
                  >
                    <p className="font-medium">
                      Row {row.index}: {sourceId ?? 'Choose the source ID column'}
                    </p>
                    {row.sourceFields ? (
                      <details>
                        <summary className="cursor-pointer text-accent">
                          Original source fields
                        </summary>
                        <dl>
                          {draft.inspection.headers.map((column) => (
                            <div key={column} className="grid grid-cols-2 gap-2">
                              <dt>{column}</dt>
                              <dd className="break-words whitespace-pre-wrap">
                                {row.sourceFields?.[column]}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </details>
                    ) : null}
                    <p>
                      {preview
                        ? rowLabels[row.kind]
                        : 'Preview the updated choices to resolve this row.'}
                    </p>
                    {preview && row.fields ? (
                      <p>
                        Quantity: unknown · Quality: {row.quality} · Source plate/well:{' '}
                        {row.sourcePlate} / {row.sourceWell} → {row.position}
                        <br />
                        Stock: {row.stockId ?? 'Not assigned'}
                        <br />
                        Permanent well: {row.vesselId ?? 'Unresolved'}
                      </p>
                    ) : null}
                    {row.issues.map((issue, index) => (
                      <p key={index}>{issue.message}</p>
                    ))}
                    {sourceId !== null ? (
                      <>
                        {!skipped.has(sourceId) ? (
                          <>
                            <Select
                              ariaLabel={`Scientific record for source ${sourceId}`}
                              value={material?.materialId ?? ''}
                              disabled={busy}
                              options={[
                                { value: '', label: 'Choose a scientific record explicitly' },
                                ...choices.map((item) => ({
                                  value: item.id,
                                  label: `${item.name} · ${item.id}`,
                                })),
                              ]}
                              onValueChange={(materialId) =>
                                editChoices({
                                  ...draft.choices,
                                  materials: replaceSource(
                                    draft.choices.materials,
                                    sourceId,
                                    materialId ? { sourceId, materialId } : undefined
                                  ),
                                })
                              }
                            />
                            <Select
                              ariaLabel={`Quality for source ${sourceId}`}
                              value={quality?.quality ?? ''}
                              disabled={busy}
                              options={[
                                { value: '', label: 'Choose physical stock quality' },
                                { value: 'usable', label: 'Usable' },
                                { value: 'quarantined', label: 'Quarantined' },
                              ]}
                              onValueChange={(value) =>
                                editChoices({
                                  ...draft.choices,
                                  qualities: replaceSource(
                                    draft.choices.qualities,
                                    sourceId,
                                    value
                                      ? {
                                          sourceId,
                                          quality: value as InventoryQuality,
                                          reason: quality?.reason ?? '',
                                        }
                                      : undefined
                                  ),
                                })
                              }
                            />
                            {quality ? (
                              <TextField
                                aria-label={`Quality reason for source ${sourceId}`}
                                value={quality.reason}
                                disabled={busy}
                                onChange={(event) =>
                                  editChoices({
                                    ...draft.choices,
                                    qualities: replaceSource(draft.choices.qualities, sourceId, {
                                      ...quality,
                                      reason: event.target.value,
                                    }),
                                  })
                                }
                              />
                            ) : null}
                          </>
                        ) : null}
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            aria-label={`Skip mapped source ${sourceId}`}
                            checked={Boolean(excluded)}
                            disabled={busy}
                            onChange={(event) =>
                              skip(sourceId, event.target.checked ? (excluded?.reason ?? '') : null)
                            }
                          />
                          Skip this source row with a reason
                        </label>
                        {excluded ? (
                          <TextField
                            aria-label={`Skip reason for mapped source ${sourceId}`}
                            value={excluded.reason}
                            disabled={busy}
                            onChange={(event) => skip(sourceId, event.target.value)}
                          />
                        ) : null}
                      </>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}
        <Button disabled={busy || !draft.sourceText} onClick={() => void inspect()}>
          {draft.phase === 'previewing' ? 'Previewing…' : 'Preview mapped receiving'}
        </Button>
        {draft.phase === 'failed' ? <Notice tone="error">{draft.message}</Notice> : null}
        {stale ? (
          <Notice tone="warning">
            This mapped preview is stale. Preview the retained source and decisions again.
          </Notice>
        ) : null}
        {preview ? (
          <section
            className="space-y-2"
            data-testid="inventory-mapped-preview"
            data-plan-digest={preview.planDigest ?? ''}
          >
            <h3 className="font-semibold">
              {stale
                ? 'Preview needs refreshing'
                : preview.kind === 'ready'
                  ? 'Ready for atomic mapped receiving'
                  : preview.kind === 'no-change'
                    ? 'No physical changes'
                    : 'Resolve the spreadsheet interpretation'}
            </h3>
            {preview.issues.map((issue, index) => (
              <p key={index} className="text-sm">
                {issue.message}
              </p>
            ))}
            <p>
              {preview.rows.filter((row) => row.kind === 'create').length} new stocks ·{' '}
              {preview.rows.filter((row) => row.kind === 'unchanged').length} already imported ·{' '}
              {preview.rows.filter((row) => row.kind === 'skipped').length} explicitly skipped
            </p>
            {preview.kind === 'ready' ? (
              <p>
                {preview.innerPreview?.commands.length ?? 0} of {MAX_INVENTORY_BATCH_COMMANDS}{' '}
                supported commands in one atomic operation. A refusal receives none of these stocks.
                No automatic splitting occurs.
              </p>
            ) : null}
            {preview.kind === 'no-change' ? (
              <Notice>
                No new source file or receipt is saved. Changes only to retained evidence columns do
                not change physical stock; this preview does not retain the revised file.
              </Notice>
            ) : (
              <p className="text-xs text-fg-muted">
                The complete original source and all explicit decisions are retained only when this
                proposal commits.
              </p>
            )}
            <details>
              <summary className="cursor-pointer text-accent">Source and plan identity</summary>
              <p className="break-all text-xs">Source SHA-256: {preview.sourceSha256}</p>
              {preview.planDigest ? (
                <p className="break-all text-xs">Plan: {preview.planDigest}</p>
              ) : null}
            </details>
          </section>
        ) : null}
      </section>
    </InventoryPhysicalDialog>
  );
}
