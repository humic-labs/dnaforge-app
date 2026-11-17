import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  inventoryValidityFamilyHead,
  parseInventoryCommand,
  type InventoryCommand,
  type InventorySourceReference,
  type InventoryValidityFact,
  type InventoryValidityOwner,
  type InventoryValidityRule,
  type InventoryValiditySourcePrecision,
} from '@waypoint/domain-services';
import { Notice, Select, TextArea, TextField } from '../../components/ui';
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
import {
  INVENTORY_ELAPSED_UNITS,
  inventoryElapsedMilliseconds,
  inventoryValidityInstant,
  inventoryValidityRuleLabel,
  type InventoryElapsedUnit,
} from './inventory-validity-view';
import { inventoryPrincipalLabel } from './inventory-view';

export type InventoryValidityDialog =
  | { kind: 'opening'; stockId: string; supersedesId?: string }
  | { kind: 'validity'; owner?: InventoryValidityOwner; headId?: string };
interface Props {
  data: InventoryData;
  status: InventoryControllerState;
  controller: InventoryController;
  onClose(): void;
}
const ownerKey = (owner: InventoryValidityOwner) =>
  owner.kind === 'stock' ? `stock:${owner.stockId}` : `lot:${owner.lotId}`;
const parseOwner = (key: string): InventoryValidityOwner | null =>
  key.startsWith('stock:')
    ? { kind: 'stock', stockId: key.slice(6) }
    : key.startsWith('lot:')
      ? { kind: 'lot', lotId: key.slice(4) }
      : null;

function SourceFields({
  enabled,
  setEnabled,
  source,
  setSource,
}: {
  enabled: boolean;
  setEnabled(value: boolean): void;
  source: InventorySourceReference;
  setSource(value: InventorySourceReference): void;
}) {
  return (
    <>
      <PhysicalField label="Evidence reference">
        <Select
          ariaLabel="Evidence reference"
          value={enabled ? 'source' : 'none'}
          options={[
            { value: 'none', label: 'No source reference' },
            { value: 'source', label: 'Record source reference' },
          ]}
          onValueChange={(value) => setEnabled(value === 'source')}
        />
      </PhysicalField>
      {enabled ? (
        <InventorySourceFields value={source} onChange={setSource} prefix="Evidence" />
      ) : null}
    </>
  );
}

export function InventoryValidityFactDetails({
  fact,
  data,
}: {
  fact: InventoryValidityFact;
  data: InventoryData;
}) {
  return (
    <div className="space-y-1 text-xs" data-validity-head={fact.id}>
      <p>{inventoryValidityRuleLabel(fact.rule)}</p>
      <p className="break-all">
        Family: {fact.rootId} · Fact: {fact.id}
      </p>
      <p>Source precision: {fact.sourcePrecision}</p>
      <p className="whitespace-pre-wrap break-words">
        Source text: {fact.sourceText || 'No source text recorded'}
      </p>
      <p className="break-words">Reason: {fact.reason}</p>
      <p>
        {fact.by.kind === 'imported' ? 'Imported decision' : 'Local decision'} ·{' '}
        {inventoryPrincipalLabel(
          fact.by,
          data.availability?.principal ?? data.storageConditions.principal
        )}{' '}
        · {new Date(fact.at).toISOString()}
      </p>
      {fact.source ? <InventorySourceDetails source={fact.source} /> : null}
    </div>
  );
}

export function InventoryOpeningForm({
  dialog,
  data,
  status,
  controller,
  onClose,
}: Props & { dialog: Extract<InventoryValidityDialog, { kind: 'opening' }> }) {
  const stock = data.state.stocks[dialog.stockId];
  const predecessor = dialog.supersedesId
    ? data.state.openingObservations[dialog.supersedesId]
    : undefined;
  const [value, setValue] = useState<'sealed' | 'opened' | 'unobserved' | ''>('');
  const [timeKind, setTimeKind] = useState<'known' | 'unknown'>('unknown');
  const [time, setTime] = useState('');
  const [reason, setReason] = useState('');
  const [hasSource, setHasSource] = useState(false);
  const [source, setSource] = useState(() => inventorySourceDraft(data.storageConditions.asOf));
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const scope = `${data.project.projectId}:${data.project.defaultInventoryId}:${dialog.stockId}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => {
    ++generation.current;
    return () => {
      ++generation.current;
    };
  }, [scope]);
  const stale =
    !stock ||
    (dialog.supersedesId
      ? stock.opening.observationId !== dialog.supersedesId
      : stock.opening.kind === 'opened-observed');
  const title = dialog.supersedesId ? 'Correct opening' : 'Record opening';
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!inventoryCanEdit(status) || stale) return;
    setError(null);
    try {
      if (!value) throw new Error('Choose the opening observation explicitly.');
      if (!reason.trim()) throw new Error('Enter a reason for this opening observation.');
      const fact = {
        id: crypto.randomUUID(),
        stockId: dialog.stockId,
        source: hasSource ? source : null,
        reason: reason.trim(),
      };
      const observedAt = value === 'unobserved' ? null : inventoryObservationTime(timeKind, time);
      let command: InventoryCommand;
      if (dialog.supersedesId)
        command =
          value === 'unobserved'
            ? {
                kind: 'correct-stock-opening',
                ...fact,
                supersedesId: dialog.supersedesId,
                value,
                observedAt: null,
              }
            : {
                kind: 'correct-stock-opening',
                ...fact,
                supersedesId: dialog.supersedesId,
                value: 'opened',
                observedAt,
              };
      else {
        if (value === 'unobserved')
          throw new Error('Unknown status requires correction of a recorded observation.');
        command = { kind: 'record-stock-opening', ...fact, value, observedAt };
      }
      const current = generation.current;
      if (await controller.submit([parseInventoryCommand(command)], title))
        if (current === generation.current && scope === scopeRef.current) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <InventoryPhysicalDialog
      title={title}
      subtitle={stock ? data.state.vessels[stock.vesselId].name : dialog.stockId}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
      disabled={stale}
    >
      <div className="space-y-4" data-testid="inventory-opening-form">
        {stale ? (
          <Notice>
            Opening history changed. Close this form and select the current observation.
          </Notice>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {predecessor ? (
          <Notice>
            Correcting observation {predecessor.id}. The previous record and inherited clocks remain
            retained.
          </Notice>
        ) : (
          <Notice>
            Record first opening of this stock's material. Opening a freezer, empty vessel or plate
            carrier does not open its contents.
          </Notice>
        )}
        <PhysicalField label="Opening observation">
          <Select
            ariaLabel="Opening observation"
            value={value}
            options={[
              { value: '', label: 'Choose an observation' },
              ...(!dialog.supersedesId && stock?.opening.observationId === null
                ? [{ value: 'sealed', label: 'Observed sealed' }]
                : []),
              { value: 'opened', label: 'Observed opened' },
              ...(dialog.supersedesId
                ? [{ value: 'unobserved', label: 'Opening status is unknown' }]
                : []),
            ]}
            onValueChange={(next) => setValue(next as typeof value)}
          />
        </PhysicalField>
        {value === 'unobserved' ? (
          <Notice>
            This retracts the status claim. It does not claim an opening with an unknown time or
            remove the observation chain.
          </Notice>
        ) : (
          <>
            <PhysicalField label="Observation time">
              <Select
                ariaLabel="Observation time"
                value={timeKind}
                options={[
                  { value: 'unknown', label: 'Unknown time' },
                  { value: 'known', label: 'Known UTC time' },
                ]}
                onValueChange={(next) => setTimeKind(next as typeof timeKind)}
              />
            </PhysicalField>
            {timeKind === 'known' ? (
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
          </>
        )}
        <SourceFields
          enabled={hasSource}
          setEnabled={setHasSource}
          source={source}
          setSource={setSource}
        />
        <PhysicalField label="Reason">
          <TextArea
            aria-label="Reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
          />
        </PhysicalField>
      </div>
    </InventoryPhysicalDialog>
  );
}

export function InventoryValidityForm({
  dialog,
  data,
  status,
  controller,
  onClose,
}: Props & { dialog: Extract<InventoryValidityDialog, { kind: 'validity' }> }) {
  const previous = dialog.headId ? data.state.validityFacts[dialog.headId] : undefined;
  const [subject, setSubject] = useState(
    dialog.owner ? ownerKey(dialog.owner) : previous ? ownerKey(previous.owner) : ''
  );
  const owner = previous?.owner ?? parseOwner(subject);
  const target =
    owner?.kind === 'lot'
      ? data.state.lots[owner.lotId]
      : owner
        ? data.state.stocks[owner.stockId]
        : undefined;
  const [kind, setKind] = useState<InventoryValidityRule['kind'] | ''>('');
  const [cutoff, setCutoff] = useState('');
  const [duration, setDuration] = useState('');
  const [unit, setUnit] = useState<InventoryElapsedUnit>('second');
  const [sourceText, setSourceText] = useState(previous?.sourceText ?? '');
  const [precision, setPrecision] = useState<InventoryValiditySourcePrecision>(
    previous?.sourcePrecision ?? 'unknown'
  );
  const [reason, setReason] = useState('');
  const [hasSource, setHasSource] = useState(Boolean(previous?.source));
  const [source, setSource] = useState(
    () => previous?.source ?? inventorySourceDraft(data.storageConditions.asOf)
  );
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const scope = `${data.project.projectId}:${data.project.defaultInventoryId}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => {
    ++generation.current;
    return () => {
      ++generation.current;
    };
  }, [scope]);
  const stale = Boolean(
    dialog.headId &&
    (!previous || inventoryValidityFamilyHead(data.state, previous.rootId)?.id !== dialog.headId)
  );
  const editable = inventoryCanEdit(status);
  const title = dialog.headId ? 'Correct validity rule' : 'Record validity decision';
  const heads =
    target?.validity.kind === 'managed'
      ? target.validity.rootIds.flatMap((rootId) => {
          const fact = inventoryValidityFamilyHead(data.state, rootId);
          return fact ? [fact] : [];
        })
      : [];
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!inventoryCanEdit(status) || stale) return;
    setError(null);
    try {
      if (!owner || !target) throw new Error('Choose the stock or lot that owns this rule.');
      if (!kind) throw new Error('Choose a validity decision explicitly.');
      if (!reason.trim()) throw new Error('Enter an interpretation reason.');
      const rule: InventoryValidityRule =
        kind === 'absolute'
          ? { kind, deadlineAt: inventoryValidityInstant(cutoff) }
          : kind === 'after-opening'
            ? owner.kind === 'stock'
              ? {
                  kind,
                  openingStockId: owner.stockId,
                  elapsedMs: inventoryElapsedMilliseconds(duration, unit),
                }
              : (() => {
                  throw new Error('After-opening rules require an explicit stock owner.');
                })()
            : { kind };
      const fact = {
        id: crypto.randomUUID(),
        rule,
        sourceText,
        sourcePrecision: precision,
        source: hasSource ? source : null,
        reason: reason.trim(),
      };
      const command: InventoryCommand = dialog.headId
        ? { kind: 'correct-validity-decision', ...fact, supersedesId: dialog.headId }
        : { kind: 'record-validity-decision', ...fact, owner };
      const current = generation.current;
      if (await controller.submit([parseInventoryCommand(command)], title))
        if (current === generation.current && scope === scopeRef.current) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <InventoryPhysicalDialog
      title={title}
      subtitle={data.project.name}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={editable ? (event) => void submit(event) : undefined}
      disabled={stale || !target}
    >
      <div className="space-y-4" data-testid="inventory-validity-form">
        <PhysicalField label="Validity owner">
          <Select
            ariaLabel="Validity owner"
            value={owner ? ownerKey(owner) : ''}
            disabled={
              Boolean(dialog.headId) ||
              status.kind === 'submitting' ||
              status.kind === 'outcome-unknown'
            }
            options={[
              { value: '', label: 'Choose a stock or lot' },
              ...Object.values(data.state.stocks).map((stock) => ({
                value: `stock:${stock.id}`,
                label: `Stock: ${data.state.vessels[stock.vesselId].name}`,
              })),
              ...Object.values(data.state.lots).map((lot) => ({
                value: `lot:${lot.id}`,
                label: `Lot: ${lot.name}`,
              })),
            ]}
            onValueChange={(value) => {
              ++generation.current;
              setSubject(value);
              setKind('');
              setCutoff('');
              setDuration('');
              setSourceText('');
              setPrecision('unknown');
              setReason('');
              setHasSource(false);
              setSource(inventorySourceDraft(data.storageConditions.asOf));
              setError(null);
            }}
          />
        </PhysicalField>
        {stale ? (
          <Notice>This rule has a newer correction. Reopen the current family head.</Notice>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {previous ? (
          <>
            <InventoryValidityFactDetails fact={previous} data={data} />
            <Notice>
              This corrects only this family, including descendants that retain it. Other families
              remain independent.
            </Notice>
          </>
        ) : (
          <Notice>
            This adds an independent validity family. It does not replace or clear another rule.
          </Notice>
        )}
        {!previous && heads.length ? (
          <details>
            <summary>Existing rule families ({heads.length})</summary>
            {heads.map((fact) => (
              <InventoryValidityFactDetails key={fact.id} fact={fact} data={data} />
            ))}
          </details>
        ) : null}
        {editable ? (
          <>
            <PhysicalField label="Validity decision">
              <Select
                ariaLabel="Validity decision"
                value={kind}
                options={[
                  { value: '', label: 'Choose a decision' },
                  { value: 'unresolved', label: 'Unresolved interpretation' },
                  { value: 'not-required', label: 'No cutoff required for this rule' },
                  { value: 'absolute', label: 'Explicit cutoff instant' },
                  ...(owner?.kind === 'stock'
                    ? [{ value: 'after-opening', label: 'Elapsed time after first opening' }]
                    : []),
                ]}
                onValueChange={(value) => setKind(value as typeof kind)}
              />
            </PhysicalField>
            {kind === 'absolute' ? (
              <PhysicalField label="Cutoff at (UTC)">
                <TextField
                  aria-label="Cutoff at (UTC)"
                  value={cutoff}
                  onChange={(event) => setCutoff(event.target.value)}
                  placeholder="2026-11-16T12:00:00.000Z"
                  required
                />
              </PhysicalField>
            ) : kind === 'after-opening' ? (
              <div className="grid grid-cols-2 gap-3">
                <PhysicalField label="Elapsed duration">
                  <TextField
                    aria-label="Elapsed duration"
                    inputMode="numeric"
                    value={duration}
                    onChange={(event) => setDuration(event.target.value)}
                    required
                  />
                </PhysicalField>
                <PhysicalField label="Elapsed unit">
                  <Select
                    ariaLabel="Elapsed unit"
                    value={unit}
                    options={Object.entries(INVENTORY_ELAPSED_UNITS).map(([value, definition]) => ({
                      value,
                      label: definition.label,
                    }))}
                    onValueChange={(value) => setUnit(value as InventoryElapsedUnit)}
                  />
                </PhysicalField>
              </div>
            ) : null}
            <PhysicalField label="Original source text">
              <TextArea
                aria-label="Original source text"
                value={sourceText}
                onChange={(event) => setSourceText(event.target.value)}
              />
            </PhysicalField>
            <PhysicalField label="Source precision">
              <Select
                ariaLabel="Source precision"
                value={precision}
                options={['unknown', 'year', 'month', 'date', 'instant', 'elapsed-duration'].map(
                  (value) => ({ value, label: value })
                )}
                onValueChange={(value) => setPrecision(value as InventoryValiditySourcePrecision)}
              />
            </PhysicalField>
            <Notice>
              Printed dates and months are retained as evidence. Choose the intended UTC instant
              explicitly. Elapsed days mean exactly 24 hours; calendar months and years are
              unsupported.
            </Notice>
            <SourceFields
              enabled={hasSource}
              setEnabled={setHasSource}
              source={source}
              setSource={setSource}
            />
            <PhysicalField label="Interpretation reason">
              <TextArea
                aria-label="Interpretation reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                required
              />
            </PhysicalField>
          </>
        ) : null}
      </div>
    </InventoryPhysicalDialog>
  );
}
