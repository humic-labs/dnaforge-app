import {
  applyInventoryEquipmentIncidentAction,
  type InventoryState,
  type InventoryExecutionContext,
} from '@waypoint/domain-services';
import type { InventoryApplyEquipmentIncidentActionRequest } from '../shared/inventory-equipment-incidents';
import {
  inventoryEquipmentIncidents,
  inventoryEquipmentIncidentSummary,
  inventoryEquipmentIncidentCurrentStatus,
  inventoryEquipmentIncidentSubjects,
  inventoryEquipmentIncidentFacts,
  inventoryEquipmentIncidentManualFact,
  type InventoryPrincipal,
} from '@waypoint/domain-services';
import type * as Wire from '../shared/inventory-equipment-incidents';
import { canonicalNativeMutationRequest } from './native-mutation-request';
import { nativeInventorySha256 } from './inventory-archive';
import { NATIVE_DOCUMENT_MAX_BODY_BYTES } from '../shared/native-document-transport';
export function applyNativeInventoryEquipmentIncidentAction(
  state: InventoryState,
  request: InventoryApplyEquipmentIncidentActionRequest,
  context: InventoryExecutionContext
) {
  return applyInventoryEquipmentIncidentAction(
    state,
    {
      ...request.choices,
      target: {
        projectId: request.project,
        inventoryId: request.inventoryId,
        present: state.revision !== 0,
        revision: request.expectedRevision,
      },
      expectedPlanDigest: request.expectedPlanDigest,
    },
    context
  );
}
type Header = {
  projectId: string;
  inventoryId: string;
  revision: number;
  asOf: number;
  principal: InventoryPrincipal;
};
const unavailable = (code: string, message: string, retryable = false) => ({
  kind: 'unavailable' as const,
  code,
  message,
  retryable,
});
const missing = () =>
  unavailable(
    'INVENTORY_EQUIPMENT_INCIDENT_NOT_FOUND',
    'The exact incident report is unavailable.'
  );
function bounded<T>(result: T): T | ReturnType<typeof unavailable> {
  return Buffer.byteLength(canonicalNativeMutationRequest(result), 'utf8') <=
    NATIVE_DOCUMENT_MAX_BODY_BYTES - 2048
    ? result
    : unavailable(
        'INVENTORY_QUERY_TOO_LARGE',
        'The complete incident read exceeds the inline limit. Choose a smaller page.'
      );
}
export function boundNativeInventoryEquipmentIncidentAction(
  before: InventoryState,
  after: InventoryState,
  envelope: unknown
) {
  const added = <T>(a: Readonly<Record<string, T>>, b: Readonly<Record<string, T>>) =>
    Object.entries(b)
      .filter(([id]) => !Object.hasOwn(a, id))
      .map(([, v]) => v);
  return (
    Buffer.byteLength(
      canonicalNativeMutationRequest({
        envelope,
        incidents: added(before.equipmentIncidents, after.equipmentIncidents),
        roots: added(before.equipmentIncidentReviewRoots, after.equipmentIncidentReviewRoots),
        facts: added(before.equipmentIncidentFacts, after.equipmentIncidentFacts),
      }),
      'utf8'
    ) <=
    NATIVE_DOCUMENT_MAX_BODY_BYTES - 2048
  );
}
function exact(state: InventoryState | null, pin: { incidentId: string; intentSha256: string }) {
  const value =
    state && Object.hasOwn(state.equipmentIncidents, pin.incidentId)
      ? state.equipmentIncidents[pin.incidentId]
      : null;
  return value?.intentSha256 === pin.intentSha256 ? value : null;
}
function pageStart<T>(
  rows: readonly T[],
  cursor: { querySha256: string; revision: number; after: unknown } | undefined,
  querySha256: string,
  revision: number,
  match: (row: T, after: unknown) => boolean
) {
  if (!cursor) return 0;
  if (cursor.querySha256 !== querySha256)
    return unavailable(
      'INVENTORY_QUERY_CURSOR_INVALID',
      'This cursor belongs to another incident query.'
    );
  if (cursor.revision !== revision)
    return unavailable(
      'INVENTORY_QUERY_STALE',
      'Inventory changed. Read the first page again.',
      true
    );
  const index = rows.findIndex((row) => match(row, cursor.after));
  return index < 0
    ? unavailable('INVENTORY_QUERY_CURSOR_INVALID', 'The incident cursor boundary is unavailable.')
    : index + 1;
}
export function readNativeInventoryEquipmentIncidents(
  request: Wire.InventoryEquipmentIncidentsRequest,
  state: InventoryState | null,
  header: Header
): Wire.InventoryEquipmentIncidentsRead {
  const filters = { equipmentId: request.equipmentId ?? null, status: request.status ?? null };
  if (!state) return { kind: 'inventory-absent', ...header, filters };
  const rows = inventoryEquipmentIncidents(state)
    .map((incident) => ({
      incident,
      current: inventoryEquipmentIncidentCurrentStatus(state, incident.id),
    }))
    .filter(
      (row) =>
        (!request.equipmentId || row.incident.binding.storageId === request.equipmentId) &&
        (!request.status || row.current.lifecycle === request.status)
    );
  const querySha256 = nativeInventorySha256(
    canonicalNativeMutationRequest([header.projectId, header.inventoryId, filters])
  );
  const start = pageStart(rows, request.cursor, querySha256, state.revision, (row, after) => {
    const p = after as { at: number; incidentId: string };
    return row.incident.id === p.incidentId && row.incident.at === p.at;
  });
  if (typeof start !== 'number') return start;
  const selected = rows.slice(start, start + (request.limit ?? 20)),
    last = selected.at(-1);
  return bounded({
    kind: 'ready' as const,
    ...header,
    filters,
    incidents: selected,
    nextCursor:
      last && start + selected.length < rows.length
        ? {
            querySha256,
            revision: state.revision,
            after: { at: last.incident.at, incidentId: last.incident.id },
          }
        : null,
  });
}
export function readNativeInventoryEquipmentIncident(
  request: Wire.InventoryEquipmentIncidentRequest,
  state: InventoryState | null,
  header: Header
): Wire.InventoryEquipmentIncidentRead {
  const incident = exact(state, request);
  return incident
    ? bounded({
        kind: 'available' as const,
        ...header,
        incident: inventoryEquipmentIncidentSummary(incident),
        current: inventoryEquipmentIncidentCurrentStatus(state!, incident.id),
      })
    : missing();
}
export function readNativeInventoryEquipmentIncidentSubjects(
  request: Wire.InventoryEquipmentIncidentSubjectsRequest,
  state: InventoryState | null,
  header: Header
): Wire.InventoryEquipmentIncidentSubjectsRead {
  if (!exact(state, request)) return missing();
  const pin = { incidentId: request.incidentId, intentSha256: request.intentSha256 },
    freshnessMaxAgeMs = request.freshnessMaxAgeMs ?? null;
  const rows = inventoryEquipmentIncidentSubjects(state!, request.incidentId, request.view);
  const querySha256 = nativeInventorySha256(
    canonicalNativeMutationRequest([
      header.projectId,
      header.inventoryId,
      pin,
      request.view,
      freshnessMaxAgeMs,
    ])
  );
  const start = pageStart(
    rows,
    request.cursor,
    querySha256,
    state!.revision,
    (row, after) => row.key === (after as { subjectKey: string }).subjectKey
  );
  if (typeof start !== 'number') return start;
  const subjects = rows.slice(start, start + (request.limit ?? 20)),
    last = subjects.at(-1);
  return bounded({
    kind: 'ready' as const,
    ...header,
    incident: pin,
    view: request.view,
    freshnessMaxAgeMs,
    subjects,
    nextCursor:
      last && start + subjects.length < rows.length
        ? { querySha256, revision: state!.revision, after: { subjectKey: last.key } }
        : null,
    nextBoundaryAt: null,
  });
}
export function readNativeInventoryEquipmentIncidentFacts(
  request: Wire.InventoryEquipmentIncidentFactsRequest,
  state: InventoryState | null,
  header: Header
): Wire.InventoryEquipmentIncidentFactsRead {
  if (!exact(state, request)) return missing();
  const pin = { incidentId: request.incidentId, intentSha256: request.intentSha256 },
    freshnessMaxAgeMs = request.query.freshnessMaxAgeMs ?? null;
  if (request.query.kind === 'fact') {
    const fact = state!.equipmentIncidentFacts[request.query.fact.factId];
    if (
      !fact ||
      fact.incident.incidentId !== pin.incidentId ||
      fact.incident.intentSha256 !== pin.intentSha256 ||
      fact.intentSha256 !== request.query.fact.intentSha256
    )
      return unavailable(
        'INVENTORY_EQUIPMENT_INCIDENT_FACT_NOT_FOUND',
        'The exact incident fact is unavailable.'
      );
    const manual = inventoryEquipmentIncidentManualFact(
      state!,
      fact.id,
      header.asOf,
      freshnessMaxAgeMs
    );
    const observedAt = manual?.freshness.observedAt;
    const boundary =
      observedAt !== null && observedAt !== undefined && freshnessMaxAgeMs !== null
        ? observedAt + freshnessMaxAgeMs + 1
        : null;
    return bounded({
      kind: 'available' as const,
      ...header,
      incident: pin,
      fact,
      manual,
      freshnessMaxAgeMs,
      nextBoundaryAt:
        boundary !== null && Number.isSafeInteger(boundary) && boundary > header.asOf
          ? boundary
          : null,
    });
  }
  const filters = {
    kind: 'page' as const,
    factKind: request.query.factKind ?? null,
    freshnessMaxAgeMs,
  };
  const rows = inventoryEquipmentIncidentFacts(state!, request.incidentId).filter(
    (row) => !filters.factKind || row.kind === filters.factKind
  );
  const querySha256 = nativeInventorySha256(
    canonicalNativeMutationRequest([header.projectId, header.inventoryId, pin, filters])
  );
  const start = pageStart(
    rows,
    request.query.cursor,
    querySha256,
    state!.revision,
    (row, after) => {
      const p = after as { at: number; factId: string };
      return row.id === p.factId && row.at === p.at;
    }
  );
  if (typeof start !== 'number') return start;
  const facts = rows.slice(start, start + (request.query.limit ?? 20)),
    last = facts.at(-1);
  return bounded({
    kind: 'ready' as const,
    ...header,
    incident: pin,
    query: filters,
    facts,
    nextCursor:
      last && start + facts.length < rows.length
        ? { querySha256, revision: state!.revision, after: { at: last.at, factId: last.id } }
        : null,
    nextBoundaryAt: null,
  });
}
