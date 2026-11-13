
import { z } from 'zod';
import { nucleicAcidOf, nucleicAcidOfBases, type NucleicAcid } from '@waypoint/sequence-utils';
import { getEntityReference, updateEntityReference } from '../../../db/entity-references';
import { getCatalogEntityForFilePath } from '../../../db/workspace-catalog';
import { useSequenceStore } from '../../sequence/public/store';
import { useWorkspaceStore, type WorkspaceFolder } from '../../../stores/workspaceStore';
import { parseLocatorPath } from '../references/resolver';
import { resolveMultiRootPath } from './path-utils';
import { resolveFilePathWithFallback } from '../../../hooks/resolveFilePath';
import { parseBiologyContent } from './parse-biology-file';
import { platform } from '../../../platform';
import { primerBindingToViewState } from '../../sequence/public/primer-binding-viewstate';
import { looksLikeWorkspacePath } from '../../../shared/resolve-entity-path';
import { resolveSequenceDocumentById } from '../../sequence/public/sequence-document-repository';

export type SelectionErrorCode =
  | 'REFERENCE_NOT_FOUND'
  | 'NO_RANGE'
  | 'SEQUENCE_UNAVAILABLE'
  | 'STALE_SELECTION'
  | 'INVALID_SELECTION_INPUT'
  | 'DISJOINT_SELECTION';

export interface DisjointSelectionRegion {
  codingDnaMapped: boolean;
  start?: number;
  end?: number;
  strand?: string;
  reason?: string;
}

export interface SelectionError {
  error: SelectionErrorCode;
  message: string;
  regions?: DisjointSelectionRegion[];
}

export interface SelectionRange {
  start: number;
  end: number;
  wraps: boolean;
}

export interface ResolvedSelection {
  refId: string;
  documentId: string | null;
  parentSequence: string;
  parentLength: number;
  topology: 'circular' | 'linear';
  range: SelectionRange;
  sourceVersion: number | null;
  selectionBases: string;
  strand: '+' | '-' | 'unspecified';
  translTable: number | null;
  nucleicAcid: NucleicAcid;
}

export interface RawSelectionInput {
  sequence: string;
  strand?: '+' | '-' | 'unspecified';
  translTable?: number | null;
  topology?: 'circular' | 'linear';
  start?: number;
  end?: number;
}

export interface SelectionInput {
  refId?: string;
  sequence?: string;
  strand?: '+' | '-' | 'unspecified';
  translTable?: number | null;
  topology?: 'circular' | 'linear';
  start?: number;
  end?: number;
}

export const selectionInputSchemaShape = {
  refId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Reference id of an app selection (an entity_references row from "Ask AI about this"). ' +
        'Provide refId (an app selection) OR sequence (raw bases) — exactly one.'
    ),
  sequence: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Raw bases to compute over directly, when no app selection exists. ' +
        'Provide sequence (raw bases) OR refId (an app selection) — exactly one.'
    ),
  strand: z
    .enum(['+', '-', 'unspecified'])
    .optional()
    .describe(
      "Strand for a raw sequence; defaults to 'unspecified' (never assumed). " +
        'Ignored when refId is given (strand is read from the selection descriptor).'
    ),
  translTable: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe('NCBI translation-table id for a raw sequence, or null. Ignored when refId is given.'),
  topology: z
    .enum(['circular', 'linear'])
    .optional()
    .describe("Molecule topology for a raw sequence; defaults to 'linear'. Ignored when refId is given."),
  start: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Optional 1-indexed inclusive sub-range start for a raw sequence (whole sequence if omitted). ' +
        'Ignored when refId is given.'
    ),
  end: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Optional 1-indexed inclusive sub-range end for a raw sequence. Ignored when refId is given.'),
} as const;

export function isSelectionError(value: unknown): value is SelectionError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { error?: unknown }).error === 'string'
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

function safeParse(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function resolveAbsolutePath(locator: string, folders: WorkspaceFolder[]): string {
  if (locator.startsWith('git://') || locator.startsWith('entity://')) {
    const stripped = parseLocatorPath(locator);
    if (folders.length > 0) {
      try {
        return resolveMultiRootPath(folders, stripped).absolutePath;
      } catch {
      }
    }
    return resolveFilePathWithFallback(stripped);
  }
  return locator;
}

interface ResolvedReferenceDocument {
  documentId: string;
  sourcePath: string | null;
}

async function resolveReferenceDocument(
  refId: string,
  locator: string,
  folders: WorkspaceFolder[]
): Promise<ResolvedReferenceDocument | null> {
  if (!looksLikeWorkspacePath(locator)) {
    const document = await resolveSequenceDocumentById(
      locator,
      folders.map((folder) => folder.path)
    ).catch(() => null);
    return { documentId: locator, sourcePath: document?.sourcePath ?? null };
  }

  const sourcePath = resolveAbsolutePath(locator, folders);
  const catalogEntity = await getCatalogEntityForFilePath(sourcePath).catch(() => null);
  if (!catalogEntity) return null;

  await updateEntityReference(refId, { locator: catalogEntity.id });
  return { documentId: catalogEntity.id, sourcePath };
}

function extractRange(
  deepLink: Record<string, unknown> | null,
  descriptor: Record<string, unknown> | null
): SelectionRange | null {
  const measured =
    descriptor && typeof descriptor.measured === 'object' && descriptor.measured !== null
      ? (descriptor.measured as Record<string, unknown>)
      : null;

  const candidate =
    deepLink && typeof deepLink.start === 'number' && typeof deepLink.end === 'number'
      ? deepLink
      : measured && typeof measured.start === 'number' && typeof measured.end === 'number'
        ? measured
        : null;

  if (!candidate) return null;
  return {
    start: candidate.start as number,
    end: candidate.end as number,
    wraps: candidate.wraps === true,
  };
}

function disjointSelectionError(
  descriptor: Record<string, unknown> | null
): SelectionError | null {
  const measured =
    descriptor && typeof descriptor.measured === 'object' && descriptor.measured !== null
      ? (descriptor.measured as Record<string, unknown>)
      : null;
  if (!measured || measured.disjoint !== true) return null;

  const rawRegions = Array.isArray(measured.regions) ? measured.regions : [];
  const regions: DisjointSelectionRegion[] = rawRegions
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      codingDnaMapped: r.codingDnaMapped === true,
      ...(typeof r.start === 'number' ? { start: r.start } : {}),
      ...(typeof r.end === 'number' ? { end: r.end } : {}),
      ...(typeof r.strand === 'string' ? { strand: r.strand } : {}),
      ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
    }));

  const describe = (r: DisjointSelectionRegion): string =>
    r.codingDnaMapped && typeof r.start === 'number' && typeof r.end === 'number'
      ? `${r.start}-${r.end}`
      : `unmapped (${r.reason ?? 'no coding-DNA projection'})`;
  const summary = regions.map(describe).join('; ');

  return {
    error: 'DISJOINT_SELECTION',
    message:
      `This selection spans ${regions.length} disjoint regions${summary ? ` (${summary})` : ''}. ` +
      'Computing over the whole selection as one span would fabricate a contiguous result that ' +
      'does not exist (e.g. a protein concatenating non-adjacent residues). Run this tool once ' +
      'per region — pass a single region’s coordinates or bases — or ask the user which region to use.',
    regions,
  };
}

function readStrand(descriptor: Record<string, unknown> | null): '+' | '-' | 'unspecified' {
  const measured =
    descriptor && typeof descriptor.measured === 'object' && descriptor.measured !== null
      ? (descriptor.measured as Record<string, unknown>)
      : null;
  const strand = measured?.strand;
  if (strand === '+' || strand === '-') return strand;
  return 'unspecified';
}

function readTranslTable(descriptor: Record<string, unknown> | null): number | null {
  const measured =
    descriptor && typeof descriptor.measured === 'object' && descriptor.measured !== null
      ? (descriptor.measured as Record<string, unknown>)
      : null;
  const frames = measured?.readingFrames;
  if (Array.isArray(frames) && frames.length > 0) {
    const table = (frames[0] as Record<string, unknown> | undefined)?.translTable;
    if (typeof table === 'number') return table;
  }
  return null;
}

export function sliceRangeBases(seq: string, start: number, end: number, wraps: boolean): string {
  const viewState = primerBindingToViewState(start, end);
  const start0 = viewState.highlightRange!.start;
  const end0 = viewState.highlightRange!.end;
  if (!wraps) return seq.slice(start0, end0 + 1);
  return seq.slice(start0) + seq.slice(0, end0 + 1);
}

export async function resolveSelectionBases(
  refId: string,
  folders: WorkspaceFolder[] = []
): Promise<ResolvedSelection | SelectionError> {
  const row = await getEntityReference(refId);
  if (!row) {
    return {
      error: 'REFERENCE_NOT_FOUND',
      message: `No selection reference found for id "${refId}".`,
    };
  }

  const deepLink = safeParse(row.deep_link_params);
  const descriptor = safeParse(row.data);

  const disjoint = disjointSelectionError(descriptor);
  if (disjoint) return disjoint;

  const range = extractRange(deepLink, descriptor);
  if (!range) {
    return {
      error: 'NO_RANGE',
      message: 'This reference carries no {start,end} coordinate range to compute over.',
    };
  }

  const effectiveFolders =
    folders.length > 0 ? folders : useWorkspaceStore.getState().folders;
  const referenceDocument = await resolveReferenceDocument(
    refId,
    row.locator,
    effectiveFolders
  );
  if (!referenceDocument) {
    return {
      error: 'SEQUENCE_UNAVAILABLE',
      message: 'The referenced sequence document is no longer available in an open project.',
    };
  }
  const { documentId, sourcePath } = referenceDocument;

  const store = useSequenceStore.getState();
  let parent = store.getSequence(documentId);
  const residentAtResolve = parent != null;

  if (!parent) {
    if (!sourcePath) {
      return {
        error: 'SEQUENCE_UNAVAILABLE',
        message: 'The referenced sequence document has no available byte source.',
      };
    }
    try {
      const content = await platform().fs.readTextFile(sourcePath);
      parent = parseBiologyContent(content, sourcePath).sequence;
    } catch (err) {
      return {
        error: 'SEQUENCE_UNAVAILABLE',
        message: `Could not load the referenced sequence: ${errorMessage(err)}`,
      };
    }
  }

  const parentSequence = parent.sequence ?? '';
  const parentLength = parent.length ?? parentSequence.length;
  const topology: 'circular' | 'linear' = parent.circular ? 'circular' : 'linear';

  const sourceVersion =
    descriptor && typeof descriptor.sourceVersion === 'number' ? descriptor.sourceVersion : null;
  if (sourceVersion != null && residentAtResolve) {
    const currentVersion = store.getVersion(documentId);
    if (currentVersion !== sourceVersion) {
      return {
        error: 'STALE_SELECTION',
        message:
          `The sequence changed since this selection was captured ` +
          `(v${sourceVersion} → v${currentVersion}). Re-select the region and try again.`,
      };
    }
  }

  const selectionBases = sliceRangeBases(parentSequence, range.start, range.end, range.wraps);

  return {
    refId,
    documentId,
    parentSequence,
    parentLength,
    topology,
    range,
    sourceVersion,
    selectionBases,
    strand: readStrand(descriptor),
    translTable: readTranslTable(descriptor),
    nucleicAcid: nucleicAcidOf(parent),
  };
}

export function resolveRawSelection(input: RawSelectionInput): ResolvedSelection {
  const parentSequence = input.sequence;
  const parentLength = parentSequence.length;
  const hasRange = typeof input.start === 'number' && typeof input.end === 'number';
  const range: SelectionRange = hasRange
    ? { start: input.start as number, end: input.end as number, wraps: false }
    : { start: 1, end: parentLength, wraps: false };
  const selectionBases = hasRange
    ? sliceRangeBases(parentSequence, range.start, range.end, false)
    : parentSequence;

  return {
    refId: 'raw',
    documentId: null,
    parentSequence,
    parentLength,
    topology: input.topology ?? 'linear',
    range,
    sourceVersion: null,
    selectionBases,
    strand: input.strand ?? 'unspecified',
    translTable: input.translTable ?? null,
    nucleicAcid: nucleicAcidOfBases(parentSequence),
  };
}

function isProvided(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function resolveSelectionInput(
  input: SelectionInput,
  folders: WorkspaceFolder[] = []
): Promise<ResolvedSelection | SelectionError> | (ResolvedSelection | SelectionError) {
  const hasRefId = isProvided(input.refId);
  const hasSequence = isProvided(input.sequence);

  if (hasRefId && hasSequence) {
    return {
      error: 'INVALID_SELECTION_INPUT',
      message:
        'Provide EITHER refId (an app selection) OR sequence (raw bases), not both. ' +
        'Pass refId to compute over an app selection, or sequence to compute over raw bases.',
    };
  }
  if (!hasRefId && !hasSequence) {
    return {
      error: 'INVALID_SELECTION_INPUT',
      message:
        'Provide refId (an app selection) OR sequence (raw bases). ' +
        'Neither was provided.',
    };
  }

  if (hasRefId) {
    return resolveSelectionBases(input.refId as string, folders);
  }
  return resolveRawSelection({
    sequence: input.sequence as string,
    strand: input.strand,
    translTable: input.translTable,
    topology: input.topology,
    start: input.start,
    end: input.end,
  });
}
