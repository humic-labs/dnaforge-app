import {
  inventoryTableCanonicalJson as canonical,
  inventoryTableSha256 as sha,
} from './inventory-table-binding';
import { normalizeInventoryTemperature } from './inventory-temperature';
import type {
  InventoryEquipmentIncidentActionChoices,
  InventoryEquipmentIncidentActionIdentity,
  InventoryEquipmentIncidentActionProof,
  InventoryEquipmentIncidentContentsFact,
  InventoryEquipmentIncidentReviewRoot,
} from './inventory-equipment-incident-types';
export function incidentObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    throw TypeError('Incident fields must match their exact declared shape.');
  return value as Record<string, unknown>;
}
export function incidentText(value: unknown, max = 2000): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    value.includes('\0') ||
    new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(value)) !== value
  )
    throw TypeError('Incident text must be exact bounded nonempty UTF-8.');
  return value;
}
export function incidentTime(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw TypeError('Incident time or revision must be a safe nonnegative integer.');
  return value;
}
export function incidentSha(value: unknown): `sha256:${string}` {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value))
    throw TypeError('Incident requires an exact SHA256 pin.');
  return value as `sha256:${string}`;
}
function pin(value: unknown, key: string) {
  const v = incidentObject(value, [key, 'intentSha256']);
  incidentText(v[key], 512);
  incidentSha(v.intentSha256);
}
function factPin(value: unknown) {
  if (value !== null) pin(value, 'factId');
}
function item(value: unknown) {
  const v = incidentObject(value, ['kind', 'id']);
  if (v.kind !== 'storage' && v.kind !== 'vessel') throw TypeError('Choose a physical holder.');
  incidentText(v.id, 1024);
}
function destination(value: unknown) {
  if (!value || typeof value !== 'object')
    throw TypeError('Choose an existing physical destination.');
  const k = (value as { kind: unknown }).kind;
  if (k === 'root' || k === 'unplaced') incidentObject(value, ['kind']);
  else if (k === 'located') {
    const v = incidentObject(value, ['kind', 'storageId', 'slotId']);
    incidentText(v.storageId, 512);
    incidentText(v.slotId, 512);
  } else if (k === 'stack-top') {
    const v = incidentObject(value, ['kind', 'stackId']);
    incidentText(v.stackId, 512);
  } else throw TypeError('Choose an existing physical destination.');
}
export function inventoryEquipmentIncidentActionId(
  identity: InventoryEquipmentIncidentActionIdentity
): string {
  const v = incidentObject(identity, ['namespace', 'actionId']);
  return `equipment-incident-action:${sha(canonical(['dnaforge.inventory-equipment-incident-action.v1', incidentText(v.namespace, 1024), incidentText(v.actionId, 1024)])).slice(7)}`;
}
export function parseInventoryEquipmentIncidentActionChoices(
  value: unknown
): InventoryEquipmentIncidentActionChoices {
  const v = incidentObject(value, ['identity', 'action']);
  inventoryEquipmentIncidentActionId(v.identity as InventoryEquipmentIncidentActionIdentity);
  if (!v.action || typeof v.action !== 'object') throw TypeError('Choose an incident action.');
  const a = v.action as Record<string, unknown>;
  switch (a.kind) {
    case 'report': {
      incidentObject(a, ['kind', 'equipment', 'noticedAt', 'description', 'reason']);
      const e = incidentObject(a.equipment, ['storageId', 'configurationRevision']);
      incidentText(e.storageId, 512);
      incidentTime(e.configurationRevision);
      if (a.noticedAt !== null) incidentTime(a.noticedAt);
      incidentText(a.description);
      break;
    }
    case 'manual-temperature': {
      incidentObject(a, ['kind', 'incident', 'reading', 'supersedes', 'reason']);
      pin(a.incident, 'incidentId');
      factPin(a.supersedes);
      const r = a.reading as Record<string, unknown>;
      if (r?.kind === 'measured') {
        incidentObject(r, ['kind', 'temperature', 'observedAt', 'pointLabel']);
        const t = incidentObject(r.temperature, ['value', 'unit']);
        const n = normalizeInventoryTemperature(t as unknown as { value: string; unit: 'C' });
        if (canonical(n) !== canonical(t)) throw TypeError('Use canonical exact Celsius.');
        incidentTime(r.observedAt);
        incidentText(r.pointLabel);
      } else if (r?.kind === 'withdrawn') {
        incidentObject(r, ['kind']);
        if (a.supersedes === null) throw TypeError('Withdraw a pinned earlier observation.');
      } else throw TypeError('Choose a manual measured reading or withdrawal.');
      break;
    }
    case 'completed-relocation':
      incidentObject(a, ['kind', 'incident', 'moves', 'corrects', 'reason']);
      pin(a.incident, 'incidentId');
      factPin(a.corrects);
      if (!Array.isArray(a.moves) || a.moves.length < 1 || a.moves.length > 256)
        throw TypeError('Choose one to256 whole holders.');
      for (const m of a.moves) {
        const row = incidentObject(m, ['item', 'destination']);
        item(row.item);
        destination(row.destination);
      }
      break;
    case 'impact-review': {
      incidentObject(a, ['kind', 'incident', 'subjects', 'disposition', 'basis', 'reason']);
      pin(a.incident, 'incidentId');
      if (!Array.isArray(a.subjects) || a.subjects.length < 1 || a.subjects.length > 1000)
        throw TypeError('Review one to1000 exact roots.');
      const ids = new Set();
      for (const x of a.subjects) {
        const row = incidentObject(x, ['root', 'supersedes']);
        pin(row.root, 'rootId');
        factPin(row.supersedes);
        const id = (row.root as { rootId: string }).rootId;
        if (ids.has(id)) throw TypeError('Review roots must be distinct.');
        ids.add(id);
      }
      if (
        a.disposition !== 'keep-incident-restriction' &&
        a.disposition !== 'remove-incident-restriction'
      )
        throw TypeError('Select an explicit incident restriction disposition.');
      incidentText(a.basis);
      break;
    }
    case 'resolve':
      incidentObject(a, ['kind', 'incident', 'resolution', 'reason']);
      pin(a.incident, 'incidentId');
      if (a.resolution !== 'reported-resolved' && a.resolution !== 'reported-in-error')
        throw TypeError('Select the reported resolution.');
      break;
    default:
      throw TypeError('Unsupported equipment incident action.');
  }
  incidentText(a.reason);
  return structuredClone(v) as unknown as InventoryEquipmentIncidentActionChoices;
}
export function inventoryEquipmentIncidentActionIntentSha256(
  value: InventoryEquipmentIncidentActionChoices
) {
  return sha(
    canonical({
      schema: 'dnaforge.inventory-equipment-incident-action-intent.v1',
      ...parseInventoryEquipmentIncidentActionChoices(value),
    })
  );
}
export function inventoryEquipmentIncidentActionChoices(
  record: InventoryEquipmentIncidentActionProof
) {
  return parseInventoryEquipmentIncidentActionChoices(record.choices);
}
export function inventoryEquipmentIncidentReviewRootId(
  root: Pick<InventoryEquipmentIncidentReviewRoot, 'incident' | 'originSubject'>
) {
  return `equipment-incident-root:${sha(canonical(['dnaforge.inventory-equipment-incident-root.v1', root.incident.incidentId, root.originSubject])).slice(7)}`;
}
export function inventoryEquipmentIncidentReviewRootIntentSha256(
  root: Pick<
    InventoryEquipmentIncidentReviewRoot,
    'incident' | 'originSubject' | 'originRevision' | 'origin' | 'qualification'
  >
) {
  return sha(
    canonical({
      schema: 'dnaforge.inventory-equipment-incident-root-intent.v1',
      incident: root.incident,
      originSubject: root.originSubject,
      originRevision: root.originRevision,
      origin: root.origin,
      qualification: root.qualification,
    })
  );
}
export function inventoryEquipmentIncidentContentsFactId(
  fact: Pick<InventoryEquipmentIncidentContentsFact, 'root' | 'kind'>
) {
  return `equipment-incident-contents-fact:${sha(canonical(['dnaforge.inventory-equipment-incident-contents-fact.v1', fact.root.rootId, fact.kind])).slice(7)}`;
}
export function inventoryEquipmentIncidentContentsFactIntentSha256(
  fact: Pick<
    InventoryEquipmentIncidentContentsFact,
    'kind' | 'incident' | 'root' | 'originalTransition'
  >
) {
  return sha(
    canonical({
      schema: 'dnaforge.inventory-equipment-incident-contents-intent.v1',
      kind: fact.kind,
      incident: fact.incident,
      root: fact.root,
      originalTransition: fact.originalTransition,
    })
  );
}
