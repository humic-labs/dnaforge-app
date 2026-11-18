import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  inventoryStoragePositions,
  inventoryAmountUnitDefinition,
  type InventoryPlatePlanVersion,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea, TextField } from '../../components/ui';
import { platform } from '../../platform';
import {
  PresentationScopeContext,
  usePresentationOverlay,
} from '../../presentation/PresentationSurface';
import type { InventoryProject } from '../../shared/inventory-client';
import type { InventoryController, InventoryData } from './inventory-controller';
import {
  InventoryPlatePlanDraftSession,
  type PlatePlanDraft,
} from './inventory-plate-plan-draft-session';
import { sharedInventoryPendingCoordinator } from './inventory-pending-coordinator';
import { inventoryAmountLabel, inventoryPrincipalLabel } from './inventory-view';
import { inventoryTextOutputLocked } from './inventory-text-output';
import {
  InventoryPlatePlanObservationForm,
  type PlatePlanReportSelection,
} from './InventoryPlatePlanObservationForm';
import { InventoryPlatePlanObservations } from './InventoryPlatePlanObservations';
import { inventoryPlatePlanVersionReadSchema } from '../../shared/inventory-plate-plans';
import type { InventoryAttempt } from './inventory-pending-coordinator';

export function InventoryPlatePlans({
  project,
  data,
  controller,
  onClose,
}: {
  project: InventoryProject;
  data?: InventoryData;
  controller: InventoryController;
  onClose(): void;
}) {
  const client = platform().inventory,
    overlay = usePresentationOverlay('modal'),
    pending = sharedInventoryPendingCoordinator();
  const scope = useMemo(
    () => ({ project: project.projectId, inventoryId: project.defaultInventoryId }),
    [project.projectId, project.defaultInventoryId]
  );
  const reader = useMemo(
    () =>
      controller.platePlanSession(scope, {
        chooseDestination: (defaultPath) =>
          platform().dialog.save({
            defaultPath,
            filters: [{ name: 'Plate plan SVG', extensions: ['svg'] }],
          }),
        write: (path, content) => platform().fs.writeTextFileAtomic({ path, content }),
        read: (path) => platform().fs.readTextFile(path),
      }),
    [controller, scope]
  );
  const editor = useMemo(
    () =>
      new InventoryPlatePlanDraftSession(scope, client, pending, {
        getItem: (key) => localStorage.getItem(key),
        setItem: (key, value) => localStorage.setItem(key, value),
      }),
    [client, scope, pending]
  );
  const read = useSyncExternalStore(reader.subscribe, reader.getSnapshot),
    edit = useSyncExternalStore(editor.subscribe, editor.getSnapshot),
    pendingState = useSyncExternalStore(pending.subscribe, pending.getSnapshot);
  useEffect(() => {
    editor.activate();
    pending.refresh();
    void reader.open();
    const unsubscribe = client.onChanged((event) => {
      if (event.projectId === scope.project && event.inventoryId === scope.inventoryId)
        editor.invalidate();
    });
    const focus = () => {
      reader.invalidate();
      editor.invalidate();
    };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      editor.detach();
      reader.detach();
      unsubscribe();
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [reader, editor, pending, client, scope]);
  useEffect(() => {
    reader.setPrincipal(data?.availability?.principal);
    editor.invalidate();
  }, [reader, editor, data?.availability?.principal]);
  const { draft, save } = edit,
    selected = read.selected.kind === 'available' ? read.selected : null,
    locked = ['sending', 'unknown', 'saved-refresh-failed', 'previewing', 'complete'].includes(
      save.kind
    );
  const attempt = pendingState.attempts.find(
    (entry) =>
      entry.request.project === scope.project && entry.request.inventoryId === scope.inventoryId
  );
  const preview = save.kind === 'previewed' ? save.preview : null;
  const [report, setReport] = useState<PlatePlanReportSelection | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  async function openReport(resume?: InventoryAttempt) {
    setReportError(null);
    try {
      if (resume) {
        if (
          !('kind' in resume.request) ||
          resume.request.kind !== 'record-plate-plan-observation' ||
          resume.request.project !== scope.project ||
          resume.request.inventoryId !== scope.inventoryId
        )
          throw Error('The saved manual report belongs to another inventory.');
        const binding = resume.request.choices.binding;
        const original = inventoryPlatePlanVersionReadSchema.parse(
          await client.platePlanVersion({
            ...scope,
            versionId: binding.versionId,
            definitionSha256: binding.definitionSha256,
          })
        );
        if (
          original.kind !== 'available' ||
          original.projectId !== scope.project ||
          original.inventoryId !== scope.inventoryId ||
          original.version.id !== binding.versionId ||
          original.version.definitionSha256 !== binding.definitionSha256
        )
          throw Error('The original saved plan for this pending report is unavailable.');
        setReport({ version: original.version, resume });
      } else if (selected)
        setReport({
          version: selected.version,
          initial: { destinationPlateId: read.destinationPlateId, sources: read.sources },
        });
    } catch (cause) {
      setReportError(
        cause instanceof Error ? cause.message : 'The manual report could not be opened.'
      );
    }
  }
  const update = (change: Partial<PlatePlanDraft>) => editor.edit({ ...draft, ...change });
  function changeRole(index: number, label: string) {
    const sourceSlots = draft.sourceSlots.map((slot, at) =>
      at === index ? { ...slot, label } : slot
    );
    update({ sourceSlots });
  }
  function changeTransfer(index: number, change: Partial<PlatePlanDraft['transfers'][number]>) {
    update({
      transfers: draft.transfers.map((row, at) => (at === index ? { ...row, ...change } : row)),
    });
  }
  function move(index: number, offset: number) {
    const transfers = [...draft.transfers],
      row = transfers[index]!;
    transfers.splice(index, 1);
    transfers.splice(index + offset, 0, row);
    update({ transfers });
  }
  const physical = data?.project.projectId === project.projectId ? data.state : null;
  const plates = physical
    ? Object.values(physical.storage).filter((item) => item.layout?.kind === 'fixed-well')
    : [];
  const stocks = physical
    ? Object.values(physical.stocks).filter(
        (stock) => inventoryAmountUnitDefinition(stock.quantity.unit).dimension === 'volume'
      )
    : [];
  const feasibility =
    read.feasibility.kind === 'observed' || read.feasibility.kind === 'stale'
      ? read.feasibility.preview
      : null;
  return (
    <div
      ref={overlay.bindRef(undefined, '0')}
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-3"
    >
      <PresentationScopeContext.Provider value={overlay.scope}>
        <section
          role="dialog"
          aria-modal="true"
          aria-label="Plate plans"
          className="flex max-h-[calc(100vh-32px)] w-full max-w-6xl flex-col rounded-lg border border-border bg-bg shadow-xl"
          data-testid="inventory-plate-plans"
          data-save-state={save.kind}
          data-plan-id={draft.identity.planId}
          data-plan-namespace={draft.identity.namespace}
        >
          <header className="flex items-center justify-between gap-3 border-b border-border p-4">
            <div>
              <h2 className="font-semibold">Plate plans</h2>
              <p className="text-xs text-fg-muted">{project.name}</p>
            </div>
            <Button onClick={onClose}>Close plate plans</Button>
          </header>
          <main className="min-h-0 space-y-6 overflow-auto p-4">
            <p>
              Save reusable instructions, export their diagram, and check a binding against recorded
              inventory. Physical work is recorded separately.
            </p>
            {attempt && !['sending', 'unknown', 'saved-refresh-failed'].includes(save.kind) ? (
              <Notice>
                A saved inventory change needs confirmation.{' '}
                {'kind' in attempt.request && attempt.request.kind === 'save-plate-plan-version' ? (
                  <Button onClick={() => editor.resume(attempt)}>Resume saved change</Button>
                ) : 'kind' in attempt.request &&
                  attempt.request.kind === 'record-plate-plan-observation' ? (
                  <Button onClick={() => void openReport(attempt)}>
                    Resume saved manual report
                  </Button>
                ) : (
                  <span>Open its inventory workflow to confirm the original change.</span>
                )}
              </Notice>
            ) : null}
            {reportError ? <Notice tone="error">{reportError}</Notice> : null}
            <section className="space-y-3" data-testid="plate-plan-versions">
              <div className="flex gap-2">
                <h3 className="mr-auto font-semibold">Saved versions</h3>
                <Button onClick={() => void reader.refresh()}>Refresh plan versions</Button>
                <Button
                  disabled={locked && save.kind !== 'complete'}
                  onClick={() => editor.newPlan()}
                >
                  New plan
                </Button>
              </div>
              {read.list.kind === 'loading' ? (
                <p role="status">Loading saved versions…</p>
              ) : read.list.kind === 'unavailable' ? (
                <Notice tone="error">{read.list.message}</Notice>
              ) : read.list.kind === 'inventory-absent' ? (
                <p>This project has no inventory yet. A plan save creates metadata only.</p>
              ) : (
                <>
                  {!read.list.versions.length ? <p>No saved plan versions.</p> : null}
                  <div className="space-y-2">
                    {read.list.versions.map((version) => (
                      <article
                        className="flex flex-wrap items-center gap-3 rounded border border-border p-3"
                        data-plan-version-id={version.id}
                        key={version.id}
                      >
                        <div className="mr-auto">
                          <p className="font-semibold">
                            {version.title} · {version.layout.rows} × {version.layout.columns}
                          </p>
                          <p className="text-xs">
                            {version.transferCount} planned transfers ·{' '}
                            {inventoryPrincipalLabel(version.by)} ·{' '}
                            {new Date(version.at).toISOString()}
                          </p>
                          <p className="text-xs">{version.reason}</p>
                          <p className="break-all text-xs">{version.id}</p>
                        </div>
                        <Button
                          onClick={() => void reader.select(version.id, version.definitionSha256)}
                        >
                          Open version
                        </Button>
                      </article>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Button disabled={!read.cursor} onClick={() => void reader.refresh()}>
                      First versions page
                    </Button>
                    <Button disabled={!read.list.nextCursor} onClick={() => void reader.next()}>
                      Next versions page
                    </Button>
                  </div>
                </>
              )}
            </section>
            <section
              className="space-y-3 rounded border border-border p-4"
              data-testid="plate-plan-editor"
            >
              <h3 className="font-semibold">Local definition draft</h3>
              <p className="text-xs">Saving appends an immutable version in this plan family.</p>
              <fieldset disabled={locked || project.pinned} className="space-y-3">
                <Field label="Plan title">
                  <TextField
                    aria-label="Plan title"
                    value={draft.title}
                    onChange={(event) => update({ title: event.target.value })}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Grid rows">
                    <TextField
                      aria-label="Grid rows"
                      value={draft.rows}
                      onChange={(event) => update({ rows: event.target.value })}
                    />
                  </Field>
                  <Field label="Grid columns">
                    <TextField
                      aria-label="Grid columns"
                      value={draft.columns}
                      onChange={(event) => update({ columns: event.target.value })}
                    />
                  </Field>
                </div>
                <div className="space-y-2">
                  <h4 className="font-semibold">Logical source roles</h4>
                  {draft.sourceSlots.map((slot, index) => (
                    <div className="flex gap-2" key={slot.key} data-source-slot-key={slot.key}>
                      <Field label={`Source role ${index + 1} label`}>
                        <TextField
                          aria-label={`Source role ${index + 1} label`}
                          value={slot.label}
                          onChange={(event) => changeRole(index, event.target.value)}
                        />
                      </Field>
                      <Button
                        disabled={draft.transfers.some((row) => row.sourceSlotKey === slot.key)}
                        onClick={() =>
                          update({
                            sourceSlots: draft.sourceSlots.filter((row) => row.key !== slot.key),
                          })
                        }
                      >
                        Remove source role {index + 1}
                      </Button>
                    </div>
                  ))}
                  <Button
                    onClick={() =>
                      update({
                        sourceSlots: [
                          ...draft.sourceSlots,
                          {
                            key: `source-${crypto.randomUUID()}`,
                            label: `Source ${draft.sourceSlots.length + 1}`,
                          },
                        ],
                      })
                    }
                  >
                    Add source role
                  </Button>
                </div>
                <div className="space-y-3">
                  <h4 className="font-semibold">Ordered planned transfers</h4>
                  {draft.transfers.map((row, index) => (
                    <section
                      className="space-y-2 rounded border border-border p-3"
                      key={row.actionId}
                      data-action-id={row.actionId}
                    >
                      <h5>Step {index + 1}</h5>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label={`Step ${index + 1} source role`}>
                          <Select
                            ariaLabel={`Step ${index + 1} source role`}
                            value={row.sourceSlotKey}
                            options={draft.sourceSlots.map((slot) => ({
                              value: slot.key,
                              label: slot.label,
                            }))}
                            onValueChange={(value) =>
                              changeTransfer(index, { sourceSlotKey: value })
                            }
                          />
                        </Field>
                        <Field label={`Step ${index + 1} destination`}>
                          <TextField
                            aria-label={`Step ${index + 1} destination`}
                            value={row.destinationPosition}
                            onChange={(event) =>
                              changeTransfer(index, { destinationPosition: event.target.value })
                            }
                          />
                        </Field>
                        <Field label={`Step ${index + 1} volume (µL)`}>
                          <TextField
                            aria-label={`Step ${index + 1} volume (µL)`}
                            value={row.volume}
                            onChange={(event) =>
                              changeTransfer(index, { volume: event.target.value })
                            }
                          />
                        </Field>
                        <Field label={`Step ${index + 1} label`}>
                          <TextField
                            aria-label={`Step ${index + 1} label`}
                            value={row.label}
                            onChange={(event) =>
                              changeTransfer(index, { label: event.target.value })
                            }
                          />
                        </Field>
                      </div>
                      <div className="flex gap-2">
                        <Button disabled={index === 0} onClick={() => move(index, -1)}>
                          Move step {index + 1} up
                        </Button>
                        <Button
                          disabled={index === draft.transfers.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          Move step {index + 1} down
                        </Button>
                        <Button
                          onClick={() =>
                            update({
                              transfers: draft.transfers.filter(
                                (item) => item.actionId !== row.actionId
                              ),
                            })
                          }
                        >
                          Remove step {index + 1}
                        </Button>
                      </div>
                    </section>
                  ))}
                  <Button
                    onClick={() =>
                      update({
                        transfers: [
                          ...draft.transfers,
                          {
                            actionId: crypto.randomUUID(),
                            sourceSlotKey: draft.sourceSlots[0]?.key ?? '',
                            destinationPosition: '',
                            volume: '4',
                            label: `Transfer ${draft.transfers.length + 1}`,
                          },
                        ],
                      })
                    }
                  >
                    Add planned transfer
                  </Button>
                </div>
                <Field label="Reason for version save">
                  <TextArea
                    aria-label="Reason for version save"
                    value={draft.reason}
                    rows={2}
                    onChange={(event) => update({ reason: event.target.value })}
                  />
                </Field>
                <Button onClick={() => void editor.preview()}>Preview version save</Button>
              </fieldset>
              {project.pinned ? (
                <Notice>
                  This inventory is read only. Saved versions and binding previews remain available.
                </Notice>
              ) : null}
              <details>
                <summary>Plan identity</summary>
                <p className="break-all text-xs">
                  {draft.identity.namespace} / {draft.identity.planId}
                </p>
              </details>
              {preview?.kind === 'blocked' ? (
                <Notice tone="error">
                  {preview.issues.map((issue) => issue.message).join(' ')}
                </Notice>
              ) : preview?.kind === 'no-change' ? (
                <Notice>
                  <p>
                    This exact version already exists. Its original reason remains:{' '}
                    {preview.version.reason}
                  </p>
                  <p>The new reason was not recorded.</p>
                  <Button
                    onClick={() =>
                      void reader.select(preview.version.id, preview.version.definitionSha256)
                    }
                  >
                    Open existing version
                  </Button>
                </Notice>
              ) : preview?.kind === 'ready' ? (
                <Notice>
                  <p>Ready to save this immutable version.</p>
                  <p>
                    {preview.version.definition.transfers
                      .map((row) => `${row.destinationPosition}: ${row.quantity.value} µL`)
                      .join(' · ')}
                  </p>
                  <Button variant="primary" onClick={() => void editor.submit()}>
                    Save plan version
                  </Button>
                </Notice>
              ) : null}
              {save.kind === 'previewed' && save.request ? (
                <details>
                  <summary>Prepared save details</summary>
                  <TextArea
                    aria-label="Prepared plan save request"
                    readOnly
                    value={JSON.stringify(save.request, null, 2)}
                    rows={8}
                  />
                </details>
              ) : null}
              {save.kind === 'sending' || save.kind === 'previewing' ? (
                <p role="status">
                  {save.kind === 'sending' ? 'Saving plan version…' : 'Checking exact definition…'}
                </p>
              ) : save.kind === 'unknown' ? (
                <Notice tone="warning">
                  {save.message}
                  <Button onClick={() => void editor.checkStatus()}>Check status</Button>
                  <Button onClick={() => void editor.retry()}>Retry same change</Button>
                </Notice>
              ) : save.kind === 'saved-refresh-failed' ? (
                <Notice tone="warning">
                  {save.message}
                  <Button onClick={() => void editor.reloadSaved()}>Reload saved plan</Button>
                </Notice>
              ) : save.kind === 'failed' ? (
                <Notice tone="error">{save.message}</Notice>
              ) : save.kind === 'complete' ? (
                <Notice>
                  <p>Plan version saved.</p>
                  <Button
                    onClick={() =>
                      void reader.select(save.version.id, save.version.definitionSha256)
                    }
                  >
                    View saved version
                  </Button>
                </Notice>
              ) : null}
            </section>
            {read.selected.kind === 'loading' ? (
              <p role="status">Loading exact saved version…</p>
            ) : read.selected.kind === 'failed' ? (
              <Notice tone="error">{read.selected.message}</Notice>
            ) : selected ? (
              <section
                className="space-y-4"
                data-testid="plate-plan-selected"
                data-plan-version-id={selected.version.id}
                data-definition-sha256={selected.version.definitionSha256}
              >
                <Button disabled={project.pinned} onClick={() => void openReport()}>
                  Report completed manual use
                </Button>
                <div className="flex gap-3">
                  <div className="mr-auto">
                    <h3 className="font-semibold">
                      {selected.version.definition.title} · Saved{' '}
                      {selected.version.definition.layout.rows} ×{' '}
                      {selected.version.definition.layout.columns}
                    </h3>
                    <p className="text-xs">{selected.version.reason}</p>
                  </div>
                  <Button
                    disabled={locked && save.kind !== 'complete'}
                    onClick={() => editor.editVersion(selected.version)}
                  >
                    Edit as new version
                  </Button>
                </div>
                <PlanGrid version={selected.version} />
                {selected.diagram.kind === 'refused' ? (
                  <Notice tone="warning">Diagram unavailable: {selected.diagram.message}</Notice>
                ) : (
                  <section
                    className="space-y-2"
                    data-testid="inventory-plate-plan-output"
                    data-output-state={read.output.kind}
                  >
                    <Button
                      disabled={inventoryTextOutputLocked(read.output)}
                      onClick={() => void reader.exportDiagram()}
                    >
                      Export printable plan SVG
                    </Button>
                    <p>
                      {read.output.kind === 'exported'
                        ? 'Saved SVG read-back matches this exact diagram.'
                        : read.output.kind === 'not-exported'
                          ? 'No saved output has been confirmed in this session for this diagram.'
                          : read.output.kind === 'output-unconfirmed'
                            ? 'File output is unconfirmed. The exact artifact and destination are retained.'
                            : read.output.kind === 'failed'
                              ? 'The SVG output failed.'
                              : `${read.output.kind} SVG…`}
                    </p>
                    {'path' in read.output ? (
                      <p className="break-all text-xs" data-testid="plate-plan-output-path">
                        {read.output.path}
                      </p>
                    ) : null}
                    {'message' in read.output ? (
                      <Notice tone="warning">{read.output.message}</Notice>
                    ) : null}
                    {['exported', 'failed', 'output-unconfirmed'].includes(read.output.kind) ? (
                      <div className="flex gap-2">
                        <Button onClick={() => void reader.checkOutput()}>Check saved SVG</Button>
                        {read.output.kind !== 'exported' ? (
                          <Button onClick={() => void reader.retryOutput()}>
                            Retry same SVG output
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </section>
                )}
                <section
                  className="space-y-3 rounded border border-border p-4"
                  data-testid="plate-plan-binding"
                  data-binding-state={read.feasibility.kind}
                >
                  <h4 className="font-semibold">Physical binding draft</h4>
                  <p>
                    Check these intended transfers against recorded inventory at a native
                    observation time.
                  </p>
                  <Field label="Destination physical plate">
                    <Select
                      ariaLabel="Destination physical plate"
                      value={read.destinationPlateId}
                      options={[
                        { value: '', label: 'Choose an existing plate' },
                        ...plates.map((plate) => ({
                          value: plate.id,
                          label: `${plate.name} · ${plate.layout?.kind === 'fixed-well' ? `${plate.layout.rows} × ${plate.layout.columns}` : ''} · ${plate.lifecycle}`,
                          description: plate.id,
                        })),
                      ]}
                      onValueChange={(value) => reader.bind(value, read.sources)}
                    />
                  </Field>
                  {selected.version.definition.sourceSlots.map((slot, index) => (
                    <Field label={`Source ${index + 1}: ${slot.label}`} key={slot.key}>
                      <Select
                        ariaLabel={`Source ${index + 1}: ${slot.label}`}
                        value={read.sources[slot.key] ?? ''}
                        options={[
                          { value: '', label: 'Choose an existing volume stock' },
                          ...stocks.map((stock) => ({
                            value: stock.id,
                            label: `${physical?.vessels[stock.vesselId]?.name ?? stock.vesselId} · ${inventoryAmountLabel(stock.quantity)}`,
                            description: stock.id,
                          })),
                        ]}
                        onValueChange={(value) =>
                          reader.bind(read.destinationPlateId, {
                            ...read.sources,
                            [slot.key]: value,
                          })
                        }
                      />
                    </Field>
                  ))}
                  <Button
                    disabled={read.feasibility.kind === 'checking'}
                    onClick={() => void reader.previewBinding()}
                  >
                    {read.feasibility.kind === 'stale'
                      ? 'Recheck feasibility'
                      : 'Check feasibility'}
                  </Button>
                  {read.feasibility.kind === 'checking' ? (
                    <p role="status">Checking the cumulative binding…</p>
                  ) : read.feasibility.kind === 'failed' ? (
                    <Notice tone="error">{read.feasibility.message}</Notice>
                  ) : null}
                  {feasibility && feasibility.kind !== 'unavailable' ? (
                    <section
                      className="space-y-2"
                      data-testid="plate-plan-feasibility"
                      data-observed-as-of={feasibility.asOf}
                      data-next-boundary={feasibility.nextBoundaryAt ?? ''}
                    >
                      <h5 className="font-semibold">
                        {read.feasibility.kind === 'stale' ? 'Needs recheck · ' : ''}
                        {feasibility.kind === 'ready' ? 'Feasible' : 'Blocked'} at{' '}
                        {new Date(feasibility.asOf).toISOString()}
                      </h5>
                      <p>Recorded inventory constraints were checked at this observation time.</p>
                      {feasibility.kind === 'blocked' ? (
                        <Notice tone="warning">
                          {feasibility.issues.map((issue) => issue.message).join(' ')}
                        </Notice>
                      ) : null}
                      {feasibility.sources.map((source) => (
                        <article
                          className="rounded border border-border p-3"
                          key={source.stock.id}
                          data-demand-stock-id={source.stock.id}
                        >
                          <p>
                            {source.vessel.name} · Roles:{' '}
                            {source.sourceSlotKeys
                              .map(
                                (key) =>
                                  selected.version.definition.sourceSlots.find(
                                    (slot) => slot.key === key
                                  )?.label ?? key
                              )
                              .join(', ')}
                          </p>
                          <p>
                            On hand: {inventoryAmountLabel(source.availability.onHand)} · Held:{' '}
                            {inventoryAmountLabel(source.availability.held)} · Unreserved:{' '}
                            {inventoryAmountLabel(source.availability.unreserved)}
                          </p>
                          <p>
                            Combined demand: {inventoryAmountLabel(source.demand)}
                            {'projectedRemaining' in source
                              ? ` · Projected remaining: ${inventoryAmountLabel(source.projectedRemaining)}`
                              : ''}
                          </p>
                          <p className="break-all text-xs">
                            Material: {source.stock.materialId} · Stock: {source.stock.id}
                          </p>
                          <details>
                            <summary>Observed source, validity and access facts</summary>
                            <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
                              {JSON.stringify(
                                {
                                  stock: source.stock,
                                  vessel: source.vessel,
                                  availability: source.availability,
                                },
                                null,
                                2
                              )}
                            </pre>
                          </details>
                        </article>
                      ))}
                      {feasibility.kind === 'ready' ? (
                        <ol>
                          {feasibility.destinations.map((destination) => (
                            <li key={destination.actionId}>
                              Step {destination.ordinal} → {destination.position} ·{' '}
                              <span className="break-all text-xs">{destination.vesselId}</span>
                            </li>
                          ))}
                        </ol>
                      ) : null}
                    </section>
                  ) : null}
                </section>
              </section>
            ) : (
              <p>Choose an exact saved version to view its grid, export or bind it.</p>
            )}
            {selected ? (
              <InventoryPlatePlanObservations
                scope={scope}
                filters={{
                  version: {
                    versionId: selected.version.id,
                    definitionSha256: selected.version.definitionSha256,
                  },
                }}
              />
            ) : null}
          </main>
        </section>
        {report ? (
          <InventoryPlatePlanObservationForm
            key={report.version.id + ':' + (report.resume?.request.operationId ?? 'draft')}
            scope={scope}
            selection={report}
            data={data}
            onClose={() => setReport(null)}
          />
        ) : null}
      </PresentationScopeContext.Provider>
    </div>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm">
      <span>{label}</span>
      {children}
    </label>
  );
}
function PlanGrid({ version }: { version: InventoryPlatePlanVersion }) {
  const definition = version.definition,
    positions = inventoryStoragePositions({ layout: definition.layout }),
    columns = definition.layout.columns;
  return (
    <section
      className="space-y-3"
      data-testid="inventory-plate-plan-grid"
      data-plan-version-id={version.id}
    >
      <p>
        Logical plan grid · {definition.layout.rows} × {columns}. Unplanned cells have no
        instruction.
      </p>
      <div className="overflow-auto">
        <table aria-label="Saved plan grid" className="w-full border-collapse text-xs">
          <thead>
            <tr>
              <th>Row / column</th>
              {Array.from({ length: columns }, (_, index) => (
                <th className="min-w-20 border border-border p-2" key={index}>
                  {index + 1}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: definition.layout.rows }, (_, row) => (
              <tr key={row}>
                <th className="border border-border p-2">
                  {positions[row * columns]?.replace(/[0-9]+$/u, '')}
                </th>
                {positions.slice(row * columns, (row + 1) * columns).map((position) => {
                  const index = definition.transfers.findIndex(
                      (step) => step.destinationPosition === position
                    ),
                    step = definition.transfers[index];
                  return (
                    <td
                      className="min-w-20 border border-border p-2 align-top"
                      key={position}
                      data-position={position}
                      data-action-id={step?.actionId ?? ''}
                    >
                      {step ? (
                        <>
                          <p>Step {index + 1}</p>
                          <p>
                            {
                              definition.sourceSlots.find((slot) => slot.key === step.sourceSlotKey)
                                ?.label
                            }
                          </p>
                          <p>{step.quantity.value} µL</p>
                        </>
                      ) : (
                        'Unplanned'
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>Source roles: {definition.sourceSlots.map((slot) => slot.label).join(' · ')}</p>
      <ol>
        {definition.transfers.map((step, index) => (
          <li key={step.actionId}>
            Step {index + 1}: {step.label} · {step.destinationPosition} · {step.quantity.value} µL
          </li>
        ))}
      </ol>
      <details>
        <summary>Saved version identity and definition</summary>
        <p className="break-all text-xs">
          {version.id} · {version.definitionSha256}
        </p>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
          {JSON.stringify(version.definition, null, 2)}
        </pre>
      </details>
    </section>
  );
}
