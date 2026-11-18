import { inventoryRecordIdExists } from './inventory-identity';
import { parseInventoryExecutionContext, parseInventoryState } from './inventory-validation';
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
  inventoryScientificCitationId,
  inventoryScientificCitationWithdrawalId,
  inventoryScientificCitationIntentSha256,
  inventoryScientificCitationWithdrawalIntentSha256,
  inventoryScientificCitationChoices,
  inventoryScientificCitationSemanticKey,
} from './inventory-scientific-citation-identity';
import type {
  InventoryState,
  InventoryExecutionContext,
  InventoryErrorCode,
  InventoryTransition,
} from './inventory-types';
import type {
  InventoryScientificCitation,
  InventoryScientificCitationChoices,
  InventoryScientificCitationEntry,
  InventoryScientificCitationExisting,
  InventoryScientificCitationWithdrawalChoices,
  InventoryScientificCitationWithdrawalExisting,
  InventoryScientificCitationPreview,
  InventoryScientificCitationWithdrawalPreview,
  InventoryScientificCitationPreviewInput,
  InventoryScientificCitationWithdrawalPreviewInput,
  InventoryScientificCitationApplication,
  InventoryScientificCitationWithdrawalApplication,
  InventoryScientificCitationIssue,
} from './inventory-scientific-citation-types';
import type { InventoryTableSha256 } from './inventory-table-types';

export * from './inventory-scientific-citation-identity';
const issue = (
  code: InventoryErrorCode,
  pointer: string,
  message: string
): InventoryScientificCitationIssue => ({ code, pointer, message });
function withdrawalFor(state: InventoryState, citationId: string) {
  return (
    Object.values(state.scientificCitationWithdrawals).find(
      (row) => row.citationId === citationId
    ) ?? null
  );
}
function entry(
  state: InventoryState,
  citation: InventoryScientificCitation
): InventoryScientificCitationEntry {
  return structuredClone({ citation, withdrawal: withdrawalFor(state, citation.id) });
}
export function inventoryScientificCitationsForWork(
  state: InventoryState,
  workId: string
): readonly InventoryScientificCitationEntry[] {
  return Object.values(state.scientificCitations)
    .filter((row) => row.workId === workId)
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) => entry(state, row));
}
export function inventoryScientificCitationExisting(
  state: InventoryState,
  input: InventoryScientificCitationChoices
): InventoryScientificCitationExisting {
  const id = inventoryScientificCitationId(input.identity),
    intent = inventoryScientificCitationIntentSha256(input),
    existing = state.scientificCitations[id];
  if (existing)
    return existing.intentSha256 === intent
      ? { kind: 'no-change', match: { kind: 'citation', entry: entry(state, existing) } }
      : {
          kind: 'blocked',
          issue: issue(
            'SCIENTIFIC_CITATION_CONFLICT',
            '/identity',
            'This citation identity already records different intent.'
          ),
        };
  const work = state.scientificWorks[input.workId];
  if (!work || work.intentSha256 !== input.workIntentSha256)
    return {
      kind: 'blocked',
      issue: issue(
        'SCIENTIFIC_CITATION_TARGET_MISMATCH',
        '/workId',
        'Choose the exact existing physical-work observation and intent.'
      ),
    };
  const primaryId =
    work.context.kind === 'notebook-page' ? work.context.pageId : work.context.entityId;
  if (
    input.context.kind === work.context.kind &&
    input.context.entityId === primaryId &&
    input.context.sourceSha256 === work.context.source.sha256
  )
    return {
      kind: 'no-change',
      match: { kind: 'primary-context', workId: work.id, workIntentSha256: work.intentSha256 },
    };
  const key = inventoryScientificCitationSemanticKey(input),
    duplicate = Object.values(state.scientificCitations).find(
      (row) =>
        inventoryScientificCitationSemanticKey(inventoryScientificCitationChoices(row)) === key
    );
  if (duplicate)
    return { kind: 'no-change', match: { kind: 'citation', entry: entry(state, duplicate) } };
  if (input.reinstates) {
    const prior = input.reinstates,
      parent = state.scientificCitations[prior.citationId],
      withdrawal = state.scientificCitationWithdrawals[prior.withdrawalId];
    if (
      !parent ||
      !withdrawal ||
      parent.intentSha256 !== prior.citationIntentSha256 ||
      withdrawal.intentSha256 !== prior.withdrawalIntentSha256 ||
      withdrawal.citationId !== parent.id ||
      withdrawal.citationIntentSha256 !== parent.intentSha256 ||
      parent.workId !== work.id ||
      parent.workIntentSha256 !== work.intentSha256 ||
      withdrawal.workId !== work.id ||
      withdrawal.workIntentSha256 !== work.intentSha256 ||
      canonical(inventoryScientificCitationChoices(parent).context) !== canonical(input.context) ||
      Object.values(state.scientificCitations).some(
        (row) =>
          row.reinstates?.citationId === parent.id || row.reinstates?.withdrawalId === withdrawal.id
      )
    )
      return {
        kind: 'blocked',
        issue: issue(
          'SCIENTIFIC_CITATION_PREDECESSOR_MISMATCH',
          '/reinstates',
          'A new generation requires the exact withdrawn predecessor, source pin and unused successor position.'
        ),
      };
  }
  return { kind: 'new' };
}
export function inventoryScientificCitationWithdrawalExisting(
  state: InventoryState,
  input: InventoryScientificCitationWithdrawalChoices
): InventoryScientificCitationWithdrawalExisting {
  const id = inventoryScientificCitationWithdrawalId(input.identity),
    intent = inventoryScientificCitationWithdrawalIntentSha256(input),
    known = state.scientificCitationWithdrawals[id];
  if (known && known.intentSha256 !== intent)
    return {
      kind: 'blocked',
      issue: issue(
        'SCIENTIFIC_CITATION_WITHDRAWAL_CONFLICT',
        '/identity',
        'This withdrawal identity already records a different correction.'
      ),
    };
  const citation = state.scientificCitations[input.citationId],
    work = state.scientificWorks[input.workId];
  if (
    !citation ||
    !work ||
    citation.intentSha256 !== input.citationIntentSha256 ||
    citation.workId !== work.id ||
    citation.workIntentSha256 !== input.workIntentSha256 ||
    work.intentSha256 !== input.workIntentSha256
  )
    return {
      kind: 'blocked',
      issue: issue(
        'SCIENTIFIC_CITATION_TARGET_MISMATCH',
        '/citationId',
        'Choose the exact existing citation and physical-work pins.'
      ),
    };
  const withdrawal = known ?? withdrawalFor(state, citation.id);
  return withdrawal
    ? {
        kind: 'no-change',
        citation: structuredClone(citation),
        withdrawal: structuredClone(withdrawal),
      }
    : { kind: 'new', citation: structuredClone(citation) };
}
function admission(
  state: InventoryState,
  input: Pick<
    InventoryScientificCitationPreviewInput,
    'target' | 'asOf' | 'principal' | 'authority'
  >
) {
  const context = parseInventoryExecutionContext({
    at: input.asOf,
    principal: input.principal,
    authority: input.authority,
  });
  if (!input.target.present || state.revision !== input.target.revision)
    return {
      issue: issue(
        'REVISION_CONFLICT',
        '/target',
        'The inventory changed. Inspect it before submitting another command.'
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
function plan(
  input:
    | InventoryScientificCitationPreviewInput
    | InventoryScientificCitationWithdrawalPreviewInput,
  intentSha256: InventoryTableSha256,
  withdrawal: boolean
): InventoryTableSha256 {
  return inventoryTableSha256(
    canonical({
      schema: withdrawal
        ? 'dnaforge.inventory-scientific-citation-withdrawal-plan.v1'
        : 'dnaforge.inventory-scientific-citation-plan.v1',
      target: input.target,
      intentSha256,
      principal: input.principal,
      authority: input.authority,
    })
  );
}
function prepareCitation(
  state: InventoryState,
  input: InventoryScientificCitationPreviewInput
): { preview: InventoryScientificCitationPreview; state?: InventoryState } {
  let intentSha256: InventoryTableSha256 | null = null;
  const facts = () => ({
    schema: 'dnaforge.inventory-scientific-citation-preview.v1' as const,
    target: structuredClone(input.target),
    workId: input.workId,
    intentSha256,
  });
  const blocked = (
    value: InventoryScientificCitationIssue
  ): { preview: InventoryScientificCitationPreview } => ({
    preview: { ...facts(), kind: 'blocked', issues: [value] },
  });
  try {
    intentSha256 = inventoryScientificCitationIntentSha256(input);
    const existing = inventoryScientificCitationExisting(state, input);
    if (existing.kind === 'blocked') return blocked(existing.issue);
    if (existing.kind === 'no-change') return { preview: { ...facts(), ...existing } };
    const admitted = admission(state, input);
    if (admitted.issue) return blocked(admitted.issue);
    const context = admitted.context!,
      id = inventoryScientificCitationId(input.identity);
    if (inventoryRecordIdExists(state, id))
      return blocked(
        issue('ID_ALREADY_EXISTS', '/identity', 'That inventory record identifier already exists.')
      );
    const source = input.source;
    if (
      !source ||
      source.projectId !== input.target.projectId ||
      !source.workspaceScope ||
      !source.fileObjectUuid ||
      !source.title ||
      !input.context.entityId.startsWith(`${source.workspaceScope}::`)
    )
      return blocked(
        issue(
          'SCIENTIFIC_CONTEXT_MISMATCH',
          '/context',
          'Choose an exact admitted saved source in the inventory project.'
        )
      );
    let sourceSha256: InventoryTableSha256;
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
          issue('SCIENTIFIC_CONTEXT_MISMATCH', '/context', 'Choose the exact saved Run source.')
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
          '/context/sourceSha256',
          'The saved source changed. Select it and preview again.'
        )
      );
    const citation: InventoryScientificCitation = {
      id,
      identity: { ...input.identity },
      intentSha256,
      workId: input.workId,
      workIntentSha256: input.workIntentSha256,
      reinstates: input.reinstates ? { ...input.reinstates } : null,
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
      at: context.at,
      by: { ...context.principal },
      reason: input.reason,
    };
    const candidate = parseInventoryState({
      ...state,
      revision: state.revision + 1,
      lastRecordedAt: context.at,
      scientificCitations: Object.assign(Object.create(null), state.scientificCitations, {
        [id]: citation,
      }),
    });
    return {
      preview: {
        ...facts(),
        kind: 'ready',
        citation: candidate.scientificCitations[id],
        planDigest: plan(input, intentSha256, false),
      },
      state: candidate,
    };
  } catch (error) {
    return blocked(
      issue(
        'INVALID_INVENTORY_INPUT',
        '/citation',
        error instanceof Error ? error.message : 'Invalid saved citation.'
      )
    );
  }
}
function prepareWithdrawal(
  state: InventoryState,
  input: InventoryScientificCitationWithdrawalPreviewInput
): { preview: InventoryScientificCitationWithdrawalPreview; state?: InventoryState } {
  let intentSha256: InventoryTableSha256 | null = null;
  const facts = () => ({
    schema: 'dnaforge.inventory-scientific-citation-withdrawal-preview.v1' as const,
    target: structuredClone(input.target),
    workId: input.workId,
    intentSha256,
  });
  const blocked = (
    value: InventoryScientificCitationIssue
  ): { preview: InventoryScientificCitationWithdrawalPreview } => ({
    preview: { ...facts(), kind: 'blocked', issues: [value] },
  });
  try {
    intentSha256 = inventoryScientificCitationWithdrawalIntentSha256(input);
    const existing = inventoryScientificCitationWithdrawalExisting(state, input);
    if (existing.kind === 'blocked') return blocked(existing.issue);
    if (existing.kind === 'no-change') return { preview: { ...facts(), ...existing } };
    const admitted = admission(state, input);
    if (admitted.issue) return blocked(admitted.issue);
    const context = admitted.context!,
      id = inventoryScientificCitationWithdrawalId(input.identity);
    if (inventoryRecordIdExists(state, id))
      return blocked(
        issue('ID_ALREADY_EXISTS', '/identity', 'That inventory record identifier already exists.')
      );
    const withdrawal = {
      id,
      identity: { ...input.identity },
      intentSha256,
      citationId: input.citationId,
      citationIntentSha256: input.citationIntentSha256,
      workId: input.workId,
      workIntentSha256: input.workIntentSha256,
      at: context.at,
      by: { ...context.principal },
      reason: input.reason,
    };
    const candidate = parseInventoryState({
      ...state,
      revision: state.revision + 1,
      lastRecordedAt: context.at,
      scientificCitationWithdrawals: Object.assign(
        Object.create(null),
        state.scientificCitationWithdrawals,
        { [id]: withdrawal }
      ),
    });
    return {
      preview: {
        ...facts(),
        kind: 'ready',
        citation: existing.citation,
        withdrawal: candidate.scientificCitationWithdrawals[id],
        planDigest: plan(input, intentSha256, true),
      },
      state: candidate,
    };
  } catch (error) {
    return blocked(
      issue(
        'INVALID_INVENTORY_INPUT',
        '/withdrawal',
        error instanceof Error ? error.message : 'Invalid citation withdrawal.'
      )
    );
  }
}
export function inventoryScientificCitationPreview(
  state: InventoryState,
  input: InventoryScientificCitationPreviewInput
) {
  return prepareCitation(state, input).preview;
}
export function inventoryScientificCitationWithdrawalPreview(
  state: InventoryState,
  input: InventoryScientificCitationWithdrawalPreviewInput
) {
  return prepareWithdrawal(state, input).preview;
}
export function applyInventoryScientificCitation(
  state: InventoryState,
  input: InventoryScientificCitationApplication,
  context: InventoryExecutionContext
): InventoryTransition {
  const prepared = prepareCitation(state, {
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
      message: 'The saved citation preview changed. Preview it again.',
    };
  return { ok: true, state: prepared.state };
}
export function applyInventoryScientificCitationWithdrawal(
  state: InventoryState,
  input: InventoryScientificCitationWithdrawalApplication,
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
  if (!prepared.state || prepared.preview.planDigest !== input.expectedPlanDigest)
    return {
      ok: false,
      code: 'REVISION_CONFLICT',
      message: 'The citation withdrawal preview changed. Preview it again.',
    };
  return { ok: true, state: prepared.state };
}
