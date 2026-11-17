import { useEffect, useState, type FormEvent } from 'react';
import {
  parseInventoryCommand,
  type InventoryAmountUnit,
  type InventoryStockroomCommand,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea, TextField } from '../../components/ui';
import type { InventoryClient, InventoryMaterial } from '../../shared/inventory-client';
import {
  inventoryCanEdit,
  type InventoryController,
  type InventoryControllerState,
  type InventoryData,
} from './inventory-controller';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import { PhysicalField } from './InventoryPhysicalControls';
import {
  inventoryAmountLabel,
  inventoryAmountUnitOptions,
  inventoryBlockerLabel,
  inventoryPrincipalLabel,
} from './inventory-view';
import {
  inventoryStockroomSnapshot,
  inventoryReorderActionLabel,
  inventoryReorderValidityLabel,
} from './inventory-stockroom-view';

export type InventoryStockroomDialog = { kind: 'stockroom' };
type Action =
  | { kind: 'expectation' }
  | { kind: 'allocation'; lineId: string }
  | { kind: 'withdraw'; allocationId: string }
  | { kind: 'close' | 'reopen'; lineId: string }
  | { kind: 'rule' }
  | { kind: 'retire'; ruleId: string };
const titles = {
  expectation: 'Record expected delivery',
  allocation: 'Match received material',
  withdraw: 'Withdraw receipt matching',
  close: 'Close expected remainder',
  reopen: 'Reopen expected delivery',
  rule: 'Record reorder rule',
  retire: 'Retire reorder rule',
} as const;

function StockroomActionForm({
  action,
  data,
  status,
  controller,
  client,
  onClose,
}: {
  action: Action;
  data: InventoryData;
  status: InventoryControllerState;
  controller: InventoryController;
  client: InventoryClient;
  onClose(): void;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [name, setName] = useState('');
  const [supplierKind, setSupplierKind] = useState<'known' | 'unknown'>('unknown');
  const [supplier, setSupplier] = useState('');
  const [materialId, setMaterialId] = useState('');
  const [query, setQuery] = useState('');
  const [materials, setMaterials] = useState<readonly InventoryMaterial[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [quantity, setQuantity] = useState('');
  const report = inventoryStockroomSnapshot(data),
    line = 'lineId' in action ? report?.expectedDeliveries[action.lineId]?.line : undefined;
  const [unit, setUnit] = useState<InventoryAmountUnit>(line?.expectation.quantity.unit ?? 'mg');
  const [componentKey, setComponentKey] = useState('');
  const [reason, setReason] = useState('');
  const [actionBasis, setActionBasis] = useState<'' | 'reserve' | 'withdraw'>('');
  const [validityBasis, setValidityBasis] = useState<
    '' | 'current-recorded-rules' | 'confirmed-current-validity'
  >('');
  const [error, setError] = useState<string | null>(null);
  const editable = inventoryCanEdit(status),
    locked =
      status.kind === 'submitting' ||
      status.kind === 'outcome-unknown' ||
      status.kind === 'committed-refresh-failed';
  const components =
    report?.arrivalComponents.filter(
      (component) =>
        component.materialId === line?.expectation.materialId &&
        component.received.unit === line?.expectation.quantity.unit
    ) ?? [];
  const selected = components.find(
    (component) => JSON.stringify([component.arrivalId, component.componentKey]) === componentKey
  );
  useEffect(() => {
    if (action.kind !== 'expectation' && action.kind !== 'rule') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void client
        .materials({ project: data.project.projectId, query, limit: 100 })
        .then((page) => {
          if (!cancelled) {
            setMaterials(page.items);
            setSearchError(null);
          }
        })
        .catch(() => {
          if (!cancelled) setSearchError('Current scientific records could not be searched.');
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [action.kind, client, data.project.projectId, query]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editable) return;
    setError(null);
    try {
      if (!reason.trim()) throw Error('Enter the reason for this stockroom action.');
      let command: InventoryStockroomCommand;
      if (action.kind === 'expectation') {
        if (!materialId) throw Error('Choose the current scientific material.');
        if (!name.trim()) throw Error('Enter the expected delivery name.');
        if (supplierKind === 'known' && !supplier.trim()) throw Error('Enter the known supplier.');
        command = {
          kind: 'record-expected-delivery',
          id,
          name: name.trim(),
          supplier: supplierKind === 'known' ? supplier.trim() : null,
          externalReference: null,
          materialId,
          quantity: { value: quantity, unit },
          reason: reason.trim(),
        };
      } else if (action.kind === 'allocation') {
        if (!selected) throw Error('Choose an original received component.');
        command = {
          kind: 'allocate-arrival',
          id,
          lineId: action.lineId,
          arrivalId: selected.arrivalId,
          componentKey: selected.componentKey,
          quantity: { value: quantity, unit },
          reason: reason.trim(),
        };
      } else if (action.kind === 'withdraw')
        command = {
          kind: 'withdraw-arrival-allocation',
          allocationId: action.allocationId,
          reason: reason.trim(),
        };
      else if (action.kind === 'close')
        command = {
          kind: 'close-expected-delivery-remainder',
          lineId: action.lineId,
          reason: reason.trim(),
        };
      else if (action.kind === 'reopen')
        command = {
          kind: 'reopen-expected-delivery',
          lineId: action.lineId,
          reason: reason.trim(),
        };
      else if (action.kind === 'retire')
        command = { kind: 'retire-reorder-rule', ruleId: action.ruleId, reason: reason.trim() };
      else {
        if (!materialId) throw Error('Choose the current scientific material.');
        if (!name.trim()) throw Error('Enter the reorder rule name.');
        if (!actionBasis || !validityBasis) throw Error('Choose both reorder policies explicitly.');
        command = {
          kind: 'record-reorder-rule',
          id,
          name: name.trim(),
          materialId,
          threshold: { value: quantity, unit },
          actionBasis,
          validityBasis,
          reason: reason.trim(),
        };
      }
      if (await controller.submit([parseInventoryCommand(command)], titles[action.kind])) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <InventoryPhysicalDialog
      title={titles[action.kind]}
      subtitle={data.project.name}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
      disabled={!editable}
      submitLabel={titles[action.kind]}
    >
      <div className="space-y-4" data-testid="inventory-stockroom-action" data-action={action.kind}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <fieldset disabled={locked || !editable} className="space-y-4">
          {action.kind === 'expectation' || action.kind === 'rule' ? (
            <>
              <PhysicalField
                label={
                  action.kind === 'expectation' ? 'Expected delivery name' : 'Reorder rule name'
                }
              >
                <TextField
                  aria-label={
                    action.kind === 'expectation' ? 'Expected delivery name' : 'Reorder rule name'
                  }
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </PhysicalField>
              <PhysicalField label="Find scientific material">
                <TextField
                  aria-label="Find scientific material"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </PhysicalField>
              {searchError ? <Notice tone="error">{searchError}</Notice> : null}
              <PhysicalField label="Scientific material">
                <Select
                  ariaLabel="Scientific material"
                  value={materialId}
                  options={[
                    { value: '', label: 'Choose current scientific material' },
                    ...materials.map((material) => ({
                      value: material.id,
                      label: material.name,
                      description: material.registryId ?? material.id,
                    })),
                  ]}
                  onValueChange={setMaterialId}
                />
              </PhysicalField>
            </>
          ) : null}
          {action.kind === 'expectation' ? (
            <>
              <PhysicalField label="Supplier knowledge">
                <Select
                  ariaLabel="Supplier knowledge"
                  value={supplierKind}
                  options={[
                    { value: 'unknown', label: 'Supplier unknown or not yet selected' },
                    { value: 'known', label: 'Known supplier' },
                  ]}
                  onValueChange={(value) => setSupplierKind(value as typeof supplierKind)}
                />
              </PhysicalField>
              {supplierKind === 'known' ? (
                <PhysicalField label="Expected supplier">
                  <TextField
                    aria-label="Expected supplier"
                    value={supplier}
                    onChange={(event) => setSupplier(event.target.value)}
                    required
                  />
                </PhysicalField>
              ) : null}
              <Notice>
                This records a local expectation. It creates no stock, sends no order and attaches
                no external purchase-order document.
              </Notice>
            </>
          ) : null}
          {action.kind === 'allocation' ? (
            <>
              <p>Expected line: {line?.name ?? action.lineId}</p>
              <Notice>
                Match the original received amount, independently of current stock remaining.
                Package labels and unresolved vials cannot fulfill an amount expectation.
              </Notice>
              <PhysicalField label="Original received component">
                <Select
                  ariaLabel="Original received component"
                  value={componentKey}
                  options={[
                    { value: '', label: 'Choose an identified original receipt' },
                    ...components.map((component) => {
                      const arrival = data.state.arrivals[component.arrivalId],
                        row = arrival?.components.find(
                          (item) => item.key === component.componentKey
                        );
                      return {
                        value: JSON.stringify([component.arrivalId, component.componentKey]),
                        label: `${arrival?.identity.arrivalId ?? component.arrivalId} · ${row?.label ?? component.componentKey}`,
                        description: `Originally received ${inventoryAmountLabel(component.received)} · Unmatched ${inventoryAmountLabel(component.unmatched)}`,
                      };
                    }),
                  ]}
                  onValueChange={setComponentKey}
                />
              </PhysicalField>
              {selected ? (
                <div data-testid="inventory-allocation-original-balance">
                  <p>Original received amount: {inventoryAmountLabel(selected.received)}</p>
                  <p>Already matched: {inventoryAmountLabel(selected.allocated)}</p>
                  <p>Original amount unmatched: {inventoryAmountLabel(selected.unmatched)}</p>
                </div>
              ) : null}
            </>
          ) : null}
          {action.kind === 'expectation' ||
          action.kind === 'allocation' ||
          action.kind === 'rule' ? (
            <div className="grid grid-cols-2 gap-3">
              <PhysicalField
                label={
                  action.kind === 'rule'
                    ? 'Reorder threshold'
                    : action.kind === 'allocation'
                      ? 'Amount to match'
                      : 'Expected amount'
                }
              >
                <TextField
                  aria-label={
                    action.kind === 'rule'
                      ? 'Reorder threshold'
                      : action.kind === 'allocation'
                        ? 'Amount to match'
                        : 'Expected amount'
                  }
                  inputMode="decimal"
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                  required
                />
              </PhysicalField>
              <PhysicalField label="Amount unit">
                <Select
                  ariaLabel="Amount unit"
                  value={unit}
                  options={inventoryAmountUnitOptions(
                    action.kind === 'allocation' ? line?.expectation.quantity.unit : undefined
                  )}
                  onValueChange={(value) => setUnit(value as InventoryAmountUnit)}
                />
              </PhysicalField>
            </div>
          ) : null}
          {action.kind === 'rule' ? (
            <>
              <PhysicalField label="Reorder action basis">
                <Select
                  ariaLabel="Reorder action basis"
                  value={actionBasis}
                  options={[
                    { value: '', label: 'Choose which action stock must support' },
                    { value: 'reserve', label: inventoryReorderActionLabel.reserve },
                    { value: 'withdraw', label: inventoryReorderActionLabel.withdraw },
                  ]}
                  onValueChange={(value) => setActionBasis(value as typeof actionBasis)}
                />
              </PhysicalField>
              <PhysicalField label="Reorder validity basis">
                <Select
                  ariaLabel="Reorder validity basis"
                  value={validityBasis}
                  options={[
                    { value: '', label: 'Choose the validity coverage policy' },
                    {
                      value: 'current-recorded-rules',
                      label: inventoryReorderValidityLabel['current-recorded-rules'],
                    },
                    {
                      value: 'confirmed-current-validity',
                      label: inventoryReorderValidityLabel['confirmed-current-validity'],
                    },
                  ]}
                  onValueChange={(value) => setValidityBasis(value as typeof validityBasis)}
                />
              </PhysicalField>
              <Notice>
                Expected deliveries never enter this subtotal. Compatible free stock, active holds,
                unknown quantities and exclusions are classified by the native owner.
              </Notice>
            </>
          ) : null}
          {action.kind === 'close' ? (
            <Notice>
              Close the positive unreceived remainder. This does not mark it received or change
              physical stock.
            </Notice>
          ) : null}
          {action.kind === 'reopen' ? (
            <Notice>
              Reopen matching corrections explicitly. This creates no stock and sends no order.
            </Notice>
          ) : null}
          {action.kind === 'withdraw' ? (
            <Notice>
              Withdraw only this receipt allocation. Original arrivals and current stock quantities
              remain unchanged.
            </Notice>
          ) : null}
          <PhysicalField label="Reason">
            <TextArea
              aria-label="Reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
            />
          </PhysicalField>
        </fieldset>
      </div>
    </InventoryPhysicalDialog>
  );
}

export function InventoryStockroomForm({
  data,
  status,
  controller,
  client,
  onClose,
}: {
  data: InventoryData;
  status: InventoryControllerState;
  controller: InventoryController;
  client: InventoryClient;
  onClose(): void;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const report = inventoryStockroomSnapshot(data),
    editable = inventoryCanEdit(status);
  if (action)
    return (
      <StockroomActionForm
        key={JSON.stringify(action)}
        action={action}
        data={data}
        status={status}
        controller={controller}
        client={client}
        onClose={onClose}
      />
    );
  return (
    <InventoryPhysicalDialog
      title="Stockroom"
      subtitle={data.project.name}
      controller={controller}
      status={status}
      onClose={onClose}
    >
      <div className="space-y-5" data-testid="inventory-stockroom">
        <p className="text-sm">
          Expectations, original receipt matching and current usable-stock reporting are separate
          records. An expectation never adds on-hand stock.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={!editable} onClick={() => setAction({ kind: 'expectation' })}>
            Record expected delivery
          </Button>
          <Button disabled={!editable} onClick={() => setAction({ kind: 'rule' })}>
            Record reorder rule
          </Button>
          <Button onClick={() => void controller.refresh()}>Refresh stockroom</Button>
        </div>
        {!report ? (
          <Notice>
            Stockroom projection is unavailable or stale. Refresh before matching receipts or using
            this report.
          </Notice>
        ) : (
          <>
            <section
              className="space-y-1 text-xs"
              data-stockroom-as-of={report.asOf}
              data-stockroom-revision={report.revision}
            >
              <p>Native observation time: {new Date(report.asOf).toISOString()}</p>
              <p className="break-all">
                Project: {report.projectId} · Inventory: {report.inventoryId} · Revision:{' '}
                {report.revision}
              </p>
              <p>Observed for: {inventoryPrincipalLabel(report.principal, report.principal)}</p>
            </section>
            <section className="space-y-3">
              <h3 className="font-semibold">Expected deliveries</h3>
              {Object.keys(report.expectedDeliveries).length ? (
                Object.values(report.expectedDeliveries).map((progress) => {
                  const line = progress.line,
                    open = line.lifecycle.kind === 'open';
                  return (
                    <article
                      key={line.id}
                      className="space-y-2 rounded border border-border p-3"
                      data-expected-line={line.id}
                      data-received-progress={progress.progress}
                    >
                      <h4 className="font-semibold">{line.name}</h4>
                      <p>Expected amount: {inventoryAmountLabel(line.expectation.quantity)}</p>
                      <p>
                        Originally received and matched: {inventoryAmountLabel(progress.allocated)}
                      </p>
                      <p>Unreceived remainder: {inventoryAmountLabel(progress.remaining)}</p>
                      <p>Receipt progress: {progress.progress}</p>
                      <p>Lifecycle: {open ? 'Open' : 'Unreceived remainder closed'}</p>
                      {line.lifecycle.kind === 'remainder-closed' ? (
                        <p>
                          Remainder at close:{' '}
                          {inventoryAmountLabel(line.lifecycle.remainingAtClose)} ·{' '}
                          {line.lifecycle.reason}
                        </p>
                      ) : null}
                      <p className="text-xs">
                        Supplier: {line.supplier ?? 'Unknown'} · {line.reason}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          disabled={!editable || !open || progress.progress === 'fully-received'}
                          onClick={() => setAction({ kind: 'allocation', lineId: line.id })}
                        >
                          Match received material
                        </Button>
                        {open ? (
                          <Button
                            disabled={!editable || progress.remaining.value === '0'}
                            onClick={() => setAction({ kind: 'close', lineId: line.id })}
                          >
                            Close unreceived remainder
                          </Button>
                        ) : (
                          <Button
                            disabled={!editable}
                            onClick={() => setAction({ kind: 'reopen', lineId: line.id })}
                          >
                            Reopen expected delivery
                          </Button>
                        )}
                      </div>
                      {Object.values(data.state.arrivalAllocations)
                        .filter((allocation) => allocation.lineId === line.id)
                        .map((allocation) => (
                          <div
                            key={allocation.id}
                            data-allocation-id={allocation.id}
                            className="space-y-1 border-t border-border pt-2 text-xs"
                          >
                            <p>
                              Receipt match: {inventoryAmountLabel(allocation.quantity)} ·{' '}
                              {allocation.lifecycle.kind}
                            </p>
                            <p className="break-all">
                              Arrival: {allocation.arrivalId} · Component: {allocation.componentKey}
                            </p>
                            <p>{allocation.reason}</p>
                            {allocation.lifecycle.kind === 'active' ? (
                              <Button
                                disabled={!editable || !open}
                                onClick={() =>
                                  setAction({ kind: 'withdraw', allocationId: allocation.id })
                                }
                              >
                                Withdraw receipt matching
                              </Button>
                            ) : (
                              <p>Withdrawal: {allocation.lifecycle.reason}</p>
                            )}
                          </div>
                        ))}
                    </article>
                  );
                })
              ) : (
                <p className="text-xs">No expected deliveries recorded.</p>
              )}
            </section>
            <section className="space-y-3">
              <h3 className="font-semibold">Native reorder report</h3>
              {Object.keys(report.reorderRules).length ? (
                Object.values(report.reorderRules).map((result) => {
                  const rule = result.kind === 'ready' ? result.assessment.rule : result.rule;
                  return (
                    <article
                      key={rule.id}
                      className="space-y-2 rounded border border-border p-3"
                      data-reorder-rule={rule.id}
                      data-reorder-conclusion={
                        result.kind === 'ready' ? result.assessment.conclusion : result.kind
                      }
                    >
                      <h4 className="font-semibold">{rule.name}</h4>
                      <p>Threshold: {inventoryAmountLabel(rule.threshold)}</p>
                      <p>Action basis: {inventoryReorderActionLabel[rule.actionBasis]}</p>
                      <p>Validity basis: {inventoryReorderValidityLabel[rule.validityBasis]}</p>
                      {result.kind === 'unavailable' ? (
                        <Notice tone="error">
                          {result.code}: {result.message}
                        </Notice>
                      ) : result.kind === 'retired' ? (
                        <Notice>This rule is retired.</Notice>
                      ) : (
                        <>
                          <p data-known-free-quantity>
                            Known free stock{' '}
                            {result.assessment.knownUnreservedKind === 'at-least'
                              ? 'lower bound'
                              : 'subtotal'}
                            : {inventoryAmountLabel(result.assessment.knownUnreserved)}
                          </p>
                          <p>
                            Conclusion:{' '}
                            {result.assessment.conclusion === 'needs-measurement'
                              ? 'Needs measurement'
                              : result.assessment.conclusion === 'adequate'
                                ? 'Adequate'
                                : 'Low under the selected rule policies'}
                          </p>
                          <p className="text-xs">
                            Eligible unknown amounts:{' '}
                            {result.assessment.unknownIncludedStockIds.length} · Incompatible
                            dimension: {result.assessment.incompatibleStockIds.length}
                          </p>
                          {result.assessment.legacyOrMixedValidityStockIds.length ? (
                            <Notice>
                              Some stock has untracked or mixed validity. Current recorded rules do
                              not prove all material unexpired.
                            </Notice>
                          ) : null}
                          <p className="text-xs">
                            Next native refresh boundary:{' '}
                            {result.assessment.nextBoundaryAt === null
                              ? 'None'
                              : new Date(result.assessment.nextBoundaryAt).toISOString()}
                          </p>
                          <details>
                            <summary className="text-xs">
                              Included, unknown and excluded stock
                            </summary>
                            <p className="break-all text-xs">
                              Known included:{' '}
                              {result.assessment.knownIncludedStockIds.join(', ') || 'None'}
                            </p>
                            <p className="break-all text-xs">
                              Eligible unknown:{' '}
                              {result.assessment.unknownIncludedStockIds.join(', ') || 'None'}
                            </p>
                            <p className="break-all text-xs">
                              Other dimensions:{' '}
                              {result.assessment.incompatibleStockIds.join(', ') || 'None'}
                            </p>
                            {result.assessment.excluded.map((exclusion) => (
                              <div key={exclusion.stockId} className="space-y-1 text-xs">
                                <p className="break-all">{exclusion.stockId}</p>
                                {exclusion.coverageReason ? (
                                  <p>Validity coverage not confirmed for this rule.</p>
                                ) : null}
                                {exclusion.blockers.map((blocker, index) => (
                                  <p key={index}>{inventoryBlockerLabel(blocker, data.state)}</p>
                                ))}
                              </div>
                            ))}
                          </details>
                        </>
                      )}
                      {rule.lifecycle.kind === 'active' ? (
                        <Button
                          disabled={!editable}
                          onClick={() => setAction({ kind: 'retire', ruleId: rule.id })}
                        >
                          Retire reorder rule
                        </Button>
                      ) : null}
                    </article>
                  );
                })
              ) : (
                <p className="text-xs">No reorder rules configured.</p>
              )}
            </section>
          </>
        )}
      </div>
    </InventoryPhysicalDialog>
  );
}
