import { z } from 'zod';
import {
  ENTITY_RECORD_ARTIFACT_SUFFIX,
  MOLECULAR_DOCUMENT_FILE_SUFFIX,
  TRACK_VIEW_FILE_SUFFIX,
} from './registry-file-types';
import { scientificPackageKindForMetaPath } from './scientific-package';
import { isForgePackageMetaPath } from './forge-package-path';
import { SEQUENCE_PACKAGE_META_ALIASES } from '../db/sequence-package-contract';
import { getTabTypeForFile } from '../utils/fileTypes';
import { documentReadFailureCode } from './document-read-failure';

// A path or catalog entry identifies what to try opening. Only the owning
// reader can return "ready". A readiness result applies to the bytes it read.
const literalDocumentKind = z.enum(['pdf', 'image', 'table', 'html']);
export type LiteralDocumentKind = z.infer<typeof literalDocumentKind>;

export function isLiteralDocumentKind(value: unknown): value is LiteralDocumentKind {
  return literalDocumentKind.safeParse(value).success;
}
const documentKind = z.enum([
  ...literalDocumentKind.options,
  'molecular-document',
  'structure',
  'sequence',
  'protein',
  'notebook',
  'design',
  'primer',
  'entity',
  'selection',
  'sequence-package',
  'table-package',
  'protocol',
  'protocol-run',
  'track-view',
]);
export type TypedDocumentKind = z.infer<typeof documentKind>;

const sequencePackagePreview = z.object({
  documentId: z.string(),
  name: z.string(),
  productPath: z.string(),
  schemaName: z.string().optional(),
});

export const documentAvailabilitySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unchecked') }),
  z.object({
    state: z.literal('ready'),
    kind: documentKind,
    revision: z.string(),
    paths: z.array(z.string()).optional(),
    sequencePackage: sequencePackagePreview.optional(),
  }),
  z.object({
    state: z.literal('blocked'),
    code: documentReadFailureCode,
    reason: z.string(),
    recognized: z.boolean(),
    paths: z.array(z.string()).optional(),
  }),
]);
export type DocumentAvailability = z.infer<typeof documentAvailabilitySchema>;
export type DocumentAvailabilityProbe =
  | DocumentAvailability
  | {
      state: 'inspect-design-draft';
      designId: string;
      revision: string;
      paths: string[];
    }
  | {
      state: 'inspect';
      kind: z.infer<typeof literalDocumentKind>;
      path: string;
      revision: string;
      paths: string[];
    };
export type DocumentAvailabilityRequest = Readonly<{
  workspaceRoot?: string;
  path: string;
  package?: boolean;
  literalKind?: LiteralDocumentKind;
}>;

export function isMolecularDocumentFile(path: string): boolean {
  return path.toLowerCase().endsWith(MOLECULAR_DOCUMENT_FILE_SUFFIX);
}

export function typedDocumentKindForPath(path: string): TypedDocumentKind | undefined {
  const normalized = path.toLowerCase().replace(/\\/g, '/');
  if (isMolecularDocumentFile(normalized)) return 'molecular-document';
  if (normalized.endsWith(ENTITY_RECORD_ARTIFACT_SUFFIX)) return 'entity';
  if (normalized.endsWith(TRACK_VIEW_FILE_SUFFIX)) return 'track-view';
  if (normalized.endsWith('.wpselection.json')) return 'selection';
  if (normalized.endsWith('.dnaforge-protocol-run.json')) return 'protocol-run';
  if (normalized.endsWith('.dnaforge-protocol.json')) return 'protocol';
  const scientific = scientificPackageKindForMetaPath(normalized);
  if (scientific) return scientific;
  if (isForgePackageMetaPath(normalized, 'table.json')) return 'table-package';
  if (SEQUENCE_PACKAGE_META_ALIASES.some((name) => isForgePackageMetaPath(normalized, name)))
    return 'sequence-package';
  const tab = getTabTypeForFile(normalized);
  switch (tab) {
    case 'page':
      return 'notebook';
    case 'design':
    case 'primer':
    case 'structure':
    case 'sequence':
    case 'protein':
    case 'pdf':
    case 'image':
    case 'table':
    case 'html':
      return tab;
    default:
      return undefined;
  }
}

export function isTypedDocumentCandidate(path: string): boolean {
  return typedDocumentKindForPath(path) !== undefined;
}

export function canOpenDocument(availability?: DocumentAvailability | { state: 'checking' }) {
  return !availability || availability.state === 'unchecked' || availability.state === 'ready';
}
