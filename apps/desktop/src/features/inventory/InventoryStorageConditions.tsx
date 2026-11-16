import { useState } from 'react';
import {
  inventoryStorageRequirementKey,
  inventoryTemperatureItemKey,
  type InventoryEquipmentTemperatureProjection,
  type InventoryTemperatureAssessment,
  type InventoryTemperatureFreshness,
} from '@waypoint/domain-services';
import { Button, Notice, TextField } from '../../components/ui';
import type { InventoryController, InventoryData } from './inventory-controller';
import { InventorySourceDetails } from './InventoryPhysicalControls';
import type { InventoryItem } from './inventory-view';
import {
  inventoryTemperatureAssessmentLabels,
  inventoryTemperatureFreshnessLabel,
  inventoryTemperatureRangeLabel,
  inventoryTemperatureReasonLabel,
  inventoryThermalRelationshipLabels,
  type InventoryTemperatureDialog,
} from './inventory-temperature-view';

function ThermalRelationship({
  data,
  item,
  view,
  editable,
  onDialog,
}: {
  data: InventoryData;
  item: InventoryItem;
  view?: InventoryEquipmentTemperatureProjection;
  editable: boolean;
  onDialog(dialog: InventoryTemperatureDialog): void;
}) {
  const fact = view?.thermalContext;
  const relationship = fact?.value.kind ?? 'inherit';
  const record =
    item.kind === 'storage' ? data.state.storage[item.id] : data.state.vessels[item.id];
  return (
    <div
      className="space-y-2 rounded border border-border p-3"
      data-testid="inventory-temperature-context"
      data-item-id={item.id}
      data-context-relationship={relationship}
    >
      <h4 className="font-medium">Temperature relationship</h4>
      <p>{inventoryThermalRelationshipLabels[relationship]}</p>
      <p className="text-xs text-fg-muted">
        Evidence and reported settings do not change this relationship.
      </p>
      {fact ? (
        <>
          <p className="text-xs text-fg-muted">
            Recorded {new Date(fact.at).toISOString()} · {fact.reason}
          </p>
          <p className="text-xs text-fg-muted">
            {fact.observedAt === null
              ? 'Observation time unknown'
              : `Observed ${new Date(fact.observedAt).toISOString()}`}
          </p>
          {fact.source ? <InventorySourceDetails source={fact.source} /> : null}
        </>
      ) : (
        <p className="text-xs text-fg-muted">
          No relationship has been recorded; surrounding conditions are inherited.
        </p>
      )}
      <Button
        disabled={!editable || record.lifecycle !== 'active'}
        onClick={() => onDialog({ kind: 'temperature-context', item })}
      >
        Set temperature context
      </Button>
    </div>
  );
}

function Observation({ freshness }: { freshness: InventoryTemperatureFreshness }) {
  return (
    <p className="text-xs text-fg-muted" data-observation-freshness={freshness.state}>
      {freshness.observedAt === null
        ? 'Observation time unknown'
        : `Observed ${new Date(freshness.observedAt).toISOString()}`}
      {' · '}
      {inventoryTemperatureFreshnessLabel(freshness)}
      {freshness.ageMs !== null ? ` · Age ${freshness.ageMs} ms` : ''}
    </p>
  );
}

function Assessment({
  label,
  kind,
  assessment,
}: {
  label: string;
  kind: 'capability' | 'target' | 'qualification';
  assessment: InventoryTemperatureAssessment;
}) {
  return (
    <div
      className="space-y-1 rounded border border-border p-3"
      data-testid={`inventory-temperature-assessment-${kind}`}
      data-assessment-state={assessment.state}
    >
      <h4 className="font-medium">{label}</h4>
      <p>{inventoryTemperatureAssessmentLabels[assessment.state]}</p>
      {assessment.reasons.map((reason) => (
        <p key={reason} data-reason={reason} className="text-xs text-fg-muted">
          {inventoryTemperatureReasonLabel(reason)}
        </p>
      ))}
      {assessment.claimIds.length ? (
        <p className="break-all text-xs text-fg-muted">
          Evidence: {assessment.claimIds.join(', ')}
        </p>
      ) : null}
    </div>
  );
}

function EquipmentFacts({
  data,
  item,
  view,
  editable,
  onDialog,
  showRelationship = false,
}: {
  data: InventoryData;
  item: InventoryItem;
  view?: InventoryEquipmentTemperatureProjection;
  editable: boolean;
  onDialog(dialog: InventoryTemperatureDialog): void;
  showRelationship?: boolean;
}) {
  const record =
    item.kind === 'storage' ? data.state.storage[item.id] : data.state.vessels[item.id];
  const canRecord = editable && record.lifecycle === 'active';
  return (
    <div className="space-y-3" data-testid="inventory-temperature-equipment" data-item-id={item.id}>
      {showRelationship ? (
        <ThermalRelationship
          data={data}
          item={item}
          view={view}
          editable={editable}
          onDialog={onDialog}
        />
      ) : null}
      <div className="space-y-1">
        <h4 className="font-medium">Temperature facts: {record.name}</h4>
        <p data-testid="inventory-temperature-reported-target">
          Operator-reported target:{' '}
          {view?.setpoint?.value.kind === 'known'
            ? `${view.setpoint.value.temperature.value} °C`
            : 'Unknown'}
        </p>
        <>
          {view?.setpoint ? (
            <Observation freshness={view.setpointFreshness} />
          ) : (
            <p className="text-xs text-fg-muted">No operator report recorded.</p>
          )}
        </>
        {view?.setpoint ? (
          <>
            <p className="text-xs text-fg-muted">
              Recorded {new Date(view.setpoint.at).toISOString()} · {view.setpoint.reason}
            </p>
            {view.setpoint.source ? <InventorySourceDetails source={view.setpoint.source} /> : null}
          </>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!canRecord}
          onClick={() => onDialog({ kind: 'temperature-setpoint', item })}
        >
          Report setpoint
        </Button>
        <Button
          disabled={!canRecord}
          onClick={() =>
            onDialog({
              kind: 'temperature-claim',
              item,
              assertion: 'specified-setpoint-range',
            })
          }
        >
          Record operating range
        </Button>
        <Button
          disabled={!canRecord}
          onClick={() =>
            onDialog({
              kind: 'temperature-claim',
              item,
              assertion: 'qualified-envelope',
            })
          }
        >
          Record qualification
        </Button>
      </div>
      <div className="space-y-3" data-testid="inventory-temperature-claims">
        {view?.claims.length ? (
          view.claims.map(({ claim, applicability, freshness }) => (
            <article
              key={claim.id}
              className="space-y-2 rounded border border-border p-3"
              data-claim-id={claim.id}
              data-claim-lifecycle={claim.lifecycle.kind}
              data-applicability={applicability}
            >
              <h5 className="font-medium">
                {claim.assertion.kind === 'qualified-envelope'
                  ? 'Installed qualified envelope'
                  : 'Specified operating range'}
              </h5>
              <p>{inventoryTemperatureRangeLabel(claim.assertion.range)}</p>
              <p className="text-xs">
                Scope:{' '}
                {claim.subject.kind === 'installed'
                  ? `Installed ${claim.subject.item.kind} ${claim.subject.item.id} · Configuration revision ${claim.subject.configurationRevision}`
                  : `Type version ${data.state.typeVersions[claim.subject.versionId]?.name ?? claim.subject.versionId} (${claim.subject.versionId})`}
              </p>
              {claim.assertion.kind === 'qualified-envelope' ? (
                <>
                  <p>Qualification setpoint: {claim.assertion.atSetpoint.value} °C</p>
                  {claim.assertion.scope === undefined ? (
                    <Notice tone="warning">
                      The temperature relationship was not recorded with this qualification. Record
                      a new qualification for the current physical and temperature arrangement.
                    </Notice>
                  ) : null}
                  <p className="whitespace-pre-wrap text-xs">
                    Assumptions: {claim.assertion.assumptions}
                  </p>
                  {claim.installation ? (
                    <details data-testid="inventory-temperature-installation-pin">
                      <summary className="cursor-pointer text-xs text-accent">
                        Saved installed arrangement · {claim.installation.length} physical items
                      </summary>
                      <p className="my-2 text-xs text-fg-muted">
                        Applies to the saved contents and arrangement. Internal moves or physical
                        changes can invalidate it; moving the whole assembly preserves this pin.
                      </p>
                      <div className="space-y-2">
                        {claim.installation.map((entry) => (
                          <div
                            key={inventoryTemperatureItemKey(entry.item)}
                            className="rounded border border-border p-2 text-xs"
                            data-pinned-item-id={entry.item.id}
                          >
                            <p>
                              {entry.item.kind}: {entry.item.id} · Configuration revision{' '}
                              {entry.configurationRevision}
                            </p>
                            <p>
                              Temperature relationship:{' '}
                              {entry.thermalRelationship === null
                                ? 'Unrecorded in the original qualification'
                                : inventoryThermalRelationshipLabels[entry.thermalRelationship]}
                            </p>
                            <pre className="mt-1 whitespace-pre-wrap break-all font-mono">
                              {JSON.stringify(entry, null, 2)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </>
              ) : null}
              <p className="text-xs" data-testid="inventory-temperature-applicability">
                {inventoryTemperatureReasonLabel(applicability)}
              </p>
              <Observation freshness={freshness} />
              <p className="text-xs text-fg-muted">
                Recorded {new Date(claim.at).toISOString()} · {claim.reason}
              </p>
              {claim.source ? (
                <InventorySourceDetails source={claim.source} />
              ) : (
                <p className="text-xs text-fg-muted">No document reference recorded</p>
              )}
              {claim.lifecycle.kind === 'withdrawn' ? (
                <p className="text-xs">
                  Withdrawn {new Date(claim.lifecycle.at).toISOString()}: {claim.lifecycle.reason}
                </p>
              ) : (
                <Button
                  disabled={!editable}
                  onClick={() => onDialog({ kind: 'temperature-withdraw', claimId: claim.id })}
                >
                  Withdraw evidence
                </Button>
              )}
            </article>
          ))
        ) : (
          <p className="text-xs text-fg-muted">
            No operating-range or installed-qualification evidence recorded.
          </p>
        )}
      </div>
    </div>
  );
}

export function InventoryStorageConditions({
  data,
  item,
  stockId,
  editable,
  controller,
  onDialog,
  onOpenItem,
}: {
  data: InventoryData;
  item: InventoryItem;
  stockId?: string;
  editable: boolean;
  controller: InventoryController;
  onDialog(dialog: InventoryTemperatureDialog): void;
  onOpenItem(item: InventoryItem): void;
}) {
  const projection = data.storageConditions;
  const view = projection.equipment[inventoryTemperatureItemKey(item)];
  const stockView = stockId ? projection.stocks[stockId] : undefined;
  const stock = stockId ? data.state.stocks[stockId] : undefined;
  const override = stockId
    ? data.state.storageRequirements[inventoryStorageRequirementKey({ kind: 'stock', id: stockId })]
    : undefined;
  const environment =
    stockView?.environment.kind === 'known' ? stockView.environment.item : undefined;
  const environmentView = environment
    ? projection.equipment[inventoryTemperatureItemKey(environment)]
    : undefined;
  const [maxAge, setMaxAge] = useState(
    projection.freshnessMaxAgeMs === null ? '' : String(projection.freshnessMaxAgeMs)
  );
  const [policyError, setPolicyError] = useState<string | null>(null);
  function applyPolicy() {
    const value = maxAge === '' ? null : Number(maxAge);
    if (value !== null && (!/^\d+$/.test(maxAge) || !Number.isSafeInteger(value))) {
      setPolicyError('Enter a whole number of milliseconds, or leave blank for no age policy.');
      return;
    }
    setPolicyError(null);
    void controller.setStorageFreshnessPolicy(value);
  }
  return (
    <section
      className="space-y-4 rounded border border-border p-3 text-sm"
      data-testid="inventory-storage-conditions"
      data-item-id={item.id}
      data-revision={data.storageConditions.revision}
    >
      <h3 className="font-semibold">Storage temperature</h3>
      <p className="text-xs text-fg-muted">
        Operating range, reported target and installed qualification answer separate questions.
        Temperature comparisons do not establish overall sample suitability or continuous chamber
        conditions.
      </p>
      <ThermalRelationship
        data={data}
        item={item}
        view={view}
        editable={editable}
        onDialog={onDialog}
      />
      {stockView && stock ? (
        <>
          <div
            className="space-y-2"
            data-testid="inventory-temperature-requirement"
            data-requirement-setting={override?.value.kind ?? 'inherit'}
          >
            <h4 className="font-medium">Formulation requirement</h4>
            <p>
              {stockView.requirement.value.kind === 'specified'
                ? inventoryTemperatureRangeLabel(stockView.requirement.value.range)
                : 'Unknown'}
            </p>
            <p className="text-xs text-fg-muted">
              Stock setting:{' '}
              {override?.value.kind === 'specified'
                ? 'Specified range'
                : override?.value.kind === 'unknown'
                  ? 'Explicitly unknown'
                  : 'Inherit lot requirement'}
            </p>
            <p className="text-xs text-fg-muted">
              {stockView.requirement.inheritedFromLotId
                ? `Inherited from lot: ${data.state.lots[stockView.requirement.inheritedFromLotId].name}`
                : inventoryTemperatureReasonLabel(stockView.requirement.reason)}
            </p>
            {stockView.requirement.setting ? (
              <>
                <p className="text-xs text-fg-muted">{stockView.requirement.setting.reason}</p>
                {stockView.requirement.setting.source ? (
                  <InventorySourceDetails source={stockView.requirement.setting.source} />
                ) : null}
              </>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={!editable}
                onClick={() =>
                  onDialog({
                    kind: 'temperature-requirement',
                    target: { kind: 'stock', id: stock.id },
                  })
                }
              >
                Record stock requirement
              </Button>
              {stock.source.kind === 'lot' ? (
                <Button
                  disabled={!editable}
                  onClick={() =>
                    onDialog({
                      kind: 'temperature-requirement',
                      target: {
                        kind: 'lot',
                        id: stock.source.kind === 'lot' ? stock.source.lotId : '',
                      },
                    })
                  }
                >
                  Record lot requirement
                </Button>
              ) : null}
            </div>
          </div>
          <div className="space-y-2" data-testid="inventory-temperature-environment">
            <h4 className="font-medium">Current storage environment</h4>
            {environment ? (
              <Button onClick={() => onOpenItem(environment)}>
                {environment.kind === 'storage'
                  ? data.state.storage[environment.id].name
                  : data.state.vessels[environment.id].name}
              </Button>
            ) : (
              <p>
                Unknown ·{' '}
                {stockView.environment.kind === 'unknown'
                  ? inventoryTemperatureReasonLabel(stockView.environment.reason)
                  : ''}
              </p>
            )}
          </div>
          <div className="grid gap-2">
            <Assessment
              kind="capability"
              label="Specified capability"
              assessment={stockView.capability}
            />
            <Assessment
              kind="target"
              label="Reported target"
              assessment={stockView.reportedTarget}
            />
            <Assessment
              kind="qualification"
              label="Qualified support"
              assessment={stockView.qualifiedSupport}
            />
          </div>
        </>
      ) : null}
      <EquipmentFacts data={data} item={item} view={view} editable={editable} onDialog={onDialog} />
      {environmentView && environment?.id !== item.id ? (
        <details className="space-y-3">
          <summary className="cursor-pointer text-xs text-accent">
            Inspect environment evidence
          </summary>
          <EquipmentFacts
            data={data}
            item={environmentView.item}
            view={environmentView}
            editable={editable}
            onDialog={onDialog}
            showRelationship
          />
        </details>
      ) : null}
      <details className="space-y-3" data-testid="inventory-temperature-freshness-policy">
        <summary className="cursor-pointer text-xs text-accent">
          Observation age policy:{' '}
          {projection.freshnessMaxAgeMs === null
            ? 'none selected'
            : `${projection.freshnessMaxAgeMs} ms`}
        </summary>
        <p className="text-xs text-fg-muted">
          An optional age threshold labels recorded facts. It does not make manual reports live
          measurements. Snapshot: {new Date(projection.asOf).toISOString()}.
        </p>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Maximum observation age (milliseconds; blank means no policy)
          <TextField
            aria-label="Maximum observation age (milliseconds)"
            data-testid="inventory-temperature-max-age"
            value={maxAge}
            onChange={(event) => setMaxAge(event.target.value)}
          />
        </label>
        {policyError ? <Notice tone="error">{policyError}</Notice> : null}
        <Button onClick={applyPolicy}>Apply age policy</Button>
      </details>
    </section>
  );
}
