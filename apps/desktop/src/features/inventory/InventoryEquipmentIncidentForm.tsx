import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { InventoryEquipmentIncidentActionSummary } from '@waypoint/domain-services';
import { Button, Notice, TextArea, TextField, UI_FIELD_CLASS } from '../../components/ui';
import { UI_MODAL_LAYER_CLASS } from '../../components/ui/styles';
import { platform } from '../../platform';
import {
  PresentationScopeContext,
  usePresentationOverlay,
} from '../../presentation/PresentationSurface';
import type { InventoryData } from './inventory-controller';
import { inventoryPrincipalLabel } from './inventory-view';
import {
  InventoryEquipmentIncidentSession,
  type EquipmentIncidentScope,
} from './inventory-equipment-incident-session';
import {
  sharedInventoryPendingCoordinator,
  type InventoryAttempt,
} from './inventory-pending-coordinator';
import {
  equipmentIncidentDraftLabel,
  type EquipmentIncidentFollowUpDraft,
} from './inventory-equipment-incident-action-draft';
import { InventoryEquipmentIncidentActionFields } from './InventoryEquipmentIncidentActionFields';
export function EquipmentIncidentPreviewFacts({
  record,
}: {
  record: InventoryEquipmentIncidentActionSummary;
}) {
  const action = record.actionProof.choices.action,
    counts = record.effectCounts;
  return (
    <article
      className="space-y-3 rounded border border-border p-3"
      data-testid="equipment-incident-action-facts"
      data-action-id={record.actionProof.actionId}
    >
      <h4 className="font-semibold">
        {action.kind === 'report'
          ? 'Outage report preview'
          : equipmentIncidentDraftLabel(action.kind)}
      </h4>
      {action.kind === 'report' ? (
        <>
          <p>{action.description}</p>
          <p>
            Outage noticed:{' '}
            {action.noticedAt === null ? 'time unknown' : new Date(action.noticedAt).toISOString()}
          </p>
        </>
      ) : null}
      {action.kind === 'manual-temperature' ? (
        <>
          <p>
            {action.reading.kind === 'measured'
              ? `${action.reading.temperature.value} °C · ${action.reading.pointLabel}`
              : 'Withdraw selected earlier reading'}
          </p>
          {action.reading.kind === 'measured' ? (
            <p>Observed {new Date(action.reading.observedAt).toISOString()}</p>
          ) : null}
          <p>
            {action.supersedes
              ? 'Explicitly supersedes the selected earlier manual fact.'
              : 'Independent manual observation.'}
          </p>
        </>
      ) : null}
      {action.kind === 'completed-relocation' ? (
        <p>
          {counts.relocatedHolders} whole holders will be recorded in one completed relocation. No
          partial action is saved.
        </p>
      ) : null}
      {action.kind === 'impact-review' ? (
        <>
          <p>
            {counts.reviewedRoots} obligations ·{' '}
            {action.disposition === 'keep-incident-restriction'
              ? 'Keep this incident restriction'
              : 'Remove this incident restriction'}
          </p>
          <p>Review basis: {action.basis}</p>
        </>
      ) : null}
      {action.kind === 'resolve' ? (
        <p>
          {action.resolution === 'reported-resolved'
            ? 'Equipment reported resolved'
            : 'Original outage reported in error'}
          . Subject review restrictions remain separate.
        </p>
      ) : null}
      {action.kind === 'report' ? (
        <>
          <p>
            {counts.capturedHolders} holders · {counts.capturedVessels} vessels ·{' '}
            {counts.createdReviewRoots} review obligations
          </p>
          <p>
            Contents will be captured when the outage is recorded. An earlier noticed time does not
            establish earlier contents.
          </p>
          <p>
            While open, the affected storage blocks new inbound items and contents. Pending incident
            restrictions block use while guarded rescue remains available.
          </p>
        </>
      ) : null}
      <p>Stock quality, lot assessment and other restrictions remain separate.</p>
      <p>Reason: {action.reason}</p>
      <p>
        {inventoryPrincipalLabel(record.by)} · {new Date(record.at).toISOString()}
      </p>
      <details>
        <summary>Original action identities and exact choices</summary>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs">
          {JSON.stringify(record, null, 2)}
        </pre>
      </details>
    </article>
  );
}
export function InventoryEquipmentIncidentForm({
  scope,
  equipmentId,
  data,
  editable,
  resume,
  followUp,
  onClose,
}: {
  scope: EquipmentIncidentScope;
  equipmentId: string;
  data?: InventoryData;
  editable: boolean;
  resume?: InventoryAttempt;
  followUp?: EquipmentIncidentFollowUpDraft;
  onClose(): void;
}) {
  const equipment = data?.state.storage[equipmentId],
    client = platform().inventory,
    pending = sharedInventoryPendingCoordinator(),
    overlay = usePresentationOverlay('modal');
  const session = useMemo(
    () =>
      new InventoryEquipmentIncidentSession(
        scope,
        equipmentId,
        equipment?.configuration.revision ?? 0,
        client,
        pending,
        {
          getItem: (key) => localStorage.getItem(key),
          setItem: (key, value) => localStorage.setItem(key, value),
        },
        undefined,
        followUp
      ),
    [client, pending, scope.project, scope.inventoryId, equipmentId, JSON.stringify(followUp)]
  );
  const { draft, phase } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    session.activate();
    if (resume) session.resume(resume);
    const invalidate = () => session.invalidate();
    const unsubscribe = client.onChanged((event) => {
      if (event.projectId === scope.project && event.inventoryId === scope.inventoryId)
        invalidate();
    });
    window.addEventListener('focus', invalidate);
    document.addEventListener('visibilitychange', invalidate);
    return () => {
      session.detach();
      unsubscribe();
      window.removeEventListener('focus', invalidate);
      document.removeEventListener('visibilitychange', invalidate);
    };
  }, [session, client, scope.project, scope.inventoryId]);
  const allowed = Boolean(editable && (followUp || equipment?.lifecycle === 'active'));
  useEffect(() => session.setWritable(allowed), [session, allowed]);
  useEffect(() => {
    const principal = data?.availability?.principal ?? data?.storageConditions.principal;
    if (principal) session.setPrincipal(principal);
  }, [session, data?.availability?.principal, data?.storageConditions.principal]);
  const edit = (change: Partial<typeof draft>) => session.edit({ ...draft, ...change });
  const locked = ['sending', 'unknown', 'accepted-read-pending', 'recorded'].includes(phase.kind);
  const currentArrangement = Boolean(
    followUp || (equipment && draft.configurationRevision === equipment.configuration.revision)
  );
  const actionKind = draft.followUp?.kind ?? 'report';
  const title =
    draft.followUp?.kind === 'manual-temperature' && draft.followUp.readingKind === 'withdrawn'
      ? 'Withdraw manual temperature reading'
      : draft.followUp?.kind === 'manual-temperature' && draft.followUp.supersedes
        ? 'Correct manual temperature reading'
        : draft.followUp?.kind === 'completed-relocation' && draft.followUp.corrects
          ? 'Correct completed whole-holder relocation'
          : equipmentIncidentDraftLabel(actionKind);
  const preparedLabel = followUp ? 'Prepared incident action request' : 'Prepared outage request';
  const repeatable =
    !followUp ||
    (followUp.kind === 'manual-temperature' && !followUp.supersedes) ||
    (followUp.kind === 'completed-relocation' && !followUp.corrects);
  const nextAction = () => (repeatable ? session.newAction() : onClose());
  const nextLabel = !followUp
    ? 'Report another occurrence'
    : repeatable
      ? 'New incident action'
      : 'Choose another incident action';
  const preview = phase.kind === 'previewed' ? phase.preview : null;
  const prepared = phase.kind === 'previewed' ? phase.request : undefined;
  return (
    <div
      ref={overlay.bindRef(undefined, '0')}
      className={`fixed inset-0 ${UI_MODAL_LAYER_CLASS} grid place-items-center bg-black/40 p-4`}
    >
      <PresentationScopeContext.Provider value={overlay.scope}>
        <section
          role="dialog"
          aria-modal="true"
          aria-label={title}
          data-testid={
            followUp ? 'equipment-incident-follow-up-form' : 'equipment-incident-report-form'
          }
          className="flex max-h-[calc(100vh-40px)] w-full max-w-4xl flex-col rounded-lg border border-border bg-bg shadow-xl"
        >
          <header className="flex items-center justify-between border-b border-border p-4">
            <h2 className="font-semibold">{title}</h2>
            <Button onClick={onClose}>
              {followUp ? 'Close incident action' : 'Close outage report'}
            </Button>
          </header>
          <main className="min-h-0 space-y-4 overflow-auto p-4">
            <h3 className="font-semibold">{equipment?.name ?? 'Original equipment report'}</h3>
            {!followUp ? (
              <p>
                This is an operator report about an existing storage location. Its type, temperature
                evidence and qualification remain separate.
              </p>
            ) : null}
            {phase.kind === 'failed' ? <Notice tone="error">{phase.message}</Notice> : null}
            {phase.kind === 'unknown' || phase.kind === 'accepted-read-pending' ? (
              <Notice>
                <p>{phase.message}</p>
                <div className="mt-2 flex gap-2">
                  <Button onClick={() => void session.checkStatus()}>
                    {followUp
                      ? 'Confirm original incident action'
                      : 'Confirm original outage report'}
                  </Button>
                  <Button onClick={() => void session.retry()}>
                    {phase.kind === 'unknown'
                      ? followUp
                        ? 'Retry original incident action'
                        : 'Retry original outage request'
                      : 'Reload recorded outage'}
                  </Button>
                </div>
                <details>
                  <summary>Original outage request</summary>
                  <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs">
                    {JSON.stringify(phase.attempt.request, null, 2)}
                  </pre>
                </details>
              </Notice>
            ) : null}
            {phase.kind === 'sending' ? (
              <p role="status">Recording the original incident action…</p>
            ) : null}
            {phase.kind === 'recorded' ? (
              <>
                <Notice>
                  {phase.outcome === 'existing'
                    ? 'This exact incident action was already recorded. No new event was added.'
                    : 'The incident action was recorded.'}
                </Notice>
                <p>
                  {phase.incident.equipment.name} · contents captured{' '}
                  {new Date(phase.incident.contentsWhenRecorded).toISOString()}
                </p>
                <Button onClick={() => void session.preview(phase.record ?? phase.incident)}>
                  {followUp
                    ? 'Preview original incident action again'
                    : 'Preview original outage again'}
                </Button>
                <Button onClick={nextAction}>{nextLabel}</Button>
              </>
            ) : null}
            {!locked ? (
              <>
                {!allowed ? (
                  <Notice>
                    This storage location is not available for a new report. Original history
                    remains readable.
                  </Notice>
                ) : null}
                {!followUp && equipment && !currentArrangement ? (
                  <Notice>
                    The installed arrangement has changed.{' '}
                    <Button
                      onClick={() =>
                        edit({ configurationRevision: equipment.configuration.revision })
                      }
                    >
                      Use current installed arrangement
                    </Button>
                  </Notice>
                ) : null}
                {draft.followUp ? (
                  <InventoryEquipmentIncidentActionFields
                    draft={draft.followUp}
                    data={data}
                    onChange={(value) => edit({ followUp: value })}
                  />
                ) : (
                  <>
                    <label className="block space-y-1">
                      <span className="font-medium">Outage description</span>
                      <TextArea
                        aria-label="Outage description"
                        value={draft.description}
                        onChange={(event) => edit({ description: event.target.value })}
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="font-medium">Outage noticed time</span>
                      <select
                        aria-label="Outage noticed time"
                        className={UI_FIELD_CLASS}
                        value={draft.noticedTimeKnown ? 'known' : 'unknown'}
                        onChange={(event) =>
                          edit({ noticedTimeKnown: event.target.value === 'known' })
                        }
                      >
                        <option value="unknown">Time is unknown</option>
                        <option value="known">Record the noticed time</option>
                      </select>
                    </label>
                    {draft.noticedTimeKnown ? (
                      <label className="block space-y-1">
                        <span className="font-medium">Outage noticed at (UTC)</span>
                        <TextField
                          aria-label="Outage noticed at (UTC)"
                          placeholder="2026-11-18T12:34:56.000Z"
                          value={draft.noticedTime}
                          onChange={(event) => edit({ noticedTime: event.target.value })}
                        />
                      </label>
                    ) : null}
                  </>
                )}
                <label className="block space-y-1">
                  <span className="font-medium">
                    {followUp ? 'Reason for incident action' : 'Reason for outage report'}
                  </span>
                  <TextArea
                    aria-label={
                      followUp ? 'Reason for incident action' : 'Reason for outage report'
                    }
                    value={draft.reason}
                    onChange={(event) => edit({ reason: event.target.value })}
                  />
                </label>
                <Notice>
                  {followUp
                    ? 'Preview makes no changes. Recording reports only the exact completed action shown below; stock quality and batch assessment remain separate.'
                    : 'Preview makes no inventory changes. Recording snapshots the contents present then and starts incident restrictions; it does not change stock quality or release a batch.'}
                </Notice>
                <Button
                  disabled={!allowed || !currentArrangement || phase.kind === 'previewing'}
                  onClick={() => void session.preview()}
                >
                  {followUp ? 'Preview incident action' : 'Preview equipment outage'}
                </Button>
              </>
            ) : null}
            {phase.kind === 'previewing' ? (
              <p role="status">Previewing without changing inventory…</p>
            ) : null}
            {preview ? (
              <section className="space-y-3" data-testid="equipment-incident-action-preview">
                {preview.kind === 'blocked' ? (
                  <Notice tone="error">
                    <ul>
                      {preview.issues.map((issue, index) => (
                        <li key={index}>{issue.message}</li>
                      ))}
                    </ul>
                  </Notice>
                ) : (
                  <>
                    <Notice>
                      {preview.kind === 'no-change'
                        ? 'This original incident action already exists. There is no new change to save.'
                        : 'Ready to record this exact incident action. No changes have been saved.'}
                    </Notice>
                    <EquipmentIncidentPreviewFacts record={preview.record} />
                    {preview.kind === 'no-change' ? (
                      <Button onClick={nextAction}>{nextLabel}</Button>
                    ) : null}
                    {prepared ? (
                      <>
                        <details>
                          <summary>{preparedLabel}</summary>
                          <TextArea
                            aria-label={preparedLabel}
                            readOnly
                            value={JSON.stringify(prepared, null, 2)}
                          />
                        </details>
                        <Button
                          disabled={!allowed || !currentArrangement}
                          onClick={() => void session.submit()}
                        >
                          {title}
                        </Button>
                      </>
                    ) : null}
                  </>
                )}
              </section>
            ) : null}
          </main>
        </section>
      </PresentationScopeContext.Provider>
    </div>
  );
}
