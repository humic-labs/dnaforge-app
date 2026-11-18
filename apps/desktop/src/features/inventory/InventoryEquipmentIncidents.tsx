import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type {
  InventoryEquipmentIncidentSubjectProjection,
  InventoryEquipmentIncidentCurrentStatus,
  InventoryEquipmentIncidentReviewRootPin,
  InventoryEquipmentIncidentFactPin,
} from '@waypoint/domain-services';
import { Button, Notice, TextArea, TextField } from '../../components/ui';
import { UI_MODAL_LAYER_CLASS } from '../../components/ui/styles';
import { platform } from '../../platform';
import {
  PresentationScopeContext,
  usePresentationOverlay,
} from '../../presentation/PresentationSurface';
import type { InventoryData } from './inventory-controller';
import { inventoryContentsLabel } from './inventory-contents-view';
import {
  inventoryAmountLabel,
  inventoryLocationPathLabel,
  inventoryPrincipalLabel,
} from './inventory-view';
import { inventoryTemperatureFreshnessLabel } from './inventory-temperature-view';
import { InventoryEquipmentIncidentReadSession } from './inventory-equipment-incident-read-session';
import {
  equipmentIncidentFollowUpDraft,
  type EquipmentIncidentFollowUpDraft,
} from './inventory-equipment-incident-action-draft';
import type { EquipmentIncidentScope } from './inventory-equipment-incident-session';
import { InventoryEquipmentIncidentForm } from './InventoryEquipmentIncidentForm';
import {
  sharedInventoryPendingCoordinator,
  type InventoryAttempt,
} from './inventory-pending-coordinator';
export function equipmentIncidentActionLabel(kind: string) {
  const labels: Record<string, string> = {
    report: 'Outage reported',
    'manual-temperature': 'Manual temperature report',
    'completed-relocation': 'Completed whole-holder relocation',
    'impact-review': 'Incident impact review',
    resolve: 'Equipment resolution',
    'contents-identified': 'Existing contents identified',
    'contents-episode-closed': 'Contents episode closed',
  };
  return labels[kind] ?? 'Incident fact';
}
function CurrentRestrictions({ current }: { current: InventoryEquipmentIncidentCurrentStatus }) {
  return (
    <div className="space-y-1">
      <p>
        Equipment incident: <strong>{current.lifecycle === 'open' ? 'Open' : 'Resolved'}</strong>
      </p>
      <p>
        Incident restrictions: {current.review.pending} pending · {current.review.kept} kept ·{' '}
        {current.review.removed} removed · {current.review.importedRemovalUnconfirmed} imported
        removals requiring local confirmation
      </p>
      <p>
        Reviewed does not mean usable. Quality, batch assessment, validity and other incident
        restrictions remain separate.
      </p>
    </div>
  );
}
function Subject({
  row,
  data,
  onReview,
}: {
  row: InventoryEquipmentIncidentSubjectProjection;
  data?: InventoryData;
  onReview?(
    root: InventoryEquipmentIncidentReviewRootPin,
    supersedes: InventoryEquipmentIncidentFactPin | null
  ): void;
}) {
  if (row.view !== 'review')
    return (
      <article className="space-y-1 rounded border border-border p-3" data-subject-key={row.key}>
        <p className="font-medium">{row.snapshot.name}</p>
        {'contents' in row.snapshot ? <p>{inventoryContentsLabel(row.snapshot.contents)}</p> : null}
        {'stock' in row && row.stock ? (
          <p>
            Recorded stock: {inventoryAmountLabel(row.stock.quantity)} · {row.stock.quality}
          </p>
        ) : null}
        <p>
          {row.view === 'initial' ? 'Location when recorded' : 'Current confirmed location'}:{' '}
          {row.snapshot.currentPath
            ? inventoryLocationPathLabel(row.snapshot.currentPath)
            : 'Unavailable'}
        </p>
        <p>Custody: {row.snapshot.custody.kind.replaceAll('-', ' ')}</p>
        {!row.snapshot.currentPath && row.snapshot.lastKnown ? (
          <p>Last-known location is retained separately; it is not a confirmed current location.</p>
        ) : null}
        <p>{row.reviewRootIds.length} retained incident review obligations</p>
        <details>
          <summary>Exact retained subject and location facts</summary>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
            {JSON.stringify(row, null, 2)}
          </pre>
        </details>
      </article>
    );
  if (row.kind === 'root') {
    const labels = {
      pending: 'Pending review restriction',
      kept: 'Reviewed — restriction kept',
      removed: 'Reviewed — this restriction removed',
      'imported-removal-unconfirmed': 'Historical removal requires a local review',
    };
    return (
      <article
        className="space-y-1 rounded border border-border p-3"
        data-subject-key={row.key}
        data-review-root-id={row.root.id}
      >
        <p className="font-medium">{row.root.snapshot.vessel.name}</p>
        <p>
          {row.root.qualification === 'confirmed-unidentified-at-open'
            ? 'Unidentified contents confirmed present when recorded'
            : row.root.qualification === 'possible-unconfirmed'
              ? 'Possible contents; initial presence was not confirmed'
              : 'Identified stock when recorded'}
        </p>
        <p>{labels[row.review.restriction]}</p>
        <p>
          Review record: {row.review.status === 'reviewed' ? 'Reviewed' : 'Pending'} · this incident
          restriction: {row.review.restriction === 'removed' ? 'removed' : 'still blocks use'}
        </p>
        {onReview ? (
          <Button
            onClick={() =>
              onReview(
                { rootId: row.root.id, intentSha256: row.root.intentSha256 },
                row.review.head
              )
            }
          >
            {row.review.head ? 'Supersede this impact review' : 'Review this incident obligation'}
          </Button>
        ) : null}
        <details>
          <summary>Original obligation and exact current review pin</summary>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
            {JSON.stringify(row, null, 2)}
          </pre>
        </details>
      </article>
    );
  }
  return (
    <article className="space-y-1 rounded border border-border p-3" data-subject-key={row.key}>
      <p className="font-medium">
        {row.kind === 'lot'
          ? row.lot.name
          : (data?.state.vessels[row.stock.vesselId]?.name ??
            'Current stock carrying an incident obligation')}
      </p>
      {row.kind === 'stock' ? (
        <p>
          {inventoryAmountLabel(row.stock.quantity)} ·{' '}
          {row.relation === 'derived-material' ? 'Derived material' : 'Direct subject'}
        </p>
      ) : null}
      <p>
        {row.reviewRootIds.length} carried incident review obligations; each restriction is assessed
        separately.
      </p>
      <details>
        <summary>Exact current lineage references</summary>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
          {JSON.stringify(row, null, 2)}
        </pre>
      </details>
    </article>
  );
}
export function InventoryEquipmentIncidents({
  scope,
  equipmentId,
  data,
  editable = false,
}: {
  scope: EquipmentIncidentScope;
  equipmentId?: string;
  data?: InventoryData;
  editable?: boolean;
}) {
  const client = platform().inventory,
    pending = sharedInventoryPendingCoordinator(),
    key = JSON.stringify([scope, equipmentId]);
  const reader = useMemo(
    () => new InventoryEquipmentIncidentReadSession(client, scope, equipmentId),
    [client, key]
  );
  const snapshot = useSyncExternalStore(reader.subscribe, reader.getSnapshot),
    pendingSnapshot = useSyncExternalStore(pending.subscribe, pending.getSnapshot);
  const [selection, setSelection] = useState<{
      equipmentId: string;
      resume?: InventoryAttempt;
      followUp?: EquipmentIncidentFollowUpDraft;
    } | null>(null),
    [error, setError] = useState<string | null>(null),
    [policy, setPolicy] = useState('');
  useEffect(() => {
    setSelection(null);
    setError(null);
    void reader.open();
    try {
      pending.refresh();
    } catch (cause) {
      setError(message(cause));
    }
    const focus = () => void reader.refresh();
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      reader.dispose();
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [reader, pending]);
  const attempt = pendingSnapshot.attempts.find(
    (value) =>
      value.request.project === scope.project &&
      value.request.inventoryId === scope.inventoryId &&
      'kind' in value.request &&
      value.request.kind === 'record-equipment-incident-action'
  );
  function resumeOriginal() {
    if (
      !attempt ||
      !('kind' in attempt.request) ||
      attempt.request.kind !== 'record-equipment-incident-action'
    )
      return;
    const action = attempt.request.choices.action;
    if (action.kind !== 'report') {
      const incident = data?.state.equipmentIncidents[action.incident.incidentId];
      if (!incident) {
        setError('Load the inventory containing this original incident before resuming it.');
        return;
      }
      setSelection({
        equipmentId: incident.binding.storageId,
        followUp: equipmentIncidentFollowUpDraft(action),
        resume: attempt,
      });
      return;
    }
    if (equipmentId && action.equipment.storageId !== equipmentId) {
      setError(
        'Use Inventory Equipment incidents to confirm the original report for its location.'
      );
      return;
    }
    setSelection({ equipmentId: action.equipment.storageId, resume: attempt });
  }
  const { list, detail, subjects, facts, fact } = snapshot;
  const currentEquipment = equipmentId ? data?.state.storage[equipmentId] : undefined;
  function followUp(draft: EquipmentIncidentFollowUpDraft) {
    if (detail.kind !== 'available' || !editable || attempt) return;
    setSelection({ equipmentId: detail.incident.binding.storageId, followUp: draft });
  }
  const incidentPin =
    detail.kind === 'available'
      ? { incidentId: detail.incident.id, intentSha256: detail.incident.actionProof.intentSha256 }
      : null;
  function applyPolicy() {
    const minutes = policy === '' ? null : Number(policy);
    if (
      minutes !== null &&
      (!Number.isFinite(minutes) || minutes < 0 || !Number.isSafeInteger(minutes * 60000))
    ) {
      setError('Enter a nonnegative freshness limit in minutes.');
      return;
    }
    setError(null);
    void reader.setFreshness(minutes === null ? null : minutes * 60000);
  }
  return (
    <>
      <section
        className="space-y-3 rounded border border-border p-4"
        data-testid="equipment-incidents"
        data-equipment-id={equipmentId}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">Equipment incidents</h3>
          <Button onClick={() => void reader.refresh()}>Refresh equipment incidents</Button>
          {equipmentId ? (
            <Button
              disabled={!editable || currentEquipment?.lifecycle !== 'active' || Boolean(attempt)}
              onClick={() => setSelection({ equipmentId })}
            >
              Report equipment outage
            </Button>
          ) : null}
        </div>
        <p>
          Operator reports, recorded contents and review obligations remain separate from
          temperature qualification and sample quality.
        </p>
        {attempt ? (
          <Notice>
            An original equipment incident action needs confirmation.{' '}
            <Button onClick={resumeOriginal}>Resume original equipment incident action</Button>
          </Notice>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {list.kind === 'loading' ? (
          <p role="status">Loading equipment incidents…</p>
        ) : list.kind === 'unavailable' ? (
          <Notice tone="error">{list.message}</Notice>
        ) : list.kind === 'inventory-absent' ? (
          <p>This project has no inventory yet.</p>
        ) : (
          <>
            {!list.incidents.length ? <p>No recorded equipment incidents.</p> : null}
            {list.incidents.map((row) => (
              <article
                key={row.incident.id}
                data-incident-id={row.incident.id}
                className="space-y-2 rounded border border-border p-3"
              >
                <p className="font-semibold">{row.incident.equipment.name}</p>
                <p>
                  {row.incident.actionProof.choices.action.kind === 'report'
                    ? row.incident.actionProof.choices.action.description
                    : ''}
                </p>
                <CurrentRestrictions current={row.current} />
                <p>Contents captured {new Date(row.incident.contentsWhenRecorded).toISOString()}</p>
                <Button
                  onClick={() =>
                    void reader.select({
                      incidentId: row.incident.id,
                      intentSha256: row.incident.actionProof.intentSha256,
                    })
                  }
                >
                  View equipment incident
                </Button>
              </article>
            ))}
            <div className="flex gap-2">
              <Button disabled={!snapshot.listCursor} onClick={() => void reader.refresh()}>
                First incidents page
              </Button>
              <Button disabled={!list.nextCursor} onClick={() => void reader.next()}>
                Next incidents page
              </Button>
            </div>
          </>
        )}
        {detail.kind === 'loading' ? (
          <p role="status">Loading the exact equipment incident…</p>
        ) : detail.kind === 'unavailable' ? (
          <Notice tone="error">{detail.message}</Notice>
        ) : detail.kind === 'available' ? (
          <section
            className="space-y-4"
            data-testid="equipment-incident-detail"
            data-incident-id={detail.incident.id}
          >
            <h4 className="font-semibold">{detail.incident.equipment.name}</h4>
            <CurrentRestrictions current={detail.current} />
            <p>
              Contents present when the outage was recorded:{' '}
              {new Date(detail.incident.contentsWhenRecorded).toISOString()}
            </p>
            {detail.incident.actionProof.choices.action.kind === 'report' ? (
              <p>
                Operator noticed time:{' '}
                {detail.incident.actionProof.choices.action.noticedAt === null
                  ? 'unknown'
                  : new Date(detail.incident.actionProof.choices.action.noticedAt).toISOString()}
              </p>
            ) : null}
            <p>
              {detail.incident.effectCounts.capturedHolders} holders ·{' '}
              {detail.incident.effectCounts.capturedVessels} vessels ·{' '}
              {detail.incident.effectCounts.createdReviewRoots} initial review obligations
            </p>
            {incidentPin ? (
              <div className="flex flex-wrap gap-2" aria-label="Incident actions">
                <Button
                  disabled={!editable || Boolean(attempt)}
                  onClick={() =>
                    followUp({
                      kind: 'manual-temperature',
                      incident: incidentPin,
                      readingKind: 'measured',
                      temperature: '',
                      observedTime: '',
                      pointLabel: '',
                      supersedes: null,
                    })
                  }
                >
                  Record manual temperature
                </Button>
                <Button
                  disabled={!editable || Boolean(attempt) || !data}
                  onClick={() =>
                    followUp({
                      kind: 'completed-relocation',
                      incident: incidentPin,
                      moves: [{ item: null, destination: null }],
                      corrects: null,
                    })
                  }
                >
                  Report completed whole-holder relocation
                </Button>
                {detail.current.lifecycle === 'open' ? (
                  <Button
                    disabled={!editable || Boolean(attempt)}
                    onClick={() =>
                      followUp({ kind: 'resolve', incident: incidentPin, resolution: '' })
                    }
                  >
                    Resolve equipment incident
                  </Button>
                ) : (
                  <p>
                    Resolved equipment can still have retained review restrictions. Manual
                    follow-ups, reviews and guarded relocation of retained subjects remain separate.
                  </p>
                )}
              </div>
            ) : null}
            <div
              role="tablist"
              aria-label="Incident subject views"
              className="flex flex-wrap gap-2"
            >
              {(['initial', 'current', 'review'] as const).map((view) => (
                <Button
                  key={view}
                  role="tab"
                  aria-selected={snapshot.view === view}
                  onClick={() => void reader.setView(view)}
                >
                  {view === 'initial'
                    ? 'Contents when recorded'
                    : view === 'current'
                      ? 'Contents now'
                      : 'Review obligations'}
                </Button>
              ))}
            </div>
            <div data-testid="equipment-incident-subjects" data-subject-view={snapshot.view}>
              {subjects.kind === 'loading' ? (
                <p role="status">Loading this incident subject view…</p>
              ) : subjects.kind === 'unavailable' ? (
                <Notice tone="error">{subjects.message}</Notice>
              ) : subjects.kind === 'ready' ? (
                <div className="space-y-2">
                  {!subjects.subjects.length ? <p>No subjects in this view.</p> : null}
                  {subjects.subjects.map((row) => (
                    <Subject
                      key={row.key}
                      row={row}
                      data={data}
                      onReview={
                        editable && !attempt && incidentPin
                          ? (root, supersedes) =>
                              followUp({
                                kind: 'impact-review',
                                incident: incidentPin,
                                subjects: [{ root, supersedes }],
                                disposition: '',
                                basis: '',
                              })
                          : undefined
                      }
                    />
                  ))}
                  <p className="text-xs text-fg-muted">
                    This page is a bounded view, not a claim that current contents exhaust the
                    retained history.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      disabled={!snapshot.subjectCursor}
                      onClick={() => void reader.firstSubjects()}
                    >
                      First subjects page
                    </Button>
                    <Button
                      disabled={!subjects.nextCursor}
                      onClick={() => void reader.nextSubjects()}
                    >
                      Next subjects page
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
            <h4 className="font-semibold">Incident history · recording order</h4>
            {facts.kind === 'loading' ? (
              <p role="status">Loading recorded incident facts…</p>
            ) : facts.kind === 'unavailable' ? (
              <Notice tone="error">{facts.message}</Notice>
            ) : facts.kind === 'ready' ? (
              <div className="space-y-2">
                {!facts.facts.length ? <p>No additional incident facts.</p> : null}
                {facts.facts.map((row) => (
                  <article
                    className="space-y-1 rounded border border-border p-3"
                    key={row.id}
                    data-fact-id={row.id}
                  >
                    <p>{equipmentIncidentActionLabel(row.kind)}</p>
                    <p>
                      {new Date(row.at).toISOString()} · {inventoryPrincipalLabel(row.by)}
                    </p>
                    <Button
                      onClick={() =>
                        void reader.readFact({ factId: row.id, intentSha256: row.intentSha256 })
                      }
                    >
                      View exact incident fact
                    </Button>
                  </article>
                ))}
                <div className="flex gap-2">
                  <Button disabled={!snapshot.factCursor} onClick={() => void reader.firstFacts()}>
                    First facts page
                  </Button>
                  <Button disabled={!facts.nextCursor} onClick={() => void reader.nextFacts()}>
                    Next facts page
                  </Button>
                </div>
              </div>
            ) : null}
            <label className="block space-y-1">
              <span>Freshness limit for selected manual fact (minutes)</span>
              <TextField
                aria-label="Freshness limit for selected manual fact (minutes)"
                value={policy}
                onChange={(event) => setPolicy(event.target.value)}
                placeholder="No freshness policy"
              />
            </label>
            <Button onClick={applyPolicy}>Apply selected-fact freshness policy</Button>
            {fact.kind === 'loading' ? (
              <p role="status">Loading the selected original fact…</p>
            ) : fact.kind === 'unavailable' ? (
              <Notice tone="error">{fact.message}</Notice>
            ) : fact.kind === 'available' ? (
              <article
                className="space-y-3 rounded border border-border p-3"
                data-testid="equipment-incident-fact"
                data-fact-id={fact.fact.id}
              >
                <h4 className="font-semibold">{equipmentIncidentActionLabel(fact.fact.kind)}</h4>
                <p>
                  Recorded {new Date(fact.fact.at).toISOString()} ·{' '}
                  {inventoryPrincipalLabel(fact.fact.by)}
                </p>
                {'choices' in fact.fact &&
                fact.fact.choices.action.kind === 'manual-temperature' ? (
                  <>
                    {fact.fact.choices.action.reading.kind === 'measured' ? (
                      <>
                        <p>
                          {fact.fact.choices.action.reading.temperature.value} °C ·{' '}
                          {fact.fact.choices.action.reading.pointLabel}
                        </p>
                        <p>
                          Observed{' '}
                          {new Date(fact.fact.choices.action.reading.observedAt).toISOString()}
                        </p>
                      </>
                    ) : (
                      <p>This fact withdraws an earlier manual reading.</p>
                    )}
                    <p>
                      This is one selected manual report, not a current chamber temperature or
                      sensor feed.
                    </p>
                  </>
                ) : null}
                {fact.manual ? (
                  <>
                    <p data-freshness-state={fact.manual.freshness.state}>
                      {inventoryTemperatureFreshnessLabel(fact.manual.freshness)}
                    </p>
                    <p>
                      Arrangement applicability:{' '}
                      {fact.manual.configurationApplicability.replaceAll('-', ' ')}
                    </p>
                    <p>
                      Assessed at {new Date(fact.asOf).toISOString()} ·{' '}
                      {fact.freshnessMaxAgeMs === null
                        ? 'No freshness policy'
                        : `Freshness limit ${fact.freshnessMaxAgeMs / 60000} minutes`}
                    </p>
                  </>
                ) : null}
                {'choices' in fact.fact &&
                fact.fact.choices.action.kind === 'manual-temperature' &&
                incidentPin ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={!editable || Boolean(attempt)}
                      onClick={() => {
                        const action = fact.fact;
                        if (
                          !('choices' in action) ||
                          action.choices.action.kind !== 'manual-temperature'
                        )
                          return;
                        followUp({
                          ...equipmentIncidentFollowUpDraft(action.choices.action),
                          kind: 'manual-temperature',
                          incident: incidentPin,
                          readingKind: 'measured',
                          supersedes: { factId: action.id, intentSha256: action.intentSha256 },
                        } as EquipmentIncidentFollowUpDraft);
                      }}
                    >
                      Correct selected manual reading
                    </Button>
                    <Button
                      disabled={!editable || Boolean(attempt)}
                      onClick={() =>
                        followUp({
                          kind: 'manual-temperature',
                          incident: incidentPin,
                          readingKind: 'withdrawn',
                          temperature: '',
                          observedTime: '',
                          pointLabel: '',
                          supersedes: {
                            factId: fact.fact.id,
                            intentSha256: fact.fact.intentSha256,
                          },
                        })
                      }
                    >
                      Withdraw selected manual reading
                    </Button>
                  </div>
                ) : null}
                {'choices' in fact.fact &&
                fact.fact.choices.action.kind === 'completed-relocation' &&
                incidentPin ? (
                  <Button
                    disabled={!editable || Boolean(attempt) || !data}
                    onClick={() =>
                      followUp({
                        kind: 'completed-relocation',
                        incident: incidentPin,
                        moves: [{ item: null, destination: null }],
                        corrects: { factId: fact.fact.id, intentSha256: fact.fact.intentSha256 },
                      })
                    }
                  >
                    Correct selected relocation
                  </Button>
                ) : null}
                {'choices' in fact.fact && fact.fact.choices.action.kind === 'impact-review' ? (
                  <>
                    <p>
                      Decision:{' '}
                      {fact.fact.choices.action.disposition === 'keep-incident-restriction'
                        ? 'Keep this incident restriction'
                        : 'Remove this incident restriction'}
                    </p>
                    <p>Basis: {fact.fact.choices.action.basis}</p>
                  </>
                ) : null}
                {fact.fact.kind === 'completed-relocation' &&
                'effects' in fact.fact &&
                fact.fact.effects.kind === 'completed-relocation'
                  ? fact.fact.effects.holders.map((holder, index) => (
                      <div className="rounded border border-border p-2" key={index}>
                        <p>{holder.before.name}</p>
                        <p>
                          From:{' '}
                          {holder.before.currentPath
                            ? inventoryLocationPathLabel(holder.before.currentPath)
                            : 'No confirmed location'}
                        </p>
                        <p>
                          To:{' '}
                          {holder.after.currentPath
                            ? inventoryLocationPathLabel(holder.after.currentPath)
                            : 'No confirmed location'}
                        </p>
                        <p>
                          {holder.descendantVesselIds.length} descendant vessels ·{' '}
                          {holder.descendantStockIds.length} recorded stocks retained in this move
                        </p>
                      </div>
                    ))
                  : null}
                <details>
                  <summary>Original exact fact, choices and recording basis</summary>
                  <TextArea
                    aria-label="Original equipment incident fact"
                    readOnly
                    value={JSON.stringify(fact.fact, null, 2)}
                  />
                </details>
              </article>
            ) : null}
            <details>
              <summary>Original report identity and recorded equipment snapshot</summary>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs">
                {JSON.stringify(detail.incident, null, 2)}
              </pre>
            </details>
          </section>
        ) : null}
      </section>
      {selection ? (
        <InventoryEquipmentIncidentForm
          key={`${key}:${selection.equipmentId}:${selection.resume?.request.operationId ?? JSON.stringify(selection.followUp ?? 'report')}`}
          scope={scope}
          equipmentId={selection.equipmentId}
          data={data}
          editable={editable}
          resume={selection.resume}
          followUp={selection.followUp}
          onClose={() => {
            setSelection(null);
            void reader.refresh();
          }}
        />
      ) : null}
    </>
  );
}
export function InventoryEquipmentIncidentsHistory({
  scope,
  data,
  editable,
  onClose,
}: {
  scope: EquipmentIncidentScope;
  data?: InventoryData;
  editable: boolean;
  onClose(): void;
}) {
  const overlay = usePresentationOverlay('modal');
  return (
    <div
      ref={overlay.bindRef(undefined, '0')}
      className={`fixed inset-0 ${UI_MODAL_LAYER_CLASS} grid place-items-center bg-black/40 p-4`}
    >
      <PresentationScopeContext.Provider value={overlay.scope}>
        <section
          role="dialog"
          aria-modal="true"
          aria-label="Equipment incidents"
          data-testid="inventory-equipment-incidents-history"
          className="flex max-h-[calc(100vh-40px)] w-full max-w-5xl flex-col rounded-lg border border-border bg-bg shadow-xl"
        >
          <header className="flex items-center justify-between border-b border-border p-4">
            <h2 className="font-semibold">Equipment incidents</h2>
            <Button onClick={onClose}>Close equipment incidents</Button>
          </header>
          <main className="min-h-0 overflow-auto p-4">
            <InventoryEquipmentIncidents scope={scope} data={data} editable={editable} />
          </main>
        </section>
      </PresentationScopeContext.Provider>
    </div>
  );
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Equipment incident information is unavailable.';
}
