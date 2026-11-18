import { inventoryRecordIdExists } from './inventory-identity';
import { applyInventoryCommandBatch } from './inventory-state';
import { parseInventoryExecutionContext, parseInventoryState } from './inventory-validation';
import { inventoryPlatePlanBindingPreview } from './inventory-plate-plan-binding';
import {
  inventoryTableCanonicalJson as canonical,
  inventoryTableSha256,
} from './inventory-table-binding';
import {
  inventoryNotebookSourceSha256,
  inventoryProtocolRunSourceSha256,
} from './inventory-scientific-source';
import { parseProtocolPackage } from './protocol-package';
import {
  inventoryPlatePlanObservationBinding,
  inventoryPlatePlanObservationId,
  inventoryPlatePlanObservationIntentSha256,
  inventoryPlatePlanObservationStockId,
} from './inventory-plate-plan-observation-identity';
import type {
  InventoryExecutionContext,
  InventoryState,
  InventoryTransition,
  InventoryVessel,
} from './inventory-types';
import type { InventoryTableSha256 } from './inventory-table-types';
import type {
  InventoryScientificTransferCommand,
  InventoryScientificVesselSnapshot,
} from './inventory-scientific-types';
import type {
  InventoryPlatePlanObservation,
  InventoryPlatePlanObservationChoices,
  InventoryPlatePlanObservationExisting,
  InventoryPlatePlanObservationPreviewInput,
  InventoryPlatePlanObservationApplication,
  InventoryPlatePlanObservationPreview,
  InventoryPlatePlanObservationSummary,
  InventoryPlatePlanObservationFilter,
} from './inventory-plate-plan-observation-types';
import type { InventoryPlatePlanIssue } from './inventory-plate-plan-types';

export * from './inventory-plate-plan-observation-identity';
const issue = (
  code: InventoryPlatePlanIssue['code'],
  pointer: string,
  message: string
): InventoryPlatePlanIssue => ({ code, pointer, message });
export function inventoryPlatePlanObservationExisting(
  state: InventoryState,
  choices: InventoryPlatePlanObservationChoices
): InventoryPlatePlanObservationExisting {
  const id = inventoryPlatePlanObservationId(choices.identity),
    existing = state.platePlanObservations[id],
    version = state.platePlanVersions[choices.binding.versionId];
  const conflict = () => ({
    kind: 'blocked' as const,
    issue: issue(
      'PLATE_PLAN_OBSERVATION_CONFLICT',
      '/identity',
      'This occurrence identity already records different completed work. Preserve it and record an explicit correction.'
    ),
  });
  if (
    existing &&
    (existing.binding.versionId !== choices.binding.versionId ||
      existing.binding.definitionSha256 !== choices.binding.definitionSha256)
  )
    return conflict();
  if (!version || version.definitionSha256 !== choices.binding.definitionSha256)
    return {
      kind: 'blocked',
      issue: issue(
        'PLATE_PLAN_VERSION_MISMATCH',
        '/binding/versionId',
        'Choose the exact saved plan version and definition pin.'
      ),
    };
  const intent = inventoryPlatePlanObservationIntentSha256(choices, version.definition);
  if (existing)
    return existing.intentSha256 === intent
      ? { kind: 'no-change', observation: structuredClone(existing) }
      : conflict();
  return inventoryRecordIdExists(state, id)
    ? {
        kind: 'blocked',
        issue: issue(
          'ID_ALREADY_EXISTS',
          '/identity',
          'That inventory record identifier already exists.'
        ),
      }
    : { kind: 'new' };
}
export function inventoryPlatePlanObservations(
  state: InventoryState,
  filter: InventoryPlatePlanObservationFilter = {}
): readonly InventoryPlatePlanObservationSummary[] {
  return Object.values(state.platePlanObservations)
    .filter(
      (row) =>
        (!filter.version ||
          (row.binding.versionId === filter.version.versionId &&
            row.binding.definitionSha256 === filter.version.definitionSha256)) &&
        (!filter.context ||
          (row.context.kind === filter.context.kind &&
            row.context.projectId === filter.context.projectId &&
            row.context.workspaceScope === filter.context.workspaceScope &&
            row.context.entityId === filter.context.entityId))
    )
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) =>
      structuredClone({
        id: row.id,
        identity: row.identity,
        intentSha256: row.intentSha256,
        versionId: row.binding.versionId,
        definitionSha256: row.binding.definitionSha256,
        planTitle: state.platePlanVersions[row.binding.versionId].definition.title,
        context: row.context,
        plate: { id: row.plate.id, name: row.plate.name, layout: row.plate.layout },
        actionCount: row.actions.length,
        sourceStockCount: row.effects.sources.length,
        at: row.at,
        by: row.by,
        reason: row.reason,
      })
    );
}
function vesselSnapshot(value: InventoryVessel): InventoryScientificVesselSnapshot {
  return { id: value.id, kind: value.kind, name: value.name, placement: { ...value.placement } };
}
function prepare(
  state: InventoryState,
  input: InventoryPlatePlanObservationPreviewInput
): { preview: InventoryPlatePlanObservationPreview; state?: InventoryState } {
  let observationId: string | null = null,
    intentSha256: InventoryTableSha256 | null = null,
    sourceSha256: InventoryTableSha256 | null = null,
    nextBoundaryAt: number | null = null;
  const target = { ...input.target, present: state.revision !== 0, revision: state.revision };
  const facts = () => ({
    schema: 'dnaforge.inventory-plate-plan-observation-preview.v1' as const,
    target,
    observationId,
    intentSha256,
    sourceSha256,
    asOf: input.asOf,
    principal: structuredClone(input.principal),
    nextBoundaryAt,
  });
  const blocked = (
    value: InventoryPlatePlanIssue
  ): { preview: InventoryPlatePlanObservationPreview } => ({
    preview: {
      ...facts(),
      kind: 'blocked',
      issues: [value],
      observation: null,
      commands: [],
      planDigest: null,
    },
  });
  try {
    observationId = inventoryPlatePlanObservationId(input.identity);
    const existing = inventoryPlatePlanObservationExisting(state, input);
    if (existing.kind === 'blocked') return blocked(existing.issue);
    if (existing.kind === 'no-change') {
      intentSha256 = existing.observation.intentSha256;
      sourceSha256 = existing.observation.context.source.sha256;
      return {
        preview: {
          ...facts(),
          kind: 'no-change',
          observation: existing.observation,
          commands: [],
          planDigest: null,
        },
      };
    }
    const version = state.platePlanVersions[input.binding.versionId],
      binding = inventoryPlatePlanObservationBinding(input.binding, version.definition);
    intentSha256 = inventoryPlatePlanObservationIntentSha256(input, version.definition);
    const context = parseInventoryExecutionContext({
      at: input.asOf,
      principal: input.principal,
      authority: input.authority,
    });
    if (
      !target.present ||
      input.target.present !== target.present ||
      input.target.revision !== state.revision
    )
      return blocked(
        issue(
          'REVISION_CONFLICT',
          '/target',
          'The inventory changed. Preview the whole completed occurrence again.'
        )
      );
    if (state.revision === Number.MAX_SAFE_INTEGER)
      return blocked(
        issue('REVISION_EXHAUSTED', '/target', 'The inventory revision cannot advance safely.')
      );
    if (context.at < state.lastRecordedAt)
      return blocked(
        issue(
          'CLOCK_REGRESSION',
          '/target',
          'The trusted timestamp precedes the inventory clock floor.'
        )
      );
    const source = input.source;
    if (
      !source ||
      source.projectId !== target.projectId ||
      !source.workspaceScope ||
      !input.context.entityId.startsWith(`${source.workspaceScope}::`) ||
      !source.fileObjectUuid ||
      !source.title
    )
      return blocked(
        issue(
          'SCIENTIFIC_CONTEXT_MISMATCH',
          '/context',
          'Choose an exact admitted saved source in this inventory project.'
        )
      );
    if (input.context.kind === 'notebook-page') {
      if (
        source.schema !== 'dnaforge.notebook-saved-source.v1' ||
        source.pageId !== input.context.entityId ||
        !source.content ||
        typeof source.content !== 'object' ||
        Array.isArray(source.content)
      )
        return blocked(
          issue(
            'SCIENTIFIC_CONTEXT_MISMATCH',
            '/context',
            'Choose the exact saved Notebook source.'
          )
        );
      sourceSha256 = inventoryNotebookSourceSha256(source);
    } else {
      if (
        source.schema !== 'dnaforge.protocol-run-saved-source.v1' ||
        source.runId !== input.context.entityId
      )
        return blocked(
          issue(
            'SCIENTIFIC_CONTEXT_MISMATCH',
            '/context',
            'Choose the exact saved Protocol Run source.'
          )
        );
      const parsed = parseProtocolPackage(source.originalText);
      if (
        parsed.kind !== 'protocol_run' ||
        `${source.workspaceScope}::${parsed.id.split('::').at(-1)}` !== source.runId
      )
        return blocked(
          issue(
            'SCIENTIFIC_CONTEXT_MISMATCH',
            '/context',
            'The saved Run does not match its canonical identity.'
          )
        );
      sourceSha256 = inventoryProtocolRunSourceSha256(source);
    }
    if (sourceSha256 !== input.context.sourceSha256)
      return blocked(
        issue(
          'SCIENTIFIC_CONTEXT_MISMATCH',
          '/context',
          'The saved scientific context changed. Inspect it and preview the occurrence again.'
        )
      );
    const feasibility = inventoryPlatePlanBindingPreview(state, {
      target: input.target,
      binding,
      asOf: context.at,
      principal: context.principal,
      authority: context.authority,
    });
    nextBoundaryAt = feasibility.nextBoundaryAt;
    if (feasibility.kind === 'blocked') return blocked(feasibility.issues[0]);
    const commands: InventoryScientificTransferCommand[] = version.definition.transfers.map(
      (row, index) => ({
        kind: 'transfer',
        sourceStockId: binding.sources.find((source) => source.sourceSlotKey === row.sourceSlotKey)!
          .stockId,
        quantity: { ...row.quantity },
        destination: {
          kind: 'new-stock',
          stockId: inventoryPlatePlanObservationStockId(input.identity, row.actionId),
          vesselId: feasibility.destinations[index].vesselId,
        },
        reason: input.reason,
      })
    );
    for (const command of commands)
      if (inventoryRecordIdExists(state, command.destination.stockId))
        return blocked(
          issue('ID_ALREADY_EXISTS', '/binding', 'A deterministic output identity already exists.')
        );
    const transition = applyInventoryCommandBatch(
      structuredClone(state),
      { expectedRevision: state.revision, commands },
      context
    );
    if (!transition.ok) return blocked(issue(transition.code, '/binding', transition.message));
    const grouped = new Map<string, string[]>();
    for (const row of binding.sources)
      grouped.set(row.stockId, [...(grouped.get(row.stockId) ?? []), row.sourceSlotKey]);
    const plate = state.storage[binding.destinationPlateId];
    const observation: InventoryPlatePlanObservation = {
      id: observationId,
      identity: { ...input.identity },
      intentSha256,
      context: {
        kind: input.context.kind,
        projectId: source.projectId,
        workspaceScope: source.workspaceScope,
        entityId: input.context.entityId,
        source: {
          kind: 'native-observed-saved-source',
          sha256: sourceSha256,
          fileObjectUuid: source.fileObjectUuid,
          title: source.title,
        },
      },
      observation: { kind: 'reported-completed-manual-plate-plan' },
      binding,
      plate: {
        id: plate.id,
        name: plate.name,
        layout: { ...version.definition.layout },
        placement: { ...plate.placement },
      },
      actions: commands.map((transfer, index) => ({
        actionId: version.definition.transfers[index].actionId,
        ordinal: index + 1,
        sourceSlotKey: version.definition.transfers[index].sourceSlotKey,
        transfer,
      })),
      effects: {
        sources: [...grouped].map(([stockId, sourceSlotKeys]) => ({
          sourceSlotKeys,
          before: structuredClone(state.stocks[stockId]),
          after: structuredClone(transition.state.stocks[stockId]),
          vessel: vesselSnapshot(state.vessels[state.stocks[stockId].vesselId]),
        })),
        destinations: commands.map((command, index) => ({
          actionId: version.definition.transfers[index].actionId,
          before: null,
          after: structuredClone(transition.state.stocks[command.destination.stockId]),
          vessel: vesselSnapshot(state.vessels[command.destination.vesselId]),
        })),
      },
      at: context.at,
      by: { ...context.principal },
      reason: input.reason,
    };
    const candidate = parseInventoryState({
      ...transition.state,
      platePlanObservations: Object.assign(Object.create(null), state.platePlanObservations, {
        [observationId]: observation,
      }),
    });
    const planDigest = inventoryTableSha256(
      canonical({
        schema: 'dnaforge.inventory-plate-plan-observation-plan.v1',
        target,
        intentSha256,
        sourceSha256,
        principal: context.principal,
        authority: context.authority,
        sources: [...grouped.keys()].map((id) => ({
          stock: state.stocks[id],
          vessel: state.vessels[state.stocks[id].vesselId],
        })),
        plate,
        destinations: commands.map((command) => state.vessels[command.destination.vesselId]),
      })
    );
    return {
      preview: {
        ...facts(),
        kind: 'ready',
        observation: candidate.platePlanObservations[observationId],
        commands,
        planDigest,
      },
      state: candidate,
    };
  } catch (error) {
    return blocked(
      issue(
        'INVALID_INVENTORY_INPUT',
        '/observation',
        error instanceof Error ? error.message : 'The completed occurrence is invalid.'
      )
    );
  }
}
export function inventoryPlatePlanObservationPreview(
  state: InventoryState,
  input: InventoryPlatePlanObservationPreviewInput
): InventoryPlatePlanObservationPreview {
  return prepare(state, input).preview;
}
export function applyInventoryPlatePlanObservation(
  state: InventoryState,
  input: InventoryPlatePlanObservationApplication,
  context: InventoryExecutionContext
): InventoryTransition {
  const prepared = prepare(state, {
    ...input,
    asOf: context.at,
    principal: context.principal,
    authority: context.authority,
  });
  if (prepared.preview.kind === 'no-change') return { ok: true, state };
  if (prepared.preview.kind === 'blocked')
    return {
      ok: false,
      code: prepared.preview.issues[0].code,
      message: prepared.preview.issues[0].message,
    };
  if (!prepared.state || prepared.preview.planDigest !== input.expectedPlanDigest)
    return {
      ok: false,
      code: 'REVISION_CONFLICT',
      message: 'The exact completed occurrence preview changed. Preview it again.',
    };
  return { ok: true, state: prepared.state };
}
