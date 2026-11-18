import { inventoryTableCanonicalJson as canonical } from './inventory-table-binding';
import {
  inventoryEquipmentIncidentRootReview,
  inventoryIncidentEpisodeTerminal,
} from './inventory-incident-constraints';
import type { InventoryState } from './inventory-types';
import type {
  InventoryEquipmentIncidentOperatorFact,
  InventoryEquipmentIncidentHolderSnapshot,
} from './inventory-equipment-incident-types';
const valid = (condition: unknown, message: string): void => {
  if (!condition) throw TypeError(message);
};
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export function validateInventoryEquipmentIncidents(state: InventoryState): void {
  const roots = state.equipmentIncidentReviewRoots,
    facts = state.equipmentIncidentFacts,
    incidents = state.equipmentIncidents;
  const rootRefs = (ids: readonly string[]) => {
    for (const id of ids)
      valid(Object.hasOwn(roots, id), 'Incident lineage must retain every review root.');
  };
  const holder = (s: InventoryEquipmentIncidentHolderSnapshot) => {
    valid(
      s.item.kind === 'storage'
        ? Object.hasOwn(state.storage, s.item.id)
        : Object.hasOwn(state.vessels, s.item.id),
      'Historical incident holders must retain physical identity.'
    );
    if (s.placement.kind === 'located')
      valid(
        Object.hasOwn(state.storage, s.placement.storageId),
        'Historical incident placements must retain parent identity.'
      );
  };
  for (const stock of Object.values(state.stocks)) {
    rootRefs(stock.incidentReviewRootIds);
    if (stock.source.kind === 'lot')
      for (const id of state.lots[stock.source.lotId]?.incidentReviewRootIds ?? [])
        valid(
          stock.incidentReviewRootIds.includes(id),
          'A received stock retains its source lot incident constraints.'
        );
  }
  for (const lot of Object.values(state.lots)) rootRefs(lot.incidentReviewRootIds);
  const openEquipment = new Set<string>();
  for (const [key, i] of Object.entries(incidents)) {
    valid(
      key === i.id && i.id === i.actionId && i.choices.action.kind === 'report',
      'Incident map identity must match its report.'
    );
    valid(
      Object.hasOwn(state.storage, i.binding.storageId) &&
        i.at === i.contentsWhenRecorded &&
        i.at <= state.lastRecordedAt,
      'Incident retains local equipment identity and native capture time.'
    );
    if (i.choices.action.kind === 'report')
      valid(
        i.choices.action.noticedAt === null || i.choices.action.noticedAt <= i.at,
        'Incident noticed time cannot invent a future observation.'
      );
    const resolutions = Object.values(facts).filter(
      (f) => f.incident.incidentId === i.id && f.kind === 'resolve'
    );
    valid(resolutions.length <= 1, 'An incident has one terminal resolution.');
    if (!resolutions.length) {
      valid(
        !openEquipment.has(i.binding.storageId),
        'Only one open incident per exact equipment identity is supported.'
      );
      openEquipment.add(i.binding.storageId);
    }
    const ids = new Set();
    for (const s of [...i.initial.holders, ...i.initial.vessels]) {
      holder(s);
      const k = s.item.kind + ':' + s.item.id;
      valid(!ids.has(k), 'Initial incident physical subjects must be distinct.');
      ids.add(k);
    }
    rootRefs(i.initial.reviewRootIds);
    const original = Object.values(roots)
      .filter((r) => r.incident.incidentId === i.id && r.origin === 'initial-cohort')
      .map((r) => r.id)
      .sort();
    valid(
      same(original, i.initial.reviewRootIds),
      'Initial cohort roots are immutable and complete.'
    );
    for (const vessel of i.initial.vessels) {
      const matching = original
        .map((id) => roots[id])
        .filter((r) => r.snapshot.vessel.item.id === vessel.item.id);
      valid(
        vessel.contents.kind === 'declared-empty' ? matching.length === 0 : matching.length === 1,
        'Initial known and unknown contents require exactly their original review obligation.'
      );
      if (matching[0])
        valid(
          same(matching[0].snapshot.vessel, vessel),
          'Root retains the exact initial vessel observation.'
        );
    }
  }
  for (const [key, r] of Object.entries(roots)) {
    const i = incidents[r.incident.incidentId];
    valid(
      key === r.id && i && i.intentSha256 === r.incident.intentSha256,
      'Review roots reference the exact immutable incident.'
    );
    valid(
      r.at >= i.at && r.at <= state.lastRecordedAt,
      'Root capture stays inside recorded incident history.'
    );
    holder(r.snapshot.vessel);
    if (r.origin === 'initial-cohort')
      valid(r.at === i.at, 'Initial roots share the original native capture time.');
    if (r.binding.kind === 'stock') {
      valid(
        r.originSubject.kind === 'stock' &&
          r.snapshot.kind === 'stock' &&
          r.qualification === 'identified-stock-at-recording',
        'Stock roots retain a stock subject.'
      );
      const stock = state.stocks[r.binding.stockId];
      valid(
        stock && stock.incidentReviewRootIds.includes(r.id),
        'Directly affected stock cannot shed its incident obligation.'
      );
      if (r.snapshot.kind === 'stock') {
        valid(
          r.snapshot.before.id === r.binding.stockId &&
            r.snapshot.before.vesselId === r.snapshot.vessel.item.id,
          'Stock root snapshot identifies the bound physical subject.'
        );
        rootRefs(r.snapshot.before.incidentReviewRootIds);
      }
    } else {
      valid(
        r.originSubject.kind === 'contents-episode' &&
          r.snapshot.kind === 'contents-episode' &&
          Object.hasOwn(state.vessels, r.binding.vesselId),
        'Contents roots retain a vessel episode.'
      );
      valid(
        r.snapshot.vessel.contents.kind === 'unidentified' ||
          r.snapshot.vessel.contents.kind === 'unobserved',
        'Contents episode cannot assert an initially empty or already identified stock.'
      );
      if (r.qualification === 'confirmed-unidentified-at-open')
        valid(
          r.origin === 'initial-cohort' && r.snapshot.vessel.contents.kind === 'unidentified',
          'Only initial confirmed unidentified contents qualify for inbound identification.'
        );
      else
        valid(
          r.qualification === 'possible-unconfirmed',
          'Unknown contents remain explicitly unconfirmed.'
        );
      const terminal = inventoryIncidentEpisodeTerminal(state, r.id);
      if (terminal?.kind === 'contents-identified') {
        const stock = state.stocks[terminal.binding.stockId!];
        valid(
          stock &&
            stock.incidentReviewRootIds.includes(r.id) &&
            stock.vesselId === terminal.binding.vesselId,
          'Identified original contents retain the same root.'
        );
      } else if (terminal?.kind === 'contents-episode-closed') {
        for (const stock of Object.values(state.stocks))
          valid(
            !stock.incidentReviewRootIds.includes(r.id),
            'A closed unidentified episode cannot bind unrelated future stock.'
          );
        for (const lot of Object.values(state.lots))
          valid(
            !lot.incidentReviewRootIds.includes(r.id),
            'A closed unidentified episode cannot create material lineage.'
          );
      } else {
        const vesselId = r.binding.vesselId,
          vessel = state.vessels[vesselId];
        valid(
          vessel.contentsKnowledge.kind !== 'recorded' &&
            !Object.values(state.stocks).some((s) => s.vesselId === vesselId),
          'Open contents episodes require explicit identification or empty closure.'
        );
      }
    }
    inventoryEquipmentIncidentRootReview(state, r.id);
  }
  const graph = new Map<string, readonly string[]>();
  const terminalRoots = new Set<string>();
  const observationChildren = new Set<string>();
  for (const [key, f] of Object.entries(facts)) {
    const i = incidents[f.incident.incidentId];
    valid(
      key === f.id &&
        i &&
        i.intentSha256 === f.incident.intentSha256 &&
        f.at >= i.at &&
        f.at <= state.lastRecordedAt,
      'Incident facts retain exact incident identity and recording lifetime.'
    );
    if (!('choices' in f)) {
      const r = roots[f.root.rootId];
      valid(
        r &&
          r.intentSha256 === f.root.intentSha256 &&
          r.incident.incidentId === i.id &&
          r.binding.kind === 'contents-episode' &&
          r.binding.vesselId === f.binding.vesselId,
        'Automatic contents fact retains its original root and current vessel binding.'
      );
      valid(
        !terminalRoots.has(r.id),
        'Only one identified or closed terminal is allowed per contents episode.'
      );
      terminalRoots.add(r.id);
      valid(
        f.originalTransition.inventoryRevision >= 1,
        'Contents terminal retains its accepted transition revision.'
      );
      if (f.kind === 'contents-identified')
        valid(
          f.binding.stockId !== null && Object.hasOwn(state.stocks, f.binding.stockId),
          'Identified bridge retains its stock identity.'
        );
      continue;
    }
    const a = f.choices.action;
    valid(
      a.kind === f.kind && f.actionId === f.id,
      'Operator facts retain original action meaning.'
    );
    const parents: string[] = [];
    if (a.kind === 'report') throw TypeError('Report belongs in incident map.');
    if (a.kind === 'impact-review')
      for (const s of a.subjects) {
        const r = roots[s.root.rootId];
        valid(
          r &&
            r.intentSha256 === s.root.intentSha256 &&
            r.incident.incidentId === i.id &&
            f.at >= r.at,
          'Review binds exact retained subject roots.'
        );
        if (s.supersedes) {
          const prev = facts[s.supersedes.factId];
          valid(
            prev &&
              'choices' in prev &&
              prev.kind === 'impact-review' &&
              prev.intentSha256 === s.supersedes.intentSha256 &&
              prev.incident.incidentId === i.id &&
              prev.at <= f.at &&
              prev.choices.action.kind === 'impact-review' &&
              prev.choices.action.subjects.some((x) => x.root.rootId === r.id),
            'Review predecessor must review the same exact root.'
          );
          parents.push(prev.id);
        }
      }
    if (a.kind === 'manual-temperature') {
      valid(
        f.effects.kind === 'manual-temperature',
        'Manual fact retains its recording configuration.'
      );
      if (a.reading.kind === 'measured')
        valid(
          a.reading.observedAt <= f.at,
          'A new manual reading cannot be recorded before its claimed observation.'
        );
      if (a.supersedes) {
        const prev = facts[a.supersedes.factId];
        valid(
          prev &&
            prev.kind === 'manual-temperature' &&
            prev.intentSha256 === a.supersedes.intentSha256 &&
            prev.incident.incidentId === i.id &&
            prev.at <= f.at &&
            !observationChildren.has(prev.id),
          'Manual correction uses one exact unsuperseded observation.'
        );
        observationChildren.add(prev.id);
        parents.push(prev.id);
      }
    }
    if (a.kind === 'completed-relocation') {
      valid(
        f.effects.kind === 'completed-relocation',
        'Completed relocation retains its exact physical effects.'
      );
      if (f.effects.kind === 'completed-relocation') {
        valid(
          f.effects.holders.length === a.moves.length,
          'Completed relocation retains every selected holder.'
        );
        for (const [index, e] of f.effects.holders.entries()) {
          holder(e.before);
          holder(e.after);
          valid(
            same(e.item, a.moves[index].item) &&
              same(e.before.item, e.item) &&
              same(e.after.item, e.item),
            'Relocation retains the exact selected holder in ordered before/after facts.'
          );
          for (const id of e.descendantStockIds)
            valid(Object.hasOwn(state.stocks, id), 'Relocation stock descendants retain identity.');
          for (const id of e.descendantVesselIds)
            valid(
              Object.hasOwn(state.vessels, id),
              'Relocation vessel descendants retain identity.'
            );
          rootRefs(e.reviewRootIds);
          const d = a.moves[index].destination;
          valid(
            d.kind === 'stack-top'
              ? e.after.placement.kind === 'located' && e.after.placement.storageId === d.stackId
              : same(e.after.placement, d),
            'Relocation after placement matches its exact requested destination.'
          );
        }
        for (const command of f.effects.commands) {
          valid(
            ['move-storage', 'move-vessel', 'pop-stack', 'push-stack'].includes(command.kind),
            'Incident relocation cannot smuggle a material or unrelated metadata command.'
          );
          const item =
            command.kind === 'move-storage'
              ? { kind: 'storage', id: command.id }
              : command.kind === 'move-vessel'
                ? { kind: 'vessel', id: command.id }
                : 'item' in command
                  ? command.item
                  : null;
          valid(
            item && a.moves.some((m) => same(m.item, item)),
            'Relocation commands operate only selected holders.'
          );
        }
      }
      if (a.corrects) {
        const prev = facts[a.corrects.factId];
        valid(
          prev &&
            prev.kind === 'completed-relocation' &&
            prev.intentSha256 === a.corrects.intentSha256 &&
            prev.incident.incidentId === i.id,
          'Relocation correction links its exact earlier fact.'
        );
      }
    }
    graph.set(f.id, parents);
  }
  const done = new Set<string>();
  function visit(id: string, path: Set<string>) {
    valid(!path.has(id), 'Incident supersession cannot contain a cycle.');
    if (done.has(id)) return;
    path.add(id);
    for (const p of graph.get(id) ?? []) visit(p, path);
    path.delete(id);
    done.add(id);
  }
  for (const id of graph.keys()) visit(id, new Set());
}
