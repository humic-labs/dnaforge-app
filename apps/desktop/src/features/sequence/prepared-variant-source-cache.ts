import type { IndexedGenomeVariantSourceState } from '../../shared/indexed-genome';

import type { PreparedVariantSource, VariantReferenceIdentity } from './variant-client';

const remembered = new Map<string, PreparedVariantSource>();

function referenceKey(references: ReadonlyArray<VariantReferenceIdentity>): string {
  return references.map((reference) => `${reference.name}\u0001${reference.length}`).join('\u0000');
}

function entryKey(sourcePath: string, references: ReadonlyArray<VariantReferenceIdentity>): string {
  return `${sourcePath}\u0002${referenceKey(references)}`;
}

export function rememberPreparedVariantSource(
  prepared: PreparedVariantSource,
  references: ReadonlyArray<VariantReferenceIdentity>,
  requestedPath?: string
): void {
  remembered.set(entryKey(prepared.sourcePath, references), prepared);
  if (requestedPath && requestedPath !== prepared.sourcePath) {
    remembered.set(entryKey(requestedPath, references), prepared);
  }
}

export function recallPreparedVariantSource(
  sourcePath: string,
  references: ReadonlyArray<VariantReferenceIdentity>
): PreparedVariantSource | null {
  return remembered.get(entryKey(sourcePath, references)) ?? null;
}

export function forgetPreparedVariantSource(sourcePath: string): void {
  const canonicalPaths = new Set<string>();
  for (const [key, prepared] of remembered) {
    if (key.startsWith(`${sourcePath}\u0002`) || prepared.sourcePath === sourcePath) {
      canonicalPaths.add(prepared.sourcePath);
    }
  }
  for (const [key, prepared] of [...remembered]) {
    if (key.startsWith(`${sourcePath}\u0002`) || canonicalPaths.has(prepared.sourcePath)) {
      remembered.delete(key);
    }
  }
}

export function clearPreparedVariantSources(): void {
  remembered.clear();
}

export function preparedVariantSourceFromDurable(
  source: IndexedGenomeVariantSourceState
): PreparedVariantSource | null {
  const request = source.admittedSource?.request;
  if (request && request.source.kind !== 'local-file') return null;
  if (
    !source.sourceGeneration ||
    !source.queryGeneration ||
    !source.indexGeneration ||
    !source.assemblyRevision ||
    source.sourceMtimeNs === undefined
  ) {
    return null;
  }
  return {
    sourcePath: source.sourcePath,
    queryPath: source.queryPath,
    indexPath: source.indexPath,
    format: source.format,
    label: source.label,
    sourceSizeBytes: source.sourceSizeBytes,
    sourceMtimeNs: source.sourceMtimeNs,
    sourceIdentity: source.sourceIdentity,
    sourceGeneration: source.sourceGeneration,
    queryGeneration: source.queryGeneration,
    indexGeneration: source.indexGeneration,
    assemblyRevision: source.assemblyRevision,
    matchedReferences: [...source.matchedReferences],
    samples: [...source.samples],
  };
}
