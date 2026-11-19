import { z } from 'zod';
import { MOLECULAR_DOCUMENT_FILE_SUFFIX, REGISTRY_FILE_TYPES } from './registry-file-types';
import { scientificPackageKindForMetaPath } from './scientific-package';
import { isForgePackageMetaPath } from './forge-package-path';

// A path or catalog entry identifies what to try opening. Only the owning
// reader can return "ready". A readiness result applies to the bytes it read.
export const documentAvailabilitySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unchecked') }),
  z.object({ state: z.literal('ready'), revision: z.string() }),
  z.object({ state: z.literal('blocked'), reason: z.string() }),
]);
export type DocumentAvailability = z.infer<typeof documentAvailabilitySchema>;
export type DocumentAvailabilityRequest = Readonly<{ workspaceRoot: string; path: string }>;

export function isMolecularDocumentFile(path: string): boolean {
  return path.toLowerCase().endsWith(MOLECULAR_DOCUMENT_FILE_SUFFIX);
}

export function isTypedDocumentCandidate(path: string): boolean {
  const normalized = path.toLowerCase().replace(/\\/g, '/');
  return (
    REGISTRY_FILE_TYPES.some(({ suffix }) => normalized.endsWith(suffix)) ||
    isForgePackageMetaPath(path, 'table.json') ||
    Boolean(scientificPackageKindForMetaPath(path))
  );
}
