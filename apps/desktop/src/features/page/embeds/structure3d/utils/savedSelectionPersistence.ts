import {
  appendSavedResidueSelectionRevision,
  parseSavedResidueSelectionDocument,
  type SavedResidueSelectionDocument,
  type SavedSelectionStructureRevision,
} from '@waypoint/workspace-editor';
import {
  createSavedResidueSelectionArtifact,
  writeSavedResidueSelectionArtifactRevision,
} from '../../../../../db/saved-residue-selection-artifact';
import {
  digestStructureCoordinateData,
  materializeStructureCoordinateArtifact,
} from '../../../../../db/structure-coordinate-artifact';
import { findWorkspaceRootForPath } from '../../../../../db/workspace-catalog';
import { useWorkspaceStore } from '../../../../../stores/workspaceStore';
import { useStructure3dStore } from '../store';
import { stripDisplayExtension } from '@/utils/fileTypes';
import {
  MOLECULAR_DOCUMENT_SUFFIX,
  getCurrentMolecularSnapshot,
  type MolecularDocument,
} from '../../../../../shared/molecular-document';
import { buildDefaultMolecularDocument } from '../../../../../shared/default-molecular-view';
import { platform } from '../../../../../platform';
import { isAbsolutePathLike } from '../../../../../shared/path-boundary';
import { MANAGED_WORKSPACE_MARKER } from '../../../../../shared/workspace-git-types';
import { fetchStructureData, fetchStructureFromUrl } from './structureData';
import { getMolstarPropsFromAttrs } from './molstarPropsUtils';
import {
  buildSavedSelectionDocumentFromStructure,
  projectSavedSelectionRevisionToHighlightGroup,
} from './savedSelectionProjection';
import type {
  ChainSequence,
  HighlightGroup,
  SavedSelectionViewRef,
  Structure3dAttrs,
  StructureCoordinateArtifactRef,
} from '../types';

export interface SaveStructureSelectionResult {
  ref: SavedSelectionViewRef;
  projection: HighlightGroup;
  structureArtifactRef?: StructureCoordinateArtifactRef;
  molecularDocumentPath?: string;
  molecularDocumentRevision?: string;
  warnings?: PersistenceProjectionWarning[];
}

export interface EnsuredStructureCoordinateArtifact {
  ref: StructureCoordinateArtifactRef;
  revision: SavedSelectionStructureRevision;
  created: boolean;
  warnings?: PersistenceProjectionWarning[];
}

export interface PersistenceProjectionWarning {
  stage: string;
  error: string;
}

export interface StructureSelectionPartialEffect {
  kind: 'structure-coordinate-artifact';
  path: string;
  entityId: string;
}

export type StructureCoordinateCompatibilityRef = Pick<
  StructureCoordinateArtifactRef,
  'structureId' | 'providerIdentityKey' | 'coordinateDigestSha256' | 'assemblyId'
>;

export async function saveStructureSelection(input: {
  workspaceRoot: string;
  structureId: string;
  attrs: Structure3dAttrs;
  chains: ReadonlyArray<ChainSequence>;
  group: HighlightGroup;
}): Promise<SaveStructureSelectionResult> {
  if (input.attrs.molecularDocumentPath) return saveStructureSelectionIntoView(input);
  const assetId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const sourceGitCommit = await currentManagedWorkspaceHead(input.workspaceRoot);
  const ensuredStructure = await ensureStructureCoordinateArtifact({
    workspaceRoot: input.workspaceRoot,
    structureId: input.structureId,
    attrs: input.attrs,
  });

  let document: SavedResidueSelectionDocument;
  let artifact: Awaited<ReturnType<typeof createSavedResidueSelectionArtifact>>;
  try {
    document = await buildSavedSelectionDocumentFromStructure({
      assetId,
      revisionId,
      createdAt: new Date().toISOString(),
      group: input.group,
      attrs: input.attrs,
      chains: input.chains,
      structureId: input.structureId,
      structureRevision: ensuredStructure.revision,
      sourceArtifactGitCommit: sourceGitCommit ?? undefined,
    });
    artifact = await createSavedResidueSelectionArtifact({
      workspaceRoot: input.workspaceRoot,
      document,
    });
  } catch (error) {
    if (!ensuredStructure.created) throw error;
    throw appendPartialEffect(error, {
      kind: 'structure-coordinate-artifact',
      path: ensuredStructure.ref.artifactPath,
      entityId: ensuredStructure.ref.entityId,
    });
  }
  const ref: SavedSelectionViewRef = {
    selectionId: document.id,
    revisionId: document.currentRevisionId,
    artifactPath: workspaceRelativePath(input.workspaceRoot, artifact.path),
    visible: true,
  };
  return {
    ref,
    projection: projectSavedSelectionRevisionToHighlightGroup(
      document,
      document.currentRevisionId,
      ref.visible
    ),
    structureArtifactRef: ensuredStructure.ref,
    ...mergeProjectionWarnings(ensuredStructure.warnings, artifact.warnings),
  };
}

export async function ensureStructureCoordinateArtifact(input: {
  workspaceRoot: string;
  structureId: string;
  attrs: Structure3dAttrs;
  validateBeforePersist?: (candidate: StructureCoordinateCompatibilityRef) => void;
}): Promise<EnsuredStructureCoordinateArtifact> {
  const existing = input.attrs.structureArtifactRef;
  if (existing) {
    input.validateBeforePersist?.(existing);
    return {
      created: false,
      ref: existing,
      revision: {
        id: existing.revisionId,
        structureId: existing.structureId,
        ...(existing.providerIdentityKey
          ? { providerIdentityKey: existing.providerIdentityKey }
          : {}),
        coordinateDigestSha256: existing.coordinateDigestSha256,
        ...(existing.assemblyId ? { assemblyId: existing.assemblyId } : {}),
        sourceArtifact: {
          entityId: existing.entityId,
          path: workspaceRelativePath(input.workspaceRoot, existing.artifactPath),
        },
      },
    };
  }

  const entityId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const coordinates = await fetchExactStructureCoordinates(input.attrs);
  const coordinateDigestSha256 = await digestStructureCoordinateData(coordinates.data);
  input.validateBeforePersist?.({
    structureId: input.structureId,
    ...(input.attrs.providerIdentityKey
      ? { providerIdentityKey: input.attrs.providerIdentityKey }
      : {}),
    coordinateDigestSha256,
    ...(input.attrs.assemblyId ? { assemblyId: input.attrs.assemblyId } : {}),
  });
  const materialized = await materializeStructureCoordinateArtifact({
    workspaceRoot: input.workspaceRoot,
    entityId,
    revisionId,
    structureId: input.structureId,
    label: input.attrs.label ?? input.attrs.title ?? input.attrs.sourceId ?? 'Structure',
    providerIdentityKey: input.attrs.providerIdentityKey,
    assemblyId: input.attrs.assemblyId,
    format: coordinates.format,
    data: coordinates.data,
    coordinateDigestSha256,
  });
  return {
    created: true,
    revision: materialized.revision,
    ref: {
      entityId,
      revisionId,
      structureId: input.structureId,
      ...(input.attrs.providerIdentityKey
        ? { providerIdentityKey: input.attrs.providerIdentityKey }
        : {}),
      coordinateDigestSha256: materialized.revision.coordinateDigestSha256,
      ...(input.attrs.assemblyId ? { assemblyId: input.attrs.assemblyId } : {}),
      artifactPath: workspaceRelativePath(input.workspaceRoot, materialized.path),
      format: coordinates.format,
    },
    ...(materialized.warnings ? { warnings: materialized.warnings } : {}),
  };
}

function appendPartialEffect(
  error: unknown,
  effect: StructureSelectionPartialEffect
): Error & { partialEffects: unknown[] } {
  const base = error instanceof Error ? error : new Error(String(error));
  const baseWithEffects = base as Error & { partialEffects?: unknown };
  const existing = Array.isArray(baseWithEffects.partialEffects)
    ? baseWithEffects.partialEffects
    : [];
  return Object.assign(base, { partialEffects: [...existing, effect] });
}

function mergeProjectionWarnings(
  ...groups: Array<ReadonlyArray<PersistenceProjectionWarning> | undefined>
): { warnings?: PersistenceProjectionWarning[] } {
  const warnings = groups.flatMap((group) => group ?? []);
  return warnings.length > 0 ? { warnings } : {};
}

export async function loadSavedSelectionProjections(
  workspaceRoot: string,
  refs: ReadonlyArray<SavedSelectionViewRef>,
  structureArtifactRef: StructureCoordinateArtifactRef | undefined
): Promise<{
  groups: HighlightGroup[];
  errors: Array<{ ref: SavedSelectionViewRef; error: string }>;
}> {
  const groups: HighlightGroup[] = [];
  const errors: Array<{ ref: SavedSelectionViewRef; error: string }> = [];
  for (const ref of refs) {
    try {
      const document = parseSavedResidueSelectionDocument(
        await platform().fs.readTextFile(
          resolveWorkspaceArtifactPath(workspaceRoot, ref.artifactPath)
        )
      );
      if (document.id !== ref.selectionId) {
        throw new Error(`selection identity mismatch (${document.id})`);
      }
      assertSavedSelectionStructureCompatibility(document, ref.revisionId, structureArtifactRef);
      groups.push(
        projectSavedSelectionRevisionToHighlightGroup(document, ref.revisionId, ref.visible)
      );
    } catch (error) {
      errors.push({
        ref,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { groups, errors };
}

export async function loadSavedSelectionProjectionsFromFolders(
  folders: ReadonlyArray<{ path: string }>,
  refs: ReadonlyArray<SavedSelectionViewRef>,
  structureArtifactRef: StructureCoordinateArtifactRef | undefined
): Promise<{
  groups: HighlightGroup[];
  errors: Array<{ ref: SavedSelectionViewRef; error: string }>;
}> {
  const groups: HighlightGroup[] = [];
  const errors: Array<{ ref: SavedSelectionViewRef; error: string }> = [];
  for (const ref of refs) {
    try {
      if (isMolecularViewPath(ref.artifactPath)) {
        groups.push(await projectSelectionFromView(folders, ref));
        continue;
      }
      const candidates = isAbsolutePathLike(ref.artifactPath)
        ? [ref.artifactPath]
        : folders.map((folder) => resolveWorkspaceArtifactPath(folder.path, ref.artifactPath));
      const uniqueCandidates = [...new Set(candidates)];
      const matches: Array<{ path: string; document: SavedResidueSelectionDocument }> = [];
      const invalid: Array<{ path: string; error: string }> = [];
      for (const path of uniqueCandidates) {
        if (!(await platform().fs.exists(path))) continue;
        try {
          const document = parseSavedResidueSelectionDocument(
            await platform().fs.readTextFile(path)
          );
          if (document.id === ref.selectionId) matches.push({ path, document });
        } catch (error) {
          invalid.push({ path, error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (matches.length === 0) {
        if (invalid.length > 0) {
          throw new Error(`${invalid[0].path}: ${invalid[0].error}`);
        }
        throw new Error(`artifact not found in mounted projects: ${ref.artifactPath}`);
      }
      if (matches.length > 1) {
        throw new Error(
          `selection identity is ambiguous across mounted projects: ${matches
            .map((match) => match.path)
            .join(', ')}`
        );
      }
      const document = matches[0].document;
      assertSavedSelectionStructureCompatibility(document, ref.revisionId, structureArtifactRef);
      groups.push(
        projectSavedSelectionRevisionToHighlightGroup(document, ref.revisionId, ref.visible)
      );
    } catch (error) {
      errors.push({ ref, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { groups, errors };
}

async function projectSelectionFromView(
  folders: ReadonlyArray<{ path: string }>,
  ref: SavedSelectionViewRef
): Promise<HighlightGroup> {
  const candidates = isAbsolutePathLike(ref.artifactPath)
    ? folders
        .filter(
          (folder) => findWorkspaceRootForPath([...folders], ref.artifactPath) === folder.path
        )
        .map((folder) => ({ workspaceRoot: folder.path, path: ref.artifactPath }))
    : folders.map((folder) => ({
        workspaceRoot: folder.path,
        path: resolveWorkspaceArtifactPath(folder.path, ref.artifactPath),
      }));
  const matches: Array<{
    path: string;
    view: MolecularDocument;
    selection: SavedResidueSelectionDocument;
  }> = [];
  for (const candidate of candidates) {
    if (!(await platform().fs.exists(candidate.path))) continue;
    const view = (await platform().molecularDocuments.read(candidate)).document;
    const selection = view.selections?.find((entry) => entry.id === ref.selectionId);
    if (selection) matches.push({ path: candidate.path, view, selection });
  }
  if (matches.length === 0)
    throw new Error(`selection not found in its molecular view: ${ref.artifactPath}`);
  if (matches.length > 1)
    throw new Error(
      `selection identity is ambiguous across mounted projects: ${matches
        .map((match) => match.path)
        .join(', ')}`
    );
  const [{ view, selection }] = matches;
  assertSelectionMatchesView(selection, ref.revisionId, view);
  return projectSavedSelectionRevisionToHighlightGroup(selection, ref.revisionId, ref.visible);
}

export function assertSavedSelectionStructureCompatibility(
  document: SavedResidueSelectionDocument,
  revisionId: string,
  structureArtifactRef: StructureCoordinateCompatibilityRef | undefined
): void {
  const revision = document.revisions.find((candidate) => candidate.id === revisionId);
  if (!revision) throw new Error(`saved selection revision is missing: ${revisionId}`);
  const requiredRevisionIds = new Set(
    revision.members.flatMap((member) =>
      member.scope.kind === 'structure-chain-instance' ? [member.scope.structureRevisionId] : []
    )
  );
  if (requiredRevisionIds.size === 0) return;
  if (!structureArtifactRef) {
    throw new Error('current structure coordinate revision is unavailable');
  }
  for (const requiredRevisionId of requiredRevisionIds) {
    const pinned = revision.structureRevisions.find(
      (candidate) => candidate.id === requiredRevisionId
    );
    if (!pinned) {
      throw new Error(`pinned structure revision is missing: ${requiredRevisionId}`);
    }
    if ((pinned.assemblyId ?? null) !== (structureArtifactRef.assemblyId ?? null)) {
      throw new Error(
        `saved selection biological assembly differs from the current structure (${pinned.assemblyId ?? 'unspecified'} != ${structureArtifactRef.assemblyId ?? 'unspecified'}); explicit remap required`
      );
    }
    if (pinned.coordinateDigestSha256 !== structureArtifactRef.coordinateDigestSha256) {
      throw new Error(
        `saved selection coordinate bytes differ from the current structure (${pinned.coordinateDigestSha256} != ${structureArtifactRef.coordinateDigestSha256}); explicit remap required`
      );
    }
  }
}

export async function renameSavedSelectionRef(
  workspaceRoot: string,
  ref: SavedSelectionViewRef,
  name: string
): Promise<{
  ref: SavedSelectionViewRef;
  projection: HighlightGroup;
  molecularDocumentRevision?: string;
}> {
  if (isMolecularViewPath(ref.artifactPath)) return renameSelectionInView(workspaceRoot, ref, name);
  const document = parseSavedResidueSelectionDocument(
    await platform().fs.readTextFile(resolveWorkspaceArtifactPath(workspaceRoot, ref.artifactPath))
  );
  if (document.id !== ref.selectionId) {
    throw new Error(`Saved selection identity mismatch: ${document.id}`);
  }
  const current = document.revisions.find((revision) => revision.id === ref.revisionId);
  if (!current) throw new Error(`Saved selection revision is missing: ${ref.revisionId}`);
  const next = appendSavedResidueSelectionRevision(document, {
    revisionId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    actor: { kind: 'user' },
    reason: 'Rename saved selection',
    name,
    members: current.members,
    structureRevisions: current.structureRevisions,
  });
  await writeSavedResidueSelectionArtifactRevision({
    workspaceRoot,
    path: resolveWorkspaceArtifactPath(workspaceRoot, ref.artifactPath),
    document: next,
  });
  const nextRef = { ...ref, revisionId: next.currentRevisionId };
  return {
    ref: nextRef,
    projection: projectSavedSelectionRevisionToHighlightGroup(
      next,
      next.currentRevisionId,
      ref.visible
    ),
  };
}

async function renameSelectionInView(
  workspaceRoot: string,
  ref: SavedSelectionViewRef,
  name: string
): Promise<{
  ref: SavedSelectionViewRef;
  projection: HighlightGroup;
  molecularDocumentRevision: string;
}> {
  const destination = {
    path: resolveWorkspaceArtifactPath(workspaceRoot, ref.artifactPath),
    workspaceRoot,
  };
  const opened = await platform().molecularDocuments.read(destination);
  const selection = opened.document.selections?.find((entry) => entry.id === ref.selectionId);
  if (!selection) throw new Error(`Saved selection is missing from its view: ${ref.selectionId}`);
  const current = selection.revisions.find((revision) => revision.id === ref.revisionId);
  if (!current) throw new Error(`Saved selection revision is missing: ${ref.revisionId}`);
  const next = appendSavedResidueSelectionRevision(selection, {
    revisionId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    actor: { kind: 'user' },
    reason: 'Rename saved selection',
    name,
    members: current.members,
    structureRevisions: current.structureRevisions,
  });
  const saved = await platform().molecularDocuments.save({
    document: {
      ...opened.document,
      selections: opened.document.selections!.map((entry) => (entry.id === next.id ? next : entry)),
    },
    destination,
    expectedRevision: opened.revision,
  });
  return {
    ref: { ...ref, revisionId: next.currentRevisionId },
    projection: projectSavedSelectionRevisionToHighlightGroup(
      next,
      next.currentRevisionId,
      ref.visible
    ),
    molecularDocumentRevision: saved.revision,
  };
}

export function recordSelectionInOpenViews(
  molecularDocumentPath: string,
  ref: SavedSelectionViewRef,
  molecularDocumentRevision: string
): number {
  const store = useStructure3dStore.getState();
  let updated = 0;
  for (const [id, entry] of Object.entries(store.expandedStructures)) {
    if (entry?.data?.molecularDocumentPath !== molecularDocumentPath) continue;
    store.updateStructureData(id, {
      ...entry.data,
      savedSelectionRefs: [
        ...(entry.data.savedSelectionRefs ?? []).filter(
          (candidate) => candidate.selectionId !== ref.selectionId
        ),
        ref,
      ],
      molecularDocumentRevision,
    });
    updated += 1;
  }
  return updated;
}

const MOLECULAR_VIEW_BINDING_KEYS = [
  'molecularDocumentId',
  'molecularDocumentReference',
  'molecularDocumentProjectId',
  'molecularDocumentPath',
  'molecularDocumentRevision',
  'molecularDocumentSavedReferenceId',
] as const;

export function molecularViewBinding(
  attrs: Structure3dAttrs
): Pick<Structure3dAttrs, (typeof MOLECULAR_VIEW_BINDING_KEYS)[number]> {
  return Object.fromEntries(
    MOLECULAR_VIEW_BINDING_KEYS.filter((key) => attrs[key] !== undefined).map((key) => [
      key,
      attrs[key],
    ])
  );
}

export async function createViewForSelection(input: {
  workspaceRoot: string;
  attrs: Structure3dAttrs;
}): Promise<{ attrs: Structure3dAttrs; workspaceRoot: string }> {
  const coordinates = await fetchExactStructureCoordinates(input.attrs);
  const name =
    (stripDisplayExtension(input.attrs.label || input.attrs.title || '') || 'Structure')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .trim() || 'Structure';
  const document = await buildDefaultMolecularDocument({
    name,
    format: coordinates.format === 'mmcif' ? 'cif' : 'pdb',
    text: coordinates.data,
    createdAt: Date.now(),
    documentId: crypto.randomUUID(),
    referenceId: crypto.randomUUID(),
  });
  const root = input.workspaceRoot.replace(/[\\/]+$/, '');
  for (let n = 1; n <= 1000; n += 1) {
    const path = `${root}/${n === 1 ? name : `${name} ${n}`}${MOLECULAR_DOCUMENT_SUFFIX}`;
    if (await platform().fs.exists(path)) continue;
    await platform().molecularDocuments.save({
      document,
      destination: { path, workspaceRoot: input.workspaceRoot },
      expectedRevision: null,
    });
    useWorkspaceStore.getState().bumpFileTreeRefresh();
    const { readMolecularDocument } =
      await import('../../../../molecular-documents/public/services');
    const saved = await readMolecularDocument(path, input.workspaceRoot);
    return {
      attrs: {
        ...input.attrs,
        ...molecularViewBinding({
          molecularDocumentId: saved.document.id,
          molecularDocumentReference: saved.documentReference,
          molecularDocumentProjectId: saved.documentReference.projectId,
          molecularDocumentPath: saved.path,
          molecularDocumentRevision: saved.revision,
          molecularDocumentSavedReferenceId: saved.document.currentReferenceId,
        }),
      },
      workspaceRoot: input.workspaceRoot,
    };
  }
  throw new Error('No free name for the structure view.');
}

export async function saveViewBeforeSelection(
  structureViewId: string,
  attrs: Structure3dAttrs
): Promise<{ attrs: Structure3dAttrs; workspaceRoot: string }> {
  const { handleMolSaveView } = await import('../../../../agent-bridge/public/structure-tools');
  const result = await handleMolSaveView(
    {
      structureViewId,
      title: stripDisplayExtension(attrs.label || attrs.sourceId || '') || 'Structure',
      caption: '',
      evidence: [],
      saveToProject: true,
    },
    { cameraPolicy: 'preserve-authored' }
  );
  if (!result.ok) throw new Error(result.error ?? 'The view could not be saved.');
  if (
    !result.molecularDocumentId ||
    !result.molecularDocumentPath ||
    !result.molecularDocumentRevision
  )
    throw new Error('The view was captured, but no project file was saved.');
  const workspaceRoot = findWorkspaceRootForPath(
    useWorkspaceStore.getState().folders,
    result.molecularDocumentPath
  );
  if (!workspaceRoot) throw new Error('The saved view is outside every open project.');
  return {
    attrs: {
      ...attrs,
      molecularDocumentId: result.molecularDocumentId,
      molecularDocumentPath: result.molecularDocumentPath,
      molecularDocumentRevision: result.molecularDocumentRevision,
    },
    workspaceRoot,
  };
}

async function saveStructureSelectionIntoView(input: {
  workspaceRoot: string;
  structureId: string;
  attrs: Structure3dAttrs;
  chains: ReadonlyArray<ChainSequence>;
  group: HighlightGroup;
}): Promise<SaveStructureSelectionResult> {
  const path = input.attrs.molecularDocumentPath!;
  const opened = await platform().molecularDocuments.read({
    path,
    workspaceRoot: input.workspaceRoot,
  });
  if (
    input.attrs.molecularDocumentRevision &&
    opened.revision !== input.attrs.molecularDocumentRevision
  )
    throw new Error(
      'This molecular view changed elsewhere. Reopen its current version before saving a selection.'
    );
  const document = await buildSavedSelectionDocumentFromStructure({
    assetId: crypto.randomUUID(),
    revisionId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    group: input.group,
    attrs: input.attrs,
    chains: input.chains,
    structureId: input.structureId,
    structureRevision: {
      id: crypto.randomUUID(),
      structureId: input.structureId,
      coordinateDigestSha256: getCurrentMolecularSnapshot(opened.document).coordinates.sha256,
    },
  });
  const saved = await platform().molecularDocuments.save({
    document: {
      ...opened.document,
      selections: [...(opened.document.selections ?? []), document],
    },
    destination: { path, workspaceRoot: input.workspaceRoot },
    expectedRevision: opened.revision,
  });
  const ref: SavedSelectionViewRef = {
    selectionId: document.id,
    revisionId: document.currentRevisionId,
    artifactPath: workspaceRelativePath(input.workspaceRoot, path),
    visible: true,
  };
  return {
    ref,
    projection: projectSavedSelectionRevisionToHighlightGroup(
      document,
      document.currentRevisionId,
      ref.visible
    ),
    molecularDocumentPath: path,
    molecularDocumentRevision: saved.revision,
  };
}

function isMolecularViewPath(path: string): boolean {
  return path.toLowerCase().endsWith(MOLECULAR_DOCUMENT_SUFFIX);
}

function assertSelectionMatchesView(
  selection: SavedResidueSelectionDocument,
  revisionId: string,
  view: MolecularDocument
): void {
  const revision = selection.revisions.find((candidate) => candidate.id === revisionId);
  if (!revision) throw new Error(`saved selection revision is missing: ${revisionId}`);
  const current = getCurrentMolecularSnapshot(view);
  const digests = new Set([
    current.coordinates.sha256,
    ...(current.version === 2 ? current.pinnedAssets.map((asset) => asset.sha256) : []),
  ]);
  for (const pinned of revision.structureRevisions)
    if (!digests.has(pinned.coordinateDigestSha256))
      throw new Error(
        'saved selection coordinate bytes differ from the current view; explicit remap required'
      );
}

async function currentManagedWorkspaceHead(workspaceRoot: string): Promise<string | null> {
  try {
    const markerPath = `${workspaceRoot.replace(/\/+$/, '')}/${MANAGED_WORKSPACE_MARKER}`;
    if (!(await platform().fs.exists(markerPath))) return null;
    return (await platform().workspace.indexManagedHead({ repoPath: workspaceRoot })).headCommit;
  } catch {
    return null;
  }
}

async function fetchExactStructureCoordinates(
  attrs: Structure3dAttrs
): Promise<{ data: string; format: 'mmcif' | 'pdb' }> {
  const source = attrs.source ?? 'pdb';
  const props = getMolstarPropsFromAttrs(source, attrs);
  if (props.structureData instanceof Uint8Array)
    throw new Error('Selections on binary coordinates are saved in their molecular view.');
  if (props.structureData) {
    return {
      data: props.structureData,
      format:
        props.structureData.includes('data_') || props.structureData.includes('_atom_site')
          ? 'mmcif'
          : 'pdb',
    };
  }
  if (props.url) {
    return fetchStructureFromUrl(props.url);
  }
  if (props.structureIdentity?.provider === 'rcsb' || props.pdbId) {
    const sourceIdentity = props.structureIdentity ?? props.pdbId;
    if (sourceIdentity) return fetchStructureData(sourceIdentity, 'rcsb');
  }
  if (props.structureIdentity?.provider === 'alphafold' || props.uniprotId) {
    const sourceIdentity = props.structureIdentity ?? props.uniprotId;
    if (sourceIdentity) return fetchStructureData(sourceIdentity, 'alphafold');
  }
  throw new Error('Cannot materialize exact coordinate bytes for this structure');
}

function workspaceRelativePath(workspaceRoot: string, path: string): string {
  const root = workspaceRoot.replace(/\/+$/, '');
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

export function resolveStructureWorkspaceRoot(
  folders: ReadonlyArray<{ path: string }>,
  attrs: Structure3dAttrs,
  notebookRoot?: string | null
): string | null {
  const candidates = [
    attrs.molecularDocumentPath,
    attrs.structureArtifactRef?.artifactPath,
    attrs.scene?.queryAnchor.sourceWorkspaceRoot,
  ];
  for (const candidate of candidates) {
    if (!candidate || !isAbsolutePathLike(candidate)) continue;
    const containingRoot = findWorkspaceRootForPath([...folders], candidate);
    if (containingRoot) return containingRoot;
  }
  if (notebookRoot && folders.some((folder) => folder.path === notebookRoot)) return notebookRoot;
  return folders.length === 1 ? folders[0].path : null;
}

export function resolveWorkspaceArtifactPath(workspaceRoot: string, artifactPath: string): string {
  if (isAbsolutePathLike(artifactPath)) return artifactPath;
  if (artifactPath.split(/[\\/]/).includes('..')) {
    throw new Error(`Project-relative artifact path cannot escape its root: ${artifactPath}`);
  }
  return `${workspaceRoot.replace(/[\\/]+$/, '')}/${artifactPath.replace(/^[\\/]+/, '')}`;
}
