import { useEffect, useRef, useState } from 'react';
import {
  INVENTORY_HIERARCHY_COLUMNS,
  MAX_INVENTORY_BATCH_COMMANDS,
  type InventoryHierarchyChoices,
  type InventoryHierarchyRowPreview,
  type InventoryLayout,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea, TextField } from '../../components/ui';
import { platform } from '../../platform';
import type {
  InventoryClient,
  InventoryHierarchyPreviewSnapshot,
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

interface HierarchyInspection {
  readonly parentKeys: readonly string[];
  readonly rows: readonly InventoryHierarchyRowPreview[];
}
interface HierarchyDraftFacts {
  readonly sourceText: string;
  readonly sourcePath: string | null;
  readonly choices: InventoryHierarchyChoices;
  readonly inspection: HierarchyInspection;
}
type HierarchyDraft = HierarchyDraftFacts &
  (
    | { phase: 'editing' | 'reading-source' | 'previewing' }
    | { phase: 'previewed'; preview: InventoryHierarchyPreviewSnapshot }
    | { phase: 'failed'; message: string }
  );
const emptyInspection: HierarchyInspection = { parentKeys: [], rows: [] };
const emptyChoices = (): InventoryHierarchyChoices => ({
  namespace: '',
  delimiter: ',',
  parents: [],
  skips: [],
});
const facts = ({
  sourceText,
  sourcePath,
  choices,
  inspection,
}: HierarchyDraft): HierarchyDraftFacts => ({ sourceText, sourcePath, choices, inspection });
const rowLabels = {
  create: 'Create this location',
  unchanged: 'Already imported; keep current inventory',
  skipped: 'Explicitly skipped',
  blocked: 'Resolve this row before importing',
} as const;

function layoutLabel(layout: InventoryLayout): string {
  switch (layout.kind) {
    case 'named':
      return `Named positions: ${layout.slots.join(', ')}`;
    case 'grid':
      return `Grid: ${layout.rows} rows × ${layout.columns} columns`;
    case 'removable-tube':
      return `Tube box: ${layout.rows} rows × ${layout.columns} columns`;
    case 'fixed-well':
      return `Permanent-well plate: ${layout.rows} rows × ${layout.columns} columns`;
    case 'stack':
      return `Ordered stack: capacity ${layout.capacity}, top-only removal`;
  }
}

export function InventoryHierarchyForm({
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
    status.attempt.request.kind === 'import-hierarchy'
      ? status.attempt.request
      : null;
  const [draft, setDraft] = useState<HierarchyDraft>(() => ({
    phase: 'editing',
    sourceText: pending?.sourceText ?? '',
    sourcePath: null,
    choices: pending?.options ?? emptyChoices(),
    inspection: emptyInspection,
  }));
  const [parentQuery, setParentQuery] = useState('');
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
        status.attempt.request.kind === 'import-hierarchy'))
  );
  const canApply = preview?.kind === 'ready' && !stale && inventoryCanEdit(status);
  const parents = Object.values(data.state.storage)
    .filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(parentQuery.toLowerCase()))
    .slice(0, 100);

  useEffect(
    () => () => {
      ++generation.current;
    },
    []
  );

  function editChoices(choices: InventoryHierarchyChoices) {
    ++generation.current;
    setDraft({ ...facts(draft), choices, phase: 'editing' });
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
        title: 'Choose inventory hierarchy table',
        multiple: false,
        filters: [{ name: 'CSV or TSV table', extensions: ['csv', 'tsv', 'txt'] }],
      });
      if (generation.current !== current) return;
      if (selected === null) {
        setDraft(before);
        return;
      }
      if (Array.isArray(selected) && selected.length !== 1)
        throw new Error('Choose one hierarchy table.');
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
      const result = await client.previewHierarchy({
        project: data.project.projectId,
        inventoryId: data.project.defaultInventoryId,
        format: 'hierarchy-v1',
        sourceText: before.sourceText,
        options: before.choices,
      });
      if (generation.current !== current) return;
      if (
        result.target.projectId !== data.project.projectId ||
        result.target.inventoryId !== data.project.defaultInventoryId
      )
        throw new Error('The hierarchy preview belongs to another project or inventory.');
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
                  kind: 'blocked',
                  storageId: null,
                  layout: null,
                  destination: null,
                  reason: null,
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
  function skip(sourceId: string, reason: string | null) {
    const skips = [
      ...draft.choices.skips.filter((item) => item.sourceId !== sourceId),
      ...(reason === null ? [] : [{ sourceId, reason }]),
    ];
    const skippedIds = new Set(skips.map((item) => item.sourceId));
    const retained = new Set(
      draft.inspection.rows
        .filter((row) => row.sourceId === null || !skippedIds.has(row.sourceId))
        .filter((row) => row.fields?.parent_kind === 'existing')
        .map((row) => row.fields?.parent_key)
    );
    editChoices({
      ...draft.choices,
      skips,
      parents: draft.choices.parents.filter((item) => retained.has(item.key)),
    });
  }
  async function apply() {
    if (!canApply || preview?.kind !== 'ready') return;
    if (await controller.importHierarchy(draft.sourceText, preview.options, preview.planDigest))
      onClose();
  }
  const example = [
    INVENTORY_HIERARCHY_COLUMNS.join(','),
    'freezer,Freezer,named,"[""Shelf 1""]",,,,root,,',
    'shelf,Shelf 1,named,"[""Box 1"",""Plate stack""]",,,,source,freezer,Shelf 1',
    'box,Box 1,removable-tube,,2,3,,source,shelf,Box 1',
    'stack,Plate stack,stack,,,,2,source,shelf,Plate stack',
    'plate,Plate 1,fixed-well,,2,3,,source,stack,1',
  ].join('\n');

  return (
    <InventoryPhysicalDialog
      title="Import inventory hierarchy"
      subtitle={data.project.name}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        void apply();
      }}
      submitLabel="Import hierarchy"
      disabled={!canApply}
    >
      <section
        className="space-y-4"
        data-testid="inventory-hierarchy-import"
        data-preview-state={stale ? 'stale' : (preview?.kind ?? draft.phase)}
      >
        <p className="text-sm">
          Create locations, boxes, permanent-well plates and ordered stacks from explicit layouts
          and parent positions. Previewing changes nothing. The complete accepted proposal commits
          in one operation.
        </p>
        <TextField
          aria-label="Hierarchy source namespace"
          placeholder="Stable source collection"
          value={draft.choices.namespace}
          disabled={busy}
          onChange={(event) => editChoices({ ...draft.choices, namespace: event.target.value })}
        />
        <p className="text-xs text-fg-muted">
          Keep the namespace and each source ID stable when rows are sorted or the file is revised.
          Source identity is separate from file name and row number.
        </p>
        <Select
          ariaLabel="Hierarchy delimiter"
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
              choices: { ...draft.choices, delimiter: value as ',' | '\t', parents: [], skips: [] },
              inspection: emptyInspection,
              phase: 'editing',
            });
          }}
        />
        <details className="space-y-2 text-sm">
          <summary className="cursor-pointer text-accent">
            Canonical hierarchy format and example
          </summary>
          <p>
            Every column is required once. Named layouts use a JSON array of exact position names.
            Grid, tube-box and permanent-well layouts require explicit rows and columns; stacks
            require capacity. Leave unused layout fields empty.
          </p>
          <p>
            Parent kind is root, source or existing. Source refers to an exact ID in this table;
            existing requires a parent mapping below. Root uses empty parent key and slot. Stack
            slots are explicit positive ordinals, ordered from bottom to top.
          </p>
          <TextArea
            readOnly
            aria-label="Canonical hierarchy example"
            value={example}
            className="h-44 font-mono text-xs"
          />
        </details>
        <Button onClick={() => void chooseFile()} disabled={busy}>
          {draft.phase === 'reading-source' ? 'Reading hierarchy…' : 'Choose hierarchy file'}
        </Button>
        {draft.sourcePath ? (
          <p className="break-all text-xs text-fg-muted">Source file: {draft.sourcePath}</p>
        ) : null}
        <details className="space-y-2">
          <summary className="cursor-pointer text-accent">Paste or inspect hierarchy text</summary>
          <TextArea
            aria-label="Hierarchy table text"
            data-testid="inventory-hierarchy-source"
            value={draft.sourceText}
            disabled={busy}
            onChange={(event) => editSource(event.target.value)}
            className="h-48 font-mono text-xs"
          />
        </details>
        {draft.inspection.parentKeys.length ? (
          <div className="space-y-3">
            <h3 className="font-semibold">Existing parent locations</h3>
            <TextField
              aria-label="Search hierarchy parents"
              value={parentQuery}
              onChange={(event) => setParentQuery(event.target.value)}
              disabled={busy}
            />
            <p className="text-xs text-fg-muted">
              Up to 100 matching locations are shown. Existing source bindings remain identifiable
              after movement or disposal; the owner checks whether a new placement is allowed.
            </p>
            {draft.inspection.parentKeys.map((key) => {
              const selected = draft.choices.parents.find((item) => item.key === key)?.storageId;
              const retained =
                selected && !parents.some((item) => item.id === selected)
                  ? data.state.storage[selected]
                  : null;
              return (
                <Select
                  key={key}
                  ariaLabel={`Parent for ${key}`}
                  value={selected ?? ''}
                  disabled={busy}
                  options={[
                    { value: '', label: `${key} — choose an existing parent` },
                    ...(retained
                      ? [
                          {
                            value: retained.id,
                            label: `${locationPath(data.state, retained.id)} · ${retained.id}${retained.lifecycle === 'disposed' ? ' · Disposed' : ''}`,
                          },
                        ]
                      : selected && !data.state.storage[selected]
                        ? [{ value: selected, label: `Unavailable parent ${selected}` }]
                        : []),
                    ...parents.map((item) => ({
                      value: item.id,
                      label: `${locationPath(data.state, item.id)} · ${item.id}${item.lifecycle === 'disposed' ? ' · Disposed' : ''}`,
                    })),
                  ]}
                  onValueChange={(value) =>
                    editChoices({
                      ...draft.choices,
                      parents: [
                        ...draft.choices.parents.filter((item) => item.key !== key),
                        ...(value ? [{ key, storageId: value }] : []),
                      ],
                    })
                  }
                />
              );
            })}
          </div>
        ) : null}
        {draft.inspection.rows.length ? (
          <div className="space-y-3" data-testid="inventory-hierarchy-rows">
            {draft.inspection.rows.map((row) => {
              const skipped = draft.choices.skips.find((item) => item.sourceId === row.sourceId);
              return (
                <article
                  key={row.index}
                  className="space-y-2 rounded border border-border p-3 text-sm"
                  data-source-id={row.sourceId ?? ''}
                  data-row-kind={preview ? row.kind : 'editing'}
                >
                  <p className="break-words font-medium">
                    Row {row.index}: {row.sourceId ?? 'Unresolved source ID'}
                    {row.fields?.name ? ` · ${row.fields.name}` : ''}
                  </p>
                  {row.fields ? (
                    <p className="text-xs text-fg-muted">
                      Source layout: {row.fields.layout_kind} ·{' '}
                      {row.fields.parent_kind === 'root'
                        ? 'Top level'
                        : `Parent ${row.fields.parent_kind}: ${row.fields.parent_key} · Position ${row.fields.slot}`}
                    </p>
                  ) : null}
                  <p>
                    {preview
                      ? rowLabels[row.kind]
                      : 'Preview the updated choices before importing this row.'}
                  </p>
                  {preview && row.layout ? <p>{layoutLabel(row.layout)}</p> : null}
                  {preview && row.destination ? (
                    <p>
                      {row.destination.kind === 'root'
                        ? 'Destination: top level'
                        : `Destination: ${data.state.storage[row.destination.storageId] ? locationPath(data.state, row.destination.storageId) : row.destination.storageId} / ${row.destination.slotId}`}
                    </p>
                  ) : null}
                  {preview && row.storageId ? (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-accent">Physical identity</summary>
                      <p className="break-all">{row.storageId}</p>
                    </details>
                  ) : null}
                  {preview
                    ? row.issues.map((issue, index) => (
                        <p className="text-sm text-danger" key={index}>
                          {issue.message}
                        </p>
                      ))
                    : null}
                  {row.reason ? <p>{row.reason}</p> : null}
                  {row.sourceId !== null ? (
                    <>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          aria-label={`Skip hierarchy source ${row.sourceId}`}
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
                          aria-label={`Skip reason for hierarchy source ${row.sourceId}`}
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
        <p className="text-xs text-fg-muted">
          Skipping never deletes a location. An unbound skipped parent cannot become an invented
          root. Already imported rows keep later movement and disposal; changed source facts require
          separate reconciliation.
        </p>
        <Button onClick={() => void inspect()} disabled={busy || !draft.sourceText}>
          {draft.phase === 'previewing' ? 'Previewing…' : 'Preview hierarchy'}
        </Button>
        {draft.phase === 'failed' ? <Notice tone="error">{draft.message}</Notice> : null}
        {stale ? (
          <Notice tone="warning">
            This hierarchy preview is stale. Preview the retained source and choices again before
            importing.
          </Notice>
        ) : null}
        {preview ? (
          <section
            className="space-y-2"
            data-testid="inventory-hierarchy-preview"
            data-plan-digest={preview.planDigest ?? ''}
          >
            <h3 className="font-semibold">
              {stale
                ? 'Preview is stale'
                : preview.kind === 'ready'
                  ? 'Ready to import the complete hierarchy'
                  : preview.kind === 'no-change'
                    ? 'No new hierarchy locations'
                    : 'Resolve the hierarchy before importing'}
            </h3>
            <p>
              {preview.rows.filter((row) => row.kind === 'create').length} new locations ·{' '}
              {preview.rows.filter((row) => row.kind === 'unchanged').length} already imported ·{' '}
              {preview.rows.filter((row) => row.kind === 'skipped').length} explicitly skipped
            </p>
            {preview.kind === 'ready' ? (
              <>
                <p>
                  {preview.commands.length} of {MAX_INVENTORY_BATCH_COMMANDS} supported commands in
                  one atomic operation. A refusal creates none of the proposed locations. No
                  automatic splitting occurs.
                </p>
                <ol
                  className="list-decimal space-y-1 pl-5 text-sm"
                  aria-label="Hierarchy command order"
                >
                  {preview.commands.map((command, index) => (
                    <li key={index}>
                      {command.kind === 'create-layout-storage'
                        ? `Create ${command.name}`
                        : command.kind === 'push-stack'
                          ? `Push ${preview.rows.find((row) => row.storageId === command.item.id)?.fields?.name ?? command.item.id} onto ${preview.rows.find((row) => row.storageId === command.stackId)?.fields?.name ?? data.state.storage[command.stackId]?.name ?? command.stackId}`
                          : command.kind}
                    </li>
                  ))}
                </ol>
              </>
            ) : null}
            {preview.kind === 'no-change' ? (
              <p>
                No operation or skip history is written. Existing source bindings do not reset
                current placement, layout or lifecycle.
              </p>
            ) : null}
            {preview.issues.map((issue, index) => (
              <p key={index} className="text-sm text-danger">
                {issue.message}
              </p>
            ))}
            <details className="text-xs">
              <summary className="cursor-pointer text-accent">Source and plan identity</summary>
              <p className="break-all">Source SHA-256: {preview.sourceSha256}</p>
              {preview.planDigest ? <p className="break-all">Plan: {preview.planDigest}</p> : null}
            </details>
          </section>
        ) : null}
        <p className="text-xs text-fg-muted">
          These are declared logical layouts. Names and positions do not establish hardware
          dimensions, temperature control or qualified fit. Permanent wells are created by their
          plate owner; receive scientific stock in a separate visible step.
        </p>
      </section>
    </InventoryPhysicalDialog>
  );
}
