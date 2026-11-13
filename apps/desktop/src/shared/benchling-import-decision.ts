import {
  parseRegistryTableMappingDecision,
  type RegistryTableMappingDecision,
} from './benchling-registry-table-review';

export type Sha256Digest = `sha256:${string}`;

export type ExistingPathFingerprint =
  | Readonly<{ kind: 'file'; sha256: Sha256Digest; sizeBytes: number }>
  | Readonly<{ kind: 'directory'; treeSha256: Sha256Digest }>;

export type ProviderVersionConflictDecision = Readonly<{
  kind: 'provider_version_conflict';
  policy: 'keep_existing' | 'use_incoming';
}>;

export type UnboundExactMatchDecision = Readonly<{
  kind: 'unbound_exact_match';
  sourceObjectId: string;
  candidateEntityId: string;
  expectedCandidateScientificSha256: Sha256Digest;
  expectedBindingState: 'unbound';
  policy: 'link_existing' | 'import_separate';
}>;

export type StructuralPathConflictDecision = Readonly<{
  kind: 'structural_path_conflict';
  relativePath: string;
  expectedExistingState: ExistingPathFingerprint;
  policy: 'rename_incoming' | 'replace_existing' | 'cancel_import';
}>;

export type ImportDecision =
  | RegistryTableMappingDecision
  | ProviderVersionConflictDecision
  | UnboundExactMatchDecision
  | StructuralPathConflictDecision;

export type PendingImportDecision =
  | Readonly<{
      kind: 'provider_version_conflict';
      conflicts: readonly Readonly<{
        sourceObjectId: string;
        stableId: string;
        displayName: string;
      }>[];
    }>
  | Readonly<{
      kind: 'unbound_exact_match';
      sourceObjectId: string;
      sourceDisplayName: string;
      candidateEntityId: string;
      candidateDisplayName: string;
      expectedCandidateScientificSha256: Sha256Digest;
    }>
  | Readonly<{
      kind: 'structural_path_conflict';
      relativePath: string;
      incomingKind: 'file' | 'package' | 'catalog-record';
      expectedExistingState: ExistingPathFingerprint;
      replaceAllowed: boolean;
    }>;

export type ImportDecisionSummary = Readonly<{
  providerVersionConflictCount: number;
  unboundExactMatchCount: number;
  structuralPathConflictCount: number;
}>;

export function importDecisionKey(decision: ImportDecision): string {
  switch (decision.kind) {
    case 'registry_table_mapping':
      return `registry_table_mapping:${decision.source.archiveSha256}:${decision.source.entryPath}`;
    case 'provider_version_conflict':
      return 'provider_version_conflict';
    case 'unbound_exact_match':
      return `unbound_exact_match:${decision.sourceObjectId}`;
    case 'structural_path_conflict':
      return `structural_path_conflict:${decision.relativePath}`;
  }
}

export function sortPendingImportDecisions(
  decisions: readonly PendingImportDecision[]
): PendingImportDecision[] {
  return [...decisions].sort((left, right) => {
    const rankDifference = importDecisionRank(left.kind) - importDecisionRank(right.kind);
    if (rankDifference !== 0) return rankDifference;
    return importDecisionScope(left).localeCompare(importDecisionScope(right));
  });
}

export function nextUnansweredImportDecision(
  pending: readonly PendingImportDecision[],
  answered: readonly ImportDecision[]
): PendingImportDecision | null {
  const answeredKeys = new Set(answered.map(importDecisionKey));
  return (
    sortPendingImportDecisions(pending).find(
      (decision) => !answeredKeys.has(pendingImportDecisionKey(decision))
    ) ?? null
  );
}

export function summarizeImportDecisions(
  decisions: readonly ImportDecision[]
): ImportDecisionSummary {
  const summary = {
    providerVersionConflictCount: 0,
    unboundExactMatchCount: 0,
    structuralPathConflictCount: 0,
  };
  for (const decision of decisions) {
    switch (decision.kind) {
      case 'registry_table_mapping':
        break;
      case 'provider_version_conflict':
        summary.providerVersionConflictCount += 1;
        break;
      case 'unbound_exact_match':
        summary.unboundExactMatchCount += 1;
        break;
      case 'structural_path_conflict':
        summary.structuralPathConflictCount += 1;
        break;
    }
  }
  return summary;
}

export function pendingImportDecisionKey(decision: PendingImportDecision): string {
  switch (decision.kind) {
    case 'provider_version_conflict':
      return 'provider_version_conflict';
    case 'unbound_exact_match':
      return `unbound_exact_match:${decision.sourceObjectId}`;
    case 'structural_path_conflict':
      return `structural_path_conflict:${decision.relativePath}`;
  }
}

export function isProtectedImportReplacementPath(relativePath: string): boolean {
  const [topLevel] = relativePath.normalize('NFC').replace(/\\/g, '/').split('/');
  return (
    topLevel !== undefined &&
    ['.git', '.dnaforge', '.forge', '.waypoint'].includes(topLevel.toLowerCase())
  );
}

export function isImportDecision(value: unknown): value is ImportDecision {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'registry_table_mapping':
      try {
        parseRegistryTableMappingDecision(value);
        return true;
      } catch {
        return false;
      }
    case 'provider_version_conflict':
      return (
        hasExactKeys(value, ['kind', 'policy']) &&
        (value.policy === 'keep_existing' || value.policy === 'use_incoming')
      );
    case 'unbound_exact_match':
      return (
        hasExactKeys(value, [
          'candidateEntityId',
          'expectedBindingState',
          'expectedCandidateScientificSha256',
          'kind',
          'policy',
          'sourceObjectId',
        ]) &&
        isNonemptyString(value.sourceObjectId) &&
        isNonemptyString(value.candidateEntityId) &&
        isSha256Digest(value.expectedCandidateScientificSha256) &&
        value.expectedBindingState === 'unbound' &&
        (value.policy === 'link_existing' || value.policy === 'import_separate')
      );
    case 'structural_path_conflict':
      return (
        hasExactKeys(value, ['expectedExistingState', 'kind', 'policy', 'relativePath']) &&
        isNonemptyString(value.relativePath) &&
        isExistingPathFingerprint(value.expectedExistingState) &&
        (value.policy === 'rename_incoming' ||
          value.policy === 'replace_existing' ||
          value.policy === 'cancel_import')
      );
    default:
      return false;
  }
}

export function isPendingImportDecision(value: unknown): value is PendingImportDecision {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'provider_version_conflict':
      return (
        hasExactKeys(value, ['conflicts', 'kind']) &&
        Array.isArray(value.conflicts) &&
        value.conflicts.length > 0 &&
        value.conflicts.every(
          (conflict) =>
            isRecord(conflict) &&
            hasExactKeys(conflict, ['displayName', 'sourceObjectId', 'stableId']) &&
            isNonemptyString(conflict.sourceObjectId) &&
            isNonemptyString(conflict.stableId) &&
            typeof conflict.displayName === 'string'
        )
      );
    case 'unbound_exact_match':
      return (
        hasExactKeys(value, [
          'candidateDisplayName',
          'candidateEntityId',
          'expectedCandidateScientificSha256',
          'kind',
          'sourceDisplayName',
          'sourceObjectId',
        ]) &&
        isNonemptyString(value.sourceObjectId) &&
        typeof value.sourceDisplayName === 'string' &&
        isNonemptyString(value.candidateEntityId) &&
        typeof value.candidateDisplayName === 'string' &&
        isSha256Digest(value.expectedCandidateScientificSha256)
      );
    case 'structural_path_conflict':
      return (
        hasExactKeys(value, [
          'expectedExistingState',
          'incomingKind',
          'kind',
          'relativePath',
          'replaceAllowed',
        ]) &&
        isNonemptyString(value.relativePath) &&
        (value.incomingKind === 'file' ||
          value.incomingKind === 'package' ||
          value.incomingKind === 'catalog-record') &&
        isExistingPathFingerprint(value.expectedExistingState) &&
        typeof value.replaceAllowed === 'boolean'
      );
    default:
      return false;
  }
}

export function importDecisionAnswersPending(
  decision: ImportDecision,
  pending: PendingImportDecision
): boolean {
  if (decision.kind !== pending.kind) return false;
  switch (pending.kind) {
    case 'provider_version_conflict':
      return decision.kind === 'provider_version_conflict';
    case 'unbound_exact_match':
      return (
        decision.kind === 'unbound_exact_match' &&
        decision.sourceObjectId === pending.sourceObjectId &&
        decision.candidateEntityId === pending.candidateEntityId &&
        decision.expectedCandidateScientificSha256 === pending.expectedCandidateScientificSha256 &&
        decision.expectedBindingState === 'unbound'
      );
    case 'structural_path_conflict':
      return (
        decision.kind === 'structural_path_conflict' &&
        decision.relativePath === pending.relativePath &&
        sameExistingPathFingerprint(
          decision.expectedExistingState,
          pending.expectedExistingState
        ) &&
        (decision.policy !== 'replace_existing' || pending.replaceAllowed)
      );
  }
}

function importDecisionRank(kind: PendingImportDecision['kind']): number {
  switch (kind) {
    case 'provider_version_conflict':
      return 0;
    case 'unbound_exact_match':
      return 1;
    case 'structural_path_conflict':
      return 2;
  }
}

function importDecisionScope(decision: PendingImportDecision): string {
  switch (decision.kind) {
    case 'provider_version_conflict':
      return '';
    case 'unbound_exact_match':
      return decision.sourceObjectId;
    case 'structural_path_conflict':
      return decision.relativePath.normalize('NFC').replace(/\\/g, '/');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isExistingPathFingerprint(value: unknown): value is ExistingPathFingerprint {
  if (!isRecord(value)) return false;
  if (value.kind === 'file') {
    return (
      hasExactKeys(value, ['kind', 'sha256', 'sizeBytes']) &&
      isSha256Digest(value.sha256) &&
      Number.isSafeInteger(value.sizeBytes) &&
      Number(value.sizeBytes) >= 0
    );
  }
  return (
    value.kind === 'directory' &&
    hasExactKeys(value, ['kind', 'treeSha256']) &&
    isSha256Digest(value.treeSha256)
  );
}

function sameExistingPathFingerprint(
  left: ExistingPathFingerprint,
  right: ExistingPathFingerprint
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
