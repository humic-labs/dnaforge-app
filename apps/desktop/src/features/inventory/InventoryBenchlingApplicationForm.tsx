import { useEffect, useRef, useState } from 'react';
import type {
  InventoryBenchlingRecord,
  InventoryBenchlingCaptureChoices,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextField } from '../../components/ui';
import type {
  InventoryBenchlingCaptureSnapshot,
  InventoryBenchlingCapturePreviewSnapshot,
  InventoryClient,
  InventoryMaterial,
} from '../../shared/inventory-client';
import {
  inventoryCanEdit,
  type InventoryController,
  type InventoryControllerState,
  type InventoryData,
} from './inventory-controller';
import {
  buildCaptureChoices,
  captureDraftsFromChoices,
  captureRecordKey,
  captureReference,
  copyUniqueCaptureFacts,
  emptyCaptureRecordDraft,
  type CaptureFactDraft,
  type CaptureRecordDraft,
} from './inventory-benchling-draft';

type Draft = {
  records: Record<string, CaptureRecordDraft>;
  scopeReason: string;
  issueReasons: Record<string, string>;
} & (
  | { phase: 'editing' | 'previewing' }
  | { phase: 'failed'; message: string }
  | { phase: 'previewed'; preview: InventoryBenchlingCapturePreviewSnapshot }
);
const issueKey = (issue: { code: string; responseId: string | null; bodyPointer: string | null }) =>
  JSON.stringify([issue.code, issue.responseId, issue.bodyPointer]);
const activeAttempt = (status: InventoryControllerState) =>
  status.kind === 'submitting' ||
  status.kind === 'outcome-unknown' ||
  status.kind === 'committed-refresh-failed';

function Observation({
  record,
  field,
  value,
  onChange,
}: {
  record: InventoryBenchlingRecord;
  field: string;
  value: string;
  onChange(value: string): void;
}) {
  const observations =
    record.fields[field]?.observations.filter((item) => item.kind !== 'omitted') ?? [];
  const chosen = observations.find((item) => captureReference(item) === value);
  return (
    <div className="space-y-1">
      <Select
        ariaLabel={`Captured ${field} for ${record.sourceId}`}
        value={value}
        options={[
          { value: '', label: `Choose captured ${field}` },
          ...observations.map((item) => ({
            value: captureReference(item),
            label: `${item.responseId} ${item.pointer} · ${item.kind === 'present' ? item.jsonText.slice(0, 160) : 'null'}`,
          })),
        ]}
        onValueChange={onChange}
      />
      {chosen ? (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all text-xs">
          {chosen.kind === 'present' ? chosen.jsonText : 'null'}
        </pre>
      ) : null}
    </div>
  );
}
function Fact({
  record,
  field,
  draft,
  onChange,
}: {
  record: InventoryBenchlingRecord;
  field: string;
  draft: CaptureFactDraft;
  onChange(draft: CaptureFactDraft): void;
}) {
  return (
    <div className="space-y-2">
      <Select
        ariaLabel={`${field} basis for ${record.sourceId}`}
        value={draft.mode}
        options={[
          { value: 'captured', label: `Captured ${field}` },
          { value: 'declared', label: `Declare ${field}` },
        ]}
        onValueChange={(mode) => onChange({ ...draft, mode: mode as CaptureFactDraft['mode'] })}
      />
      {draft.mode === 'captured' ? (
        <Observation
          record={record}
          field={field}
          value={draft.reference}
          onChange={(reference) => onChange({ ...draft, reference })}
        />
      ) : (
        <TextField
          aria-label={`Declared ${field} for ${record.sourceId}`}
          value={draft.value}
          onChange={(event) => onChange({ ...draft, value: event.target.value })}
        />
      )}
      <TextField
        aria-label={`${field} reason for ${record.sourceId}`}
        placeholder="Reason for a declaration or conflict choice"
        value={draft.reason}
        onChange={(event) => onChange({ ...draft, reason: event.target.value })}
      />
    </div>
  );
}

function interpretedName(
  decision: InventoryBenchlingCaptureChoices['records'][number] | undefined,
  inspection: InventoryBenchlingCaptureSnapshot
): string | null {
  const fact =
    decision?.disposition === 'storage'
      ? decision.name
      : decision?.disposition === 'vessel' && decision.target.kind === 'movable'
        ? decision.target.name
        : null;
  if (!fact)
    return decision?.disposition === 'vessel' && decision.target.kind === 'fixed-well'
      ? `${decision.target.plateSourceId} / ${decision.target.position.value}`
      : null;
  if (fact.kind === 'declared') return fact.value;
  const record = inspection.records.find(
    (item) => captureRecordKey(item) === captureRecordKey(decision!.record)
  );
  const selected = record?.fields.name?.observations.find(
    (item) => item.responseId === fact.responseId && item.pointer === fact.pointer
  );
  if (selected?.kind !== 'present') return null;
  try {
    const name: unknown = JSON.parse(selected.jsonText);
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

export function InventoryBenchlingApplicationForm({
  data,
  controller,
  status,
  client,
  sourceText,
  inspection,
  onClose,
}: {
  data: InventoryData;
  controller: InventoryController;
  status: InventoryControllerState;
  client: InventoryClient;
  sourceText: string;
  inspection: InventoryBenchlingCaptureSnapshot;
  onClose(): void;
}) {
  const scope = JSON.stringify([
    data.project.projectId,
    data.project.defaultInventoryId,
    inspection.sourceSha256,
  ]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const generation = useRef(0);
  const [draft, setDraft] = useState<Draft>({
    phase: 'editing',
    records: {},
    scopeReason: '',
    issueReasons: {},
  });
  const [shown, setShown] = useState(100);
  const [query, setQuery] = useState('');
  const [materials, setMaterials] = useState<readonly InventoryMaterial[]>([]);
  const [materialError, setMaterialError] = useState('');
  const [bulkReason, setBulkReason] = useState('');
  const previousImport = [...data.history]
    .reverse()
    .find(
      (entry) =>
        'kind' in entry.request &&
        entry.request.kind === 'import-benchling-capture' &&
        entry.request.options.normalizedTableOptions.namespace === inspection.capture?.namespace
    );
  const busy = activeAttempt(status) || draft.phase === 'previewing';
  const preview = draft.phase === 'previewed' ? draft.preview : null;
  const stale = Boolean(
    preview &&
    (preview.target.projectId !== data.project.projectId ||
      preview.target.inventoryId !== data.project.defaultInventoryId ||
      preview.target.revision !== data.state.revision ||
      ((status.kind === 'refused' || status.kind === 'conflict') &&
        status.attempt &&
        'kind' in status.attempt.request &&
        status.attempt.request.kind === 'import-benchling-capture'))
  );
  const canApply = preview?.kind === 'ready' && !stale && !busy && inventoryCanEdit(status);
  useEffect(() => {
    ++generation.current;
    setDraft({ phase: 'editing', records: {}, scopeReason: '', issueReasons: {} });
    setShown(100);
    return () => {
      ++generation.current;
    };
  }, [scope]);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(
      () =>
        void client
          .materials({ project: data.project.projectId, query, limit: 100 })
          .then((page) => {
            if (!cancelled) {
              setMaterials(page.items);
              setMaterialError('');
            }
          })
          .catch(() => {
            if (!cancelled)
              setMaterialError('Scientific records could not be searched. Retry the search.');
          }),
      150
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, data.project.projectId, query]);
  function edit(values: Partial<Pick<Draft, 'records' | 'scopeReason' | 'issueReasons'>>) {
    ++generation.current;
    setDraft({
      records: draft.records,
      scopeReason: draft.scopeReason,
      issueReasons: draft.issueReasons,
      ...values,
      phase: 'editing',
    });
  }
  function editRecord(record: InventoryBenchlingRecord, value: CaptureRecordDraft) {
    edit({ records: { ...draft.records, [captureRecordKey(record)]: value } });
  }
  async function generatePreview() {
    const current = ++generation.current;
    const originalScope = scope;
    const before = {
      records: draft.records,
      scopeReason: draft.scopeReason,
      issueReasons: draft.issueReasons,
    };
    setDraft({ ...before, phase: 'previewing' });
    try {
      const options: InventoryBenchlingCaptureChoices = buildCaptureChoices(
        inspection,
        before.records,
        before.scopeReason,
        before.issueReasons
      );
      const result = await client.previewBenchlingCapture({
        project: data.project.projectId,
        inventoryId: data.project.defaultInventoryId,
        sourceText,
        options,
      });
      if (current !== generation.current || originalScope !== scopeRef.current) return;
      if (
        result.target.projectId !== data.project.projectId ||
        result.target.inventoryId !== data.project.defaultInventoryId ||
        result.sourceSha256 !== inspection.sourceSha256
      )
        throw new Error('The proposal does not match this project and inspected source.');
      setDraft({ ...before, phase: 'previewed', preview: result });
    } catch (error) {
      if (current === generation.current && originalScope === scopeRef.current)
        setDraft({
          ...before,
          phase: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
    }
  }
  async function apply() {
    if (!canApply || preview?.kind !== 'ready') return;
    const receipt = await controller.importBenchlingCapture(
      sourceText,
      preview.options,
      preview.planDigest
    );
    if (receipt) onClose();
  }
  return (
    <section
      className="space-y-4 border-t border-border pt-4"
      data-testid="inventory-benchling-application"
      data-application-state={draft.phase}
    >
      <h3 className="font-semibold">Interpret physical inventory</h3>
      <p className="text-sm">
        Choose each physical target and its contents separately. A single import will retain the
        original capture and these decisions. Missing records and unlisted wells do not establish
        empty positions.
      </p>
      <fieldset disabled={busy} className="space-y-4">
        {previousImport &&
        'kind' in previousImport.request &&
        previousImport.request.kind === 'import-benchling-capture' ? (
          <Button
            onClick={() => {
              if (
                !('kind' in previousImport.request) ||
                previousImport.request.kind !== 'import-benchling-capture'
              )
                return;
              const choices = previousImport.request.options;
              edit({
                records: captureDraftsFromChoices(choices),
                scopeReason: choices.scopeAcceptance.reason,
                issueReasons: Object.fromEntries(
                  choices.sourceIssueDispositions.map((item) => [issueKey(item), item.reason])
                ),
              });
            }}
          >
            Reuse interpretation from revision {previousImport.receipt.revision}
          </Button>
        ) : null}

        <TextField
          aria-label="Selected-record scope reason"
          placeholder="Why this selected-record capture is sufficient for this import"
          value={draft.scopeReason}
          onChange={(event) => edit({ scopeReason: event.target.value })}
        />
        <TextField
          aria-label="Search capture scientific records"
          placeholder="Search current scientific records"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {materialError ? <Notice tone="error">{materialError}</Notice> : null}
        <div className="space-y-2">
          <TextField
            aria-label="Remaining source evidence reason"
            placeholder="Reason for retaining all undecided records as source evidence"
            value={bulkReason}
            onChange={(event) => setBulkReason(event.target.value)}
          />
          <Button
            disabled={!bulkReason.trim()}
            onClick={() => {
              const records = { ...draft.records };
              for (const record of inspection.records)
                if (!records[captureRecordKey(record)]?.disposition)
                  records[captureRecordKey(record)] = {
                    ...emptyCaptureRecordDraft(),
                    disposition: record.kind.endsWith('-schema') ? 'evidence' : 'skip',
                    reason: bulkReason,
                  };
              edit({ records });
            }}
          >
            Keep undecided records as source evidence
          </Button>
        </div>
        {inspection.issues.map((issue) => (
          <div key={issueKey(issue)} className="space-y-2 rounded border border-border p-3">
            <p className="text-sm">{issue.message}</p>
            <TextField
              aria-label={`Source issue reason ${issueKey(issue)}`}
              value={draft.issueReasons[issueKey(issue)] ?? ''}
              placeholder="How this gap or conflict is handled by the choices below"
              onChange={(event) =>
                edit({
                  issueReasons: { ...draft.issueReasons, [issueKey(issue)]: event.target.value },
                })
              }
            />
          </div>
        ))}
        {inspection.records.slice(0, shown).map((record) => {
          const value = draft.records[captureRecordKey(record)] ?? emptyCaptureRecordDraft();
          const update = (patch: Partial<CaptureRecordDraft>) =>
            editRecord(record, { ...value, ...patch });
          const parent = value.placement;
          const updatePlacement = (patch: Partial<CaptureRecordDraft['placement']>) =>
            update({ placement: { ...parent, ...patch } });
          const schemas = inspection.records.filter(
            (item) => item.kind === (record.kind === 'plate' ? 'plate-schema' : 'box-schema')
          );
          const schema = schemas.find((item) => captureRecordKey(item) === value.schema);
          const isSchema = record.kind.endsWith('-schema');
          const imported = value.disposition === 'storage' || value.disposition === 'vessel';
          const materialChoices = [...materials];
          if (value.materialId && !materialChoices.some((item) => item.id === value.materialId))
            materialChoices.push({
              id: value.materialId,
              name: 'Selected record',
              kind: 'record',
              registryId: null,
            });
          return (
            <details
              key={captureRecordKey(record)}
              data-testid="inventory-benchling-record-choice"
              data-source-kind={record.kind}
              data-source-id={record.sourceId}
              className="space-y-3 rounded border border-border p-3"
            >
              <summary className="cursor-pointer text-sm font-medium">
                {record.kind} · {record.sourceId} · {value.disposition || 'Choose disposition'}
              </summary>
              <Select
                ariaLabel={`Disposition for ${record.sourceId}`}
                value={value.disposition}
                options={[
                  { value: '', label: 'Choose explicitly' },
                  ...(isSchema
                    ? [{ value: 'evidence', label: 'Keep schema as source evidence' }]
                    : [
                        {
                          value: record.kind === 'container' ? 'vessel' : 'storage',
                          label: 'Import physical record',
                        },
                        { value: 'skip', label: 'Keep only as source evidence' },
                      ]),
                ]}
                onValueChange={(disposition) =>
                  update({ disposition: disposition as CaptureRecordDraft['disposition'] })
                }
              />
              {!imported ? (
                <TextField
                  aria-label={`Evidence reason for ${record.sourceId}`}
                  value={value.reason}
                  onChange={(event) => update({ reason: event.target.value })}
                />
              ) : (
                <>
                  <Button
                    onClick={() =>
                      editRecord(record, copyUniqueCaptureFacts(record, inspection, value))
                    }
                  >
                    Copy unique captured facts for {record.sourceId}
                  </Button>
                  {record.kind !== 'container' || value.target === 'movable' ? (
                    <Fact
                      record={record}
                      field="name"
                      draft={value.name}
                      onChange={(name) => update({ name })}
                    />
                  ) : null}
                  {record.kind === 'container' ? (
                    <Select
                      ariaLabel={`Physical target for ${record.sourceId}`}
                      value={value.target}
                      options={[
                        { value: '', label: 'Choose physical target' },
                        { value: 'movable', label: 'Movable container' },
                        { value: 'fixed-well', label: 'Permanent well' },
                      ]}
                      onValueChange={(target) =>
                        update({
                          target: target as CaptureRecordDraft['target'],
                          placement:
                            target === 'fixed-well' ? { ...parent, kind: 'source' } : parent,
                        })
                      }
                    />
                  ) : (
                    <>
                      {record.kind === 'plate' ? (
                        <Fact
                          record={record}
                          field="type"
                          draft={value.plateType}
                          onChange={(plateType) => update({ plateType })}
                        />
                      ) : null}
                      {record.kind === 'location' ? (
                        <Select
                          ariaLabel={`Local layout for ${record.sourceId}`}
                          value={value.layoutKind}
                          options={[
                            { value: 'named', label: 'Named positions' },
                            { value: 'grid', label: 'Grid' },
                            { value: 'stack', label: 'Plate stack' },
                          ]}
                          onValueChange={(layoutKind) =>
                            update({ layoutKind: layoutKind as CaptureRecordDraft['layoutKind'] })
                          }
                        />
                      ) : (
                        <Select
                          ariaLabel={`Layout basis for ${record.sourceId}`}
                          value={value.layoutMode}
                          options={[
                            { value: 'schema', label: 'Select captured schema dimensions' },
                            { value: 'declared', label: 'Declare dimensions' },
                          ]}
                          onValueChange={(layoutMode) =>
                            update({ layoutMode: layoutMode as CaptureRecordDraft['layoutMode'] })
                          }
                        />
                      )}
                      {record.kind !== 'location' && value.layoutMode === 'schema' ? (
                        <>
                          <Select
                            ariaLabel={`Schema for ${record.sourceId}`}
                            value={value.schema}
                            options={[
                              { value: '', label: 'Choose captured schema' },
                              ...schemas.map((item) => ({
                                value: captureRecordKey(item),
                                label: item.sourceId,
                              })),
                            ]}
                            onValueChange={(schema) => update({ schema, height: '', width: '' })}
                          />
                          {schema ? (
                            <>
                              <Observation
                                record={{ ...schema, sourceId: record.sourceId }}
                                field="height"
                                value={value.height}
                                onChange={(height) => update({ height })}
                              />
                              <Observation
                                record={{ ...schema, sourceId: record.sourceId }}
                                field="width"
                                value={value.width}
                                onChange={(width) => update({ width })}
                              />
                            </>
                          ) : null}
                        </>
                      ) : record.kind === 'location' && value.layoutKind === 'named' ? (
                        <TextField
                          aria-label={`Named positions for ${record.sourceId}`}
                          placeholder="Comma-separated position names"
                          value={value.positions}
                          onChange={(event) => update({ positions: event.target.value })}
                        />
                      ) : record.kind === 'location' && value.layoutKind === 'stack' ? (
                        <TextField
                          aria-label={`Stack capacity for ${record.sourceId}`}
                          value={value.capacity}
                          onChange={(event) => update({ capacity: event.target.value })}
                        />
                      ) : (
                        <>
                          <TextField
                            aria-label={`Rows for ${record.sourceId}`}
                            value={value.rows}
                            onChange={(event) => update({ rows: event.target.value })}
                          />
                          <TextField
                            aria-label={`Columns for ${record.sourceId}`}
                            value={value.columns}
                            onChange={(event) => update({ columns: event.target.value })}
                          />
                        </>
                      )}
                      <TextField
                        aria-label={`Layout reason for ${record.sourceId}`}
                        value={value.layoutReason}
                        placeholder="Reason for declared layout or schema conflict choices"
                        onChange={(event) => update({ layoutReason: event.target.value })}
                      />
                    </>
                  )}
                  <Select
                    ariaLabel={`Placement for ${record.sourceId}`}
                    value={parent.kind}
                    options={[
                      { value: '', label: 'Choose placement' },
                      ...(record.kind === 'container'
                        ? value.target === 'fixed-well'
                          ? []
                          : [{ value: 'unplaced', label: 'Explicitly unplaced' }]
                        : [{ value: 'root', label: 'Root location' }]),
                      { value: 'source', label: 'Captured parent identity' },
                      ...(value.target === 'fixed-well'
                        ? []
                        : [{ value: 'existing', label: 'Existing local location' }]),
                    ]}
                    onValueChange={(kind) =>
                      updatePlacement({ kind: kind as CaptureRecordDraft['placement']['kind'] })
                    }
                  />
                  <Select
                    ariaLabel={`Placement evidence for ${record.sourceId}`}
                    value={parent.basis}
                    options={[
                      { value: 'declared', label: 'Declare placement with reason' },
                      ...(record.fields.parentStorageId?.observations
                        .filter((item) => item.kind !== 'omitted')
                        .map((item) => ({
                          value: `captured:${captureReference(item)}`,
                          label: `Parent: ${item.kind === 'present' ? item.jsonText : 'null'} · ${item.responseId}`,
                        })) ?? []),
                      ...inspection.placements
                        .filter((item) => item.containerId === record.sourceId)
                        .map((item) => ({
                          value: `membership:${captureReference(item)}`,
                          label: `Membership: ${item.kind === 'plate-well' ? `${item.plateId} ${item.position}` : item.boxId} · ${item.responseId}`,
                        })),
                    ]}
                    onValueChange={(basis) => updatePlacement({ basis })}
                  />
                  {parent.kind === 'source' ? (
                    <Select
                      ariaLabel={`Source parent for ${record.sourceId}`}
                      value={parent.parentSourceId}
                      options={[
                        { value: '', label: 'Choose captured parent' },
                        ...inspection.records
                          .filter((item) => ['location', 'box', 'plate'].includes(item.kind))
                          .map((item) => ({
                            value: item.sourceId,
                            label: `${item.kind} ${item.sourceId}`,
                          })),
                      ]}
                      onValueChange={(parentSourceId) => updatePlacement({ parentSourceId })}
                    />
                  ) : parent.kind === 'existing' ? (
                    <Select
                      ariaLabel={`Local parent for ${record.sourceId}`}
                      value={parent.storageId}
                      options={[
                        { value: '', label: 'Choose local location' },
                        ...Object.values(data.state.storage).map((item) => ({
                          value: item.id,
                          label: `${item.name} · ${item.id}`,
                        })),
                      ]}
                      onValueChange={(storageId) => updatePlacement({ storageId })}
                    />
                  ) : null}
                  <TextField
                    aria-label={`Placement reason for ${record.sourceId}`}
                    value={parent.reason}
                    onChange={(event) => updatePlacement({ reason: event.target.value })}
                  />
                  {parent.kind === 'source' || parent.kind === 'existing' ? (
                    <>
                      <TextField
                        aria-label={`Position for ${record.sourceId}`}
                        value={parent.position}
                        onChange={(event) => updatePlacement({ position: event.target.value })}
                      />
                      <Select
                        ariaLabel={`Position basis for ${record.sourceId}`}
                        value={parent.positionBasis}
                        options={[
                          {
                            value: 'captured-exact',
                            label: 'Exact captured membership coordinate',
                          },
                          { value: 'declared-mapping', label: 'Explicit position mapping' },
                        ]}
                        onValueChange={(positionBasis) =>
                          updatePlacement({
                            positionBasis:
                              positionBasis as CaptureRecordDraft['placement']['positionBasis'],
                          })
                        }
                      />
                      <TextField
                        aria-label={`Position reason for ${record.sourceId}`}
                        value={parent.positionReason}
                        onChange={(event) =>
                          updatePlacement({ positionReason: event.target.value })
                        }
                      />
                    </>
                  ) : null}
                  {record.kind === 'container' ? (
                    <>
                      <Select
                        ariaLabel={`Contents for ${record.sourceId}`}
                        value={value.contents}
                        options={[
                          { value: '', label: 'Choose contents knowledge' },
                          { value: 'empty', label: 'Empty contents array and exact zero volume' },
                          { value: 'unobserved', label: 'Contents not established' },
                          {
                            value: 'unidentified',
                            label: 'Present contents without local identity',
                          },
                          { value: 'identify', label: 'Identify one captured content' },
                        ]}
                        onValueChange={(contents) =>
                          update({ contents: contents as CaptureRecordDraft['contents'] })
                        }
                      />
                      {value.contents && value.contents !== 'unobserved' ? (
                        <Observation
                          record={record}
                          field="contents"
                          value={value.contentsReference}
                          onChange={(contentsReference) => update({ contentsReference })}
                        />
                      ) : null}
                      <TextField
                        aria-label={`Contents reason for ${record.sourceId}`}
                        value={value.contentsReason}
                        onChange={(event) => update({ contentsReason: event.target.value })}
                      />
                      {value.contents === 'identify' ? (
                        <>
                          <Select
                            ariaLabel={`Scientific record for ${record.sourceId}`}
                            value={value.materialId}
                            options={[
                              { value: '', label: 'Choose current local scientific record' },
                              ...materialChoices.map((item) => ({
                                value: item.id,
                                label: `${item.name} · ${item.id}`,
                              })),
                            ]}
                            onValueChange={(materialId) => update({ materialId })}
                          />
                          <Select
                            ariaLabel={`Quality for ${record.sourceId}`}
                            value={value.quality}
                            options={[
                              { value: '', label: 'Choose quality explicitly' },
                              { value: 'usable', label: 'Usable' },
                              { value: 'quarantined', label: 'Quarantined' },
                            ]}
                            onValueChange={(quality) =>
                              update({ quality: quality as CaptureRecordDraft['quality'] })
                            }
                          />
                          <TextField
                            aria-label={`Quality reason for ${record.sourceId}`}
                            value={value.qualityReason}
                            onChange={(event) => update({ qualityReason: event.target.value })}
                          />
                        </>
                      ) : null}
                      {value.contents === 'identify' || value.contents === 'empty' ? (
                        <>
                          <Select
                            ariaLabel={`Quantity interpretation for ${record.sourceId}`}
                            value={value.quantity}
                            options={[
                              { value: '', label: 'Choose quantity explicitly' },
                              { value: 'source-volume', label: 'Select captured volume' },
                              ...(value.contents === 'empty'
                                ? []
                                : [{ value: 'unknown', label: 'Volume unknown' }]),
                            ]}
                            onValueChange={(quantity) =>
                              update({ quantity: quantity as CaptureRecordDraft['quantity'] })
                            }
                          />
                          {value.quantity === 'source-volume' ? (
                            <>
                              <Select
                                ariaLabel={`Quantity field for ${record.sourceId}`}
                                value={value.quantityField}
                                options={[
                                  { value: 'quantity', label: 'quantity' },
                                  { value: 'volume', label: 'Deprecated volume' },
                                ]}
                                onValueChange={(quantityField) =>
                                  update({
                                    quantityField: quantityField as 'quantity' | 'volume',
                                    quantityReference: '',
                                  })
                                }
                              />
                              <Observation
                                record={record}
                                field={value.quantityField}
                                value={value.quantityReference}
                                onChange={(quantityReference) => update({ quantityReference })}
                              />
                            </>
                          ) : null}
                          <TextField
                            aria-label={`Quantity reason for ${record.sourceId}`}
                            value={value.quantityReason}
                            onChange={(event) => update({ quantityReason: event.target.value })}
                          />
                        </>
                      ) : null}
                    </>
                  ) : record.kind === 'box' || record.kind === 'plate' ? (
                    <>
                      <TextField
                        aria-label={`Uncaptured positions for ${record.sourceId}`}
                        placeholder="Removable-container coordinates to mark unavailable, comma-separated"
                        value={value.uncapturedPositions}
                        onChange={(event) => update({ uncapturedPositions: event.target.value })}
                      />
                      <TextField
                        aria-label={`Uncaptured positions reason for ${record.sourceId}`}
                        value={value.uncapturedReason}
                        onChange={(event) => update({ uncapturedReason: event.target.value })}
                      />
                    </>
                  ) : null}
                </>
              )}
            </details>
          );
        })}
        {shown < inspection.records.length ? (
          <Button onClick={() => setShown((count) => count + 100)}>
            Show more record decisions
          </Button>
        ) : null}
        <Button onClick={() => void generatePreview()}>
          {draft.phase === 'previewing'
            ? 'Previewing physical inventory…'
            : 'Preview physical inventory'}
        </Button>
      </fieldset>
      {draft.phase === 'failed' ? <Notice tone="error">{draft.message}</Notice> : null}
      {preview ? (
        <section
          data-testid="inventory-benchling-application-preview"
          data-preview-kind={preview.kind}
          className="space-y-3"
        >
          <h4 className="font-semibold">
            {preview.kind === 'ready'
              ? 'One atomic import is ready'
              : preview.kind === 'no-change'
                ? 'No inventory changes'
                : 'Resolve the proposal'}
          </h4>
          {stale ? (
            <Notice>
              Inventory or scientific dependencies changed. Preview again before importing.
            </Notice>
          ) : null}
          {preview.kind === 'no-change' ? (
            <Notice>
              Existing identities and current inventory are preserved. This preview saves no new
              receipt or revised source file.
            </Notice>
          ) : null}
          {preview.issues.map((issue, index) => (
            <Notice key={index} tone="error">
              {issue.message}
            </Notice>
          ))}
          <p className="text-xs">
            {preview.rows.length} source decisions ·{' '}
            {preview.kind === 'ready' ? preview.commands.length : 0} commands · destination revision{' '}
            {preview.target.revision}
          </p>
          {preview.rows.slice(0, shown).map((row) => {
            const decision = preview.options?.records.find(
              (item) => captureRecordKey(item.record) === captureRecordKey(row.record)
            );
            const targetName =
              (row.targetId
                ? (data.state.storage[row.targetId]?.name ?? data.state.vessels[row.targetId]?.name)
                : null) ?? interpretedName(decision, inspection);
            return (
              <div
                key={captureRecordKey(row.record)}
                className="rounded border border-border p-2 text-xs"
                data-preview-source-id={row.record.sourceId}
              >
                <p>
                  {row.record.kind} {row.record.sourceId} · {row.kind}
                </p>
                {targetName ? <p>Target: {targetName}</p> : null}
                {decision?.disposition === 'vessel' ? (
                  <p>
                    Source contents:{' '}
                    {decision.contents.kind === 'empty'
                      ? 'empty, supported by captured zero volume'
                      : decision.contents.kind === 'identify'
                        ? 'single captured identity mapped to a local scientific record'
                        : decision.contents.kind === 'unidentified'
                          ? 'present but unidentified'
                          : 'not established'}
                  </p>
                ) : null}
                {row.targetId ? (
                  <details>
                    <summary className="cursor-pointer text-fg-muted">Target identity</summary>
                    <p className="break-all">{row.targetId}</p>
                  </details>
                ) : null}
                {row.stockFields ? (
                  <p>
                    Source quantity:{' '}
                    {row.stockFields.quantity_kind === 'known'
                      ? `${row.stockFields.quantity} ${row.stockFields.unit}`
                      : 'unknown'}{' '}
                    · Quality: {row.stockFields.quality}
                  </p>
                ) : null}
                {row.issues.map((issue, index) => (
                  <p key={index}>{issue.message}</p>
                ))}
              </div>
            );
          })}
          {preview.uncapturedPositions.map((item) => (
            <p key={item.storageSourceId} className="break-all text-xs">
              Uncaptured source coordinates for {item.storageSourceId}: {item.kind} ·{' '}
              {item.positions.join(', ') || 'No uncaptured coordinates'}
            </p>
          ))}
        </section>
      ) : null}
      <Button variant="primary" disabled={!canApply} onClick={() => void apply()}>
        Import physical inventory
      </Button>
    </section>
  );
}
