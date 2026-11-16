import { useEffect, useRef, useState } from 'react';
import type {
  InventoryBenchlingField,
  InventoryBenchlingObservedField,
} from '@waypoint/domain-services';
import { Button, Notice, TextArea } from '../../components/ui';
import { platform } from '../../platform';
import type {
  InventoryBenchlingCaptureSnapshot,
  InventoryClient,
} from '../../shared/inventory-client';
import { readInventoryArchiveFile } from './inventory-archive-file';
import type {
  InventoryController,
  InventoryControllerState,
  InventoryData,
} from './inventory-controller';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';

interface CaptureDraftFacts {
  scope: string;
  sourceText: string;
  sourcePath: string | null;
}
type CaptureDraft = CaptureDraftFacts &
  (
    | { phase: 'editing' | 'reading-source' | 'inspecting' }
    | { phase: 'inspected'; inspection: InventoryBenchlingCaptureSnapshot }
    | { phase: 'failed'; message: string }
  );
const draftFacts = (draft: CaptureDraft): CaptureDraftFacts => ({
  scope: draft.scope,
  sourceText: draft.sourceText,
  sourcePath: draft.sourcePath,
});
const emptyDraft = (scope: string): CaptureDraft => ({
  scope,
  sourceText: '',
  sourcePath: null,
  phase: 'editing',
});
const fieldLabel = (field: InventoryBenchlingField | InventoryBenchlingObservedField): string =>
  field.kind === 'omitted'
    ? 'Omitted'
    : field.kind === 'null'
      ? 'Explicit null'
      : field.kind === 'conflict'
        ? 'Conflicting observations'
        : 'Present';

function FieldValue({
  field,
}: {
  field: InventoryBenchlingField | InventoryBenchlingObservedField;
}) {
  return (
    <div className="space-y-1" data-field-state={field.kind}>
      <p className="text-xs text-fg-muted">{fieldLabel(field)}</p>
      {field.kind === 'present' ? (
        <pre className="whitespace-pre-wrap break-all font-mono text-xs">{field.jsonText}</pre>
      ) : field.kind === 'conflict' ? (
        <ul className="space-y-1">
          {field.alternatives.map((alternative, index) => (
            <li key={index} className="whitespace-pre-wrap break-all font-mono text-xs">
              {alternative.kind === 'null' ? 'null' : alternative.jsonText}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function InventoryBenchlingCaptureForm({
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
  const scope = JSON.stringify([data.project.projectId, data.project.defaultInventoryId]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const generation = useRef(0);
  const [storedDraft, setDraft] = useState<CaptureDraft>(() => emptyDraft(scope));
  const draft = storedDraft.scope === scope ? storedDraft : emptyDraft(scope);
  const [shownRecords, setShownRecords] = useState(100);
  const inspection = draft.phase === 'inspected' ? draft.inspection : null;
  const fieldCounts = { omitted: 0, null: 0, present: 0, conflict: 0 };
  for (const record of inspection?.records ?? [])
    for (const field of Object.values(record.fields)) ++fieldCounts[field.kind];

  useEffect(() => {
    ++generation.current;
    setDraft(emptyDraft(scope));
    setShownRecords(100);
    return () => {
      ++generation.current;
    };
  }, [scope]);

  function editSource(sourceText: string) {
    ++generation.current;
    setDraft({ scope, sourceText, sourcePath: null, phase: 'editing' });
    setShownRecords(100);
  }

  async function chooseFile() {
    const before = draft;
    const current = ++generation.current;
    setDraft({ ...draftFacts(before), phase: 'reading-source' });
    try {
      const selected = await platform().dialog.open({
        title: 'Inspect Benchling capture',
        multiple: false,
      });
      if (generation.current !== current || scopeRef.current !== before.scope) return;
      if (Array.isArray(selected) && selected.length !== 1)
        throw new Error('Choose one Benchling capture file.');
      const sourcePath = typeof selected === 'string' ? selected : selected?.[0];
      if (!sourcePath) {
        setDraft(before);
        return;
      }
      const sourceText = await readInventoryArchiveFile(sourcePath);
      if (generation.current !== current || scopeRef.current !== before.scope) return;
      setDraft({ ...draftFacts(before), phase: 'editing', sourcePath, sourceText });
      setShownRecords(100);
    } catch (cause) {
      if (generation.current === current && scopeRef.current === before.scope)
        setDraft({
          ...draftFacts(before),
          phase: 'failed',
          message: cause instanceof Error ? cause.message : String(cause),
        });
    }
  }

  async function inspect() {
    const before = draftFacts(draft);
    const current = ++generation.current;
    setDraft({ ...before, phase: 'inspecting' });
    try {
      const result = await client.inspectBenchlingCapture({
        project: data.project.projectId,
        inventoryId: data.project.defaultInventoryId,
        sourceText: before.sourceText,
      });
      if (generation.current !== current || scopeRef.current !== before.scope) return;
      if (
        result.target.projectId !== data.project.projectId ||
        result.target.inventoryId !== data.project.defaultInventoryId
      )
        throw new Error('The capture inspection belongs to another project or inventory.');
      setDraft({ ...before, phase: 'inspected', inspection: result });
      setShownRecords(100);
    } catch (cause) {
      if (generation.current === current && scopeRef.current === before.scope)
        setDraft({
          ...before,
          phase: 'failed',
          message: cause instanceof Error ? cause.message : String(cause),
        });
    }
  }

  return (
    <InventoryPhysicalDialog
      title="Inspect Benchling capture"
      subtitle={data.project.name}
      controller={controller}
      status={status}
      onClose={onClose}
    >
      <section
        className="space-y-4"
        data-testid="inventory-benchling-capture"
        data-inspection-state={inspection?.kind ?? draft.phase}
      >
        <p className="text-sm">
          Inspect selected physical inventory records captured from the Benchling V2 API. This step
          reads a DNAForge capture file and changes no inventory. It does not connect to a Benchling
          account or establish a complete tenant export.
        </p>
        <Notice>
          Source archive, checkout and restriction metadata remain foreign evidence. They do not
          change local custody, quality, permissions or history. Inspection does not import physical
          items or change scientific records.
        </Notice>
        <Button disabled={draft.phase === 'reading-source'} onClick={() => void chooseFile()}>
          {draft.phase === 'reading-source' ? 'Reading capture…' : 'Choose capture file'}
        </Button>
        {draft.sourcePath ? (
          <p className="break-all text-xs" data-testid="inventory-benchling-source-path">
            Source file: {draft.sourcePath}
          </p>
        ) : null}
        <TextArea
          aria-label="Benchling capture text"
          value={draft.sourceText}
          onChange={(event) => editSource(event.target.value)}
          className="h-40 font-mono text-xs"
        />
        <Button
          variant="primary"
          disabled={draft.phase === 'reading-source' || draft.phase === 'inspecting'}
          onClick={() => void inspect()}
        >
          {draft.phase === 'inspecting' ? 'Inspecting…' : 'Inspect capture'}
        </Button>
        {draft.phase === 'failed' ? <Notice tone="error">{draft.message}</Notice> : null}
        {inspection ? (
          <div
            className="space-y-5"
            data-testid="inventory-benchling-inspection"
            data-source-sha256={inspection.sourceSha256 ?? ''}
          >
            <h3 className="font-semibold">
              {inspection.kind === 'blocked'
                ? 'Capture could not be interpreted'
                : 'Capture inspected'}
            </h3>
            <p className="text-sm">No inventory changes were submitted.</p>
            <p className="text-sm" data-testid="inventory-benchling-field-summary">
              {inspection.records.length} source records · {fieldCounts.omitted} omitted fields ·{' '}
              {fieldCounts.null} explicit null fields · {fieldCounts.conflict} conflicting fields
            </p>
            {inspection.target.revision !== data.state.revision ? (
              <div data-testid="inventory-benchling-revision-notice">
                <Notice>
                  Inventory changed since this inspection. Inspect again to refresh the destination
                  snapshot. The retained source observations are unchanged.
                </Notice>
              </div>
            ) : null}
            {inspection.sourceSha256 ? (
              <p className="break-all text-xs">Source SHA-256: {inspection.sourceSha256}</p>
            ) : null}
            {inspection.capture ? (
              <dl className="space-y-2 text-sm" data-testid="inventory-benchling-source-scope">
                <div>
                  <dt className="text-xs text-fg-muted">Source API</dt>
                  <dd>Benchling {inspection.capture.apiVersion}</dd>
                </div>
                <div>
                  <dt className="text-xs text-fg-muted">Source namespace</dt>
                  <dd className="break-all">{inspection.capture.namespace}</dd>
                </div>
                <div>
                  <dt className="text-xs text-fg-muted">Declared scope</dt>
                  <dd className="break-words">
                    {inspection.capture.scope.kind} · {inspection.capture.scope.description}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-fg-muted">Source capture time</dt>
                  <dd>{inspection.capture.capturedAt}</dd>
                </div>
              </dl>
            ) : null}
            <section className="space-y-2" data-testid="inventory-benchling-issues">
              <h3 className="font-semibold">Interpretation gaps</h3>
              <p className="text-xs text-fg-muted">
                Omitted fields do not mean empty containers or root locations. Explicit null and
                conflicting observations remain distinct. Names do not supply dimensions or freezer
                specifications.
              </p>
              {inspection.issues.length ? (
                <ul className="space-y-2">
                  {inspection.issues.map((issue, index) => (
                    <li
                      key={index}
                      data-testid="inventory-benchling-issue"
                      data-issue-severity={issue.severity}
                      className="space-y-1 rounded border border-border p-3 text-xs"
                    >
                      <p>{issue.message}</p>
                      <p className="break-all text-fg-muted">
                        {issue.code} · {issue.pointer}
                        {issue.responseId ? ` · response ${issue.responseId}` : ''}
                        {issue.bodyPointer !== null ? ` · body ${issue.bodyPointer || '/'}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm">
                  No source interpretation issues were reported. Import decisions and physical
                  compatibility have not been established.
                </p>
              )}
            </section>
            <section className="space-y-2" data-testid="inventory-benchling-pagination">
              <h3 className="font-semibold">Captured page links</h3>
              <p className="text-xs text-fg-muted">
                Linked pages cover only their declared request. They do not prove that all inventory
                records or every child location were captured.
              </p>
              {inspection.pagination.length ? (
                inspection.pagination.map((group, index) => (
                  <div key={index} data-pagination-state={group.kind} className="space-y-1 text-xs">
                    <p className="break-all font-medium">{group.path}</p>
                    <p>
                      {group.kind} · {group.pages.length} captured pages
                    </p>
                    <pre className="whitespace-pre-wrap break-all">
                      {JSON.stringify(group.query)}
                    </pre>
                    <p className="break-all">
                      Linked responses: {group.linkedResponseIds.join(', ') || 'None'}
                    </p>
                  </div>
                ))
              ) : (
                <p className="text-sm">No paginated collection requests were captured.</p>
              )}
            </section>
            <section className="space-y-2" data-testid="inventory-benchling-records">
              <h3 className="font-semibold">Source records · {inspection.records.length}</h3>
              {inspection.records.slice(0, shownRecords).map((record) => (
                <details
                  key={`${record.kind}:${record.sourceId}`}
                  data-record-kind={record.kind}
                  data-source-id={record.sourceId}
                  className="space-y-3 rounded border border-border p-3"
                >
                  <summary className="cursor-pointer break-all text-sm font-medium">
                    {record.kind} · {record.sourceId}
                  </summary>
                  <p className="break-all text-xs text-fg-muted">
                    Observed in{' '}
                    {record.observations
                      .map((item) => `${item.responseId}${item.pointer || '/'}`)
                      .join(', ')}
                  </p>
                  <dl className="space-y-3">
                    {Object.entries(record.fields).map(([name, field]) => (
                      <div
                        key={name}
                        data-source-field={name}
                        className="space-y-1 border-t border-border pt-2"
                      >
                        <dt className="break-all text-sm font-medium">{name}</dt>
                        <dd className="space-y-2">
                          <FieldValue field={field} />
                          <details className="space-y-2 text-xs">
                            <summary className="cursor-pointer text-fg-muted">
                              Field observations · {field.observations.length}
                            </summary>
                            {field.observations.map((observation, index) => (
                              <div key={index} className="space-y-1">
                                <p className="break-all">
                                  {observation.responseId} · {observation.pointer || '/'}
                                </p>
                                <FieldValue field={observation} />
                              </div>
                            ))}
                          </details>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ))}
              {inspection.records.length > shownRecords ? (
                <Button onClick={() => setShownRecords((count) => count + 100)}>
                  Show more source records
                </Button>
              ) : null}
            </section>
            <details className="space-y-2" data-testid="inventory-benchling-placements">
              <summary className="cursor-pointer font-semibold">
                Placement observations · {inspection.placements.length}
              </summary>
              {inspection.placements.map((placement, index) => (
                <article key={index} className="space-y-2 border-t border-border pt-2 text-xs">
                  <p className="break-all">Container {placement.containerId}</p>
                  {placement.kind === 'plate-well' ? (
                    <p className="break-all">
                      Plate {placement.plateId} · well {placement.position}
                    </p>
                  ) : (
                    <>
                      <p className="break-all">Box {placement.boxId}</p>
                      <p>Grid position</p>
                      <FieldValue field={placement.gridPosition} />
                      <p>Grid number</p>
                      <FieldValue field={placement.gridNumber} />
                    </>
                  )}
                  <p className="break-all text-fg-muted">
                    Response {placement.responseId} · {placement.pointer || '/'}
                  </p>
                </article>
              ))}
            </details>
            {inspection.capture ? (
              <details className="space-y-3" data-testid="inventory-benchling-responses">
                <summary className="cursor-pointer font-semibold">
                  Original responses and exact number tokens · {inspection.capture.responses.length}
                </summary>
                {inspection.capture.responses.map((response) => (
                  <details
                    key={response.id}
                    data-response-id={response.id}
                    className="space-y-2 rounded border border-border p-3 text-xs"
                  >
                    <summary className="cursor-pointer break-all">
                      {response.id} · {response.request.method} {response.request.path}
                    </summary>
                    <pre className="whitespace-pre-wrap break-all">
                      {JSON.stringify(response.request.query)}
                    </pre>
                    <p className="break-all">Body SHA-256: {response.bodySha256}</p>
                    <h4 className="font-medium">Exact source number tokens</h4>
                    <ul className="space-y-1" data-testid="inventory-benchling-number-tokens">
                      {response.numberLexemes.map((number) => (
                        <li key={number.pointer} className="break-all font-mono">
                          {number.pointer || '/'} = {number.lexeme}
                        </li>
                      ))}
                    </ul>
                    <TextArea
                      readOnly
                      aria-label={`Original response ${response.id}`}
                      value={response.bodyText}
                      className="h-36 font-mono text-xs"
                    />
                  </details>
                ))}
              </details>
            ) : null}
          </div>
        ) : null}
      </section>
    </InventoryPhysicalDialog>
  );
}
