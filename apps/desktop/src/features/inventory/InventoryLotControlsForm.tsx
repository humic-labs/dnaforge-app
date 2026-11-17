import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  inventoryStockEligibility,
  parseInventoryCommand,
  type InventoryCommand,
  type InventoryLot,
  type InventoryLotControls,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea, TextField } from '../../components/ui';
import {
  inventoryCanEdit,
  type InventoryController,
  type InventoryControllerState,
  type InventoryData,
} from './inventory-controller';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import {
  InventorySourceDetails,
  InventorySourceFields,
  PhysicalField,
  inventorySourceDraft,
} from './InventoryPhysicalControls';
import { inventoryObservationTime } from './inventory-temperature-view';
import { inventoryBlockerLabel, inventoryPrincipalLabel } from './inventory-view';

export interface InventoryLotControlsDialog {
  kind: 'lot-controls';
  lotId?: string;
}

type Action = { kind: 'manage' | 'assess' | 'recall' } | { kind: 'withdraw'; recallId: string };
const assessmentLabels = {
  unassessed: 'Unassessed',
  released: 'Released',
  quarantined: 'Quarantined',
  rejected: 'Rejected',
} as const;

function assessmentLabel(controls: InventoryLotControls): string {
  return controls.kind === 'legacy-untracked'
    ? 'Assessment not managed'
    : assessmentLabels[controls.assessment.value];
}

export function InventoryLotFacts({ lot, data }: { lot: InventoryLot; data: InventoryData }) {
  const controls = lot.controls;
  const recalls = Object.values(data.state.lotRecalls)
    .filter((recall) => recall.lotId === lot.id)
    .sort((left, right) => right.at - left.at || left.id.localeCompare(right.id));
  const current = data.availability?.principal ?? data.storageConditions.principal;
  return (
    <section className="space-y-3" data-testid="inventory-lot-facts" data-lot-id={lot.id}>
      <h3 className="break-words text-sm font-semibold">{lot.name}</h3>
      <p
        data-lot-assessment={
          controls.kind === 'managed' ? controls.assessment.value : 'legacy-untracked'
        }
      >
        {assessmentLabel(controls)}
      </p>
      {controls.kind === 'managed' ? (
        <div className="space-y-1 text-xs text-fg-muted">
          <p>
            {controls.assessment.by.kind === 'imported'
              ? 'Imported assessment'
              : 'Local assessment'}{' '}
            · {inventoryPrincipalLabel(controls.assessment.by, current)} ·{' '}
            {new Date(controls.assessment.at).toLocaleString()}
          </p>
          <p className="break-words">{controls.assessment.reason}</p>
          {controls.assessment.by.kind === 'imported' &&
          controls.assessment.value === 'released' ? (
            <Notice>
              A local release decision is required before this imported assessment can authorize
              use.
            </Notice>
          ) : null}
        </div>
      ) : (
        <Notice>This legacy lot has no managed release decision.</Notice>
      )}
      {lot.origin.kind === 'received' ? (
        <p className="break-words text-xs text-fg-muted">
          Supplier: {lot.origin.supplier} · Supplier lot: {lot.origin.lotNumber}
        </p>
      ) : null}
      <div className="space-y-2" data-testid="inventory-lot-recalls">
        <h4 className="text-xs font-semibold text-fg-muted">Recalls</h4>
        {!recalls.length ? (
          <p className="text-xs text-fg-muted">No recalls recorded.</p>
        ) : (
          recalls.map((recall) => (
            <article
              key={recall.id}
              data-recall-id={recall.id}
              data-recall-state={recall.lifecycle.kind}
              className="space-y-1 rounded border border-border p-3 text-xs"
            >
              <p className="font-semibold">
                {recall.lifecycle.kind === 'active' ? 'Active recall' : 'Withdrawn recall'}
              </p>
              <p className="break-all">Recall ID: {recall.id}</p>
              <p className="break-words">{recall.reason}</p>
              <p>
                {recall.by.kind === 'imported' ? 'Imported record' : 'Local record'} ·{' '}
                {inventoryPrincipalLabel(recall.by, current)} ·{' '}
                {new Date(recall.at).toLocaleString()}
              </p>
              <p>
                Observed:{' '}
                {recall.observedAt === null
                  ? 'Unknown'
                  : new Date(recall.observedAt).toLocaleString()}
              </p>
              {recall.source ? (
                <InventorySourceDetails source={recall.source} />
              ) : (
                <p>No source reference recorded.</p>
              )}
              {recall.lifecycle.kind === 'withdrawn' ? (
                <>
                  <p className="break-words">Withdrawal reason: {recall.lifecycle.reason}</p>
                  <p>
                    {inventoryPrincipalLabel(recall.lifecycle.by, current)} ·{' '}
                    {new Date(recall.lifecycle.at).toLocaleString()}
                  </p>
                </>
              ) : null}
            </article>
          ))
        )}
      </div>
    </section>
  );
}

export function InventoryStockLotControls({
  data,
  stockId,
  onInspect,
}: {
  data: InventoryData;
  stockId: string;
  onInspect(lotId: string): void;
}) {
  const eligibility = inventoryStockEligibility(data.state, stockId);
  if (!eligibility) return null;
  const coverage = {
    unattributed: 'Unattributed stock',
    'legacy-partial': 'Legacy lot history is incomplete',
    'legacy-untracked': 'Some contributing lots are not managed',
    managed: 'All contributing lots are managed',
  }[eligibility.coverage];
  return (
    <section
      className="space-y-3 rounded border border-border p-3"
      data-testid="inventory-stock-lot-controls"
    >
      <h3 className="text-sm font-semibold">Lot quality and recalls</h3>
      <p className="text-xs text-fg-muted">{coverage}</p>
      <p className="text-xs">
        Stock quality: {eligibility.stockQuality === 'usable' ? 'Usable' : 'Quarantined'}
      </p>
      {eligibility.blockers.map((blocker) => (
        <Notice key={`${blocker.code}:${'lotId' in blocker ? blocker.lotId : stockId}`}>
          <span data-lot-blocker={blocker.code}>{inventoryBlockerLabel(blocker, data.state)}</span>
        </Notice>
      ))}
      {eligibility.lots.map(({ lotId }) => (
        <div key={lotId} className="space-y-2 border-t border-border pt-3">
          <InventoryLotFacts lot={data.state.lots[lotId]} data={data} />
          <Button onClick={() => onInspect(lotId)}>
            Inspect lot {data.state.lots[lotId].name}
          </Button>
        </div>
      ))}
    </section>
  );
}

export function InventoryLotControlsForm({
  dialog,
  data,
  status,
  controller,
  onClose,
}: {
  dialog: InventoryLotControlsDialog;
  data: InventoryData;
  status: InventoryControllerState;
  controller: InventoryController;
  onClose(): void;
}) {
  const [lotId, setLotId] = useState(dialog.lotId ?? '');
  const [action, setAction] = useState<Action | null>(null);
  const [assessment, setAssessment] = useState<'released' | 'quarantined' | 'rejected' | ''>('');
  const [reason, setReason] = useState('');
  const [observed, setObserved] = useState<'unknown' | 'known'>('unknown');
  const [time, setTime] = useState('');
  const [hasSource, setHasSource] = useState(false);
  const [source, setSource] = useState(() => inventorySourceDraft(data.storageConditions.asOf));
  const [validation, setValidation] = useState<string | null>(null);
  const generation = useRef(0);
  const scope = `${data.project.projectId}:${data.project.defaultInventoryId}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const lot = data.state.lots[lotId];
  const editable = inventoryCanEdit(status);
  const locked = status.kind === 'submitting' || status.kind === 'outcome-unknown';
  const activeRecalls = Object.values(data.state.lotRecalls).filter(
    (recall) => recall.lotId === lotId && recall.lifecycle.kind === 'active'
  );
  const title = 'Lot quality and recalls';
  const actionTitle =
    action?.kind === 'manage'
      ? 'Start managing lot'
      : action?.kind === 'assess'
        ? 'Record lot assessment'
        : action?.kind === 'recall'
          ? 'Record lot recall'
          : 'Withdraw lot recall';
  const eligible = Boolean(
    lot &&
    action &&
    (action.kind === 'manage'
      ? lot.controls.kind === 'legacy-untracked'
      : action.kind === 'assess'
        ? lot.controls.kind === 'managed'
        : action.kind === 'withdraw'
          ? activeRecalls.some((recall) => recall.id === action.recallId)
          : true)
  );
  function reset(next: Action | null) {
    ++generation.current;
    setAction(next);
    setAssessment('');
    setReason('');
    setObserved('unknown');
    setTime('');
    setHasSource(false);
    setSource(inventorySourceDraft(data.storageConditions.asOf));
    setValidation(null);
  }
  useEffect(() => {
    ++generation.current;
    setLotId(dialog.lotId ?? '');
    setAction(null);
    setReason('');
    setValidation(null);
    return () => {
      ++generation.current;
    };
  }, [scope, dialog.lotId]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editable || !eligible || !action) return;
    setValidation(null);
    try {
      if (!reason.trim()) throw new Error('Enter a reason for this lot action.');
      let command: InventoryCommand;
      if (action.kind === 'manage') command = { kind: 'manage-lot', lotId, reason: reason.trim() };
      else if (action.kind === 'assess') {
        if (!assessment) throw new Error('Choose an assessment explicitly.');
        command = { kind: 'assess-lot', lotId, assessment, reason: reason.trim() };
      } else if (action.kind === 'recall')
        command = {
          kind: 'record-lot-recall',
          id: crypto.randomUUID(),
          lotId,
          observedAt: inventoryObservationTime(observed, time),
          source: hasSource ? source : null,
          reason: reason.trim(),
        };
      else
        command = { kind: 'withdraw-lot-recall', recallId: action.recallId, reason: reason.trim() };
      const current = generation.current;
      if (await controller.submit([parseInventoryCommand(command)], actionTitle))
        if (generation.current === current && scopeRef.current === scope) onClose();
    } catch (cause) {
      setValidation(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <InventoryPhysicalDialog
      title={title}
      subtitle={data.project.name}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={action ? (event) => void submit(event) : undefined}
      submitLabel={actionTitle}
      disabled={!eligible}
    >
      <div data-testid="inventory-lot-controls-form" className="space-y-4">
        <PhysicalField label="Lot or preparation">
          <Select
            ariaLabel="Lot or preparation"
            value={lotId}
            disabled={locked}
            options={[
              { value: '', label: 'Choose a lot or preparation' },
              ...Object.values(data.state.lots).map((item) => ({
                value: item.id,
                label: item.name,
                description: assessmentLabel(item.controls),
              })),
            ]}
            onValueChange={(value) => {
              reset(null);
              setLotId(value);
            }}
          />
        </PhysicalField>
        {!Object.keys(data.state.lots).length ? (
          <Notice>No lots have been recorded. Use Add lot to create one.</Notice>
        ) : null}
        {lot ? <InventoryLotFacts lot={lot} data={data} /> : null}
        {validation ? <Notice tone="error">{validation}</Notice> : null}
        {lot && editable && !action ? (
          <div className="flex flex-wrap gap-2">
            {lot.controls.kind === 'legacy-untracked' ? (
              <Button onClick={() => reset({ kind: 'manage' })}>Start managing lot</Button>
            ) : (
              <Button onClick={() => reset({ kind: 'assess' })}>Record assessment</Button>
            )}
            <Button onClick={() => reset({ kind: 'recall' })}>Record recall</Button>
            {activeRecalls.map((recall) => (
              <Button
                key={recall.id}
                aria-label={`Withdraw recall ${recall.id}`}
                onClick={() => reset({ kind: 'withdraw', recallId: recall.id })}
              >
                Withdraw recall {recall.id}
              </Button>
            ))}
          </div>
        ) : null}
        {action ? (
          <div
            className="space-y-4 rounded border border-border p-3"
            data-testid="inventory-lot-action"
          >
            <h3 className="text-sm font-semibold">{actionTitle}</h3>
            {action.kind === 'manage' ? (
              <Notice>
                This starts managed assessment as Unassessed. It does not release the lot.
              </Notice>
            ) : action.kind === 'assess' ? (
              <>
                <PhysicalField label="Lot assessment">
                  <Select
                    ariaLabel="Lot assessment"
                    value={assessment}
                    options={[
                      { value: '', label: 'Choose an assessment' },
                      { value: 'released', label: 'Released' },
                      { value: 'quarantined', label: 'Quarantined' },
                      { value: 'rejected', label: 'Rejected' },
                    ].filter(
                      (option) =>
                        lot?.controls.kind !== 'managed' ||
                        lot.controls.assessment.by.kind === 'imported' ||
                        option.value !== lot.controls.assessment.value
                    )}
                    onValueChange={(value) => setAssessment(value as typeof assessment)}
                  />
                </PhysicalField>
                <Notice>This assessment does not clear stock quarantine or active recalls.</Notice>
              </>
            ) : action.kind === 'recall' ? (
              <>
                <PhysicalField label="Recall observation time">
                  <Select
                    ariaLabel="Recall observation time"
                    value={observed}
                    options={[
                      { value: 'unknown', label: 'Unknown' },
                      { value: 'known', label: 'Known UTC time' },
                    ]}
                    onValueChange={(value) => setObserved(value as typeof observed)}
                  />
                </PhysicalField>
                {observed === 'known' ? (
                  <PhysicalField label="Observed at (UTC)">
                    <TextField
                      aria-label="Observed at (UTC)"
                      value={time}
                      onChange={(event) => setTime(event.target.value)}
                      placeholder="2026-11-16T12:00:00.000Z"
                      required
                    />
                  </PhysicalField>
                ) : null}
                <PhysicalField label="Recall source">
                  <Select
                    ariaLabel="Recall source"
                    value={hasSource ? 'reference' : 'none'}
                    options={[
                      { value: 'none', label: 'No source reference' },
                      { value: 'reference', label: 'Record source reference' },
                    ]}
                    onValueChange={(value) => setHasSource(value === 'reference')}
                  />
                </PhysicalField>
                {hasSource ? (
                  <InventorySourceFields
                    value={source}
                    onChange={setSource}
                    prefix="Recall source"
                  />
                ) : null}
                <Notice>
                  This records an independent recall. Quantity, custody and existing reservations
                  remain recorded.
                </Notice>
              </>
            ) : (
              <Notice>
                Withdraw only recall {action.recallId}. Other recalls, lot assessment and stock
                quarantine remain independent.
              </Notice>
            )}
            <PhysicalField label="Reason">
              <TextArea
                aria-label="Reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                required
              />
            </PhysicalField>
            <Button disabled={locked} onClick={() => reset(null)}>
              Cancel action
            </Button>
          </div>
        ) : null}
      </div>
    </InventoryPhysicalDialog>
  );
}
