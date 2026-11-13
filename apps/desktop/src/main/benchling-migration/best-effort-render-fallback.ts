import type {
  ExternalZipEntryEvidence,
  MigrationIssue,
  SourceObject,
} from '../../shared/benchling-migration';
import type { MigrationRenderCheck } from './validation';

export function selectBestEffortRenderFallbackPaths(input: {
  expectedSourceObjectIds: readonly string[];
  renderChecks: readonly MigrationRenderCheck[];
  blockingIssues: readonly MigrationIssue[];
  sourceObjects: readonly Pick<SourceObject, 'id' | 'sourcePath'>[];
  sourceEntries: readonly Pick<ExternalZipEntryEvidence, 'entryPath' | 'sourceObjectId' | 'role'>[];
  alreadyFallbackEntryPaths?: readonly string[];
}): string[] {
  const expected = new Set(input.expectedSourceObjectIds);
  if (
    expected.size === 0 ||
    expected.size !== input.expectedSourceObjectIds.length ||
    input.renderChecks.length !== expected.size ||
    new Set(input.renderChecks.map((check) => check.sourceObjectId)).size !== expected.size ||
    input.renderChecks.some((check) => !expected.has(check.sourceObjectId))
  ) {
    return [];
  }
  const failedChecks = input.renderChecks.filter((check) => !check.passed);
  if (
    failedChecks.length === 0 ||
    failedChecks.some(
      (check) =>
        !check.message || check.message.startsWith('Destination render validation failed closed:')
    ) ||
    input.blockingIssues.length !== failedChecks.length
  ) {
    return [];
  }
  const failedMessages = new Map(
    failedChecks.map((check) => [check.sourceObjectId, check.message] as const)
  );
  if (
    input.blockingIssues.some(
      (issue) =>
        issue.code !== 'validation_failed' ||
        !issue.sourceObjectId ||
        failedMessages.get(issue.sourceObjectId) !== issue.message
    )
  ) {
    return [];
  }
  const sourceById = new Map(input.sourceObjects.map((source) => [source.id, source] as const));
  const alreadyFallback = new Set(input.alreadyFallbackEntryPaths ?? []);
  const paths: string[] = [];
  for (const check of failedChecks) {
    const sourcePath = sourceById.get(check.sourceObjectId)?.sourcePath;
    if (
      !sourcePath ||
      alreadyFallback.has(sourcePath) ||
      input.sourceEntries.filter(
        (entry) =>
          entry.role === 'source-record' &&
          entry.sourceObjectId === check.sourceObjectId &&
          entry.entryPath === sourcePath
      ).length !== 1
    ) {
      return [];
    }
    paths.push(sourcePath);
  }
  return [...new Set(paths)].sort();
}
