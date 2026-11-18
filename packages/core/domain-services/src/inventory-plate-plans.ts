import { inventoryRecordIdExists } from './inventory-identity';
import { parseInventoryExecutionContext, parseInventoryState } from './inventory-validation';
import {
  inventoryTableCanonicalJson as canonical,
  inventoryTableSha256,
} from './inventory-table-binding';
import {
  inventoryPlatePlanDefinitionSha256,
  inventoryPlatePlanFamilyId,
  inventoryPlatePlanVersionId,
  inventoryPlatePlanVersionSaveIntentSha256,
} from './inventory-plate-plan-identity';
import { parseInventoryPlatePlanDefinition } from './inventory-plate-plan-definition';
import type {
  InventoryState,
  InventoryExecutionContext,
  InventoryTransition,
} from './inventory-types';
import type {
  InventoryPlatePlanIdentity,
  InventoryPlatePlanVersionChoices,
  InventoryPlatePlanVersionExisting,
  InventoryPlatePlanVersionPreviewInput,
  InventoryPlatePlanVersionApplication,
  InventoryPlatePlanVersionPreview,
  InventoryPlatePlanVersionSummary,
  InventoryPlatePlanIssue,
} from './inventory-plate-plan-types';
import type { InventoryTableSha256 } from './inventory-table-types';
export function inventoryPlatePlanVersionExisting(
  state: InventoryState,
  choices: InventoryPlatePlanVersionChoices
): InventoryPlatePlanVersionExisting {
  inventoryPlatePlanVersionSaveIntentSha256(choices);
  const definitionSha256 = inventoryPlatePlanDefinitionSha256(choices.definition),
    id = inventoryPlatePlanVersionId(choices.identity, definitionSha256),
    known = state.platePlanVersions[id];
  if (known)
    return canonical(known.identity) === canonical(choices.identity) &&
      canonical(known.definition) === canonical(choices.definition)
      ? { kind: 'no-change', version: structuredClone(known) }
      : {
          kind: 'blocked',
          issue: {
            code: 'ID_ALREADY_EXISTS',
            pointer: '/identity',
            message: 'The computed plan-version identifier already has different content.',
          },
        };
  return inventoryRecordIdExists(state, id)
    ? {
        kind: 'blocked',
        issue: {
          code: 'ID_ALREADY_EXISTS',
          pointer: '/identity',
          message: 'That inventory record identifier already exists.',
        },
      }
    : { kind: 'new' };
}
export function inventoryPlatePlanVersions(
  state: InventoryState,
  identity?: InventoryPlatePlanIdentity
): readonly InventoryPlatePlanVersionSummary[] {
  const family = identity ? inventoryPlatePlanFamilyId(identity) : null;
  return Object.values(state.platePlanVersions)
    .filter((version) => family === null || inventoryPlatePlanFamilyId(version.identity) === family)
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((version) =>
      structuredClone({
        id: version.id,
        identity: version.identity,
        definitionSha256: version.definitionSha256,
        title: version.definition.title,
        layout: version.definition.layout,
        sourceSlotCount: version.definition.sourceSlots.length,
        transferCount: version.definition.transfers.length,
        at: version.at,
        by: version.by,
        reason: version.reason,
      })
    );
}
function prepare(
  state: InventoryState,
  input: InventoryPlatePlanVersionPreviewInput
): { preview: InventoryPlatePlanVersionPreview; state?: InventoryState } {
  let versionId: string | null = null,
    definitionSha256: InventoryTableSha256 | null = null;
  const observedTarget = {
    ...input.target,
    present: state.revision !== 0,
    revision: state.revision,
  };
  const facts = () => ({
    schema: 'dnaforge.inventory-plate-plan-version-preview.v1' as const,
    target: observedTarget,
    versionId,
    definitionSha256,
  });
  const blocked = (
    value: InventoryPlatePlanIssue
  ): { preview: InventoryPlatePlanVersionPreview } => ({
    preview: { ...facts(), kind: 'blocked', issues: [value] },
  });
  try {
    const definition = parseInventoryPlatePlanDefinition(input.definition),
      intentSha256 = inventoryPlatePlanVersionSaveIntentSha256(input);
    definitionSha256 = inventoryPlatePlanDefinitionSha256(definition);
    versionId = inventoryPlatePlanVersionId(input.identity, definitionSha256);
    const existing = inventoryPlatePlanVersionExisting(state, input);
    if (existing.kind === 'blocked') return blocked(existing.issue);
    if (existing.kind === 'no-change') return { preview: { ...facts(), ...existing } };
    const context = parseInventoryExecutionContext({
      at: input.asOf,
      principal: input.principal,
      authority: input.authority,
    });
    if (input.target.revision !== state.revision || input.target.present !== observedTarget.present)
      return blocked({
        code: 'REVISION_CONFLICT',
        pointer: '/target',
        message: 'The inventory changed. Inspect it before submitting another command.',
      });
    if (state.revision === Number.MAX_SAFE_INTEGER)
      return blocked({
        code: 'REVISION_EXHAUSTED',
        pointer: '/target',
        message: 'The inventory revision cannot advance safely.',
      });
    if (context.at < state.lastRecordedAt)
      return blocked({
        code: 'CLOCK_REGRESSION',
        pointer: '/target',
        message: 'The trusted timestamp precedes the inventory clock floor.',
      });
    const version = {
      id: versionId,
      identity: { ...input.identity },
      definitionSha256,
      definition,
      at: context.at,
      by: { ...context.principal },
      reason: input.reason,
    };
    const candidate = parseInventoryState({
      ...state,
      revision: state.revision + 1,
      lastRecordedAt: context.at,
      platePlanVersions: Object.assign(Object.create(null), state.platePlanVersions, {
        [versionId]: version,
      }),
    });
    return {
      preview: {
        ...facts(),
        kind: 'ready',
        version: candidate.platePlanVersions[versionId],
        planDigest: inventoryTableSha256(
          canonical({
            schema: 'dnaforge.inventory-plate-plan-save-preview.v1',
            target: observedTarget,
            intentSha256,
            principal: context.principal,
            authority: context.authority,
          })
        ),
      },
      state: candidate,
    };
  } catch (error) {
    return blocked({
      code: 'INVALID_INVENTORY_INPUT',
      pointer: '/definition',
      message: error instanceof Error ? error.message : 'The plan definition is invalid.',
    });
  }
}
export function inventoryPlatePlanVersionPreview(
  state: InventoryState,
  input: InventoryPlatePlanVersionPreviewInput
) {
  return prepare(state, input).preview;
}
export function applyInventoryPlatePlanVersion(
  state: InventoryState,
  input: InventoryPlatePlanVersionApplication,
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
      message: 'The exact plan save preview changed. Preview it again.',
    };
  return { ok: true, state: prepared.state };
}
