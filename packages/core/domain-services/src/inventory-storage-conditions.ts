import type {
  InventoryCommand,
  InventoryState,
  InventoryPhysicalItem,
  InventoryExecutionContext,
  InventoryTransition,
  InventoryTemperatureClaim,
  InventoryTemperatureClaimProjection,
  InventoryEquipmentSetpoint,
  InventoryStorageRequirement,
  InventoryStorageRequirementTarget,
  InventoryTemperatureRange,
  InventoryTemperatureAssessment,
  InventoryStockTemperatureProjection,
  InventoryEquipmentTemperatureProjection,
  InventoryStorageConditionsProjection,
  InventoryTemperatureInstallationEntry,
  InventoryThermalContext,
} from './inventory-types';
import { inventoryRecordIdExists } from './inventory-identity';
import { inventoryEffectiveGeometry } from './inventory-configuration';
import { inventoryEffectiveCustody } from './inventory-custody';
import {
  compareInventoryTemperatures,
  inventoryTemperatureFreshness,
  normalizeInventoryTemperature,
  normalizeInventoryTemperatureRange,
} from './inventory-temperature';

type Failure = Extract<InventoryTransition, { ok: false }>;
type Draft = Omit<
  InventoryState,
  | 'schema'
  | 'revision'
  | 'temperatureClaims'
  | 'equipmentSetpoints'
  | 'storageRequirements'
  | 'thermalContexts'
> & {
  readonly thermalContexts: Record<string, InventoryThermalContext>;
  readonly temperatureClaims: Record<string, InventoryTemperatureClaim>;
  readonly equipmentSetpoints: Record<string, InventoryEquipmentSetpoint>;
  readonly storageRequirements: Record<string, InventoryStorageRequirement>;
};
const refuse = (code: Failure['code'], message: string): Failure => ({ ok: false, code, message });
const record = (state: Pick<InventoryState, 'storage' | 'vessels'>, item: InventoryPhysicalItem) =>
  item.kind === 'storage' ? state.storage[item.id] : state.vessels[item.id];

export function inventoryTemperatureItemKey(item: InventoryPhysicalItem): string {
  return `${item.kind}:${item.id}`;
}
export function inventoryStorageRequirementKey(target: InventoryStorageRequirementTarget): string {
  return `${target.kind}:${target.id}`;
}
function installationSnapshot(
  state: Pick<
    InventoryState,
    'storage' | 'vessels' | 'typeVersions' | 'recipeVersions' | 'fitEvidence' | 'thermalContexts'
  >,
  root: InventoryPhysicalItem,
  includeThermalRelationship = true
): readonly InventoryTemperatureInstallationEntry[] {
  const entries: InventoryTemperatureInstallationEntry[] = [];
  const pending = [root];
  const visited = new Set<string>();
  const children = new Map<string, InventoryPhysicalItem[]>();
  for (const item of [
    ...Object.keys(state.storage).map((id) => ({ kind: 'storage' as const, id })),
    ...Object.keys(state.vessels).map((id) => ({ kind: 'vessel' as const, id })),
  ]) {
    const placement = record(state, item)!.placement;
    if (placement.kind !== 'located') continue;
    const siblings = children.get(placement.storageId) ?? [];
    siblings.push(item);
    children.set(placement.storageId, siblings);
  }
  for (const siblings of children.values())
    siblings.sort((a, b) =>
      inventoryTemperatureItemKey(a) < inventoryTemperatureItemKey(b) ? -1 : 1
    );
  for (let index = 0; index < pending.length; index++) {
    const item = pending[index],
      key = inventoryTemperatureItemKey(item);
    if (visited.has(key))
      throw new TypeError('A qualification installation cannot contain a cycle.');
    visited.add(key);
    const row = record(state, item)!;
    entries.push({
      item: { ...item },
      configurationRevision: row.configuration.revision,
      typeVersionId: row.configuration.typeVersionId,
      geometry: inventoryEffectiveGeometry(state, item),
      orientation: structuredClone(row.configuration.orientation),
      unavailablePositionIds: Object.keys(row.configuration.unavailablePositions).sort(),
      layout: item.kind === 'storage' ? structuredClone(state.storage[item.id].layout) : null,
      limits: item.kind === 'vessel' ? structuredClone(state.vessels[item.id].limits) : null,
      placement:
        index === 0
          ? { kind: 'root' }
          : (structuredClone(row.placement) as InventoryTemperatureInstallationEntry['placement']),
      lifecycle: row.lifecycle,
      thermalRelationship: includeThermalRelationship
        ? (state.thermalContexts[key]?.value.kind ?? 'inherit')
        : null,
    });
    if (item.kind === 'storage') {
      for (const child of children.get(item.id) ?? []) pending.push(child);
    }
  }
  return entries;
}

export function applyInventoryTemperatureCommand(
  state: Draft,
  command: InventoryCommand,
  context: InventoryExecutionContext | undefined
): Failure | null | undefined {
  if (
    ![
      'record-temperature-claim',
      'withdraw-temperature-claim',
      'record-equipment-setpoint',
      'record-storage-requirement',
      'record-thermal-context',
    ].includes(command.kind)
  )
    return undefined;
  if (!context)
    return refuse('CONTEXT_REQUIRED', 'Temperature facts require trusted actor and clock context.');
  if (command.kind === 'record-thermal-context') {
    if (!record(state, command.item))
      return refuse(
        command.item.kind === 'storage' ? 'STORAGE_NOT_FOUND' : 'VESSEL_NOT_FOUND',
        'The thermal context item does not exist.'
      );
    state.thermalContexts[inventoryTemperatureItemKey(command.item)] = {
      item: { ...command.item },
      value: { ...command.value },
      observedAt: command.observedAt,
      source: structuredClone(command.source),
      reason: command.reason,
      at: context.at,
      by: { ...context.principal },
    };
    return null;
  }
  if (command.kind === 'withdraw-temperature-claim') {
    const claim = state.temperatureClaims[command.claimId];
    if (!claim)
      return refuse('TEMPERATURE_CLAIM_NOT_FOUND', 'The temperature claim does not exist.');
    if (claim.lifecycle.kind === 'withdrawn')
      return refuse('TEMPERATURE_CLAIM_WITHDRAWN', 'The temperature claim is already withdrawn.');
    state.temperatureClaims[claim.id] = {
      ...claim,
      lifecycle: {
        kind: 'withdrawn',
        at: context.at,
        by: { ...context.principal },
        reason: command.reason,
      },
    };
    return null;
  }
  if (command.kind === 'record-equipment-setpoint') {
    if (!record(state, command.item))
      return refuse(
        command.item.kind === 'storage' ? 'STORAGE_NOT_FOUND' : 'VESSEL_NOT_FOUND',
        'The reported equipment does not exist.'
      );
    state.equipmentSetpoints[inventoryTemperatureItemKey(command.item)] = {
      item: { ...command.item },
      value:
        command.value.kind === 'known'
          ? { kind: 'known', temperature: normalizeInventoryTemperature(command.value.temperature) }
          : { kind: 'unknown' },
      observedAt: command.observedAt,
      source: structuredClone(command.source),
      reason: command.reason,
      at: context.at,
      by: { ...context.principal },
    };
    return null;
  }
  if (command.kind === 'record-storage-requirement') {
    const exists =
      command.target.kind === 'stock'
        ? state.stocks[command.target.id]
        : state.lots[command.target.id];
    if (!exists)
      return refuse(
        command.target.kind === 'stock' ? 'STOCK_NOT_FOUND' : 'LOT_NOT_FOUND',
        'The storage requirement target does not exist.'
      );
    if (command.target.kind === 'lot' && command.value.kind === 'inherit')
      return refuse(
        'INVALID_INVENTORY_INPUT',
        'A lot requirement is unknown or specified; only stock can inherit.'
      );
    state.storageRequirements[inventoryStorageRequirementKey(command.target)] = {
      target: { ...command.target },
      value:
        command.value.kind === 'specified'
          ? { kind: 'specified', range: normalizeInventoryTemperatureRange(command.value.range) }
          : { ...command.value },
      observedAt: command.observedAt,
      source: structuredClone(command.source),
      reason: command.reason,
      at: context.at,
      by: { ...context.principal },
    };
    return null;
  }
  if (command.kind !== 'record-temperature-claim') return undefined;
  if (inventoryRecordIdExists(state, command.id))
    return refuse('ID_ALREADY_EXISTS', 'That inventory identifier already exists.');
  if (command.subject.kind === 'type-version') {
    if (!state.typeVersions[command.subject.versionId])
      return refuse(
        'TEMPERATURE_SCOPE_CONFLICT',
        'The claimed physical type version does not exist.'
      );
    if (command.assertion.kind === 'qualified-envelope')
      return refuse(
        'TEMPERATURE_SCOPE_CONFLICT',
        'A qualification must identify an exact installed configuration.'
      );
  } else {
    const item = record(state, command.subject.item);
    if (!item)
      return refuse(
        command.subject.item.kind === 'storage' ? 'STORAGE_NOT_FOUND' : 'VESSEL_NOT_FOUND',
        'The claimed installation does not exist.'
      );
    if (item.configuration.revision !== command.subject.configurationRevision)
      return refuse(
        'TEMPERATURE_SCOPE_CONFLICT',
        'The temperature claim must pin the current installed physical revision.'
      );
  }
  state.temperatureClaims[command.id] = {
    id: command.id,
    subject: structuredClone(command.subject),
    assertion:
      command.assertion.kind === 'qualified-envelope'
        ? {
            ...command.assertion,
            range: normalizeInventoryTemperatureRange(command.assertion.range),
            atSetpoint: normalizeInventoryTemperature(command.assertion.atSetpoint),
          }
        : {
            kind: 'specified-setpoint-range',
            range: normalizeInventoryTemperatureRange(command.assertion.range),
          },
    installation:
      command.assertion.kind === 'qualified-envelope' && command.subject.kind === 'installed'
        ? installationSnapshot(
            state,
            command.subject.item,
            command.assertion.scope === 'physical-and-thermal-arrangement'
          )
        : null,
    observedAt: command.observedAt,
    source: structuredClone(command.source),
    reason: command.reason,
    at: context.at,
    by: { ...context.principal },
    lifecycle: { kind: 'active' },
  };
  return null;
}

function claimScopeMatches(
  state: InventoryState,
  claim: InventoryTemperatureClaim,
  item: InventoryPhysicalItem
): boolean {
  const row = record(state, item)!;
  return claim.subject.kind === 'type-version'
    ? claim.subject.versionId === row.configuration.typeVersionId
    : inventoryTemperatureItemKey(claim.subject.item) === inventoryTemperatureItemKey(item);
}
function applicability(
  state: InventoryState,
  claim: InventoryTemperatureClaim,
  item: InventoryPhysicalItem
): InventoryTemperatureClaimProjection['applicability'] {
  if (claim.lifecycle.kind === 'withdrawn') return 'withdrawn';
  if (
    claim.subject.kind === 'installed' &&
    claim.subject.configurationRevision !== record(state, item)!.configuration.revision
  )
    return 'configuration-changed';
  if (claim.assertion.kind === 'qualified-envelope') {
    if (JSON.stringify(claim.installation) !== JSON.stringify(installationSnapshot(state, item)))
      return 'configuration-changed';
    const setpoint = state.equipmentSetpoints[inventoryTemperatureItemKey(item)];
    if (!setpoint || setpoint.value.kind === 'unknown') return 'setpoint-unknown';
    if (compareInventoryTemperatures(setpoint.value.temperature, claim.assertion.atSetpoint) !== 0)
      return 'setpoint-changed';
  }
  return 'applicable';
}
function stockRequirement(
  state: InventoryState,
  stockId: string
): InventoryStockTemperatureProjection['requirement'] {
  const stock = state.stocks[stockId];
  const own =
    state.storageRequirements[inventoryStorageRequirementKey({ kind: 'stock', id: stockId })];
  if (own && own.value.kind !== 'inherit')
    return {
      value: structuredClone(own.value),
      setting: structuredClone(own),
      inheritedFromLotId: null,
      reason: 'stock-override',
    };
  if (stock.source.kind === 'unattributed')
    return {
      value: { kind: 'unknown' },
      setting: null,
      inheritedFromLotId: null,
      reason: 'unattributed',
    };
  const inherited =
    state.storageRequirements[
      inventoryStorageRequirementKey({ kind: 'lot', id: stock.source.lotId })
    ];
  return {
    value:
      inherited?.value.kind === 'specified'
        ? structuredClone(inherited.value)
        : { kind: 'unknown' },
    setting: inherited ? structuredClone(inherited) : null,
    inheritedFromLotId: stock.source.lotId,
    reason: inherited?.value.kind === 'specified' ? 'lot-inheritance' : 'lot-unknown',
  };
}
function environment(
  state: InventoryState,
  equipment: InventoryStorageConditionsProjection['equipment'],
  item: InventoryPhysicalItem
): InventoryStockTemperatureProjection['environment'] {
  if (record(state, item)?.lifecycle === 'disposed') return { kind: 'unknown', reason: 'disposed' };
  if (inventoryEffectiveCustody(state, item).state.kind !== 'available')
    return { kind: 'unknown', reason: 'custody-unavailable' };
  let cursor = item;
  const visited = new Set<string>();
  while (!visited.has(inventoryTemperatureItemKey(cursor))) {
    visited.add(inventoryTemperatureItemKey(cursor));
    const relationship =
      equipment[inventoryTemperatureItemKey(cursor)]?.thermalContext?.value.kind ?? 'inherit';
    if (relationship === 'self') return { kind: 'known', item: { ...cursor } };
    if (relationship === 'unknown') return { kind: 'unknown', reason: 'thermal-context-unknown' };
    const row = record(state, cursor);
    if (!row || row.placement.kind !== 'located') break;
    cursor = { kind: 'storage', id: row.placement.storageId };
  }
  return { kind: 'unknown', reason: 'no-thermal-context' };
}
const assessment = (
  state: InventoryTemperatureAssessment['state'],
  reasons: readonly string[],
  claimIds: readonly string[] = []
): InventoryTemperatureAssessment => ({ state, reasons, claimIds });
function overlaps(first: InventoryTemperatureRange, second: InventoryTemperatureRange): boolean {
  return (
    compareInventoryTemperatures(first.maximum, second.minimum) >= 0 &&
    compareInventoryTemperatures(first.minimum, second.maximum) <= 0
  );
}
function inside(inner: InventoryTemperatureRange, outer: InventoryTemperatureRange): boolean {
  return (
    compareInventoryTemperatures(inner.minimum, outer.minimum) >= 0 &&
    compareInventoryTemperatures(inner.maximum, outer.maximum) <= 0
  );
}
function claimAssessment(
  claims: readonly InventoryTemperatureClaimProjection[],
  kind: 'specified-setpoint-range' | 'qualified-envelope',
  required: InventoryTemperatureRange
): InventoryTemperatureAssessment {
  let selected = claims
    .filter((entry) => entry.applicability === 'applicable' && entry.claim.assertion.kind === kind)
    .map((entry) => entry.claim);
  const installed = selected.filter((claim) => claim.subject.kind === 'installed');
  if (installed.length) selected = installed;
  if (!selected.length)
    return assessment('unknown', [
      kind === 'specified-setpoint-range'
        ? 'NO_APPLICABLE_SPECIFIED_RANGE'
        : 'NO_APPLICABLE_INSTALLED_QUALIFICATION',
    ]);
  const ids = selected.map((claim) => claim.id);
  const definitions = new Set(
    selected.map((claim) =>
      JSON.stringify({
        range: normalizeInventoryTemperatureRange(claim.assertion.range),
        ...(claim.assertion.kind === 'qualified-envelope'
          ? {
              atSetpoint: normalizeInventoryTemperature(claim.assertion.atSetpoint),
              assumptions: claim.assertion.assumptions,
            }
          : {}),
      })
    )
  );
  if (definitions.size > 1)
    return assessment('conflicting', ['CONFLICTING_EQUAL_SCOPE_CLAIMS'], ids);
  const range = selected[0].assertion.range;
  const supports =
    kind === 'specified-setpoint-range' ? overlaps(range, required) : inside(range, required);
  return assessment(
    supports ? 'supported' : 'incompatible',
    [
      kind === 'specified-setpoint-range'
        ? supports
          ? 'POSSIBLE_SPECIFIED_SETPOINT_ONLY'
          : 'NO_SPECIFIED_SETPOINT_MEETS_REQUIREMENT'
        : supports
          ? 'WHOLE_QUALIFIED_ENVELOPE_WITHIN_REQUIREMENT'
          : 'QUALIFIED_ENVELOPE_EXCEEDS_REQUIREMENT',
      ...(installed.length && kind === 'specified-setpoint-range'
        ? ['INSTALLED_CLAIMS_OVERRIDE_TYPE_DEFAULTS']
        : []),
    ],
    ids
  );
}
export function inventoryStorageConditionsProjection(
  state: InventoryState,
  options: { readonly asOf: number; readonly freshnessMaxAgeMs: number | null }
): InventoryStorageConditionsProjection {
  inventoryTemperatureFreshness(null, options.asOf, options.freshnessMaxAgeMs);
  const equipment = Object.create(null) as Record<string, InventoryEquipmentTemperatureProjection>;
  for (const item of [
    ...Object.keys(state.storage).map((id) => ({ kind: 'storage' as const, id })),
    ...Object.keys(state.vessels).map((id) => ({ kind: 'vessel' as const, id })),
  ]) {
    const key = inventoryTemperatureItemKey(item);
    const setpoint = state.equipmentSetpoints[key] ?? null;
    const thermalContext = state.thermalContexts[key] ?? null;
    const claims = Object.values(state.temperatureClaims)
      .filter((claim) => claimScopeMatches(state, claim, item))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((claim) => ({
        claim: structuredClone(claim),
        applicability: applicability(state, claim, item),
        freshness: inventoryTemperatureFreshness(
          claim.observedAt,
          options.asOf,
          options.freshnessMaxAgeMs
        ),
      }));
    if (setpoint || claims.length || thermalContext)
      equipment[key] = {
        item: { ...item },
        thermalContext: thermalContext ? structuredClone(thermalContext) : null,
        setpoint: setpoint ? structuredClone(setpoint) : null,
        setpointFreshness: inventoryTemperatureFreshness(
          setpoint?.observedAt ?? null,
          options.asOf,
          options.freshnessMaxAgeMs
        ),
        claims,
      };
  }
  const stocks = Object.create(null) as Record<string, InventoryStockTemperatureProjection>;
  for (const stock of Object.values(state.stocks)) {
    const requirement = stockRequirement(state, stock.id);
    const context = environment(state, equipment, { kind: 'vessel', id: stock.vesselId });
    let capability: InventoryTemperatureAssessment,
      reportedTarget: InventoryTemperatureAssessment,
      qualifiedSupport: InventoryTemperatureAssessment;
    if (requirement.value.kind === 'unknown' || context.kind === 'unknown') {
      const reasons = [
        ...(requirement.value.kind === 'unknown' ? ['STORAGE_REQUIREMENT_UNKNOWN'] : []),
        ...(context.kind === 'unknown'
          ? [`ENVIRONMENT_${context.reason.toUpperCase().replaceAll('-', '_')}`]
          : []),
      ];
      capability = assessment('unknown', [...reasons]);
      reportedTarget = assessment('unknown', [...reasons]);
      qualifiedSupport = assessment('unknown', [...reasons]);
    } else {
      const facts = equipment[inventoryTemperatureItemKey(context.item)];
      capability = claimAssessment(
        facts.claims,
        'specified-setpoint-range',
        requirement.value.range
      );
      qualifiedSupport = claimAssessment(
        facts.claims,
        'qualified-envelope',
        requirement.value.range
      );
      const value = facts.setpoint?.value;
      if (!value || value.kind === 'unknown')
        reportedTarget = assessment('unknown', ['REPORTED_SETPOINT_UNKNOWN']);
      else {
        const supported =
          compareInventoryTemperatures(value.temperature, requirement.value.range.minimum) >= 0 &&
          compareInventoryTemperatures(value.temperature, requirement.value.range.maximum) <= 0;
        reportedTarget = assessment(supported ? 'supported' : 'incompatible', [
          supported ? 'REPORTED_TARGET_WITHIN_REQUIREMENT' : 'REPORTED_TARGET_OUTSIDE_REQUIREMENT',
          'OPERATOR_REPORT_NOT_MEASURED_TEMPERATURE',
          `REPORT_${facts.setpointFreshness.reason.toUpperCase().replaceAll('-', '_')}`,
        ]);
      }
    }
    stocks[stock.id] = {
      stockId: stock.id,
      requirement,
      environment: context,
      capability,
      reportedTarget,
      qualifiedSupport,
    };
  }
  return { asOf: options.asOf, freshnessMaxAgeMs: options.freshnessMaxAgeMs, equipment, stocks };
}

export function validateInventoryTemperatureState(state: InventoryState): void {
  const validRecorded = (fact: { readonly at: number }) => {
    if (fact.at > state.lastRecordedAt)
      throw new TypeError('Temperature facts cannot exceed the recorded inventory clock.');
  };
  for (const [key, fact] of Object.entries(state.thermalContexts)) {
    if (key !== inventoryTemperatureItemKey(fact.item) || !record(state, fact.item))
      throw new TypeError('A thermal context requires its existing exact physical item key.');
    validRecorded(fact);
  }
  for (const [key, fact] of Object.entries(state.equipmentSetpoints)) {
    if (key !== inventoryTemperatureItemKey(fact.item) || !record(state, fact.item))
      throw new TypeError('A reported setpoint requires its existing exact equipment key.');
    validRecorded(fact);
  }
  for (const [key, fact] of Object.entries(state.storageRequirements)) {
    if (
      key !== inventoryStorageRequirementKey(fact.target) ||
      !(fact.target.kind === 'stock' ? state.stocks[fact.target.id] : state.lots[fact.target.id])
    )
      throw new TypeError('A storage requirement requires its existing exact target key.');
    if (fact.target.kind === 'lot' && fact.value.kind === 'inherit')
      throw new TypeError('A lot requirement cannot inherit.');
    validRecorded(fact);
  }
  for (const claim of Object.values(state.temperatureClaims)) {
    validRecorded(claim);
    if (claim.subject.kind === 'type-version') {
      if (
        !state.typeVersions[claim.subject.versionId] ||
        claim.assertion.kind === 'qualified-envelope'
      )
        throw new TypeError(
          'A type temperature claim requires an existing type and cannot qualify an installation.'
        );
    } else {
      const row = record(state, claim.subject.item);
      if (!row || claim.subject.configurationRevision > row.configuration.revision)
        throw new TypeError(
          'A temperature claim requires an existing recorded physical configuration.'
        );
    }
    if (claim.assertion.kind === 'qualified-envelope') {
      if (!claim.installation?.length || claim.subject.kind !== 'installed')
        throw new TypeError('A qualification requires an inspectable installed physical snapshot.');
      if (
        inventoryTemperatureItemKey(claim.installation[0].item) !==
          inventoryTemperatureItemKey(claim.subject.item) ||
        claim.installation[0].configurationRevision !== claim.subject.configurationRevision ||
        claim.installation[0].placement.kind !== 'root'
      )
        throw new TypeError('A qualification snapshot must start at its exact installed subject.');
      const seen = new Set<string>();
      for (const entry of claim.installation) {
        if (
          (claim.assertion.scope === 'physical-and-thermal-arrangement') ===
          (entry.thermalRelationship === null)
        )
          throw new TypeError(
            'A qualification snapshot must preserve its declared thermal coverage scope.'
          );
        const key = inventoryTemperatureItemKey(entry.item),
          row = record(state, entry.item);
        if (!row || seen.has(key) || entry.configurationRevision > row.configuration.revision)
          throw new TypeError(
            'A qualification snapshot requires distinct known historical physical items.'
          );
        seen.add(key);
        if (
          (entry.item.kind === 'storage') !== (entry.layout !== null) ||
          (entry.item.kind === 'vessel') !== (entry.limits !== null)
        )
          throw new TypeError('A qualification snapshot must preserve the physical item kind.');
        if (
          entry !== claim.installation[0] &&
          (entry.placement.kind !== 'located' ||
            !seen.has(
              inventoryTemperatureItemKey({ kind: 'storage', id: entry.placement.storageId })
            ))
        )
          throw new TypeError(
            'A qualification snapshot must retain its connected internal placement tree.'
          );
      }
    } else if (claim.installation !== null)
      throw new TypeError('A specified setpoint range does not qualify a physical installation.');
    if (
      claim.lifecycle.kind === 'withdrawn' &&
      (claim.lifecycle.at < claim.at || claim.lifecycle.at > state.lastRecordedAt)
    )
      throw new TypeError('Claim withdrawal must follow recording within the inventory clock.');
  }
}
