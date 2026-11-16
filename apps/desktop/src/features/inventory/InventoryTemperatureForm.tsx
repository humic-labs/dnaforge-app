import { useState, type FormEvent } from 'react';
import {
  inventoryStorageRequirementKey,
  inventoryTemperatureItemKey,
  normalizeInventoryTemperature,
  normalizeInventoryTemperatureRange,
  parseInventoryCommand,
  type InventoryTemperatureSubject,
  type InventoryThermalContextValue,
} from '@waypoint/domain-services';
import { Notice, Select, TextArea, TextField } from '../../components/ui';
import type {
  InventoryController,
  InventoryControllerState,
  InventoryData,
} from './inventory-controller';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import { InventoryPhysicalSubjectFields } from './InventoryPhysicalSubjectFields';
import {
  InventorySourceFields,
  PhysicalField,
  inventorySourceDraft,
} from './InventoryPhysicalControls';
import {
  inventoryObservationTime,
  inventoryTemperatureRangeLabel,
  inventoryThermalRelationshipLabels,
  type InventoryTemperatureDialog,
} from './inventory-temperature-view';

export function InventoryTemperatureForm({
  dialog,
  data,
  controller,
  status,
  onClose,
}: {
  dialog: InventoryTemperatureDialog;
  data: InventoryData;
  controller: InventoryController;
  status: InventoryControllerState;
  onClose(): void;
}) {
  const requirement =
    dialog.kind === 'temperature-requirement'
      ? data.state.storageRequirements[inventoryStorageRequirementKey(dialog.target)]
      : undefined;
  const setpoint =
    'item' in dialog
      ? data.state.equipmentSetpoints[inventoryTemperatureItemKey(dialog.item)]
      : undefined;
  const thermalContext =
    dialog.kind === 'temperature-context'
      ? data.state.thermalContexts[inventoryTemperatureItemKey(dialog.item)]
      : undefined;
  const claim =
    dialog.kind === 'temperature-withdraw'
      ? data.state.temperatureClaims[dialog.claimId]
      : undefined;
  const item =
    'item' in dialog
      ? dialog.item.kind === 'storage'
        ? data.state.storage[dialog.item.id]
        : data.state.vessels[dialog.item.id]
      : undefined;
  const initialFact =
    requirement ??
    thermalContext ??
    (dialog.kind === 'temperature-setpoint' ? setpoint : undefined);
  const [relationship, setRelationship] = useState<InventoryThermalContextValue['kind']>(
    thermalContext?.value.kind ?? 'inherit'
  );
  const initialRange =
    requirement?.value.kind === 'specified' ? requirement.value.range : undefined;
  const [mode, setMode] = useState<'inherit' | 'unknown' | 'specified' | 'known'>(
    requirement?.value.kind ??
      (dialog.kind === 'temperature-requirement'
        ? dialog.target.kind === 'stock'
          ? 'inherit'
          : 'unknown'
        : (setpoint?.value.kind ?? 'unknown'))
  );
  const [minimum, setMinimum] = useState(initialRange?.minimum.value ?? '');
  const [maximum, setMaximum] = useState(initialRange?.maximum.value ?? '');
  const [target, setTarget] = useState(
    setpoint?.value.kind === 'known' ? setpoint.value.temperature.value : ''
  );
  const [subject, setSubject] = useState<InventoryTemperatureSubject | null>(
    'item' in dialog && item
      ? { kind: 'installed', item: dialog.item, configurationRevision: item.configuration.revision }
      : null
  );
  const [assumptions, setAssumptions] = useState('');
  const [timeKind, setTimeKind] = useState<'unknown' | 'known'>(
    initialFact?.observedAt != null ? 'known' : 'unknown'
  );
  const [time, setTime] = useState(
    initialFact?.observedAt != null ? new Date(initialFact.observedAt).toISOString() : ''
  );
  const [hasSource, setHasSource] = useState(
    Boolean(initialFact?.source) || dialog.kind === 'temperature-claim'
  );
  const [source, setSource] = useState(
    initialFact?.source ?? inventorySourceDraft(data.storageConditions.asOf)
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const title =
    dialog.kind === 'temperature-requirement'
      ? 'Record temperature requirement'
      : dialog.kind === 'temperature-setpoint'
        ? 'Report equipment setpoint'
        : dialog.kind === 'temperature-context'
          ? 'Record temperature context'
          : dialog.kind === 'temperature-withdraw'
            ? 'Withdraw temperature evidence'
            : dialog.assertion === 'qualified-envelope'
              ? 'Record installed qualification'
              : 'Record specified operating range';
  const subtitle =
    item?.name ??
    (dialog.kind === 'temperature-requirement'
      ? dialog.target.kind === 'lot'
        ? `Lot: ${data.state.lots[dialog.target.id].name}`
        : `Stock: ${data.state.vessels[data.state.stocks[dialog.target.id].vesselId].name}`
      : claim?.id);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const temperature = { value: target, unit: 'C' as const };
      const range = {
        minimum: { value: minimum, unit: 'C' as const },
        maximum: { value: maximum, unit: 'C' as const },
      };
      if (
        dialog.kind === 'temperature-claim' ||
        (dialog.kind === 'temperature-requirement' && mode === 'specified')
      )
        normalizeInventoryTemperatureRange(range);
      if (
        (dialog.kind === 'temperature-setpoint' && mode === 'known') ||
        (dialog.kind === 'temperature-claim' && dialog.assertion === 'qualified-envelope')
      )
        normalizeInventoryTemperature(temperature);
      const fact =
        dialog.kind === 'temperature-withdraw'
          ? null
          : {
              observedAt: inventoryObservationTime(timeKind, time),
              source: hasSource ? source : null,
              reason: reason.trim(),
            };
      let command: unknown;
      if (dialog.kind === 'temperature-withdraw')
        command = {
          kind: 'withdraw-temperature-claim',
          claimId: dialog.claimId,
          reason: reason.trim(),
        };
      else if (dialog.kind === 'temperature-requirement')
        command = {
          kind: 'record-storage-requirement',
          target: dialog.target,
          value: mode === 'specified' ? { kind: 'specified', range } : { kind: mode },
          ...fact,
        };
      else if (dialog.kind === 'temperature-setpoint')
        command = {
          kind: 'record-equipment-setpoint',
          item: dialog.item,
          value: mode === 'known' ? { kind: 'known', temperature } : { kind: 'unknown' },
          ...fact,
        };
      else if (dialog.kind === 'temperature-context')
        command = {
          kind: 'record-thermal-context',
          item: dialog.item,
          value: { kind: relationship },
          ...fact,
        };
      else {
        if (!subject) throw new Error('Choose the exact subject for this evidence.');
        command = {
          kind: 'record-temperature-claim',
          id: crypto.randomUUID(),
          subject,
          assertion:
            dialog.assertion === 'qualified-envelope'
              ? {
                  kind: 'qualified-envelope',
                  scope: 'physical-and-thermal-arrangement',
                  range,
                  atSetpoint: temperature,
                  assumptions: assumptions.trim(),
                }
              : { kind: 'specified-setpoint-range', range },
          ...fact,
        };
      }
      if (await controller.submit([parseInventoryCommand(command)], title)) onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Check the temperature record.');
    }
  }

  return (
    <InventoryPhysicalDialog
      title={title}
      subtitle={subtitle}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
    >
      <div
        className="space-y-4"
        data-testid="inventory-temperature-form"
        data-temperature-action={dialog.kind}
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
        {dialog.kind === 'temperature-context' ? (
          <>
            <Notice>
              Choose how this item's temperature relates to its surroundings. Its own temperature
              control remains separate from reported settings and evidence. Changing or withdrawing
              evidence does not change this relationship.
            </Notice>
            <PhysicalField label="Thermal relationship">
              <Select
                ariaLabel="Thermal relationship"
                value={relationship}
                options={Object.entries(inventoryThermalRelationshipLabels).map(
                  ([value, label]) => ({
                    value,
                    label,
                  })
                )}
                onValueChange={(value) =>
                  setRelationship(value as InventoryThermalContextValue['kind'])
                }
              />
            </PhysicalField>
          </>
        ) : dialog.kind === 'temperature-requirement' ? (
          <>
            <Notice>
              Record the storage requirement for this actual{' '}
              {dialog.target.kind === 'stock' ? 'stock formulation' : 'lot or preparation'}. A
              scientific design does not supply a formulation requirement.
            </Notice>
            <PhysicalField label="Requirement setting">
              <Select
                ariaLabel="Requirement setting"
                value={mode}
                options={[
                  ...(dialog.target.kind === 'stock'
                    ? [{ value: 'inherit', label: 'Inherit lot requirement' }]
                    : []),
                  { value: 'unknown', label: 'Explicitly unknown' },
                  { value: 'specified', label: 'Specified temperature range' },
                ]}
                onValueChange={(value) => setMode(value as typeof mode)}
              />
            </PhysicalField>
          </>
        ) : dialog.kind === 'temperature-setpoint' ? (
          <>
            <Notice>
              This records an operator-reported control setting. It does not control equipment or
              measure chamber temperature.
            </Notice>
            <PhysicalField label="Reported target knowledge">
              <Select
                ariaLabel="Reported target knowledge"
                value={mode}
                options={[
                  { value: 'unknown', label: 'Unknown' },
                  { value: 'known', label: 'Known reported setpoint' },
                ]}
                onValueChange={(value) => setMode(value as typeof mode)}
              />
            </PhysicalField>
          </>
        ) : dialog.kind === 'temperature-claim' ? (
          <>
            <Notice>
              {dialog.assertion === 'qualified-envelope'
                ? 'Record an existing qualification of this exact installed arrangement, including its current physical contents and temperature relationships. Rearranging or changing those contents or relationships can invalidate applicability. The software does not perform the qualification. Its whole temperature envelope must meet a stock requirement.'
                : 'A specified adjustable range describes possible settings. It does not establish the current target or an installed qualification.'}
            </Notice>
            {dialog.assertion === 'specified-setpoint-range' ? (
              <InventoryPhysicalSubjectFields
                data={data}
                label="Evidence subject"
                value={subject}
                onChange={setSubject}
              />
            ) : (
              <p data-testid="inventory-temperature-configuration">
                Exact installed item: {item?.name} · Configuration revision{' '}
                {subject?.kind === 'installed' ? subject.configurationRevision : 'unknown'}
              </p>
            )}
          </>
        ) : claim ? (
          <div className="space-y-2" data-testid="inventory-temperature-withdrawal-subject">
            <p>
              {claim.assertion.kind === 'qualified-envelope'
                ? 'Installed qualification'
                : 'Specified operating range'}{' '}
              · {inventoryTemperatureRangeLabel(claim.assertion.range)}
            </p>
            <p>Evidence ID: {claim.id}</p>
            <Notice>
              Withdrawal keeps the original evidence and records a reason. It does not change stock,
              custody or placement.
            </Notice>
          </div>
        ) : null}
        {dialog.kind === 'temperature-claim' ||
        (dialog.kind === 'temperature-requirement' && mode === 'specified') ? (
          <fieldset className="grid grid-cols-2 gap-3 rounded border border-border p-3">
            <legend className="px-1 text-sm font-semibold">
              Inclusive temperature bounds (°C)
            </legend>
            <PhysicalField label="Minimum temperature (°C)">
              <TextField
                aria-label="Minimum temperature (°C)"
                data-testid="inventory-temperature-minimum"
                value={minimum}
                onChange={(event) => setMinimum(event.target.value)}
                required
              />
            </PhysicalField>
            <PhysicalField label="Maximum temperature (°C)">
              <TextField
                aria-label="Maximum temperature (°C)"
                data-testid="inventory-temperature-maximum"
                value={maximum}
                onChange={(event) => setMaximum(event.target.value)}
                required
              />
            </PhysicalField>
          </fieldset>
        ) : null}
        {(dialog.kind === 'temperature-setpoint' && mode === 'known') ||
        (dialog.kind === 'temperature-claim' && dialog.assertion === 'qualified-envelope') ? (
          <PhysicalField
            label={
              dialog.kind === 'temperature-claim'
                ? 'Qualification setpoint (°C)'
                : 'Reported setpoint (°C)'
            }
          >
            <TextField
              aria-label={
                dialog.kind === 'temperature-claim'
                  ? 'Qualification setpoint (°C)'
                  : 'Reported setpoint (°C)'
              }
              data-testid="inventory-temperature-setpoint"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              required
            />
          </PhysicalField>
        ) : null}
        {dialog.kind === 'temperature-claim' && dialog.assertion === 'qualified-envelope' ? (
          <PhysicalField label="Qualification assumptions">
            <TextArea
              aria-label="Qualification assumptions"
              data-testid="inventory-temperature-assumptions"
              value={assumptions}
              onChange={(event) => setAssumptions(event.target.value)}
              required
            />
          </PhysicalField>
        ) : null}
        {dialog.kind !== 'temperature-withdraw' ? (
          <>
            <PhysicalField label="Observation time knowledge">
              <Select
                ariaLabel="Observation time knowledge"
                value={timeKind}
                options={[
                  { value: 'unknown', label: 'Observation time unknown' },
                  { value: 'known', label: 'Known UTC timestamp' },
                ]}
                onValueChange={(value) => setTimeKind(value as typeof timeKind)}
              />
            </PhysicalField>
            {timeKind === 'known' ? (
              <PhysicalField label="Observation time (UTC)">
                <TextField
                  aria-label="Observation time (UTC)"
                  data-testid="inventory-temperature-observed-at"
                  placeholder="2026-11-16T12:00:00.000Z"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                  required
                />
              </PhysicalField>
            ) : null}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={hasSource}
                onChange={(event) => setHasSource(event.target.checked)}
              />
              Add a source reference
            </label>
            {hasSource ? <InventorySourceFields value={source} onChange={setSource} /> : null}
          </>
        ) : null}
        <PhysicalField label="Reason">
          <TextArea
            aria-label="Reason"
            data-testid="inventory-temperature-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
          />
        </PhysicalField>
      </div>
    </InventoryPhysicalDialog>
  );
}
