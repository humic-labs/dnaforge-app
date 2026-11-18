import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  inventoryVesselContentsProjection,
  type InventoryAmountUnit,
  type InventoryScientificWork,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea, TextField } from '../../components/ui';
import type { InventoryClient } from '../../shared/inventory-client';
import { parseProtocolPackage } from '@waypoint/domain-services';
import { FrozenProtocolDefinition } from '../scientific-document/FrozenProtocolDefinition';
import { openProjectResourceReference } from '../../services/notebook-resource-navigation';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import { PhysicalField } from './InventoryPhysicalControls';
import {
  inventoryCanEdit,
  type InventoryController,
  type InventoryControllerState,
  type InventoryData,
} from './inventory-controller';
import {
  inventoryAmountLabel,
  inventoryAmountUnitOptions,
  inventoryStockAction,
  locationPath,
} from './inventory-view';

export type InventoryScientificDialog = { kind: 'scientific-transfer'; stockId?: string };
function savedText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const node = content as { text?: unknown; content?: unknown; type?: unknown };
  if (typeof node.text === 'string') return node.text;
  return Array.isArray(node.content)
    ? node.content.map(savedText).join(node.type === 'doc' ? '\n' : '')
    : '';
}
function WorkFacts({
  work,
  data,
  client,
  onNavigate,
}: {
  work: InventoryScientificWork;
  data: InventoryData;
  client: InventoryClient;
  onNavigate(): void;
}) {
  const [source, setSource] = useState<Awaited<
    ReturnType<InventoryClient['scientificSource']>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    setSource(null);
    setError(null);
    setPending(false);
  }, [work.id, data.project.projectId]);
  async function read() {
    setPending(true);
    setError(null);
    try {
      const result = await client.scientificSource({
        project: data.project.projectId,
        inventoryId: data.project.defaultInventoryId,
        workId: work.id,
      });
      if (
        result.kind === 'available' &&
        (result.workId !== work.id ||
          result.sourceSha256 !== work.context.source.sha256 ||
          (result.source.schema === 'dnaforge.notebook-saved-source.v1'
            ? result.source.pageId
            : result.source.runId) !==
            (work.context.kind === 'notebook-page' ? work.context.pageId : work.context.entityId) ||
          result.source.projectId !== work.context.projectId)
      )
        throw Error('The retained notebook context does not match this exact observation.');
      setSource(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The retained context could not be read.');
    } finally {
      setPending(false);
    }
  }
  return (
    <article
      className="space-y-3 rounded border border-border p-3"
      data-scientific-work-id={work.id}
    >
      <h3 className="font-semibold">{work.context.source.title}</h3>
      <p>
        Operator-reported completed manual transfer · {inventoryAmountLabel(work.transfer.quantity)}
      </p>
      <p>
        Source: {work.effects.source.vessel.name} ·{' '}
        {inventoryAmountLabel(work.effects.source.before.quantity)} →{' '}
        {inventoryAmountLabel(work.effects.source.after.quantity)}
      </p>
      <p>
        Destination: {work.effects.destination.vessel.name} ·{' '}
        {inventoryAmountLabel(work.effects.destination.after.quantity)}
      </p>
      <p className="text-xs">{work.reason}</p>
      <p className="break-all text-xs">
        Work identity: {work.identity.namespace} / {work.identity.workId}
      </p>
      <p className="break-all text-xs">Saved source: {work.context.source.sha256}</p>
      <Notice>
        This transfer keeps a saved copy of its scientific context from the time it was recorded.
        Later edits leave that copy unchanged.
      </Notice>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() =>
            void openProjectResourceReference({
              kind: 'entity',
              projectId: work.context.projectId,
              entityId:
                work.context.kind === 'notebook-page' ? work.context.pageId : work.context.entityId,
            })
              .then(onNavigate)
              .catch((cause) =>
                setError(
                  cause instanceof Error ? cause.message : 'The current notebook is unavailable.'
                )
              )
          }
        >
          Open current notebook
        </Button>
        <Button
          disabled={pending || !data.state.scientificWorks[work.id]}
          onClick={() => void read()}
        >
          Read retained saved context
        </Button>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {source?.kind === 'unavailable' ? (
        <Notice>{source.message}</Notice>
      ) : source?.kind === 'available' ? (
        <section className="space-y-2" data-testid="inventory-retained-scientific-source">
          <h4 className="text-sm font-semibold">
            Retained structured saved context: {source.source.title}
          </h4>
          {source.source.schema === 'dnaforge.notebook-saved-source.v1' ? (
            <TextArea
              readOnly
              aria-label="Retained saved notebook context"
              value={savedText(source.source.content)}
              rows={6}
            />
          ) : (
            <FrozenProtocolDefinition raw={parseProtocolPackage(source.source.originalText).raw} />
          )}
          <details>
            <summary className="text-xs">Complete structured saved source</summary>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
              {JSON.stringify(source.source, null, 2)}
            </pre>
          </details>
        </section>
      ) : null}
    </article>
  );
}

export function InventoryScientificForm({
  dialog,
  data,
  status,
  controller,
  client,
  onClose,
}: {
  dialog: InventoryScientificDialog;
  data: InventoryData;
  status: InventoryControllerState;
  controller: InventoryController;
  client: InventoryClient;
  onClose(): void;
}) {
  const session = controller.scientificSession({
    project: data.project.projectId,
    inventoryId: data.project.defaultInventoryId,
  });
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot),
    draft = snapshot.draft;
  const [pages, setPages] = useState<
    Awaited<ReturnType<InventoryClient['scientificContextsV2']>>['contexts']
  >([]);
  const [pageError, setPageError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState('');
  const editable = inventoryCanEdit(status),
    locked =
      snapshot.phase === 'previewing' ||
      status.kind === 'submitting' ||
      status.kind === 'outcome-unknown' ||
      status.kind === 'committed-refresh-failed';
  const preview = snapshot.phase === 'previewed' ? snapshot.preview : null;
  const stale = Boolean(preview && preview.target.revision !== data.state.revision);
  const contents = inventoryVesselContentsProjection(data.state);
  const sources = Object.values(data.state.stocks).filter(
    (stock) =>
      stock.quantity.kind === 'known' &&
      inventoryStockAction(data, stock.id, 'withdraw')?.kind === 'allowed'
  );
  const destinations = Object.values(data.state.vessels).filter(
    (vessel) =>
      vessel.kind === 'fixed-well' &&
      vessel.lifecycle === 'active' &&
      contents[vessel.id]?.kind === 'declared-empty'
  );
  const edit = (change: Partial<typeof draft>) => session.edit({ ...draft, ...change });
  useEffect(() => {
    if (dialog.stockId && session.getSnapshot().draft.sourceStockId !== dialog.stockId)
      session.edit({ ...session.getSnapshot().draft, sourceStockId: dialog.stockId });
    return () => session.cancelPreview();
  }, [dialog.stockId, session]);
  useEffect(() => {
    let cancelled = false;
    void client
      .scientificContextsV2({
        project: data.project.projectId,
        inventoryId: data.project.defaultInventoryId,
        query,
        kind: draft.contextKind,
        limit: 50,
      })
      .then((result) => {
        if (cancelled) return;
        if (
          result.projectId !== data.project.projectId ||
          result.inventoryId !== data.project.defaultInventoryId
        )
          throw Error('Saved notebook pages belong to another inventory project.');
        setPages(result.contexts);
        setPageError(null);
      })
      .catch((cause) => {
        if (!cancelled) {
          setPages([]);
          setPageError(
            cause instanceof Error ? cause.message : 'Saved notebook pages could not be read.'
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    client,
    data.project.projectId,
    data.project.defaultInventoryId,
    query,
    refresh,
    draft.contextKind,
  ]);
  async function record() {
    if (!editable || stale || snapshot.phase !== 'previewed' || snapshot.preview.kind !== 'ready')
      return;
    if (await controller.recordScientificTransferV2(snapshot.choices, snapshot.preview.planDigest))
      onClose();
  }
  return (
    <InventoryPhysicalDialog
      title="Record scientific transfer"
      subtitle={data.project.name}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={() => void record()}
      submitLabel="Record completed manual transfer"
      disabled={!editable || stale || preview?.kind !== 'ready'}
    >
      <div
        className="space-y-4"
        data-testid="inventory-scientific-transfer"
        data-preview-state={stale ? 'stale' : (preview?.kind ?? snapshot.phase)}
      >
        <p>
          Report a manual transfer that was physically completed. A preview creates no stock or
          debit and does not execute an experiment.
        </p>
        <fieldset disabled={locked || !editable} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <PhysicalField label="Work namespace">
              <TextField
                aria-label="Work namespace"
                value={draft.namespace}
                onChange={(event) => edit({ namespace: event.target.value })}
              />
            </PhysicalField>
            <PhysicalField label="Physical work ID">
              <TextField
                aria-label="Physical work ID"
                value={draft.workId}
                onChange={(event) => edit({ workId: event.target.value })}
              />
            </PhysicalField>
          </div>
          <p className="text-xs">
            Keep this identity when presenting the same observed transfer again. Use a separate
            identity only for a separately observed physical action.
          </p>
          <Button onClick={() => session.newObservation()}>Start a separate observation</Button>
          <PhysicalField label="Scientific context kind">
            <Select
              ariaLabel="Scientific context kind"
              value={draft.contextKind}
              options={[
                { value: 'notebook-page', label: 'Notebook page' },
                { value: 'protocol-run', label: 'Protocol run' },
              ]}
              onValueChange={(value) =>
                edit({
                  contextKind: value as typeof draft.contextKind,
                  entityId: '',
                  expectedSourceSha256: '',
                })
              }
            />
          </PhysicalField>
          <PhysicalField
            label={
              draft.contextKind === 'notebook-page'
                ? 'Find saved notebook page'
                : 'Find saved protocol run'
            }
          >
            <TextField
              aria-label={
                draft.contextKind === 'notebook-page'
                  ? 'Find saved notebook page'
                  : 'Find saved protocol run'
              }
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </PhysicalField>
          <Button
            onClick={() => {
              session.edit(session.getSnapshot().draft);
              setRefresh((value) => value + 1);
            }}
          >
            Refresh saved notebook pages
          </Button>
          {pageError ? <Notice tone="error">{pageError}</Notice> : null}
          <PhysicalField
            label={
              draft.contextKind === 'notebook-page' ? 'Saved notebook page' : 'Saved protocol run'
            }
          >
            <Select
              ariaLabel={
                draft.contextKind === 'notebook-page' ? 'Saved notebook page' : 'Saved protocol run'
              }
              value={draft.entityId}
              options={[
                { value: '', label: 'Choose a clean, settled saved page in this project' },
                ...pages.map((page) => ({
                  value: page.entityId,
                  label: page.title,
                  description: page.entityId,
                })),
              ]}
              onValueChange={(value) => {
                const page = pages.find((item) => item.entityId === value);
                edit({ entityId: value, expectedSourceSha256: page?.sourceSha256 ?? '' });
              }}
            />
          </PhysicalField>
          {draft.expectedSourceSha256 ? (
            <p className="break-all text-xs" data-selected-scientific-source-sha>
              Selected structured saved source: {draft.expectedSourceSha256}
            </p>
          ) : null}
          <PhysicalField label="Source stock">
            <Select
              ariaLabel="Source stock"
              value={draft.sourceStockId}
              options={[
                { value: '', label: 'Choose known stock available for withdrawal' },
                ...sources.map((stock) => ({
                  value: stock.id,
                  label: `${data.state.vessels[stock.vesselId].name} · ${inventoryAmountLabel(stock.quantity)}`,
                  description: stock.id,
                })),
              ]}
              onValueChange={(value) =>
                edit({
                  sourceStockId: value,
                  unit: data.state.stocks[value]?.quantity.unit ?? 'uL',
                })
              }
            />
          </PhysicalField>
          <PhysicalField label="Destination permanent well">
            <Select
              ariaLabel="Destination permanent well"
              value={draft.destinationVesselId}
              options={[
                { value: '', label: 'Choose an existing empty permanent well' },
                ...destinations.map((vessel) => ({
                  value: vessel.id,
                  label:
                    vessel.placement.kind === 'located'
                      ? `${locationPath(data.state, vessel.placement.storageId)} / ${vessel.placement.slotId}`
                      : vessel.name,
                  description: vessel.id,
                })),
              ]}
              onValueChange={(value) => edit({ destinationVesselId: value })}
            />
          </PhysicalField>
          <div className="grid grid-cols-2 gap-3">
            <PhysicalField label="Observed transfer amount">
              <TextField
                aria-label="Observed transfer amount"
                value={draft.quantity}
                onChange={(event) => edit({ quantity: event.target.value })}
              />
            </PhysicalField>
            <PhysicalField label="Observed amount unit">
              <Select
                ariaLabel="Observed amount unit"
                value={draft.unit}
                options={inventoryAmountUnitOptions(
                  data.state.stocks[draft.sourceStockId]?.quantity.unit
                )}
                onValueChange={(value) => edit({ unit: value as InventoryAmountUnit })}
              />
            </PhysicalField>
          </div>
          <PhysicalField label="Completed manual observation reason">
            <TextArea
              aria-label="Completed manual observation reason"
              value={draft.reason}
              onChange={(event) => edit({ reason: event.target.value })}
            />
          </PhysicalField>
          <Button onClick={() => void session.preview(data.state.revision)}>
            Preview observed transfer
          </Button>
        </fieldset>
        {snapshot.phase === 'failed' ? <Notice tone="error">{snapshot.message}</Notice> : null}
        {stale ? (
          <Notice>The inventory changed. Preview the exact observation again.</Notice>
        ) : null}
        {preview?.kind === 'blocked'
          ? preview.issues.map((issue, index) => (
              <Notice key={index} tone="error">
                {issue.message}
              </Notice>
            ))
          : null}
        {preview?.kind === 'no-change' ? (
          <Notice>
            This physical work identity is already recorded. No stock will be transferred or debited
            again.
          </Notice>
        ) : null}
        {preview && preview.kind !== 'blocked' ? (
          <WorkFacts
            key={preview.work.id}
            work={preview.work}
            data={data}
            client={client}
            onNavigate={onClose}
          />
        ) : null}
        <details>
          <summary>
            Recorded scientific work ({Object.keys(data.state.scientificWorks).length})
          </summary>
          <div className="mt-3 space-y-3">
            {Object.values(data.state.scientificWorks).map((work) => (
              <WorkFacts
                key={work.id}
                work={work}
                data={data}
                client={client}
                onNavigate={onClose}
              />
            ))}
          </div>
        </details>
      </div>
    </InventoryPhysicalDialog>
  );
}
