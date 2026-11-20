import type { NucleicAcid } from '@waypoint/sequence-utils';

import type { WorkspaceFolder } from '../../stores/workspaceStore';
import type { DedupPreviewItem } from '../../shared/import-dedup';
import {
  resolveImportDestination,
  type ImportDropKind,
} from '../workspace-loader/public/resolve-import-destination';
import { buildImportItem } from '../workspace-loader/public/import-item-builder';
import type { ImportItem, ImportWizardState } from '../workspace-loader/public/import-wizard-state';
import type { DnaSequenceImportIntent } from './entity-import-intent';
import { isPathInsideBoundary } from '../../shared/path-boundary';
import type { SequenceImportPreviewResult } from '../../shared/workspace-git-types';
import { importItemSourcePath } from '../workspace-loader/public/import-wizard-state';
import { externalFormatForPath } from '../../shared/external-preview';
import type { HandlerFamilyId } from '../../shared/file-associations';

const CONTENT_READ_MAX_BYTES = 2 * 1024 * 1024;

export interface BuildWizardStateCtx {
  folders: WorkspaceFolder[];
  selectedPath?: string | null;
  focusedRootPath?: string | null;
  workspacePath?: string | null;

  initialDestinationPath?: string | null;

  forceExplicitDestination?: boolean;
  importIntent?: DnaSequenceImportIntent;
  stat: (path: string) => Promise<{ isDirectory: boolean; size: number }>;
  readText: (path: string) => Promise<string>;
  captureInput?: (path: string, family: HandlerFamilyId) => Promise<string>;
  previewDedup: (request: {
    sourcePaths: string[];
    targetRoot: string;
  }) => Promise<DedupPreviewItem[]>;
  previewSequenceImport: (sourcePath: string) => Promise<SequenceImportPreviewResult>;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function dropKindFor(items: ImportItem[]): ImportDropKind {
  const files = items.filter((i) => i.kind === 'file').length;
  const folders = items.filter((i) => i.kind === 'folder').length;
  if (folders > 0 && files > 0) return 'mixed';
  if (folders > 0) return 'folder';
  return files === 1 ? 'file' : 'files';
}

function sequencePreviewItemPath(sourcePath: string, recordIndex: number): string {
  return `${sourcePath}::dnaforge-sequence-record:${recordIndex}`;
}

export function sequenceItemsFromPreview(
  item: ImportItem,
  preview: SequenceImportPreviewResult,
  confirmedDnaSourceSha256?: string,
  confirmedNucleicAcid?: NucleicAcid
): ImportItem[] {
  if (preview.kind === 'blocked') {
    return [
      {
        ...item,
        sourcePath: preview.sourcePath,
        expectedSourceSha256: preview.sourceSha256,
        confirmedDnaSourceSha256: undefined,
        confirmedNucleicAcid: undefined,
        name: basename(preview.sourcePath).replace(/\.[^.]+$/, ''),
        format: 'dna-sequence',
        size: undefined,
        block: {
          kind: 'sequence-preview-failed',
          message: preview.reason,
          reasonCode: preview.reasonCode,
          ...(preview.canConfirmDnaIdentity ? { canConfirmDnaIdentity: true } : {}),
          ...(preview.canConvertToRna ? { canConvertToRna: true } : {}),
        },
      },
    ];
  }
  return preview.packages.map((plannedPackage) => ({
    ...item,
    path: sequencePreviewItemPath(preview.sourcePath, plannedPackage.recordIndex),
    sourcePath: preview.sourcePath,
    expectedSourceSha256: preview.sourceSha256,
    confirmedDnaSourceSha256,
    confirmedNucleicAcid,
    name: plannedPackage.name,
    format: 'dna-sequence',
    size: undefined,
    block: undefined,
    plannedSequencePackage: plannedPackage,
  }));
}

async function expandSequencePackagePreviews(
  items: ImportItem[],
  previewSequenceImport: BuildWizardStateCtx['previewSequenceImport']
): Promise<ImportItem[]> {
  const expanded: ImportItem[] = [];
  for (const item of items) {
    if (item.block?.kind === 'sequence-preview-failed') {
      expanded.push(item);
      continue;
    }
    if (item.kind !== 'file') {
      expanded.push({
        ...item,
        sourcePath: item.path,
        block: {
          kind: 'sequence-preview-failed',
          message: 'DNA sequence import accepts files, not folders.',
          reasonCode: 'unsupported_source_kind',
        },
      });
      continue;
    }

    let preview: SequenceImportPreviewResult;
    try {
      const result = await previewSequenceImport(item.packageInputPath ?? item.path);
      preview = { ...result, sourcePath: item.path };
    } catch (error) {
      preview = {
        kind: 'blocked',
        sourcePath: item.path,
        reason: `This DNA sequence source could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
        reasonCode: 'read_failure',
      };
    }

    expanded.push(...sequenceItemsFromPreview(item, preview));
  }
  return expanded;
}

export async function buildImportItemsFromPaths(
  paths: string[],
  ctx: Pick<BuildWizardStateCtx, 'stat' | 'readText' | 'captureInput'>
): Promise<ImportItem[]> {
  const items: ImportItem[] = [];
  for (const path of paths) {
    const stat = await ctx.stat(path).catch(() => null);
    const kind: 'file' | 'folder' = stat?.isDirectory ? 'folder' : 'file';
    const family = kind === 'file' ? externalFormatForPath(path) : null;
    if (family && ctx.captureInput) {
      const item = { path, kind, name: basename(path), format: family, size: stat?.size };
      try {
        items.push({ ...item, packageInputPath: await ctx.captureInput(path, family) });
      } catch (error) {
        items.push({
          ...item,
          block: {
            kind: 'sequence-preview-failed',
            reasonCode: 'read_failure',
            message:
              error instanceof Error ? error.message : 'Could not prepare this file for import.',
          },
        });
      }
      continue;
    }
    let content: string | undefined;
    if (kind === 'file' && (stat?.size ?? 0) <= CONTENT_READ_MAX_BYTES) {
      content = await ctx.readText(path).catch(() => undefined);
    }
    items.push(buildImportItem({ path, name: basename(path), kind, content, size: stat?.size }));
  }
  return items;
}

export async function buildImportWizardState(
  paths: string[],
  ctx: BuildWizardStateCtx
): Promise<ImportWizardState> {
  const sourceItems = await buildImportItemsFromPaths(paths, ctx);
  const items =
    ctx.importIntent?.entityType === 'dna-sequences'
      ? await expandSequencePackagePreviews(sourceItems, ctx.previewSequenceImport)
      : sourceItems;

  const resolution = resolveImportDestination({
    folders: ctx.folders,
    selectedPath: ctx.selectedPath,
    focusedRootPath: ctx.focusedRootPath,
    workspacePath: ctx.workspacePath,
    dropKind: dropKindFor(items),
  });
  const explicitDestinationPath =
    ctx.importIntent &&
    ctx.initialDestinationPath &&
    ctx.folders.some(
      (folder) =>
        !folder.pinned && isPathInsideBoundary(ctx.initialDestinationPath as string, folder.path)
    )
      ? ctx.initialDestinationPath
      : null;
  const destination = explicitDestinationPath
    ? ({ kind: 'existing-root', rootPath: explicitDestinationPath } as const)
    : resolution.preselected;
  const requiresExplicitChoice = ctx.forceExplicitDestination
    ? true
    : explicitDestinationPath
      ? false
      : resolution.requiresExplicitChoice;

  if (destination.kind === 'existing-root') {
    const fileSources = [
      ...new Set(items.filter((i) => i.kind === 'file' && !i.block).map(importItemSourcePath)),
    ];
    if (fileSources.length > 0) {
      const previews = await ctx
        .previewDedup({ sourcePaths: fileSources, targetRoot: destination.rootPath })
        .catch(() => [] as DedupPreviewItem[]);
      const byPath = new Map(previews.map((p) => [p.sourcePath, p.decision]));
      for (const item of items) {
        const decision = byPath.get(importItemSourcePath(item));
        if (decision) item.dedup = decision;
      }
    }
  }

  if (explicitDestinationPath) {
    for (const item of items) {
      item.target = { kind: 'existing-root', rootPath: explicitDestinationPath };
    }
  }

  return {
    items,
    destination,
    importIntent: ctx.importIntent,
    availableRoots: ctx.folders
      .filter((f) => !f.pinned)
      .map((f) => ({ path: f.path, name: f.name })),
    requiresExplicitChoice,
    destinationChosen: !requiresExplicitChoice,
    agentRequested: false,
  };
}
