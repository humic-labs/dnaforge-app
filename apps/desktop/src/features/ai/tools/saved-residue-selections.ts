import { resultTool, toolSuccess, toolFailure } from '../../agent-bridge/public/tool-result';
import { z } from 'zod';
import {
  parseSavedResidueSelectionDocument,
  type SavedResidueSelectionDocument,
} from '@waypoint/workspace-editor';
import { platform } from '../../../platform';
import { getCurrentMolecularSnapshot } from '../../../shared/molecular-document';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { useStructure3dStore } from '../../page/public/embeds/structure3d/store';
import { findWorkspaceRootForPath } from '../../../db/workspace-catalog';
import type {
  ChainSequence,
  HighlightGroup,
  ResidueLocation,
  SavedSelectionViewRef,
  Structure3dAttrs,
} from '../../page/public/embeds/structure3d/types';
import { selectionToHighlightGroup } from '../../page/public/embeds/structure3d/utils/highlightUtils';
import {
  assertSavedSelectionStructureCompatibility,
  ensureStructureCoordinateArtifact,
  resolveStructureWorkspaceRoot,
  recordSelectionInOpenViews,
  saveStructureSelection,
  saveViewBeforeSelection,
  createViewForSelection,
  molecularViewBinding,
  type SaveStructureSelectionResult,
} from '../../page/public/embeds/structure3d/utils/savedSelectionPersistence';

function currentCoordinateSha256(
  document: Parameters<typeof getCurrentMolecularSnapshot>[0]
): string | undefined {
  try {
    return getCurrentMolecularSnapshot(document).coordinates.sha256;
  } catch {
    return undefined;
  }
}

export interface SavedSelectionArtifactRecord {
  workspaceRoot: string;
  artifactPath: string;
  relativePath: string;
  document: SavedResidueSelectionDocument;
  molecularViewPath?: string;
  molecularViewCoordinateSha256?: string;
}

export interface SavedSelectionDiscoveryResult {
  records: SavedSelectionArtifactRecord[];
  errors: Array<{ artifactPath: string; error: string }>;
}

function openMolecularViewLocations(folders: ReadonlyArray<WorkspaceFolder>) {
  const paths = new Set<string>();
  for (const entry of Object.values(useStructure3dStore.getState().expandedStructures)) {
    const path = entry?.data?.molecularDocumentPath;
    if (path) paths.add(path);
  }
  return [...paths].flatMap((path) => {
    const workspaceRoot = findWorkspaceRootForPath([...folders], path);
    return workspaceRoot ? [{ workspaceRoot, path }] : [];
  });
}

export async function discoverSavedResidueSelections(
  folders: ReadonlyArray<WorkspaceFolder>,
  openViews: ReadonlyArray<{ workspaceRoot: string; path: string }> = openMolecularViewLocations(
    folders
  )
): Promise<SavedSelectionDiscoveryResult> {
  const records: SavedSelectionArtifactRecord[] = [];
  const errors: Array<{ artifactPath: string; error: string }> = [];
  for (const view of openViews) {
    try {
      const { document } = await platform().molecularDocuments.read(view);
      const root = view.workspaceRoot.replace(/[\\/]+$/, '');
      const relativePath = view.path.startsWith(`${root}/`)
        ? view.path.slice(root.length + 1)
        : view.path;
      for (const selection of document.selections ?? [])
        records.push({
          workspaceRoot: root,
          artifactPath: view.path,
          relativePath,
          document: selection,
          molecularViewPath: view.path,
          molecularViewCoordinateSha256: currentCoordinateSha256(document),
        });
    } catch (error) {
      errors.push({
        artifactPath: view.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const folder of folders) {
    const root = folder.path.replace(/[\\/]+$/, '');
    const directory = `${root}/Selections`;
    if (!(await platform().fs.exists(directory))) continue;
    let entries: Array<{
      name: string;
      isDirectory: boolean;
      isFile: boolean;
    }>;
    try {
      entries = await platform().fs.readDir(directory);
    } catch (error) {
      errors.push({
        artifactPath: directory,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const entry of entries
      .filter((candidate) => candidate.isFile && candidate.name.endsWith('.wpselection.json'))
      .slice(0, 1000)) {
      const artifactPath = `${directory}/${entry.name}`;
      try {
        records.push({
          workspaceRoot: root,
          artifactPath,
          relativePath: `Selections/${entry.name}`,
          document: parseSavedResidueSelectionDocument(
            await platform().fs.readTextFile(artifactPath)
          ),
        });
      } catch (error) {
        errors.push({
          artifactPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { records, errors };
}

export async function resolveSavedResidueSelectionRecord(
  folders: ReadonlyArray<WorkspaceFolder>,
  selectionId: string
): Promise<SavedSelectionArtifactRecord> {
  const discovered = await discoverSavedResidueSelections(folders);
  const matches = discovered.records.filter((record) => record.document.id === selectionId);
  if (matches.length === 0) {
    throw new Error(`Saved residue selection not found: ${selectionId}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Saved residue selection identity is ambiguous across projects: ${selectionId}`
    );
  }
  return matches[0];
}

type RegisteredStructureContext = {
  registrationId: string;
  structureId: string;
  structureViewId?: string;
  interactionKey: string;
  attrs: Structure3dAttrs;
  chains: ChainSequence[];
  selectedResidues: ResidueLocation[];
};

type MutationPartialEffect = Record<string, unknown>;

type MutationWarning = {
  stage: string;
  error: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function partialEffectsFromError(error: unknown): MutationPartialEffect[] {
  if (!error || typeof error !== 'object') return [];
  const candidate = (error as { partialEffects?: unknown }).partialEffects;
  if (!Array.isArray(candidate)) return [];
  return candidate.filter(
    (effect): effect is MutationPartialEffect =>
      effect !== null && typeof effect === 'object' && !Array.isArray(effect)
  );
}

function selectionFailure<T extends { code: string }>(data: T) {
  return {
    ...toolFailure({
      code: data.code,
      error: `Saved selection could not be read: ${data.code}.`,
      retriable: false,
      stateChanged: false,
      partialEffects: [],
    }),
    ...data,
  };
}

function failedMutation(
  code: string,
  error: unknown,
  partialEffects: MutationPartialEffect[] = partialEffectsFromError(error),
  details: Record<string, unknown> = {}
) {
  return {
    ...toolFailure({
      code,
      error: errorMessage(error),
      retriable: false,
      stateChanged: partialEffects.length > 0,
      partialEffects,
    }),
    ...details,
  };
}

function projectionWarning(stage: string, error: unknown): MutationWarning {
  return { stage, error: errorMessage(error) };
}

export interface SavedSelectionToolDependencies {
  getStructureContext: (structureRef?: string) => Promise<RegisteredStructureContext>;
  saveSelection: (input: {
    workspaceRoot: string;
    structureId: string;
    attrs: Structure3dAttrs;
    chains: ReadonlyArray<ChainSequence>;
    group: HighlightGroup;
  }) => Promise<SaveStructureSelectionResult>;
  saveViewBeforeSelection: typeof saveViewBeforeSelection;
  createViewForSelection: typeof createViewForSelection;
  recordSelectionInOpenViews: typeof recordSelectionInOpenViews;
  findViewStructureRef: (
    molecularDocumentPath: string,
    previousRegistrationId: string
  ) => Promise<string | null>;
  updateStructureAttrs: (structureId: string, updates: Partial<Structure3dAttrs>) => void;
  clearActiveSelection: (structureId: string) => void;
  resolveWorkspaceRoot: (
    folders: ReadonlyArray<WorkspaceFolder>,
    attrs: Structure3dAttrs
  ) => string | null;
}

const defaultDependencies: SavedSelectionToolDependencies = {
  getStructureContext: async (structureRef) =>
    (
      await import('../../agent-bridge/public/structure-tools')
    ).getRegisteredStructureSelectionContext(structureRef),
  saveSelection: saveStructureSelection,
  saveViewBeforeSelection,
  createViewForSelection,
  recordSelectionInOpenViews,
  findViewStructureRef: async (molecularDocumentPath, previousRegistrationId) =>
    (await import('../../agent-bridge/public/structure-tools')).registeredStructureRefForView(
      molecularDocumentPath,
      previousRegistrationId
    ),
  updateStructureAttrs: (structureId, updates) => {
    const state = useStructure3dStore.getState();
    const current = state.expandedStructures[structureId]?.data;
    if (!current) throw new Error(`Registered structure disappeared: ${structureId}`);
    state.updateStructureData(structureId, { ...current, ...updates });
  },
  clearActiveSelection: (structureId) => {
    useStructure3dStore.getState().clearSelection(structureId);
  },
  resolveWorkspaceRoot: resolveStructureWorkspaceRoot,
};

export const listSavedResidueSelectionsSchema = z.object({}).strict();

const DEFAULT_SAVED_SELECTION_PAGE_SIZE = 200;
const MAX_SAVED_SELECTION_PAGE_SIZE = 1000;

export const getSavedResidueSelectionSchema = z
  .object({
    selectionId: z.string().min(1).max(200),
    revisionId: z.string().min(1).max(200).optional(),
    memberIndex: z.number().int().min(0).default(0),
    intervalOffset: z.number().int().min(0).default(0),
    intervalLimit: z
      .number()
      .int()
      .min(1)
      .max(MAX_SAVED_SELECTION_PAGE_SIZE)
      .default(DEFAULT_SAVED_SELECTION_PAGE_SIZE),
    identityOffset: z.number().int().min(0).default(0),
    identityLimit: z
      .number()
      .int()
      .min(1)
      .max(MAX_SAVED_SELECTION_PAGE_SIZE)
      .default(DEFAULT_SAVED_SELECTION_PAGE_SIZE),
  })
  .strict();

function pageMetadata(offset: number, returned: number, total: number) {
  const nextOffset = offset + returned < total ? offset + returned : null;
  return { offset, returned, total, nextOffset };
}

export const saveActiveResidueSelectionSchema = z
  .object({
    structureRef: z.string().min(1).max(500).optional(),
    workspacePath: z.string().min(1).max(2000).optional(),
    name: z.string().min(1).max(200),
  })
  .strict();

export const applySavedResidueSelectionSchema = z
  .object({
    selectionId: z.string().min(1).max(200),
    revisionId: z.string().min(1).max(200).optional(),
    structureRef: z.string().min(1).max(500).optional(),
    visible: z.boolean().default(true),
  })
  .strict();

export function createListSavedResidueSelectionsTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'List durable, Git-versioned saved residue selection assets in open projects. ' +
      'Returns stable selection and current revision ids without expanding every residue.',
    inputSchema: listSavedResidueSelectionsSchema,
    execute: async () => {
      const discovered = await discoverSavedResidueSelections(folders);
      return toolSuccess({
        selections: discovered.records.map(({ document, relativePath, workspaceRoot }) => ({
          selectionId: document.id,
          currentRevisionId: document.currentRevisionId,
          name: document.name,
          color: document.color,
          revisionCount: document.revisions.length,
          relativePath,
          workspaceRoot,
        })),
        errors: discovered.errors,
      });
    },
  });
}

export function createGetSavedResidueSelectionTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Read one member of a durable saved residue selection revision with bounded, pageable ' +
      'exact intervals and residue identities plus physical-chain and coordinate-revision pins.',
    inputSchema: getSavedResidueSelectionSchema,
    execute: async ({
      selectionId,
      revisionId,
      memberIndex = 0,
      intervalOffset = 0,
      intervalLimit = DEFAULT_SAVED_SELECTION_PAGE_SIZE,
      identityOffset = 0,
      identityLimit = DEFAULT_SAVED_SELECTION_PAGE_SIZE,
    }) => {
      try {
        const record = await resolveSavedResidueSelectionRecord(folders, selectionId);
        const resolvedRevisionId = revisionId ?? record.document.currentRevisionId;
        const revision = record.document.revisions.find(
          (candidate) => candidate.id === resolvedRevisionId
        );
        if (!revision) {
          return selectionFailure({
            code: 'REVISION_NOT_FOUND',
            selectionId,
            revisionId: resolvedRevisionId,
          });
        }
        const member = revision.members[memberIndex];
        if (!member) {
          return selectionFailure({
            code: 'MEMBER_NOT_FOUND',
            selectionId,
            revisionId: resolvedRevisionId,
            memberIndex,
            totalMembers: revision.members.length,
          });
        }
        const intervals = member.selection.target.intervals;
        const identities = member.residueIdentities ?? [];
        const pagedIntervals = intervals.slice(intervalOffset, intervalOffset + intervalLimit);
        const pagedIdentities = identities.slice(identityOffset, identityOffset + identityLimit);
        const memberScope = member.scope;
        const pinnedStructureRevisions =
          memberScope.kind === 'structure-chain-instance'
            ? revision.structureRevisions.filter(
                (candidate) => candidate.id === memberScope.structureRevisionId
              )
            : [];
        const pagedMember = {
          ...member,
          selection: {
            selectionId: member.selection.selectionId,
            source: member.selection.source,
            target: {
              ...member.selection.target,
              intervals: pagedIntervals,
            },
          },
          ...(member.residueIdentities !== undefined ? { residueIdentities: pagedIdentities } : {}),
        };
        return toolSuccess({
          selectionId,
          revisionId: resolvedRevisionId,
          name: record.document.name,
          color: record.document.color,
          artifactPath: record.relativePath,
          revision: {
            ...revision,
            members: [pagedMember],
            structureRevisions: pinnedStructureRevisions,
          },
          page: {
            memberIndex,
            totalMembers: revision.members.length,
            nextMemberIndex: memberIndex + 1 < revision.members.length ? memberIndex + 1 : null,
            intervals: pageMetadata(intervalOffset, pagedIntervals.length, intervals.length),
            residueIdentities: pageMetadata(
              identityOffset,
              pagedIdentities.length,
              identities.length
            ),
          },
        });
      } catch (error) {
        return selectionFailure({
          code: 'SELECTION_NOT_FOUND',
          selectionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
}

export function createSaveActiveResidueSelectionTool(
  folders: WorkspaceFolder[],
  dependencies: Partial<SavedSelectionToolDependencies> = {}
) {
  const deps = { ...defaultDependencies, ...dependencies };
  return resultTool({
    description:
      'Persist the exact active residue selection from a registered structure as a named, ' +
      'append-only, Git-versioned selection asset. Use only when the user asks to save it.',
    inputSchema: saveActiveResidueSelectionSchema,
    execute: async ({ structureRef, workspacePath, name }) => {
      let mutationAttempted = false;
      try {
        const context = await deps.getStructureContext(structureRef);
        if (context.selectedResidues.length === 0) {
          return failedMutation('NO_ACTIVE_SELECTION', 'No active residues are selected');
        }
        const explicitWorkspace = workspacePath
          ? folders.find((folder) => folder.path === workspacePath)?.path
          : undefined;
        if (workspacePath && !explicitWorkspace) {
          return failedMutation(
            'WORKSPACE_NOT_MOUNTED',
            `Requested workspace is not mounted: ${workspacePath}`
          );
        }
        const workspaceRoot =
          explicitWorkspace ?? deps.resolveWorkspaceRoot(folders, context.attrs);
        if (!workspaceRoot) {
          return failedMutation(
            'WORKSPACE_AMBIGUOUS',
            'The structure is not associated with one unambiguous open project'
          );
        }
        const group = selectionToHighlightGroup(context.selectedResidues, name, [
          ...(context.attrs.highlightGroups ?? []),
        ]);
        if (!group) return failedMutation('NO_ACTIVE_SELECTION', 'No active residues are selected');
        mutationAttempted = true;
        const target = context.attrs.molecularDocumentPath
          ? { attrs: context.attrs, workspaceRoot }
          : context.structureViewId && context.attrs.coordinateFilePath
            ? await deps.saveViewBeforeSelection(context.structureViewId, context.attrs)
            : await deps.createViewForSelection({ workspaceRoot, attrs: context.attrs });
        const saved = await deps.saveSelection({
          workspaceRoot: target.workspaceRoot,
          structureId: context.structureId,
          attrs: target.attrs,
          chains: context.chains,
          group,
        });
        const warnings: MutationWarning[] = [...(saved.warnings ?? [])];
        const savedView =
          target.attrs !== context.attrs ? target.attrs.molecularDocumentPath : undefined;
        const savedStructureRef =
          (savedView && (await deps.findViewStructureRef(savedView, context.registrationId))) ||
          context.structureId;
        let viewUpdated = Boolean(
          savedView &&
          saved.molecularDocumentRevision &&
          deps.recordSelectionInOpenViews(savedView, saved.ref, saved.molecularDocumentRevision) > 0
        );
        if (!viewUpdated)
          try {
            deps.updateStructureAttrs(context.registrationId, {
              ...(savedView ? molecularViewBinding(target.attrs) : {}),
              savedSelectionRefs: [...(context.attrs.savedSelectionRefs ?? []), saved.ref],
              ...(saved.structureArtifactRef
                ? { structureArtifactRef: saved.structureArtifactRef }
                : {}),
              ...(saved.molecularDocumentRevision
                ? { molecularDocumentRevision: saved.molecularDocumentRevision }
                : {}),
            });
            viewUpdated = true;
          } catch (error) {
            warnings.push(projectionWarning('structure-view', error));
          }
        if (viewUpdated) {
          try {
            deps.clearActiveSelection(context.interactionKey);
          } catch (error) {
            warnings.push(projectionWarning('active-selection', error));
          }
        }
        return toolSuccess({
          stateChanged: true,
          selectionId: saved.ref.selectionId,
          revisionId: saved.ref.revisionId,
          artifactPath: saved.ref.artifactPath,
          structureRef: savedStructureRef,
          exactSelection: saved.projection.selections,
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      } catch (error) {
        return {
          ...failedMutation('SAVE_FAILED', error),
          ...(mutationAttempted && partialEffectsFromError(error).length === 0
            ? { stateChanged: 'unknown' as const }
            : {}),
        };
      }
    },
  });
}

export function createApplySavedResidueSelectionTool(
  folders: WorkspaceFolder[],
  dependencies: Partial<SavedSelectionToolDependencies> = {}
) {
  const deps = { ...defaultDependencies, ...dependencies };
  return resultTool({
    description:
      'Apply a pinned saved residue selection revision to a registered structure view. ' +
      'The coordinate digest must match exactly; stale structures fail without remapping.',
    inputSchema: applySavedResidueSelectionSchema,
    execute: async ({ selectionId, revisionId, structureRef, visible }) => {
      const partialEffects: MutationPartialEffect[] = [];
      let mutationAttempted = false;
      try {
        const [record, context] = await Promise.all([
          resolveSavedResidueSelectionRecord(folders, selectionId),
          deps.getStructureContext(structureRef),
        ]);
        const contextWorkspaceRoot = deps.resolveWorkspaceRoot(folders, context.attrs);
        if (contextWorkspaceRoot && contextWorkspaceRoot !== record.workspaceRoot) {
          return failedMutation(
            'CROSS_WORKSPACE_SELECTION',
            'Selection and target structure must belong to the same open project',
            [],
            { selectionId }
          );
        }
        const workspaceRoot = contextWorkspaceRoot ?? record.workspaceRoot;
        const resolvedRevisionId = revisionId ?? record.document.currentRevisionId;
        if (record.molecularViewPath) {
          if (context.attrs.molecularDocumentPath !== record.molecularViewPath)
            return failedMutation(
              'SELECTION_IN_OTHER_VIEW',
              'This selection is stored in another molecular view. Open that view to apply it; copying selections between views is not supported yet.',
              [],
              { selectionId }
            );
          assertSavedSelectionStructureCompatibility(record.document, resolvedRevisionId, {
            structureId: context.structureId,
            coordinateDigestSha256:
              context.attrs.coordinateSha256 ?? record.molecularViewCoordinateSha256 ?? '',
            assemblyId: record.document.revisions.find(
              (revision) => revision.id === resolvedRevisionId
            )?.structureRevisions[0]?.assemblyId,
          });
          mutationAttempted = true;
          const ref: SavedSelectionViewRef = {
            selectionId,
            revisionId: resolvedRevisionId,
            artifactPath: record.relativePath,
            visible,
          };
          deps.updateStructureAttrs(context.registrationId, {
            savedSelectionRefs: [
              ...(context.attrs.savedSelectionRefs ?? []).filter(
                (candidate) => candidate.selectionId !== selectionId
              ),
              ref,
            ],
          });
          const warnings: MutationWarning[] = [];
          if (visible) {
            try {
              deps.clearActiveSelection(context.interactionKey);
            } catch (error) {
              warnings.push(projectionWarning('active-selection', error));
            }
          }
          return toolSuccess({
            stateChanged: true,
            structureRef: context.structureId,
            selectionId,
            revisionId: resolvedRevisionId,
            visible,
            ...(warnings.length ? { warnings } : {}),
          });
        }
        const structureArtifact = await ensureStructureCoordinateArtifact({
          workspaceRoot,
          structureId: context.structureId,
          attrs: context.attrs,
          validateBeforePersist: (candidate) => {
            assertSavedSelectionStructureCompatibility(
              record.document,
              resolvedRevisionId,
              candidate
            );
            mutationAttempted = true;
          },
        });
        if (structureArtifact.created) {
          partialEffects.push({
            kind: 'structure-coordinate-artifact',
            path: structureArtifact.ref.artifactPath,
            entityId: structureArtifact.ref.entityId,
          });
        }
        const ref: SavedSelectionViewRef = {
          selectionId,
          revisionId: resolvedRevisionId,
          artifactPath: record.relativePath,
          visible,
        };
        const existing = context.attrs.savedSelectionRefs ?? [];
        deps.updateStructureAttrs(context.registrationId, {
          savedSelectionRefs: [
            ...existing.filter((candidate) => candidate.selectionId !== selectionId),
            ref,
          ],
          structureArtifactRef: structureArtifact.ref,
        });
        partialEffects.push({
          kind: 'structure-view-selection',
          registrationId: context.registrationId,
          selectionId,
          revisionId: resolvedRevisionId,
        });
        const warnings: MutationWarning[] = [...(structureArtifact.warnings ?? [])];
        if (visible) {
          try {
            deps.clearActiveSelection(context.interactionKey);
          } catch (error) {
            warnings.push(projectionWarning('active-selection', error));
          }
        }
        return toolSuccess({
          stateChanged: true,
          structureRef: context.structureId,
          selectionId,
          revisionId: resolvedRevisionId,
          visible,
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      } catch (error) {
        const failure = failedMutation(
          'APPLY_FAILED',
          error,
          [...partialEffects, ...partialEffectsFromError(error)],
          { selectionId }
        );
        return {
          ...failure,
          ...(mutationAttempted && failure.partialEffects.length === 0
            ? { stateChanged: 'unknown' as const }
            : {}),
        };
      }
    },
  });
}
