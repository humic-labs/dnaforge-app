import {
  inventoryTableCanonicalJson as canonical,
  inventoryTableSha256 as sha,
} from './inventory-table-binding';
import { inventoryRecordIdExists } from './inventory-identity';
import { parseInventoryExecutionContext, parseInventoryState } from './inventory-validation';
import { applyInventoryCommandBatch } from './inventory-state';
import { inventoryItemContains } from './inventory-placement';
import { inventoryTemperatureFreshness } from './inventory-temperature';
import { inventoryCurrentLocationPath, inventoryItemCustody } from './inventory-custody';
import { inventoryStockAvailabilityFacts } from './inventory-reservations';
import {
  inventoryEquipmentIncidentActionId,
  inventoryEquipmentIncidentActionIntentSha256,
  parseInventoryEquipmentIncidentActionChoices,
} from './inventory-equipment-incident-identity';
import {
  inventoryIncidentReviewRootIds,
  inventoryEquipmentIncidentResolution,
  inventoryEquipmentIncidentRootReview,
  inventoryIncidentHolderSnapshot,
  inventoryIncidentVesselSnapshot,
  inventoryIncidentMakeRoot,
  inventoryIncidentVesselEpisodeRoots,
  incidentOrder,
} from './inventory-incident-constraints';
import type {
  InventoryState,
  InventoryTransition,
  InventoryExecutionContext,
  InventoryCommand,
  InventoryPhysicalItem,
} from './inventory-types';
import type * as T from './inventory-equipment-incident-types';
export * from './inventory-equipment-incident-identity';
const issue = (
  code: T.InventoryEquipmentIncidentIssue['code'],
  pointer: string,
  message: string
): T.InventoryEquipmentIncidentIssue => ({ code, pointer, message });
const proof = (
  r: T.InventoryEquipmentIncidentActionProof
): T.InventoryEquipmentIncidentActionProof =>
  structuredClone({
    actionId: r.actionId,
    intentSha256: r.intentSha256,
    choices: r.choices,
    originalOwner: r.originalOwner,
  });
const counts = (): T.InventoryEquipmentIncidentEffectCounts => ({
  capturedHolders: 0,
  capturedVessels: 0,
  createdReviewRoots: 0,
  identifiedContentsBridges: 0,
  relocatedHolders: 0,
  reviewedRoots: 0,
});
export function inventoryEquipmentIncidentActionSummary(
  record: T.InventoryEquipmentIncident | T.InventoryEquipmentIncidentOperatorFact
): T.InventoryEquipmentIncidentActionSummary {
  let effect = counts();
  if ('initial' in record)
    effect = {
      ...effect,
      capturedHolders: record.initial.holders.length,
      capturedVessels: record.initial.vessels.length,
      createdReviewRoots: record.initial.reviewRootIds.length,
    };
  else if (record.effects.kind === 'completed-relocation')
    effect = { ...effect, relocatedHolders: record.effects.holders.length };
  else if (record.choices.action.kind === 'impact-review')
    effect = { ...effect, reviewedRoots: record.choices.action.subjects.length };
  return {
    kind: record.choices.action.kind,
    actionProof: proof(record),
    incident:
      'initial' in record
        ? { incidentId: record.id, intentSha256: record.intentSha256 }
        : structuredClone(record.incident),
    effectCounts: effect,
    at: record.at,
    by: structuredClone(record.by),
  };
}
export function inventoryEquipmentIncidentSummary(
  record: T.InventoryEquipmentIncident
): T.InventoryEquipmentIncidentSummary {
  return {
    id: record.id,
    actionProof: proof(record),
    equipment: structuredClone(record.equipment),
    binding: { ...record.binding },
    contentsWhenRecorded: record.contentsWhenRecorded,
    effectCounts: inventoryEquipmentIncidentActionSummary(record).effectCounts,
    at: record.at,
    by: structuredClone(record.by),
  };
}
export function inventoryEquipmentIncidentCurrentStatus(
  state: T.InventoryEquipmentIncidentState,
  id: string
): T.InventoryEquipmentIncidentCurrentStatus {
  const resolution = inventoryEquipmentIncidentResolution(state, id),
    review = { pending: 0, kept: 0, removed: 0, importedRemovalUnconfirmed: 0 };
  for (const root of Object.values(state.equipmentIncidentReviewRoots).filter(
    (r) => r.incident.incidentId === id
  )) {
    const r = inventoryEquipmentIncidentRootReview(state, root.id);
    if (r.restriction === 'pending') review.pending++;
    else if (r.restriction === 'kept') review.kept++;
    else if (r.restriction === 'removed') review.removed++;
    else review.importedRemovalUnconfirmed++;
  }
  return {
    lifecycle: resolution ? 'resolved' : 'open',
    resolution: resolution
      ? { factId: resolution.id, intentSha256: resolution.intentSha256 }
      : null,
    review,
  };
}
export function inventoryEquipmentIncidentActionExisting(
  state: InventoryState,
  choices: T.InventoryEquipmentIncidentActionChoices
): T.InventoryEquipmentIncidentActionExisting {
  const id = inventoryEquipmentIncidentActionId(choices.identity),
    intent = inventoryEquipmentIncidentActionIntentSha256(choices),
    r = state.equipmentIncidents[id] ?? state.equipmentIncidentFacts[id];
  if (r) {
    if (!('choices' in r) || r.intentSha256 !== intent)
      return {
        kind: 'blocked',
        issue: issue(
          'EQUIPMENT_INCIDENT_CONFLICT',
          '/identity',
          'This incident action identity already has a different meaning.'
        ),
      };
    const summary = inventoryEquipmentIncidentActionSummary(r);
    return {
      kind: 'no-change',
      record: summary,
      current: inventoryEquipmentIncidentCurrentStatus(state, summary.incident.incidentId),
    };
  }
  return inventoryRecordIdExists(state, id)
    ? {
        kind: 'blocked',
        issue: issue('ID_ALREADY_EXISTS', '/identity', 'This inventory identity already exists.'),
      }
    : { kind: 'new' };
}
export function inventoryEquipmentIncidents(
  state: InventoryState,
  filter: { storageId?: string; lifecycle?: 'open' | 'resolved' } = {}
): readonly T.InventoryEquipmentIncidentSummary[] {
  return Object.values(state.equipmentIncidents)
    .filter(
      (r) =>
        (!filter.storageId || r.binding.storageId === filter.storageId) &&
        (!filter.lifecycle ||
          inventoryEquipmentIncidentCurrentStatus(state, r.id).lifecycle === filter.lifecycle)
    )
    .sort((a, b) => a.at - b.at || incidentOrder(a.id, b.id))
    .map(inventoryEquipmentIncidentSummary);
}
export function inventoryEquipmentIncidentFacts(
  state: InventoryState,
  incidentId: string
): readonly T.InventoryEquipmentIncidentFactSummary[] {
  return Object.values(state.equipmentIncidentFacts)
    .filter((f) => f.incident.incidentId === incidentId)
    .sort((a, b) => a.at - b.at || incidentOrder(a.id, b.id))
    .map((f) => ({
      id: f.id,
      kind: f.kind,
      intentSha256: f.intentSha256,
      incident: structuredClone(f.incident),
      at: f.at,
      by: structuredClone(f.by),
      actionProof: 'choices' in f ? proof(f) : null,
    }));
}
function holderRoots(
  state: T.InventoryEquipmentIncidentState,
  item: InventoryPhysicalItem,
  incidentId: string
): readonly string[] {
  return inventoryIncidentReviewRootIds(
    ...Object.values(state.stocks)
      .filter((s) => inventoryItemContains(state, item, { kind: 'vessel', id: s.vesselId }))
      .map((s) => s.incidentReviewRootIds),
    ...Object.values(state.vessels)
      .filter((v) => inventoryItemContains(state, item, { kind: 'vessel', id: v.id }))
      .map((v) => inventoryIncidentVesselEpisodeRoots(state, v.id).map((r) => r.id))
  ).filter((id) => state.equipmentIncidentReviewRoots[id]?.incident.incidentId === incidentId);
}
function initialHolderRoots(
  state: InventoryState,
  incident: T.InventoryEquipmentIncident,
  item: InventoryPhysicalItem
): readonly string[] {
  const holders = new Map(incident.initial.holders.map((s) => [s.item.id, s]));
  return incident.initial.reviewRootIds.filter((id) => {
    const root = state.equipmentIncidentReviewRoots[id],
      v = root.snapshot.vessel;
    if (item.kind === 'vessel') return v.item.id === item.id;
    let placement = v.placement;
    const seen = new Set<string>();
    while (placement.kind === 'located' && !seen.has(placement.storageId)) {
      if (placement.storageId === item.id) return true;
      seen.add(placement.storageId);
      const parent = holders.get(placement.storageId);
      if (!parent) break;
      placement = parent.placement;
    }
    return false;
  });
}
export function inventoryEquipmentIncidentSubjects(
  state: InventoryState,
  incidentId: string,
  view: 'initial' | 'current' | 'review'
): readonly T.InventoryEquipmentIncidentSubjectProjection[] {
  const incident = state.equipmentIncidents[incidentId];
  if (!incident) return [];
  const result: T.InventoryEquipmentIncidentSubjectProjection[] = [];
  if (view === 'review') {
    for (const root of Object.values(state.equipmentIncidentReviewRoots).filter(
      (r) => r.incident.incidentId === incidentId
    ))
      result.push({
        view,
        key: `root:${root.id}`,
        kind: 'root',
        root: structuredClone(root),
        review: inventoryEquipmentIncidentRootReview(state, root.id),
      });
    for (const stock of Object.values(state.stocks)) {
      const ids = stock.incidentReviewRootIds.filter(
        (id) => state.equipmentIncidentReviewRoots[id]?.incident.incidentId === incidentId
      );
      if (ids.length)
        result.push({
          view,
          key: `stock:${stock.id}`,
          kind: 'stock',
          stock: structuredClone(stock),
          reviewRootIds: ids,
          relation: ids.some((id) => {
            const r = state.equipmentIncidentReviewRoots[id];
            return (
              (r.binding.kind === 'stock' && r.binding.stockId === stock.id) ||
              Object.values(state.equipmentIncidentFacts).some(
                (f) =>
                  f.kind === 'contents-identified' &&
                  f.root.rootId === id &&
                  f.binding.stockId === stock.id
              )
            );
          })
            ? 'direct-subject'
            : 'derived-material',
        });
    }
    for (const lot of Object.values(state.lots)) {
      const ids = lot.incidentReviewRootIds.filter(
        (id) => state.equipmentIncidentReviewRoots[id]?.incident.incidentId === incidentId
      );
      if (ids.length)
        result.push({
          view,
          key: `lot:${lot.id}`,
          kind: 'lot',
          lot: structuredClone(lot),
          reviewRootIds: ids,
        });
    }
  } else {
    const holders =
      view === 'initial'
        ? incident.initial.holders
        : Object.values(state.storage)
            .filter((s) =>
              inventoryItemContains(
                state,
                { kind: 'storage', id: incident.binding.storageId },
                { kind: 'storage', id: s.id }
              )
            )
            .map((s) =>
              inventoryIncidentHolderSnapshot(
                state,
                { kind: 'storage', id: s.id },
                state.lastRecordedAt
              )
            );
    const vessels =
      view === 'initial'
        ? incident.initial.vessels
        : Object.values(state.vessels)
            .filter((v) =>
              inventoryItemContains(
                state,
                { kind: 'storage', id: incident.binding.storageId },
                { kind: 'vessel', id: v.id }
              )
            )
            .map((v) => inventoryIncidentVesselSnapshot(state, v.id, state.lastRecordedAt));
    for (const snapshot of holders)
      result.push({
        view,
        key: `holder:${snapshot.item.id}`,
        kind: 'holder',
        snapshot: structuredClone(snapshot),
        reviewRootIds:
          view === 'initial'
            ? initialHolderRoots(state, incident, snapshot.item)
            : holderRoots(state, snapshot.item, incidentId),
      });
    for (const snapshot of vessels) {
      const root = Object.values(state.equipmentIncidentReviewRoots).find(
        (r) =>
          r.incident.incidentId === incidentId &&
          r.snapshot.kind === 'stock' &&
          r.snapshot.vessel.item.id === snapshot.item.id
      );
      const stock =
        view === 'initial'
          ? root?.snapshot.kind === 'stock'
            ? root.snapshot.before
            : null
          : (Object.values(state.stocks).find((s) => s.vesselId === snapshot.item.id) ?? null);
      result.push({
        view,
        key: `vessel:${snapshot.item.id}`,
        kind: 'vessel',
        snapshot: structuredClone(snapshot),
        stock: structuredClone(stock),
        reviewRootIds:
          view === 'initial'
            ? initialHolderRoots(state, incident, snapshot.item)
            : holderRoots(state, snapshot.item, incidentId),
      });
    }
  }
  return result.sort((a, b) => incidentOrder(a.key, b.key));
}
export function inventoryEquipmentIncidentManualFact(
  state: InventoryState,
  factId: string,
  asOf: number,
  maxAgeMs: number | null
): T.InventoryEquipmentIncidentManualFactProjection | null {
  const fact = state.equipmentIncidentFacts[factId];
  if (
    !fact ||
    fact.kind !== 'manual-temperature' ||
    !('choices' in fact) ||
    fact.choices.action.kind !== 'manual-temperature' ||
    fact.effects.kind !== 'manual-temperature'
  )
    return null;
  const storage =
      state.storage[state.equipmentIncidents[fact.incident.incidentId]?.binding.storageId],
    basis = fact.effects.configurationBasisAtRecording;
  return {
    fact: structuredClone(fact),
    configurationApplicability:
      !storage || storage.lifecycle !== 'active'
        ? 'equipment-unavailable'
        : storage.configuration.revision !== basis.configurationRevision ||
            storage.configuration.typeVersionId !== basis.typeVersionId
          ? 'configuration-changed'
          : 'same-recorded-configuration',
    freshness: inventoryTemperatureFreshness(
      fact.choices.action.reading.kind === 'measured'
        ? fact.choices.action.reading.observedAt
        : null,
      asOf,
      maxAgeMs
    ),
    asOf,
    maxAgeMs,
  };
}
function relocationNextBoundary(
  state: InventoryState,
  moves: Extract<T.InventoryEquipmentIncidentAction, { kind: 'completed-relocation' }>['moves'],
  principal: InventoryExecutionContext['principal'],
  at: number
): number | null {
  let next: number | null = null;
  const boundary = (value: number | null) => {
    if (value !== null && value > at) next = next === null ? value : Math.min(next, value);
  };
  const moving = moves.map((move) => move.item);
  const destinations = moves.flatMap((move): InventoryPhysicalItem[] =>
    move.destination.kind === 'located'
      ? [{ kind: 'storage', id: move.destination.storageId }]
      : move.destination.kind === 'stack-top'
        ? [{ kind: 'storage', id: move.destination.stackId }]
        : []
  );
  for (const item of [...moving, ...destinations]) {
    const exists = item.kind === 'storage' ? state.storage[item.id] : state.vessels[item.id];
    if (!exists) continue;
    const custody = inventoryItemCustody(state, item, principal, at).state;
    if (custody.kind === 'checked-out') boundary(custody.dueAt);
  }
  for (const stock of Object.values(state.stocks)) {
    if (
      !moving.some((item) =>
        inventoryItemContains(state, item, { kind: 'vessel', id: stock.vesselId })
      )
    )
      continue;
    const availability = inventoryStockAvailabilityFacts(
      state,
      stock.id,
      principal,
      at
    ).availability;
    boundary(availability.validity.nextBoundaryAt);
    for (const id of availability.reservationIds) {
      const reservation = state.reservations[id];
      if (reservation?.lifecycle.kind === 'active') boundary(reservation.deadline);
    }
  }
  for (const reservation of Object.values(state.reservations)) {
    if (reservation.lifecycle.kind !== 'active' || reservation.kind !== 'item') continue;
    if (
      moving.some(
        (item) =>
          inventoryItemContains(state, reservation.item, item) ||
          inventoryItemContains(state, item, reservation.item)
      ) ||
      destinations.some((item) => inventoryItemContains(state, reservation.item, item))
    )
      boundary(reservation.deadline);
  }
  return next;
}
function prepare(
  state: InventoryState,
  input: T.InventoryEquipmentIncidentActionPreviewInput
): { preview: T.InventoryEquipmentIncidentActionPreview; state?: InventoryState } {
  let actionId: string | null = null,
    intentSha256: T.InventoryEquipmentIncidentActionProof['intentSha256'] | null = null,
    incidentId: string | null = null;
  let nextBoundaryAt: number | null = null;
  const target = { ...input.target, present: state.revision !== 0, revision: state.revision };
  const header = () => ({
    schema: 'dnaforge.inventory-equipment-incident-action-preview.v1' as const,
    target,
    actionId,
    intentSha256,
    incidentId,
    asOf: input.asOf,
    principal: input.principal,
    nextBoundaryAt,
  });
  const blocked = (v: T.InventoryEquipmentIncidentIssue) => ({
    preview: {
      ...header(),
      kind: 'blocked' as const,
      record: null,
      commands: [] as const,
      planDigest: null,
      issues: [v] as const,
    },
  });
  try {
    const choices = parseInventoryEquipmentIncidentActionChoices({
      identity: input.identity,
      action: input.action,
    });
    actionId = inventoryEquipmentIncidentActionId(choices.identity);
    intentSha256 = inventoryEquipmentIncidentActionIntentSha256(choices);
    incidentId = choices.action.kind === 'report' ? actionId : choices.action.incident.incidentId;
    const old = inventoryEquipmentIncidentActionExisting(state, choices);
    if (old.kind === 'blocked') return blocked(old.issue);
    if (old.kind === 'no-change')
      return {
        preview: {
          ...header(),
          kind: 'no-change',
          record: old.record,
          current: old.current,
          commands: [],
          planDigest: null,
        },
      };
    const context = parseInventoryExecutionContext({
      at: input.asOf,
      principal: input.principal,
      authority: input.authority,
    });
    if (input.target.revision !== state.revision || input.target.present !== target.present)
      return blocked(
        issue(
          'REVISION_CONFLICT',
          '/target',
          'Inventory changed. Preview this incident action again.'
        )
      );
    if (state.revision === Number.MAX_SAFE_INTEGER)
      return blocked(
        issue('REVISION_EXHAUSTED', '/target', 'Inventory revision cannot advance safely.')
      );
    if (context.at < state.lastRecordedAt)
      return blocked(
        issue('CLOCK_REGRESSION', '/target', 'Native recording time precedes the inventory clock.')
      );
    const action = choices.action;
    let candidate: InventoryState = {
      ...state,
      revision: state.revision + 1,
      lastRecordedAt: context.at,
      equipmentIncidents: { ...state.equipmentIncidents },
      equipmentIncidentReviewRoots: { ...state.equipmentIncidentReviewRoots },
      equipmentIncidentFacts: { ...state.equipmentIncidentFacts },
      stocks: { ...state.stocks },
    };
    const actionProof: T.InventoryEquipmentIncidentActionProof = {
      actionId,
      intentSha256,
      choices,
      originalOwner: { projectId: target.projectId, inventoryId: target.inventoryId },
    };
    let record: T.InventoryEquipmentIncident | T.InventoryEquipmentIncidentOperatorFact;
    let commands: InventoryCommand[] = [];
    let beforeMeaning: unknown = null;
    if (action.kind === 'report') {
      const equipment = state.storage[action.equipment.storageId];
      if (!equipment || equipment.lifecycle !== 'active')
        return blocked(
          issue(
            'STORAGE_NOT_FOUND',
            '/action/equipment',
            'Choose existing active physical storage.'
          )
        );
      if (equipment.configuration.revision !== action.equipment.configurationRevision)
        return blocked(
          issue('REVISION_CONFLICT', '/action/equipment', 'Equipment configuration changed.')
        );
      if (action.noticedAt !== null && action.noticedAt > context.at)
        return blocked(
          issue(
            'INVALID_INVENTORY_INPUT',
            '/action/noticedAt',
            'The reported noticed time cannot be in the future.'
          )
        );
      if (
        Object.values(state.equipmentIncidents).some(
          (i) =>
            i.binding.storageId === equipment.id &&
            !inventoryEquipmentIncidentResolution(state, i.id)
        )
      )
        return blocked(
          issue(
            'EQUIPMENT_INCIDENT_CONFLICT',
            '/action/equipment',
            'This exact storage already has an open outage report.'
          )
        );
      const holders = Object.values(state.storage)
        .filter((s) =>
          inventoryItemContains(
            state,
            { kind: 'storage', id: equipment.id },
            { kind: 'storage', id: s.id }
          )
        )
        .sort((a, b) => incidentOrder(a.id, b.id))
        .map((s) =>
          inventoryIncidentHolderSnapshot(state, { kind: 'storage', id: s.id }, context.at)
        );
      const vessels = Object.values(state.vessels)
        .filter((v) =>
          inventoryItemContains(
            state,
            { kind: 'storage', id: equipment.id },
            { kind: 'vessel', id: v.id }
          )
        )
        .sort((a, b) => incidentOrder(a.id, b.id))
        .map((v) => inventoryIncidentVesselSnapshot(state, v.id, context.at));
      if (holders.length > 10000 || vessels.length > 10000)
        return blocked(
          issue(
            'INVALID_INVENTORY_INPUT',
            '/action/equipment',
            'The complete cohort exceeds the bounded incident capture. Nothing was recorded.'
          )
        );
      record = {
        ...actionProof,
        id: actionId,
        binding: { storageId: equipment.id },
        equipment: {
          id: equipment.id,
          name: equipment.name,
          configurationRevision: equipment.configuration.revision,
          typeVersionId: equipment.configuration.typeVersionId,
          layout: structuredClone(equipment.layout),
          placement: { ...equipment.placement },
        },
        initial: { holders, vessels, reviewRootIds: [] },
        contentsWhenRecorded: context.at,
        at: context.at,
        by: context.principal,
      };
      const roots: Record<string, T.InventoryEquipmentIncidentReviewRoot> = {
          ...state.equipmentIncidentReviewRoots,
        },
        stocks = { ...candidate.stocks };
      for (const vessel of vessels) {
        const root = inventoryIncidentMakeRoot(
          state,
          record,
          vessel.item.id,
          context,
          candidate.revision,
          true
        );
        if (root) {
          roots[root.id] = root;
          if (root.binding.kind === 'stock')
            stocks[root.binding.stockId] = {
              ...stocks[root.binding.stockId],
              incidentReviewRootIds: inventoryIncidentReviewRootIds(
                stocks[root.binding.stockId].incidentReviewRootIds,
                [root.id]
              ),
            };
        }
      }
      record = {
        ...record,
        initial: {
          ...record.initial,
          reviewRootIds: Object.keys(roots)
            .filter((id) => !state.equipmentIncidentReviewRoots[id])
            .sort(incidentOrder),
        },
      };
      candidate = {
        ...candidate,
        stocks,
        equipmentIncidents: { ...candidate.equipmentIncidents, [record.id]: record },
        equipmentIncidentReviewRoots: roots,
      };
      beforeMeaning = {
        equipment: state.storage[equipment.id],
        holders,
        vessels,
        stocks: vessels.flatMap((v) =>
          Object.values(state.stocks).filter((s) => s.vesselId === v.item.id)
        ),
      };
    } else {
      const incident = state.equipmentIncidents[action.incident.incidentId];
      if (!incident || incident.intentSha256 !== action.incident.intentSha256)
        return blocked(
          issue(
            'EQUIPMENT_INCIDENT_CONFLICT',
            '/action/incident',
            'Choose the exact original incident.'
          )
        );
      let effects: T.InventoryEquipmentIncidentOperatorFact['effects'];
      if (action.kind === 'manual-temperature') {
        if (action.reading.kind === 'measured' && action.reading.observedAt > context.at)
          return blocked(
            issue(
              'INVALID_INVENTORY_INPUT',
              '/action/reading',
              'The measured time cannot be in the future.'
            )
          );
        if (action.supersedes) {
          const previous = state.equipmentIncidentFacts[action.supersedes.factId];
          if (
            !previous ||
            previous.kind !== 'manual-temperature' ||
            previous.incident.incidentId !== incident.id ||
            previous.intentSha256 !== action.supersedes.intentSha256 ||
            Object.values(state.equipmentIncidentFacts).some(
              (f) =>
                'choices' in f &&
                f.choices.action.kind === 'manual-temperature' &&
                f.choices.action.supersedes?.factId === previous.id
            )
          )
            return blocked(
              issue(
                'EQUIPMENT_INCIDENT_CONFLICT',
                '/action/supersedes',
                'Choose an exact unsuperseded manual observation.'
              )
            );
        }
        const s = state.storage[incident.binding.storageId];
        effects = {
          kind: 'manual-temperature',
          configurationBasisAtRecording: {
            storageId: s.id,
            configurationRevision: s.configuration.revision,
            typeVersionId: s.configuration.typeVersionId,
            thermalContext: state.thermalContexts[`storage:${s.id}`]?.value ?? null,
          },
        };
        beforeMeaning = effects;
      } else if (action.kind === 'impact-review') {
        for (const row of action.subjects) {
          const root = state.equipmentIncidentReviewRoots[row.root.rootId];
          if (
            !root ||
            root.incident.incidentId !== incident.id ||
            root.intentSha256 !== row.root.intentSha256 ||
            canonical(inventoryEquipmentIncidentRootReview(state, root.id).head) !==
              canonical(row.supersedes)
          )
            return blocked(
              issue(
                'EQUIPMENT_INCIDENT_CONFLICT',
                '/action/subjects',
                'Review roots or their current exact predecessor changed.'
              )
            );
        }
        effects = { kind: 'impact-review' };
        beforeMeaning = action.subjects.map((s) => ({
          root: state.equipmentIncidentReviewRoots[s.root.rootId],
          review: inventoryEquipmentIncidentRootReview(state, s.root.rootId),
        }));
      } else if (action.kind === 'resolve') {
        if (inventoryEquipmentIncidentResolution(state, incident.id))
          return blocked(
            issue(
              'EQUIPMENT_INCIDENT_CONFLICT',
              '/action/incident',
              'This incident is already resolved; preserve its original resolution.'
            )
          );
        effects = { kind: 'resolve' };
      } else {
        nextBoundaryAt = relocationNextBoundary(state, action.moves, context.principal, context.at);
        const selected = action.moves.map((m) => m.item);
        for (let i = 0; i < selected.length; i++)
          for (let j = i + 1; j < selected.length; j++)
            if (
              inventoryItemContains(state, selected[i], selected[j]) ||
              inventoryItemContains(state, selected[j], selected[i])
            )
              return blocked(
                issue(
                  'INVALID_PLACEMENT',
                  '/action/moves',
                  'Choose distinct whole holders without selecting an ancestor and its child.'
                )
              );
        if (action.corrects) {
          const previous = state.equipmentIncidentFacts[action.corrects.factId];
          if (
            !previous ||
            previous.kind !== 'completed-relocation' ||
            previous.intentSha256 !== action.corrects.intentSha256 ||
            previous.incident.incidentId !== incident.id
          )
            return blocked(
              issue(
                'EQUIPMENT_INCIDENT_CONFLICT',
                '/action/corrects',
                'Choose the exact earlier relocation fact.'
              )
            );
        }
        const before = selected.map((item) =>
          inventoryIncidentHolderSnapshot(state, item, context.at)
        );
        for (const move of action.moves) {
          const holder =
            move.item.kind === 'storage'
              ? state.storage[move.item.id]
              : state.vessels[move.item.id];
          if (!holder || !inventoryCurrentLocationPath(state, move.item))
            return blocked(
              issue(
                'CUSTODY_STATE_CONFLICT',
                '/action/moves',
                'Use the existing custody recovery before reporting a current-known relocation.'
              )
            );
          if (
            !holderRoots(state, move.item, incident.id).length &&
            (!inventoryItemContains(
              state,
              { kind: 'storage', id: incident.binding.storageId },
              move.item
            ) ||
              inventoryEquipmentIncidentResolution(state, incident.id))
          )
            return blocked(
              issue(
                'INVALID_PLACEMENT',
                '/action/moves',
                'Choose current retained affected holders for this incident.'
              )
            );
          const dest = move.destination;
          const parent =
            dest.kind === 'located'
              ? dest.storageId
              : dest.kind === 'stack-top'
                ? dest.stackId
                : null;
          if (
            parent &&
            selected.some((item) =>
              inventoryItemContains(state, item, { kind: 'storage', id: parent })
            )
          )
            return blocked(
              issue(
                'INVALID_PLACEMENT',
                '/action/moves',
                'A relocation destination cannot be inside another selected holder.'
              )
            );
          const stack =
            holder.placement.kind === 'located' &&
            state.storage[holder.placement.storageId]?.layout.kind === 'stack'
              ? holder.placement.storageId
              : null;
          if (stack)
            commands.push({
              kind: 'pop-stack',
              stackId: stack,
              item: move.item,
              destination:
                dest.kind === 'stack-top'
                  ? move.item.kind === 'storage'
                    ? { kind: 'root' }
                    : { kind: 'unplaced' }
                  : dest,
            });
          if (dest.kind === 'stack-top')
            commands.push({ kind: 'push-stack', stackId: dest.stackId, item: move.item });
          else if (!stack)
            commands.push(
              move.item.kind === 'storage'
                ? { kind: 'move-storage', id: move.item.id, placement: dest as never }
                : { kind: 'move-vessel', id: move.item.id, placement: dest as never }
            );
        }
        if (commands.length > 256)
          return blocked(
            issue(
              'INVALID_INVENTORY_INPUT',
              '/action/moves',
              'The complete relocation exceeds256 primitive commands. No holders moved.'
            )
          );
        const applied = applyInventoryCommandBatch(
          structuredClone(state),
          { expectedRevision: state.revision, commands },
          context
        );
        if (!applied.ok) return blocked(issue(applied.code, '/action/moves', applied.message));
        candidate = applied.state;
        effects = {
          kind: 'completed-relocation',
          commands,
          holders: selected.map((item, index) => ({
            item,
            before: before[index],
            after: inventoryIncidentHolderSnapshot(candidate, item, context.at),
            descendantVesselIds: Object.values(state.vessels)
              .filter((v) => inventoryItemContains(state, item, { kind: 'vessel', id: v.id }))
              .map((v) => v.id)
              .sort(incidentOrder),
            descendantStockIds: Object.values(state.stocks)
              .filter((s) => inventoryItemContains(state, item, { kind: 'vessel', id: s.vesselId }))
              .map((s) => s.id)
              .sort(incidentOrder),
            reviewRootIds: holderRoots(state, item, incident.id),
          })),
        };
        beforeMeaning = { holders: before, storage: state.storage, vessels: state.vessels };
      }
      record = {
        ...actionProof,
        id: actionId,
        kind: action.kind,
        incident: action.incident,
        effects,
        at: context.at,
        by: context.principal,
      };
      candidate = {
        ...candidate,
        equipmentIncidentFacts: { ...candidate.equipmentIncidentFacts, [record.id]: record },
      };
    }
    const closure = {
      record,
      roots: Object.values(candidate.equipmentIncidentReviewRoots).filter(
        (r) => !state.equipmentIncidentReviewRoots[r.id]
      ),
    };
    if (new TextEncoder().encode(JSON.stringify(closure)).length > 17 * 1024 * 1024)
      return blocked(
        issue(
          'INVALID_INVENTORY_INPUT',
          '/action',
          'The complete incident closure exceeds the inline limit; nothing was recorded.'
        )
      );
    candidate = parseInventoryState(candidate);
    const summary = inventoryEquipmentIncidentActionSummary(
      'initial' in record
        ? candidate.equipmentIncidents[record.id]
        : (candidate.equipmentIncidentFacts[record.id] as T.InventoryEquipmentIncidentOperatorFact)
    );
    return {
      preview: {
        ...header(),
        kind: 'ready',
        record: summary,
        effectCounts: summary.effectCounts,
        commands,
        planDigest: sha(
          canonical({
            schema: 'dnaforge.inventory-equipment-incident-action-plan.v1',
            target,
            intentSha256,
            before: beforeMeaning,
          })
        ),
      },
      state: candidate,
    };
  } catch (error) {
    return blocked(
      issue(
        'INVALID_INVENTORY_INPUT',
        '/action',
        error instanceof Error ? error.message : 'Invalid incident action.'
      )
    );
  }
}
export function inventoryEquipmentIncidentActionPreview(
  state: InventoryState,
  input: T.InventoryEquipmentIncidentActionPreviewInput
): T.InventoryEquipmentIncidentActionPreview {
  return prepare(state, input).preview;
}
export function applyInventoryEquipmentIncidentAction(
  state: InventoryState,
  input: T.InventoryEquipmentIncidentActionApplication,
  context: InventoryExecutionContext
): InventoryTransition {
  const p = prepare(state, {
    ...input,
    asOf: context.at,
    principal: context.principal,
    authority: context.authority,
  });
  if (p.preview.kind === 'no-change') return { ok: true, state };
  if (p.preview.kind === 'blocked')
    return { ok: false, code: p.preview.issues[0].code, message: p.preview.issues[0].message };
  return !p.state || p.preview.planDigest !== input.expectedPlanDigest
    ? {
        ok: false,
        code: 'REVISION_CONFLICT',
        message: 'The exact incident preview changed. Preview it again.',
      }
    : { ok: true, state: p.state };
}
