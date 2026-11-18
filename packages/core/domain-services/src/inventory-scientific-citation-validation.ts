import type { InventoryState } from './inventory-types';
import {
  inventoryScientificCitationId,
  inventoryScientificCitationWithdrawalId,
  inventoryScientificCitationIntentSha256,
  inventoryScientificCitationWithdrawalIntentSha256,
  inventoryScientificCitationChoices,
  inventoryScientificCitationWithdrawalChoices,
  inventoryScientificCitationSemanticKey,
} from './inventory-scientific-citation-identity';
import { inventoryTableCanonicalJson as canonical } from './inventory-table-binding';

function invalid(message: string): never {
  throw new TypeError(message);
}

export function validateInventoryScientificCitations(state: InventoryState): void {
  const semanticKeys = new Set<string>();
  const withdrawals = new Map<string, string>();
  const successors = new Map<string, string>();
  const parents = new Map<string, string>();
  for (const [key, withdrawal] of Object.entries(state.scientificCitationWithdrawals)) {
    const citation = Object.hasOwn(state.scientificCitations, withdrawal.citationId)
      ? state.scientificCitations[withdrawal.citationId]
      : undefined;
    if (
      key !== withdrawal.id ||
      withdrawal.id !== inventoryScientificCitationWithdrawalId(withdrawal.identity) ||
      withdrawal.intentSha256 !==
        inventoryScientificCitationWithdrawalIntentSha256(
          inventoryScientificCitationWithdrawalChoices(withdrawal)
        )
    )
      invalid('A citation withdrawal must retain its exact immutable identity and intent.');
    if (
      !citation ||
      citation.intentSha256 !== withdrawal.citationIntentSha256 ||
      citation.workId !== withdrawal.workId ||
      citation.workIntentSha256 !== withdrawal.workIntentSha256
    )
      invalid('A withdrawal must reference the exact existing citation and physical work.');
    if (withdrawal.at < citation.at || withdrawal.at > state.lastRecordedAt)
      invalid('A withdrawal must follow its citation within the recorded inventory clock.');
    if (withdrawals.has(citation.id)) invalid('A citation can have only one immutable withdrawal.');
    withdrawals.set(citation.id, withdrawal.id);
  }
  for (const [key, citation] of Object.entries(state.scientificCitations)) {
    const choices = inventoryScientificCitationChoices(citation);
    const work = Object.hasOwn(state.scientificWorks, citation.workId)
      ? state.scientificWorks[citation.workId]
      : undefined;
    if (
      key !== citation.id ||
      citation.id !== inventoryScientificCitationId(citation.identity) ||
      citation.intentSha256 !== inventoryScientificCitationIntentSha256(choices)
    )
      invalid('A citation must retain its exact immutable identity and intent.');
    if (!work || work.intentSha256 !== citation.workIntentSha256)
      invalid('A citation must reference the exact immutable physical work.');
    if (citation.at < work.at || citation.at > state.lastRecordedAt)
      invalid('A citation must follow its physical work within the recorded inventory clock.');
    if (!citation.context.entityId.startsWith(`${citation.context.workspaceScope}::`))
      invalid('A citation must retain its canonical scoped source identity.');
    const primary = work.context;
    if (
      primary.kind === citation.context.kind &&
      primary.projectId === citation.context.projectId &&
      primary.workspaceScope === citation.context.workspaceScope &&
      (primary.kind === 'notebook-page' ? primary.pageId : primary.entityId) ===
        citation.context.entityId &&
      primary.source.sha256 === citation.context.source.sha256
    )
      invalid('A citation cannot duplicate the original primary context.');
    const semanticKey = inventoryScientificCitationSemanticKey(choices);
    if (semanticKeys.has(semanticKey))
      invalid('A citation target and generation can be recorded only once across all history.');
    semanticKeys.add(semanticKey);
    if (!citation.reinstates) continue;
    const predecessor = Object.hasOwn(state.scientificCitations, citation.reinstates.citationId)
      ? state.scientificCitations[citation.reinstates.citationId]
      : undefined;
    const withdrawal = Object.hasOwn(
      state.scientificCitationWithdrawals,
      citation.reinstates.withdrawalId
    )
      ? state.scientificCitationWithdrawals[citation.reinstates.withdrawalId]
      : undefined;
    if (
      !predecessor ||
      !withdrawal ||
      predecessor.id === citation.id ||
      predecessor.intentSha256 !== citation.reinstates.citationIntentSha256 ||
      withdrawal.intentSha256 !== citation.reinstates.withdrawalIntentSha256 ||
      withdrawal.citationId !== predecessor.id ||
      withdrawal.citationIntentSha256 !== predecessor.intentSha256 ||
      predecessor.workId !== citation.workId ||
      predecessor.workIntentSha256 !== citation.workIntentSha256 ||
      canonical(predecessor.context) !== canonical(citation.context)
    )
      invalid(
        'Reattachment must pin the exact withdrawn predecessor for the same work and saved source.'
      );
    if (citation.at < withdrawal.at)
      invalid('Reattachment must follow the predecessor withdrawal.');
    if (successors.has(withdrawal.id))
      invalid('A withdrawn citation can have only one successor generation.');
    successors.set(withdrawal.id, citation.id);
    parents.set(citation.id, predecessor.id);
  }
  const visited = new Set<string>();
  for (const citationId of Object.keys(state.scientificCitations)) {
    const path = new Set<string>();
    let id: string | undefined = citationId;
    while (id && !visited.has(id)) {
      if (path.has(id)) invalid('Scientific citation generations cannot form a cycle.');
      path.add(id);
      id = parents.get(id);
    }
    for (const item of path) visited.add(item);
  }
}
