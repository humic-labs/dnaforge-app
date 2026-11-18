import { inventoryRecordIdExists } from './inventory-identity';
import { parseInventoryExecutionContext, parseInventoryState } from './inventory-validation';
import {
  inventoryTableCanonicalJson as canonical,
  inventoryTableSha256,
} from './inventory-table-binding';
import {
  inventoryRunValueAttributionId,
  inventoryRunValueAttributionWithdrawalId,
  inventoryRunValueAttributionIntentSha256,
  inventoryRunValueAttributionWithdrawalIntentSha256,
  inventoryRunValueAttributionChoices,
  inventoryRunValueAttributionSemanticKey,
} from './inventory-run-value-attribution-identity';
import {
  inventoryRunValueAttributionPhysicalMatches,
  inventoryRunValueAttributionSameChain,
} from './inventory-run-value-attribution-validation';
import { inventoryRunValueAttributionSelection } from './inventory-run-value-attribution-source';
import type {
  InventoryState,
  InventoryExecutionContext,
  InventoryTransition,
  InventoryErrorCode,
} from './inventory-types';
import type { InventoryTableSha256 } from './inventory-table-types';
import type {
  InventoryRunValueAttribution,
  InventoryRunValueAttributionChoices,
  InventoryRunValueAttributionEntry,
  InventoryRunValueAttributionExisting,
  InventoryRunValueAttributionWithdrawalChoices,
  InventoryRunValueAttributionWithdrawalExisting,
  InventoryRunValueAttributionPreview,
  InventoryRunValueAttributionWithdrawalPreview,
  InventoryRunValueAttributionPreviewInput,
  InventoryRunValueAttributionWithdrawalPreviewInput,
  InventoryRunValueAttributionApplication,
  InventoryRunValueAttributionWithdrawalApplication,
  InventoryRunValueAttributionWithdrawal,
  InventoryRunValueAttributionFilter,
  InventoryRunValueAttributionSummary,
  InventoryRunValueAttributionIssue,
} from './inventory-run-value-attribution-types';

export * from './inventory-run-value-attribution-identity';
export * from './inventory-run-value-attribution-source';
export * from './inventory-run-value-attribution-value';
const issue = (
  code: InventoryErrorCode,
  pointer: string,
  message: string
): InventoryRunValueAttributionIssue => ({ code, pointer, message });
function withdrawalFor(state: InventoryState, id: string) {
  return (
    Object.values(state.runValueAttributionWithdrawals).find((row) => row.attributionId === id) ??
    null
  );
}
function entry(
  state: InventoryState,
  attribution: InventoryRunValueAttribution
): InventoryRunValueAttributionEntry {
  return structuredClone({ attribution, withdrawal: withdrawalFor(state, attribution.id) });
}
export function inventoryRunValueAttributions(
  state: InventoryState,
  filter: InventoryRunValueAttributionFilter = {}
): readonly InventoryRunValueAttributionEntry[] {
  if (filter.slot && !filter.run)
    throw new TypeError('A slot filter requires its exact Run identity.');
  return Object.values(state.runValueAttributions)
    .filter(
      (row) =>
        (!filter.run ||
          (row.runValue.entityId === filter.run.entityId &&
            row.source.projectId === filter.run.projectId &&
            row.source.workspaceScope === filter.run.workspaceScope)) &&
        (!filter.slot ||
          (row.runValue.collection === filter.slot.collection &&
            row.runValue.key === filter.slot.key))
    )
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) => entry(state, row));
}
export function inventoryRunValueAttributionSummary(
  row: InventoryRunValueAttribution
): InventoryRunValueAttributionSummary {
  const { valueSnapshot, origin: _, ...summary } = row;
  return structuredClone({
    ...summary,
    slotLabel: valueSnapshot.label,
    valueKind: valueSnapshot.value.type,
  });
}
export function inventoryRunValueAttributionExisting(
  state: InventoryState,
  input: InventoryRunValueAttributionChoices
): InventoryRunValueAttributionExisting {
  const id = inventoryRunValueAttributionId(input.identity),
    intent = inventoryRunValueAttributionIntentSha256(input),
    known = state.runValueAttributions[id];
  if (known)
    return known.intentSha256 === intent
      ? { kind: 'no-change', entry: entry(state, known) }
      : {
          kind: 'blocked',
          issue: issue(
            'RUN_VALUE_ATTRIBUTION_CONFLICT',
            '/identity',
            'This attribution identity already records different meaning.'
          ),
        };
  const semantic = inventoryRunValueAttributionSemanticKey(input),
    duplicate = Object.values(state.runValueAttributions).find(
      (row) =>
        inventoryRunValueAttributionSemanticKey(inventoryRunValueAttributionChoices(row)) ===
        semantic
    );
  if (duplicate) return { kind: 'no-change', entry: entry(state, duplicate) };
  if (!inventoryRunValueAttributionPhysicalMatches(state, input.physical))
    return {
      kind: 'blocked',
      issue: issue(
        'RUN_VALUE_ATTRIBUTION_TARGET_MISMATCH',
        '/physical',
        'Choose the exact recorded physical observation and source or output stock.'
      ),
    };
  if (input.predecessor) {
    const pin = input.predecessor,
      parent = state.runValueAttributions[pin.attributionId],
      withdrawal = state.runValueAttributionWithdrawals[pin.withdrawalId];
    if (
      !parent ||
      !withdrawal ||
      parent.intentSha256 !== pin.attributionIntentSha256 ||
      withdrawal.intentSha256 !== pin.withdrawalIntentSha256 ||
      withdrawal.attributionId !== parent.id ||
      withdrawal.attributionIntentSha256 !== parent.intentSha256 ||
      parent.runValue.entityId !== input.runValue.entityId ||
      parent.runValue.collection !== input.runValue.collection ||
      parent.runValue.key !== input.runValue.key ||
      Object.values(state.runValueAttributions).some(
        (row) =>
          row.predecessor?.attributionId === parent.id ||
          row.predecessor?.withdrawalId === withdrawal.id
      )
    )
      return {
        kind: 'blocked',
        issue: issue(
          'RUN_VALUE_ATTRIBUTION_PREDECESSOR_MISMATCH',
          '/predecessor',
          'A successor requires its exact withdrawn predecessor, same Run/slot and unused successor position.'
        ),
      };
  }
  return inventoryRecordIdExists(state, id)
    ? {
        kind: 'blocked',
        issue: issue('ID_ALREADY_EXISTS', '/identity', 'That inventory identifier already exists.'),
      }
    : { kind: 'new' };
}
export function inventoryRunValueAttributionWithdrawalExisting(
  state: InventoryState,
  input: InventoryRunValueAttributionWithdrawalChoices
): InventoryRunValueAttributionWithdrawalExisting {
  const id = inventoryRunValueAttributionWithdrawalId(input.identity),
    intent = inventoryRunValueAttributionWithdrawalIntentSha256(input),
    known = state.runValueAttributionWithdrawals[id];
  if (known && known.intentSha256 !== intent)
    return {
      kind: 'blocked',
      issue: issue(
        'RUN_VALUE_ATTRIBUTION_WITHDRAWAL_CONFLICT',
        '/identity',
        'This withdrawal identity already records a different correction.'
      ),
    };
  const attribution = state.runValueAttributions[input.attributionId];
  if (!attribution || attribution.intentSha256 !== input.attributionIntentSha256)
    return {
      kind: 'blocked',
      issue: issue(
        'RUN_VALUE_ATTRIBUTION_TARGET_MISMATCH',
        '/attributionId',
        'Choose the exact recorded attribution and intent.'
      ),
    };
  const withdrawal = known ?? withdrawalFor(state, attribution.id);
  if (withdrawal)
    return {
      kind: 'no-change',
      attribution: structuredClone(attribution),
      withdrawal: structuredClone(withdrawal),
    };
  return inventoryRecordIdExists(state, id)
    ? {
        kind: 'blocked',
        issue: issue('ID_ALREADY_EXISTS', '/identity', 'That inventory identifier already exists.'),
      }
    : { kind: 'new', attribution: structuredClone(attribution) };
}
function admission(
  state: InventoryState,
  input: Pick<
    InventoryRunValueAttributionPreviewInput,
    'target' | 'asOf' | 'principal' | 'authority'
  >
) {
  const context = parseInventoryExecutionContext({
    at: input.asOf,
    principal: input.principal,
    authority: input.authority,
  });
  if (!input.target.present || input.target.revision !== state.revision)
    return {
      issue: issue(
        'REVISION_CONFLICT',
        '/target',
        'The inventory changed. Preview this metadata action again.'
      ),
    };
  if (state.revision === Number.MAX_SAFE_INTEGER)
    return {
      issue: issue(
        'REVISION_EXHAUSTED',
        '/target',
        'The inventory revision cannot advance safely.'
      ),
    };
  if (context.at < state.lastRecordedAt)
    return {
      issue: issue(
        'CLOCK_REGRESSION',
        '/target',
        'The trusted timestamp precedes the inventory clock floor.'
      ),
    };
  return { context };
}
function digest(
  input:
    | InventoryRunValueAttributionPreviewInput
    | InventoryRunValueAttributionWithdrawalPreviewInput,
  intentSha256: InventoryTableSha256,
  withdrawal: boolean
) {
  return inventoryTableSha256(
    canonical({
      schema: withdrawal
        ? 'dnaforge.inventory-run-value-attribution-withdrawal-plan.v1'
        : 'dnaforge.inventory-run-value-attribution-plan.v1',
      target: input.target,
      intentSha256,
      principal: input.principal,
      authority: input.authority,
    })
  );
}
function prepareAttribution(
  state: InventoryState,
  input: InventoryRunValueAttributionPreviewInput
): { preview: InventoryRunValueAttributionPreview; state?: InventoryState } {
  let attributionId: string | null = null,
    intentSha256: InventoryTableSha256 | null = null,
    sourceSha256: InventoryTableSha256 | null = null;
  const target = { ...input.target, present: state.revision !== 0, revision: state.revision },
    facts = () => ({
      schema: 'dnaforge.inventory-run-value-attribution-preview.v1' as const,
      target,
      attributionId,
      intentSha256,
      sourceSha256,
    });
  const blocked = (
    value: InventoryRunValueAttributionIssue
  ): { preview: InventoryRunValueAttributionPreview } => ({
    preview: { ...facts(), kind: 'blocked', issues: [value] },
  });
  try {
    attributionId = inventoryRunValueAttributionId(input.identity);
    intentSha256 = inventoryRunValueAttributionIntentSha256(input);
    const existing = inventoryRunValueAttributionExisting(state, input);
    if (existing.kind === 'blocked') return blocked(existing.issue);
    if (existing.kind === 'no-change') {
      attributionId = existing.entry.attribution.id;
      intentSha256 = existing.entry.attribution.intentSha256;
      sourceSha256 = existing.entry.attribution.runValue.sourceSha256;
      return { preview: { ...facts(), kind: 'no-change', entry: existing.entry } };
    }
    const admitted = admission(state, input);
    if (admitted.issue) return blocked(admitted.issue);
    if (
      !input.source ||
      input.source.projectId !== input.target.projectId ||
      input.source.runId !== input.runValue.entityId
    )
      return blocked(
        issue(
          'SCIENTIFIC_CONTEXT_MISMATCH',
          '/runValue',
          'Choose the exact saved Run in this inventory project.'
        )
      );
    let selected;
    try {
      selected = inventoryRunValueAttributionSelection(input.source, input.runValue);
    } catch (error) {
      return blocked(
        issue(
          'RUN_VALUE_ATTRIBUTION_TARGET_MISMATCH',
          '/runValue',
          error instanceof Error ? error.message : 'The selected saved Run row is unavailable.'
        )
      );
    }
    sourceSha256 = selected.runValue.sourceSha256;
    if (canonical(selected.runValue) !== canonical(input.runValue))
      return blocked(
        issue(
          'SCIENTIFIC_CONTEXT_MISMATCH',
          '/runValue',
          'The exact saved Run source or complete row changed. Inspect it and preview again.'
        )
      );
    const context = admitted.context!,
      attribution: InventoryRunValueAttribution = {
        identity: structuredClone(input.identity),
        runValue: structuredClone(input.runValue),
        physical: structuredClone(input.physical),
        predecessor: structuredClone(input.predecessor),
        reason: input.reason,
        id: attributionId,
        intentSha256,
        source: selected.source,
        valueSnapshot: selected.valueSnapshot,
        origin: selected.origin,
        at: context.at,
        by: { ...context.principal },
      };
    if (
      input.predecessor &&
      !inventoryRunValueAttributionSameChain(
        state.runValueAttributions[input.predecessor.attributionId],
        attribution
      )
    )
      return blocked(
        issue(
          'RUN_VALUE_ATTRIBUTION_PREDECESSOR_MISMATCH',
          '/predecessor',
          'A correction must retain the original project, Run, file binding and slot.'
        )
      );
    const candidate = parseInventoryState({
      ...state,
      revision: state.revision + 1,
      lastRecordedAt: context.at,
      runValueAttributions: Object.assign(Object.create(null), state.runValueAttributions, {
        [attributionId]: attribution,
      }),
    });
    return {
      preview: {
        ...facts(),
        kind: 'ready',
        attribution: candidate.runValueAttributions[attributionId],
        planDigest: digest(input, intentSha256, false),
      },
      state: candidate,
    };
  } catch (error) {
    return blocked(
      issue(
        'INVALID_INVENTORY_INPUT',
        '/attribution',
        error instanceof Error ? error.message : 'The Run value attribution is invalid.'
      )
    );
  }
}
function prepareWithdrawal(
  state: InventoryState,
  input: InventoryRunValueAttributionWithdrawalPreviewInput
): { preview: InventoryRunValueAttributionWithdrawalPreview; state?: InventoryState } {
  let intentSha256: InventoryTableSha256 | null = null;
  const target = { ...input.target, present: state.revision !== 0, revision: state.revision },
    facts = () => ({
      schema: 'dnaforge.inventory-run-value-attribution-withdrawal-preview.v1' as const,
      target,
      attributionId: input.attributionId,
      intentSha256,
      sourceSha256: null,
    });
  const blocked = (
    value: InventoryRunValueAttributionIssue
  ): { preview: InventoryRunValueAttributionWithdrawalPreview } => ({
    preview: { ...facts(), kind: 'blocked', issues: [value] },
  });
  try {
    intentSha256 = inventoryRunValueAttributionWithdrawalIntentSha256(input);
    const existing = inventoryRunValueAttributionWithdrawalExisting(state, input);
    if (existing.kind === 'blocked') return blocked(existing.issue);
    if (existing.kind === 'no-change') {
      intentSha256 = existing.withdrawal.intentSha256;
      return {
        preview: {
          ...facts(),
          kind: 'no-change',
          entry: { attribution: existing.attribution, withdrawal: existing.withdrawal },
        },
      };
    }
    const admitted = admission(state, input);
    if (admitted.issue) return blocked(admitted.issue);
    const context = admitted.context!,
      id = inventoryRunValueAttributionWithdrawalId(input.identity),
      withdrawal: InventoryRunValueAttributionWithdrawal = {
        identity: { ...input.identity },
        attributionId: input.attributionId,
        attributionIntentSha256: input.attributionIntentSha256,
        reason: input.reason,
        id,
        intentSha256,
        at: context.at,
        by: { ...context.principal },
      };
    const candidate = parseInventoryState({
      ...state,
      revision: state.revision + 1,
      lastRecordedAt: context.at,
      runValueAttributionWithdrawals: Object.assign(
        Object.create(null),
        state.runValueAttributionWithdrawals,
        { [id]: withdrawal }
      ),
    });
    return {
      preview: {
        ...facts(),
        kind: 'ready',
        attribution: existing.attribution,
        withdrawal: candidate.runValueAttributionWithdrawals[id],
        planDigest: digest(input, intentSha256, true),
      },
      state: candidate,
    };
  } catch (error) {
    return blocked(
      issue(
        'INVALID_INVENTORY_INPUT',
        '/withdrawal',
        error instanceof Error ? error.message : 'The attribution withdrawal is invalid.'
      )
    );
  }
}
export function inventoryRunValueAttributionPreview(
  state: InventoryState,
  input: InventoryRunValueAttributionPreviewInput
): InventoryRunValueAttributionPreview {
  return prepareAttribution(state, input).preview;
}
export function inventoryRunValueAttributionWithdrawalPreview(
  state: InventoryState,
  input: InventoryRunValueAttributionWithdrawalPreviewInput
): InventoryRunValueAttributionWithdrawalPreview {
  return prepareWithdrawal(state, input).preview;
}
export function applyInventoryRunValueAttribution(
  state: InventoryState,
  input: InventoryRunValueAttributionApplication,
  context: InventoryExecutionContext
): InventoryTransition {
  const prepared = prepareAttribution(state, {
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
  return !prepared.state || prepared.preview.planDigest !== input.expectedPlanDigest
    ? {
        ok: false,
        code: 'REVISION_CONFLICT',
        message: 'The exact attribution preview changed. Preview again.',
      }
    : { ok: true, state: prepared.state };
}
export function applyInventoryRunValueAttributionWithdrawal(
  state: InventoryState,
  input: InventoryRunValueAttributionWithdrawalApplication,
  context: InventoryExecutionContext
): InventoryTransition {
  const prepared = prepareWithdrawal(state, {
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
  return !prepared.state || prepared.preview.planDigest !== input.expectedPlanDigest
    ? {
        ok: false,
        code: 'REVISION_CONFLICT',
        message: 'The exact withdrawal preview changed. Preview again.',
      }
    : { ok: true, state: prepared.state };
}
