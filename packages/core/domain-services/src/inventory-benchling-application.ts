import { applyInventoryCommandBatch } from './inventory-state';
import {
  createInventoryState,
  MAX_INVENTORY_BATCH_COMMANDS,
  type InventoryCommand,
  type InventoryState,
  type InventoryExecutionContext,
  type InventoryVesselPlacement,
  type InventoryStoragePlacement,
} from './inventory-types';
import { parseInventoryExecutionContext, parseInventoryState } from './inventory-validation';
import { inventoryHierarchyPreview, inventoryHierarchyStorageId } from './inventory-hierarchy';
import {
  INVENTORY_HIERARCHY_COLUMNS,
  type InventoryHierarchyBinding,
  type InventoryHierarchyFields,
} from './inventory-hierarchy-types';
import { inventoryStoragePositions, inventoryWellId } from './inventory-layout';
import {
  inventoryTableBindingKey,
  inventoryTableCanonicalJson as canonical,
  inventoryTableRecordIds,
  inventoryTableSha256,
  inventoryTableSourceBaseline,
} from './inventory-table-binding';
import {
  inventoryReceiveSourceKey,
  inventoryReceiveTableRowSha256,
} from './inventory-receive-source';
import type { InventoryTableBinding, InventoryTableIssue } from './inventory-table-types';
import type { InventoryVesselBinding } from './inventory-vessel-binding-types';
import type {
  InventoryBenchlingCaptureApplication,
  InventoryBenchlingCapturePreview,
  InventoryBenchlingCapturePreviewInput,
  InventoryResolvedBenchlingCaptureOptions,
} from './inventory-benchling-application-types';
import { benchlingStockFacts, benchlingChoices } from './inventory-benchling-application-stocks';
import {
  BenchlingApplicationError,
  fail,
  recordKey,
  resolveInventoryBenchlingApplicationSource,
  type SourcePlacement,
} from './inventory-benchling-application-source';
export { normalizeInventoryBenchlingCaptureStocks } from './inventory-benchling-application-stocks';
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortedChoices = (options: InventoryBenchlingCapturePreviewInput['options']) => ({
  ...options,
  records: [...options.records].sort((a, b) => order(recordKey(a.record), recordKey(b.record))),
  sourceIssueDispositions: [...options.sourceIssueDispositions].sort((a, b) =>
    order(
      canonical([a.code, a.responseId, a.bodyPointer]),
      canonical([b.code, b.responseId, b.bodyPointer])
    )
  ),
  uncapturedPositions: options.uncapturedPositions
    .map((item) => ({ ...item, positions: [...item.positions].sort(order) }))
    .sort((a, b) => order(a.storageSourceId, b.storageSourceId)),
});
const csv = (rows: readonly InventoryHierarchyFields[]) => {
  const quote = (value: string) =>
    /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return (
    INVENTORY_HIERARCHY_COLUMNS.join(',') +
    '\n' +
    rows
      .map((row) => INVENTORY_HIERARCHY_COLUMNS.map((column) => quote(row[column])).join(','))
      .join('\n') +
    '\n'
  );
};
export function inventoryBenchlingCapturePreview(
  state: InventoryState | null,
  input: InventoryBenchlingCapturePreviewInput
): InventoryBenchlingCapturePreview {
  const rows: InventoryBenchlingCapturePreview['rows'][number][] = [];
  const uncapturedPositions: InventoryBenchlingCapturePreview['uncapturedPositions'][number][] = [];
  const sourceSha256 =
    typeof input.sourceText === 'string' ? inventoryTableSha256(input.sourceText) : null;
  const facts = () => ({
    schema: 'dnaforge.inventory-benchling-application-preview.v1' as const,
    sourceSha256,
    target: { ...input.target },
    rows,
    uncapturedPositions,
  });
  try {
    const previous = state === null ? createInventoryState() : parseInventoryState(state);
    const context = parseInventoryExecutionContext({
      at: input.asOf,
      principal: input.principal,
      authority: input.authority,
    });
    if (
      !inventoryReceiveSourceKey(input.target.projectId) ||
      !inventoryReceiveSourceKey(input.target.inventoryId) ||
      input.target.present !== (state !== null) ||
      input.target.revision !== previous.revision
    )
      fail(
        'BENCHLING_TARGET_CHANGED',
        '/target',
        'The original scope, presence and revision must match current inventory.'
      );
    if (context.at < previous.lastRecordedAt)
      fail('CLOCK_REGRESSION', '/asOf', 'The trusted clock precedes recorded inventory.');
    const source = resolveInventoryBenchlingApplicationSource(
      input.sourceText,
      input.options,
      input.maxBytes
    );
    const choices = sortedChoices(source.choices);
    const namespace = source.inspection.capture!.namespace;
    const commands: InventoryCommand[] = [];
    const hierarchyBindingAdditions: Record<string, InventoryHierarchyBinding> =
      Object.create(null);
    const vesselBindingAdditions: Record<string, InventoryVesselBinding> = Object.create(null);
    const tableBindingAdditions: Record<string, InventoryTableBinding> = Object.create(null);
    const targetStorage = new Map<string, string>();
    const targetVessels = new Map<string, string>();
    const resolvedTargets: InventoryResolvedBenchlingCaptureOptions['resolvedTargets'][number][] =
      [];
    let candidate = previous;
    const append = (additions: readonly InventoryCommand[]) => {
      if (!additions.length) return;
      if (commands.length + additions.length > MAX_INVENTORY_BATCH_COMMANDS)
        fail(
          'BENCHLING_BATCH_TOO_LARGE',
          '/commands',
          `The complete proposal exceeds ${MAX_INVENTORY_BATCH_COMMANDS} existing commands and will not be split.`
        );
      const transition = applyInventoryCommandBatch(
        candidate,
        { expectedRevision: candidate.revision, commands: additions },
        context
      );
      if (!transition.ok) fail(transition.code, '/commands', transition.message);
      commands.push(...additions);
      candidate = { ...transition.state, revision: previous.revision };
    };
    const reconcile = (
      record: { kind: string; sourceId: string },
      targetId: string,
      message: string
    ): never => {
      const issue = {
        code: 'BENCHLING_SOURCE_NEEDS_RECONCILIATION',
        pointer: `/records/${record.sourceId}`,
        message,
      };
      rows.push({
        record: record as (typeof rows)[number]['record'],
        kind: 'needs-reconciliation',
        targetId,
        issues: [issue],
      });
      throw new BenchlingApplicationError(issue);
    };
    for (const binding of Object.values(previous.hierarchyBindings))
      if (binding.namespace === namespace) targetStorage.set(binding.sourceId, binding.storageId);
    for (const item of source.storage) {
      const binding =
        previous.hierarchyBindings[inventoryTableBindingKey(namespace, item.record.sourceId)];
      const id =
        binding?.storageId ??
        inventoryHierarchyStorageId(input.target, namespace, item.record.sourceId);
      if (binding && binding.rowSha256 !== item.rowSha256)
        reconcile(
          item.record,
          id,
          'The physical source facts or decisions changed for the original storage target.'
        );
      targetStorage.set(item.record.sourceId, id);
      resolvedTargets.push({
        record: {
          kind: item.record.kind as 'location' | 'box' | 'plate',
          sourceId: item.record.sourceId,
        },
        target: { kind: 'storage', id },
      });
    }
    const resolvePlacement = (
      placement: SourcePlacement
    ): InventoryStoragePlacement | InventoryVesselPlacement => {
      if (placement.kind === 'root' || placement.kind === 'unplaced')
        return { kind: placement.kind };
      const storageId =
        placement.kind === 'existing'
          ? placement.storageId
          : targetStorage.get(placement.parentSourceId);
      if (!storageId)
        fail(
          'BENCHLING_PARENT_UNRESOLVED',
          '/choices/placement',
          'The selected source parent has no imported or previously bound storage identity.'
        );
      return { kind: 'located', storageId, slotId: placement.slot };
    };
    const unboundStorage = source.storage.filter(
      (item) =>
        !previous.hierarchyBindings[inventoryTableBindingKey(namespace, item.record.sourceId)]
    );
    const newStorageIds = new Set(
      unboundStorage.map((item) => targetStorage.get(item.record.sourceId)!)
    );
    if (unboundStorage.length) {
      const parents = new Map<string, string>();
      const hierarchyRows: InventoryHierarchyFields[] = unboundStorage.map((item) => {
        const destination = resolvePlacement(item.placement);
        if (destination.kind === 'unplaced')
          fail('BENCHLING_STORAGE_PLACEMENT_INVALID', '/choices', 'Storage cannot be unplaced.');
        const placement = item.placement;
        const sourceParent =
          placement.kind === 'source' &&
          unboundStorage.some((parent) => parent.record.sourceId === placement.parentSourceId);
        if (destination.kind === 'located' && !sourceParent)
          parents.set(destination.storageId, destination.storageId);
        return {
          source_id: item.record.sourceId,
          name: item.name,
          layout_kind: item.layout.kind,
          positions: item.layout.kind === 'named' ? JSON.stringify(item.layout.slots) : '',
          rows: 'rows' in item.layout ? String(item.layout.rows) : '',
          columns: 'columns' in item.layout ? String(item.layout.columns) : '',
          capacity: item.layout.kind === 'stack' ? String(item.layout.capacity) : '',
          parent_kind: destination.kind === 'root' ? 'root' : sourceParent ? 'source' : 'existing',
          parent_key:
            destination.kind === 'root'
              ? ''
              : sourceParent && item.placement.kind === 'source'
                ? item.placement.parentSourceId
                : destination.storageId,
          slot: destination.kind === 'located' ? destination.slotId : '',
        };
      });
      const hierarchy = inventoryHierarchyPreview(state, {
        target: input.target,
        sourceText: csv(hierarchyRows),
        options: {
          namespace,
          delimiter: ',',
          parents: [...parents].map(([key, storageId]) => ({ key, storageId })),
          skips: [],
        },
        asOf: context.at,
        principal: context.principal,
        authority: context.authority,
        maxBytes: input.maxBytes,
      });
      if (hierarchy.kind !== 'ready')
        throw new BenchlingApplicationError(
          hierarchy.issues[0] ?? {
            code: 'BENCHLING_HIERARCHY_INVALID',
            pointer: '/choices',
            message: 'The new storage proposal is not ready.',
          }
        );
      append(hierarchy.commands);
      for (const item of unboundStorage) {
        const key = inventoryTableBindingKey(namespace, item.record.sourceId);
        hierarchyBindingAdditions[key] = {
          ...hierarchy.bindingAdditions[key],
          rowSha256: item.rowSha256,
        };
      }
    }
    for (const item of source.storage)
      rows.push({
        record: {
          kind: item.record.kind as 'location' | 'box' | 'plate',
          sourceId: item.record.sourceId,
        },
        kind: newStorageIds.has(targetStorage.get(item.record.sourceId)!) ? 'create' : 'unchanged',
        targetId: targetStorage.get(item.record.sourceId)!,
        issues: [],
      });
    const newVesselIds = new Set<string>();
    const vesselCreates: InventoryCommand[] = [];
    const claimedWells = new Set<string>();
    for (const item of source.vessels) {
      const key = inventoryTableBindingKey(namespace, item.record.sourceId);
      const binding = previous.vesselBindings[key];
      const destination =
        item.target.kind === 'fixed-well' ? null : resolvePlacement(item.target.placement);
      let id: string;
      let origin: InventoryVesselBinding['origin'];
      if (item.target.kind === 'fixed-well') {
        const plateId = targetStorage.get(item.target.plateSourceId);
        if (
          !plateId ||
          candidate.storage[plateId]?.layout.kind !== 'fixed-well' ||
          !inventoryStoragePositions(candidate.storage[plateId]).includes(item.target.position)
        )
          fail(
            'BENCHLING_PERMANENT_WELL_INVALID',
            '/choices',
            'A permanent well requires a valid imported or bound fixed plate and exact coordinate.'
          );
        id = inventoryWellId(plateId, item.target.position);
        origin = { kind: 'fixed-well', storageId: plateId, position: item.target.position };
        if (claimedWells.has(id))
          fail(
            'BENCHLING_WELL_IDENTITY_CONFLICT',
            '/choices',
            'Distinct source container IDs cannot claim the same permanent well.'
          );
        claimedWells.add(id);
      } else {
        id =
          binding?.vesselId ??
          inventoryTableRecordIds(input.target, namespace, item.record.sourceId).vesselId;
        if (!destination || destination.kind === 'root')
          fail(
            'BENCHLING_VESSEL_PLACEMENT_INVALID',
            '/choices',
            'Movable vessels require an unplaced or located destination.'
          );
        origin = { kind: 'movable', placement: destination };
      }
      if (binding) {
        if (
          binding.rowSha256 !== item.rowSha256 ||
          binding.vesselId !== id ||
          canonical(binding.origin) !== canonical(origin)
        )
          reconcile(
            item.record,
            binding.vesselId,
            'The physical source facts or interpretation changed for the original vessel target.'
          );
        id = binding.vesselId;
      } else {
        if (item.target.kind === 'movable') {
          vesselCreates.push({
            kind: 'create-vessel',
            id,
            name: item.target.name,
            placement: (origin as Extract<InventoryVesselBinding['origin'], { kind: 'movable' }>)
              .placement,
          });
          newVesselIds.add(id);
        }
        vesselBindingAdditions[key] = {
          namespace,
          sourceId: item.record.sourceId,
          rowSha256: item.rowSha256,
          vesselId: id,
          origin,
        };
      }
      targetVessels.set(item.record.sourceId, id);
      resolvedTargets.push({
        record: { kind: 'container', sourceId: item.record.sourceId },
        target: { kind: 'vessel', id },
      });
    }
    append(vesselCreates);
    const policyIds = new Set<string>();
    const configurationCommands: InventoryCommand[] = [];
    for (const item of source.storage) {
      const id = targetStorage.get(item.record.sourceId)!;
      const policies = choices.uncapturedPositions.filter(
        (policy) => policy.storageSourceId === item.record.sourceId
      );
      if (policies.length > 1)
        fail(
          'BENCHLING_UNCAPTURED_POLICY_INVALID',
          '/choices',
          'One storage record needs at most one unavailable-position policy.'
        );
      if (item.layout.kind === 'fixed-well') {
        const known = new Set(
          source.vessels.flatMap((vessel) =>
            vessel.target.kind === 'fixed-well' &&
            vessel.target.plateSourceId === item.record.sourceId
              ? [vessel.target.position]
              : []
          )
        );
        uncapturedPositions.push({
          storageSourceId: item.record.sourceId,
          kind: 'unobserved',
          positions: inventoryStoragePositions(candidate.storage[id]).filter(
            (position) => !known.has(position)
          ),
        });
      }
      if (item.layout.kind !== 'removable-tube') {
        if (policies.length)
          fail(
            'BENCHLING_UNCAPTURED_POLICY_INVALID',
            '/choices',
            'Only removable-container grids use unavailable-position policy. Permanent wells use contents knowledge.'
          );
        continue;
      }
      const occupied = new Set(
        source.vessels.flatMap((vessel) => {
          if (vessel.target.kind !== 'movable') return [];
          const at = resolvePlacement(vessel.target.placement);
          return at.kind === 'located' && at.storageId === id ? [at.slotId] : [];
        })
      );
      const remaining = inventoryStoragePositions(candidate.storage[id])
        .filter((position) => !occupied.has(position))
        .sort(order);
      uncapturedPositions.push({
        storageSourceId: item.record.sourceId,
        kind: 'unavailable',
        positions: remaining,
      });
      const policy = policies[0];
      if (canonical(remaining) !== canonical(policy?.positions ?? []))
        fail(
          'BENCHLING_UNCAPTURED_POSITIONS_UNRESOLVED',
          '/choices',
          'Every uncaptured removable-container position requires an explicit unavailable decision; no phantom tube or empty position is inferred.'
        );
      if (policy) policyIds.add(policy.storageSourceId);
      if (newStorageIds.has(id) && remaining.length) {
        const config = candidate.storage[id].configuration;
        configurationCommands.push({
          kind: 'configure-item',
          item: { kind: 'storage', id },
          typeVersionId: config.typeVersionId,
          metadata: config.metadata,
          orientation: config.orientation,
          unavailablePositions: Object.fromEntries(
            remaining.map((position) => [position, policy.reason])
          ),
          reason: policy.reason,
        });
      }
    }
    if (choices.uncapturedPositions.some((policy) => !policyIds.has(policy.storageSourceId)))
      fail(
        'BENCHLING_UNCAPTURED_POLICY_INVALID',
        '/choices',
        'Unavailable position policy must match an imported removable-container grid.'
      );
    append(configurationCommands);
    const materials: InventoryResolvedBenchlingCaptureOptions['materials'][number][] = [];
    const observed = new Map<string, InventoryBenchlingCapturePreviewInput['bindings'][number]>();
    if (!Array.isArray(input.bindings))
      fail(
        'BENCHLING_MATERIAL_BINDING_INVALID',
        '/bindings',
        'Supply explicit current scientific admission observations.'
      );
    for (const observation of input.bindings) {
      if (observed.has(observation.sourceId))
        fail(
          'BENCHLING_MATERIAL_BINDING_INVALID',
          '/bindings',
          'Each identified source needs one scientific admission observation.'
        );
      observed.set(observation.sourceId, observation);
    }
    for (const item of source.vessels)
      if (item.contents.kind === 'identify') {
        const observation = observed.get(item.record.sourceId);
        if (
          !observation ||
          observation.kind !== 'admitted' ||
          observation.materialId !== item.contents.materialId ||
          !/^sha256:[a-f0-9]{64}$/u.test(observation.fingerprint)
        )
          fail(
            'BENCHLING_MATERIAL_UNAVAILABLE',
            '/bindings',
            'Each identified content requires the selected current local scientific record and fingerprint.'
          );
        materials.push({
          sourceId: item.record.sourceId,
          materialId: item.contents.materialId,
          fingerprint: observation.fingerprint,
        });
        observed.delete(item.record.sourceId);
      }
    if (observed.size)
      fail(
        'BENCHLING_MATERIAL_BINDING_INVALID',
        '/bindings',
        'Scientific observations must belong to identified source contents.'
      );
    resolvedTargets.sort((a, b) => order(recordKey(a.record), recordKey(b.record)));
    const stockFacts = benchlingStockFacts(source, materials, resolvedTargets);
    const stockRows = new Map(stockFacts.rows.map((row) => [row.source_id, row]));
    const knowledge = new Map<
      string,
      { kind: 'unobserved' | 'unidentified'; reason: string; ids: string[] }
    >();
    const addKnowledge = (id: string, kind: 'unobserved' | 'unidentified', reason: string) => {
      const key = canonical([kind, reason]);
      const group = knowledge.get(key) ?? { kind, reason, ids: [] };
      group.ids.push(id);
      knowledge.set(key, group);
    };
    const importedWellIds = new Set(
      source.vessels.map((item) => targetVessels.get(item.record.sourceId)!)
    );
    for (const id of newStorageIds)
      if (candidate.storage[id].layout.kind === 'fixed-well') {
        const ids = inventoryStoragePositions(candidate.storage[id])
          .map((position) => inventoryWellId(id, position))
          .filter((wellId) => !importedWellIds.has(wellId));
        if (ids.length)
          knowledge.set(`uncaptured:${id}`, {
            kind: 'unobserved',
            reason: 'The capture does not establish contents for these permanent wells.',
            ids: [...ids],
          });
      }
    const identificationCommands: InventoryCommand[] = [];
    for (const item of source.vessels) {
      const id = targetVessels.get(item.record.sourceId)!;
      const newBinding = Boolean(
        vesselBindingAdditions[inventoryTableBindingKey(namespace, item.record.sourceId)]
      );
      const row = {
        record: { kind: 'container' as const, sourceId: item.record.sourceId },
        kind: newBinding ? ('bind' as const) : ('unchanged' as const),
        targetId: id,
        issues: [] as InventoryTableIssue[],
      };
      const physicallyNew =
        newVesselIds.has(id) ||
        (item.target.kind === 'fixed-well' &&
          newStorageIds.has(targetStorage.get(item.target.plateSourceId)!));
      if (item.contents.kind !== 'identify') {
        if (
          item.contents.kind !== 'empty' &&
          (physicallyNew ||
            (newBinding &&
              candidate.vessels[id].contentsKnowledge.kind === 'recorded' &&
              !Object.values(candidate.stocks).some((stock) => stock.vesselId === id)))
        )
          addKnowledge(id, item.contents.kind, item.contents.reason);
        rows.push(row);
        continue;
      }
      const fields = stockRows.get(item.record.sourceId)!;
      const stockRow = { ...row, stockFields: fields };
      const rowHash = inventoryReceiveTableRowSha256(fields);
      const bindingKey = inventoryTableBindingKey(namespace, item.record.sourceId);
      const binding = previous.tableBindings[bindingKey];
      if (binding) {
        if (
          inventoryTableSourceBaseline(binding).rowSha256 !== rowHash ||
          binding.materialId !== item.contents.materialId ||
          binding.vesselId !== id ||
          binding.destination.kind !== 'existing-vessel'
        )
          reconcile(
            item.record,
            binding.vesselId,
            'The identified source fields, quantity, quality or scientific identity changed; use the established source reconciliation workflow.'
          );
        rows.push(stockRow);
        continue;
      }
      if (Object.values(candidate.stocks).some((stock) => stock.vesselId === id))
        fail(
          'STOCK_ALREADY_PRESENT',
          `/records/${item.record.sourceId}`,
          'Existing local stock without this source binding cannot be overwritten or silently claimed.'
        );
      if (candidate.vessels[id].contentsKnowledge.kind === 'recorded')
        addKnowledge(id, 'unidentified', item.contents.reason);
      identificationCommands.push({
        kind: 'identify-vessel-stock',
        id: inventoryTableRecordIds(input.target, namespace, item.record.sourceId).stockId,
        vesselId: id,
        materialId: item.contents.materialId,
        quantity: item.contents.quantity,
        quality: item.contents.quality,
        reason: item.contents.reason,
      });
      tableBindingAdditions[bindingKey] = {
        namespace,
        sourceId: item.record.sourceId,
        rowSha256: rowHash,
        stockId: inventoryTableRecordIds(input.target, namespace, item.record.sourceId).stockId,
        vesselId: id,
        materialId: item.contents.materialId,
        destination: { kind: 'existing-vessel' },
        sourceRevisions: [],
      };
      rows.push({ ...stockRow, kind: 'identify' });
    }
    append(
      [...knowledge.values()].map((group) => ({
        kind: 'record-vessels-contents' as const,
        vesselIds: [...group.ids].sort(order),
        knowledge: group.kind,
        reason: group.reason,
      }))
    );
    append(identificationCommands);
    for (const decision of choices.records)
      if (decision.disposition === 'skip' || decision.disposition === 'evidence')
        rows.push({
          record: decision.record,
          kind: decision.disposition === 'skip' ? 'skipped' : 'evidence',
          targetId: null,
          issues: [],
        });
    rows.sort((a, b) => order(recordKey(a.record), recordKey(b.record)));
    const options: InventoryResolvedBenchlingCaptureOptions = {
      ...choices,
      materials,
      resolvedTargets,
      normalizedStockRows: stockFacts.rows,
      normalizedTableOptions: stockFacts.options,
    };
    const hasAdditions =
      Object.keys(hierarchyBindingAdditions).length +
        Object.keys(vesselBindingAdditions).length +
        Object.keys(tableBindingAdditions).length >
      0;
    if (!commands.length && !hasAdditions)
      return { ...facts(), kind: 'no-change', issues: [], options, planDigest: null };
    if (previous.revision === Number.MAX_SAFE_INTEGER)
      fail('REVISION_EXHAUSTED', '/target', 'The inventory revision cannot advance safely.');
    const final = commands.length
      ? applyInventoryCommandBatch(
          previous,
          { expectedRevision: previous.revision, commands },
          context
        )
      : {
          ok: true as const,
          state: { ...previous, revision: previous.revision + 1, lastRecordedAt: context.at },
        };
    if (!final.ok) fail(final.code, '/commands', final.message);
    parseInventoryState({
      ...final.state,
      hierarchyBindings: { ...previous.hierarchyBindings, ...hierarchyBindingAdditions },
      vesselBindings: { ...previous.vesselBindings, ...vesselBindingAdditions },
      tableBindings: { ...previous.tableBindings, ...tableBindingAdditions },
    });
    const planDigest = inventoryTableSha256(
      canonical({
        format: 'dnaforge.inventory-benchling-application.v1',
        sourceSha256,
        target: input.target,
        options,
        commands,
        hierarchyBindingAdditions,
        vesselBindingAdditions,
        tableBindingAdditions,
      })
    );
    return {
      ...facts(),
      kind: 'ready',
      issues: [],
      options,
      commands,
      hierarchyBindingAdditions,
      vesselBindingAdditions,
      tableBindingAdditions,
      planDigest,
    };
  } catch (error) {
    const issue =
      error instanceof BenchlingApplicationError
        ? error.issue
        : {
            code: 'BENCHLING_APPLICATION_INVALID',
            pointer: '/options',
            message: error instanceof Error ? error.message : 'Invalid source choices or target.',
          };
    return { ...facts(), kind: 'blocked', issues: [issue], options: null, planDigest: null };
  }
}
export function applyInventoryBenchlingCapture(
  state: InventoryState | null,
  application: InventoryBenchlingCaptureApplication,
  context: InventoryExecutionContext,
  maxBytes: number
) {
  const input: InventoryBenchlingCapturePreviewInput = {
    ...application,
    options: benchlingChoices(application.options),
    bindings: application.options.materials.map((material) => ({
      ...material,
      kind: 'admitted' as const,
    })),
    asOf: context.at,
    principal: context.principal,
    authority: context.authority,
    maxBytes,
  };
  const preview = inventoryBenchlingCapturePreview(state, input);
  if (
    preview.kind !== 'ready' ||
    preview.planDigest !== application.expectedPlanDigest ||
    canonical(preview.options) !== canonical(application.options)
  )
    return {
      ok: false as const,
      code: 'REVISION_CONFLICT' as const,
      message:
        'The source, choices, target or scientific dependencies changed. Preview the capture again.',
    };
  const previous = state === null ? createInventoryState() : parseInventoryState(state);
  const transition = preview.commands.length
    ? applyInventoryCommandBatch(
        previous,
        { expectedRevision: previous.revision, commands: preview.commands },
        context
      )
    : {
        ok: true as const,
        state: { ...previous, revision: previous.revision + 1, lastRecordedAt: context.at },
      };
  if (!transition.ok) return transition;
  return {
    ok: true as const,
    state: parseInventoryState({
      ...transition.state,
      hierarchyBindings: { ...previous.hierarchyBindings, ...preview.hierarchyBindingAdditions },
      vesselBindings: { ...previous.vesselBindings, ...preview.vesselBindingAdditions },
      tableBindings: { ...previous.tableBindings, ...preview.tableBindingAdditions },
    }),
  };
}
