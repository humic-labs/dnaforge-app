import { inventoryTableCanonicalJson as canonical } from './inventory-table-binding';
import { inventoryItemContains } from './inventory-placement';
import { inventoryItemCustody, inventoryCurrentLocationPath } from './inventory-custody';
import { inventoryVesselContents } from './inventory-contents';
import { inventoryUseStockIds } from './inventory-validity';
import {
  inventoryEquipmentIncidentReviewRootId,
  inventoryEquipmentIncidentReviewRootIntentSha256,
  inventoryEquipmentIncidentContentsFactId,
  inventoryEquipmentIncidentContentsFactIntentSha256,
} from './inventory-equipment-incident-identity';
import type {
  InventoryCommand,
  InventoryPhysicalExecutionContext,
  InventoryPhysicalItem,
  InventoryState,
  InventoryTransition,
  InventoryStock,
  InventoryLot,
} from './inventory-types';
import type * as T from './inventory-equipment-incident-types';
export type IncidentMutable = Omit<
  T.InventoryEquipmentIncidentState,
  | 'stocks'
  | 'lots'
  | 'equipmentIncidents'
  | 'equipmentIncidentReviewRoots'
  | 'equipmentIncidentFacts'
> & {
  stocks: Record<string, InventoryStock>;
  lots: Record<string, InventoryLot>;
  equipmentIncidents: Record<string, T.InventoryEquipmentIncident>;
  equipmentIncidentReviewRoots: Record<string, T.InventoryEquipmentIncidentReviewRoot>;
  equipmentIncidentFacts: Record<string, T.InventoryEquipmentIncidentFact>;
};
export const incidentOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function inventoryIncidentReviewRootIds(
  ...values: readonly (readonly string[] | undefined)[]
): readonly string[] {
  const rows = [...new Set(values.flatMap((v) => v ?? []))].sort(incidentOrder);
  if (rows.length > 10000) throw TypeError('Incident lineage exceeds10000 retained roots.');
  return rows;
}
export function inventoryEquipmentIncidentResolution(
  state: T.InventoryEquipmentIncidentState,
  id: string
): T.InventoryEquipmentIncidentOperatorFact | null {
  return (
    (Object.values(state.equipmentIncidentFacts).find(
      (f) => f.kind === 'resolve' && f.incident.incidentId === id
    ) as T.InventoryEquipmentIncidentOperatorFact) ?? null
  );
}
export function inventoryEquipmentIncidentRootReview(
  state: T.InventoryEquipmentIncidentState,
  id: string
): T.InventoryEquipmentIncidentRootReview {
  const reviews = Object.values(state.equipmentIncidentFacts).filter(
    (f): f is T.InventoryEquipmentIncidentOperatorFact =>
      f.kind === 'impact-review' &&
      'choices' in f &&
      f.choices.action.kind === 'impact-review' &&
      f.choices.action.subjects.some((s) => s.root.rootId === id)
  );
  const replaced = new Set(
    reviews.flatMap((f) =>
      f.choices.action.kind === 'impact-review'
        ? f.choices.action.subjects
            .filter((s) => s.root.rootId === id)
            .flatMap((s) => (s.supersedes ? [s.supersedes.factId] : []))
        : []
    )
  );
  const heads = reviews.filter((f) => !replaced.has(f.id));
  if (heads.length > 1) throw TypeError('Incident review cannot have competing heads.');
  const head = heads[0];
  if (!head || head.choices.action.kind !== 'impact-review')
    return { status: 'pending', head: null, disposition: null, restriction: 'pending' };
  const d = head.choices.action.disposition;
  return {
    status: 'reviewed',
    head: { factId: head.id, intentSha256: head.intentSha256 },
    disposition: d,
    restriction:
      d === 'keep-incident-restriction'
        ? 'kept'
        : head.by.kind === 'imported'
          ? 'imported-removal-unconfirmed'
          : 'removed',
  };
}
export function inventoryIncidentBlockedRootIds(
  state: T.InventoryEquipmentIncidentState,
  ids: readonly string[]
): readonly string[] {
  return inventoryIncidentReviewRootIds(ids).filter(
    (id) => inventoryEquipmentIncidentRootReview(state, id).restriction !== 'removed'
  );
}
export function inventoryIncidentEpisodeTerminal(
  state: T.InventoryEquipmentIncidentState,
  id: string
): T.InventoryEquipmentIncidentContentsFact | null {
  return (
    Object.values(state.equipmentIncidentFacts).find(
      (f): f is T.InventoryEquipmentIncidentContentsFact =>
        (f.kind === 'contents-identified' || f.kind === 'contents-episode-closed') &&
        f.root.rootId === id
    ) ?? null
  );
}
export function inventoryIncidentVesselEpisodeRoots(
  state: T.InventoryEquipmentIncidentState,
  vesselId: string
) {
  return Object.values(state.equipmentIncidentReviewRoots).filter(
    (r) =>
      r.binding.kind === 'contents-episode' &&
      r.binding.vesselId === vesselId &&
      !inventoryIncidentEpisodeTerminal(state, r.id)
  );
}
export function inventoryIncidentHolderSnapshot(
  state: T.InventoryEquipmentIncidentState,
  item: InventoryPhysicalItem,
  at: number
): T.InventoryEquipmentIncidentHolderSnapshot {
  const row = item.kind === 'storage' ? state.storage[item.id] : state.vessels[item.id];
  if (!row) throw TypeError('Incident holder does not exist.');
  const c = inventoryItemCustody(state, item, undefined, at);
  return {
    item: { ...item },
    name: row.name,
    placement: structuredClone(row.placement),
    custody: structuredClone(c.state),
    lastKnown: structuredClone(c.lastKnown),
    currentPath: structuredClone(inventoryCurrentLocationPath(state, item)),
  };
}
export function inventoryIncidentVesselSnapshot(
  state: T.InventoryEquipmentIncidentState,
  id: string,
  at: number
): T.InventoryEquipmentIncidentVesselSnapshot {
  const row = state.vessels[id];
  if (!row) throw TypeError('Incident vessel does not exist.');
  return {
    ...inventoryIncidentHolderSnapshot(state, { kind: 'vessel', id }, at),
    vesselKind: row.kind,
    contents: inventoryVesselContents(state, id)!,
  };
}
export function inventoryIncidentMakeRoot(
  state: T.InventoryEquipmentIncidentState,
  incident: T.InventoryEquipmentIncident,
  vesselId: string,
  context: InventoryPhysicalExecutionContext,
  revision: number,
  initial: boolean
): T.InventoryEquipmentIncidentReviewRoot | null {
  const vessel = inventoryIncidentVesselSnapshot(state, vesselId, context.at),
    stock = Object.values(state.stocks).find((s) => s.vesselId === vesselId);
  if (!stock && vessel.contents.kind === 'declared-empty') return null;
  const episode =
    1 +
    Math.max(
      -1,
      ...Object.values(state.equipmentIncidentReviewRoots)
        .filter(
          (r) =>
            r.incident.incidentId === incident.id &&
            r.originSubject.kind === 'contents-episode' &&
            r.binding.kind === 'contents-episode' &&
            r.binding.vesselId === vesselId
        )
        .map((r) => (r.originSubject.kind === 'contents-episode' ? r.originSubject.episode : -1))
    );
  const meaning = {
    incident: { incidentId: incident.id, intentSha256: incident.intentSha256 },
    originSubject: stock
      ? { kind: 'stock' as const, stockId: stock.id }
      : { kind: 'contents-episode' as const, vesselId, episode },
    originRevision: revision,
    origin: initial ? ('initial-cohort' as const) : ('later-knowledge-observation' as const),
    qualification: stock
      ? ('identified-stock-at-recording' as const)
      : initial && vessel.contents.kind === 'unidentified'
        ? ('confirmed-unidentified-at-open' as const)
        : ('possible-unconfirmed' as const),
  };
  return {
    ...meaning,
    id: inventoryEquipmentIncidentReviewRootId(meaning),
    intentSha256: inventoryEquipmentIncidentReviewRootIntentSha256(meaning),
    originalOwner: structuredClone(incident.originalOwner),
    binding: stock ? { kind: 'stock', stockId: stock.id } : { kind: 'contents-episode', vesselId },
    snapshot: stock
      ? { kind: 'stock', vessel, before: structuredClone(stock) }
      : { kind: 'contents-episode', vessel },
    at: context.at,
    by: structuredClone(context.principal),
  };
}
export function inventoryIncidentUseGuard(
  state: T.InventoryEquipmentIncidentState,
  command: InventoryCommand
): Extract<InventoryTransition, { ok: false }> | null {
  const ids = inventoryUseStockIds(state, command).stockIds.flatMap(
    (id) => state.stocks[id]?.incidentReviewRootIds ?? []
  );
  if (command.kind === 'reserve-item')
    for (const root of Object.values(state.equipmentIncidentReviewRoots))
      if (
        root.binding.kind === 'contents-episode' &&
        !inventoryIncidentEpisodeTerminal(state, root.id) &&
        inventoryItemContains(state, command.item, { kind: 'vessel', id: root.binding.vesselId })
      )
        ids.push(root.id);
  const blocked = inventoryIncidentBlockedRootIds(state, ids);
  return blocked.length
    ? {
        ok: false,
        code: 'INCIDENT_REVIEW_REQUIRED',
        message:
          'Incident review restrictions block this reservation or use. Rescue movement remains subject to ordinary access rules.',
      }
    : null;
}
export function inventoryIncidentCaptureTransition(
  state: T.InventoryEquipmentIncidentState
): T.InventoryEquipmentIncidentState | null {
  return Object.keys(state.equipmentIncidents).length
    ? {
        ...state,
        storage: { ...state.storage },
        vessels: { ...state.vessels },
        stocks: { ...state.stocks },
        lots: { ...state.lots },
        equipmentIncidentReviewRoots: { ...state.equipmentIncidentReviewRoots },
        equipmentIncidentFacts: { ...state.equipmentIncidentFacts },
      }
    : null;
}
function terminal(
  after: IncidentMutable,
  root: T.InventoryEquipmentIncidentReviewRoot,
  stockId: string | null,
  reason: string,
  context: InventoryPhysicalExecutionContext,
  revision: number
) {
  if (inventoryIncidentEpisodeTerminal(after, root.id)) return;
  const data = {
    kind: stockId ? ('contents-identified' as const) : ('contents-episode-closed' as const),
    incident: root.incident,
    root: { rootId: root.id, intentSha256: root.intentSha256 },
    originalTransition: {
      inventoryRevision: revision,
      vesselId:
        root.binding.kind === 'contents-episode'
          ? root.binding.vesselId
          : root.snapshot.vessel.item.id,
      stockId,
      reason,
    },
  };
  const fact: T.InventoryEquipmentIncidentContentsFact = {
    ...data,
    id: inventoryEquipmentIncidentContentsFactId(data),
    intentSha256: inventoryEquipmentIncidentContentsFactIntentSha256(data),
    binding: { vesselId: data.originalTransition.vesselId, stockId },
    at: context.at,
    by: context.principal,
  };
  after.equipmentIncidentFacts = { ...after.equipmentIncidentFacts, [fact.id]: fact };
}
export function inventoryIncidentTransition(
  before: T.InventoryEquipmentIncidentState | null,
  after: IncidentMutable,
  command: InventoryCommand,
  context: InventoryPhysicalExecutionContext | undefined,
  revision: number
): Extract<InventoryTransition, { ok: false }> | null {
  if (!before) return null;
  if (!context)
    return {
      ok: false,
      code: 'CONTEXT_REQUIRED',
      message: 'Incident-aware physical transitions require native attribution and time.',
    };
  const opens = Object.values(after.equipmentIncidents).filter(
    (i) => !inventoryEquipmentIncidentResolution(after, i.id)
  );
  const fail = () => ({
    ok: false as const,
    code: 'INCIDENT_INBOUND_BLOCKED' as const,
    message: 'This equipment incident is open. New holders or material cannot enter its scope.',
  });
  for (const incident of opens) {
    const scope = { kind: 'storage' as const, id: incident.binding.storageId };
    for (const [kind, rows] of [
      ['storage', after.storage],
      ['vessel', after.vessels],
    ] as const)
      for (const id of Object.keys(rows))
        if (
          inventoryItemContains(after, scope, { kind, id }) &&
          !inventoryItemContains(before, scope, { kind, id })
        )
          return fail();
  }
  for (const stock of Object.values(after.stocks))
    if (!before.stocks[stock.id]) {
      const v = before.vessels[stock.vesselId];
      const roots =
        v?.contentsKnowledge.kind !== 'recorded'
          ? inventoryIncidentVesselEpisodeRoots(before, stock.vesselId)
          : [];
      for (const incident of opens)
        if (
          inventoryItemContains(
            after,
            { kind: 'storage', id: incident.binding.storageId },
            { kind: 'vessel', id: stock.vesselId }
          )
        ) {
          const qualified = roots.some(
            (r) =>
              r.incident.incidentId === incident.id &&
              r.qualification === 'confirmed-unidentified-at-open' &&
              v?.contentsKnowledge.kind === 'unidentified'
          );
          const nestedBridge = Object.values(after.equipmentIncidentFacts).some(
            (f) =>
              f.kind === 'contents-identified' &&
              f.binding.stockId === stock.id &&
              f.incident.incidentId === incident.id &&
              after.equipmentIncidentReviewRoots[f.root.rootId]?.qualification ===
                'confirmed-unidentified-at-open' &&
              v?.contentsKnowledge.kind === 'unidentified'
          );
          if (!qualified && !nestedBridge) return fail();
        }
      if (v?.contentsKnowledge.kind !== 'recorded')
        for (const root of roots) {
          after.stocks[stock.id] = {
            ...after.stocks[stock.id],
            incidentReviewRootIds: inventoryIncidentReviewRootIds(
              after.stocks[stock.id].incidentReviewRootIds,
              [root.id]
            ),
          };
          terminal(
            after,
            root,
            stock.id,
            'reason' in command ? command.reason : 'Existing contents identified',
            context,
            revision
          );
        }
    }
  if (command.kind === 'transfer' && command.destination.kind === 'existing-stock') {
    const vessel = after.stocks[command.destination.stockId]?.vesselId;
    if (
      vessel &&
      opens.some((i) =>
        inventoryItemContains(
          after,
          { kind: 'storage', id: i.binding.storageId },
          { kind: 'vessel', id: vessel }
        )
      )
    )
      return fail();
  }
  for (const [id, lot] of Object.entries(after.lots)) {
    let roots = inventoryIncidentReviewRootIds(
      lot.incidentReviewRootIds,
      before.lots[id]?.incidentReviewRootIds
    );
    if (!before.lots[id] && lot.origin.kind !== 'received') {
      const inputs =
        lot.origin.kind === 'diluted' ? [lot.origin.sample, lot.origin.diluent] : lot.origin.inputs;
      roots = inventoryIncidentReviewRootIds(
        roots,
        ...inputs.map((i) => after.stocks[i.stockId]?.incidentReviewRootIds)
      );
    }
    if (canonical(roots) !== canonical(lot.incidentReviewRootIds))
      after.lots[id] = { ...lot, incidentReviewRootIds: roots };
  }
  for (const [id, stock] of Object.entries(after.stocks)) {
    let roots = inventoryIncidentReviewRootIds(
      stock.incidentReviewRootIds,
      before.stocks[id]?.incidentReviewRootIds,
      stock.source.kind === 'lot' ? after.lots[stock.source.lotId]?.incidentReviewRootIds : []
    );
    if (
      command.kind === 'transfer' &&
      (command.destination.kind === 'new-stock'
        ? command.destination.stockId
        : command.destination.stockId) === id
    )
      roots = inventoryIncidentReviewRootIds(
        roots,
        before.stocks[command.sourceStockId]?.incidentReviewRootIds
      );
    if (canonical(roots) !== canonical(stock.incidentReviewRootIds))
      after.stocks[id] = { ...stock, incidentReviewRootIds: roots };
  }
  for (const [id, vessel] of Object.entries(after.vessels)) {
    const old = before.vessels[id];
    if (!old || old.contentsKnowledge === vessel.contentsKnowledge) continue;
    if (
      vessel.contentsKnowledge.kind === 'recorded' &&
      !Object.values(after.stocks).some((s) => s.vesselId === id)
    )
      for (const root of inventoryIncidentVesselEpisodeRoots(before, id))
        terminal(
          after,
          root,
          null,
          'reason' in command ? command.reason : 'Contents declared empty',
          context,
          revision
        );
    if (
      vessel.contentsKnowledge.kind !== 'recorded' &&
      !inventoryIncidentVesselEpisodeRoots(after, id).length
    )
      for (const incident of opens)
        if (
          inventoryItemContains(
            after,
            { kind: 'storage', id: incident.binding.storageId },
            { kind: 'vessel', id }
          )
        ) {
          const root = inventoryIncidentMakeRoot(after, incident, id, context, revision, false);
          if (root)
            after.equipmentIncidentReviewRoots = {
              ...after.equipmentIncidentReviewRoots,
              [root.id]: root,
            };
        }
  }
  return null;
}
