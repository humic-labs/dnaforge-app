import { withUserMessage } from '@waypoint/user-messages';
import { SavedDocumentCompletionError } from '../../services/saved-document-completion';
import { platform } from '../../platform';
import {
  createEntityReference,
  getEntityReference,
  getEntityReferenceByLocator,
  type DBEntityReference,
} from '../../db/entity-references';
import { molecularDocumentAdapter } from '../../db/entity-substrate/molecular-document-adapter';
import {
  findWorkspaceRootForPath,
  getCatalogFileForPath,
  getWorkspaceRootById,
  getWorkspaceRootByScope,
  markCatalogPathMissing,
  resolveWorkspaceScope,
} from '../../db/workspace-catalog';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { writableProjectRoots } from '../../shared/project-root-selection';
import { emitRegistryChanged } from '../../shared/registry-events';
import {
  MOLECULAR_DOCUMENT_SCHEMA,
  MOLECULAR_DOCUMENT_SUFFIX,
  molecularDocumentStorageStatus,
  type MolecularDocument,
  type SavedMolecularDocument,
} from '../../shared/molecular-document';
import type { MolecularCoordinateText } from '../../shared/molecular-storage';
import { binaryCoordinateText } from '../../shared/binary-coordinates';
import {
  coordinateDigest,
  molecularViewFromReferenceData,
  type MolecularView,
} from '../../shared/molecular-view';
import {
  importMolecularPresentationSnapshot,
  prepareMolecularPresentationRevision,
} from '../page/public/embeds/structure3d/molecularPresentation';
import type { Structure3dAttrs } from '../page/public/embeds/structure3d/types';
import { pathIsAtOrUnder } from '../../shared/path-boundary';
import {
  molecularDocumentReferenceFor,
  molecularDocumentReferenceLocator,
  type MolecularDocumentReference,
} from '../../shared/molecular-document-reference';
import { molecularDocumentOwner } from '../../shared/molecular-document-owner';
import { stripDisplayExtension } from '../../utils/fileTypes';

export type ProjectedMolecularDocument = SavedMolecularDocument & {
  catalogEntityId: string;
  documentReference: MolecularDocumentReference;
};
type ProjectionContext = { workspaceRoot: string; workspaceScope: string | null };

async function project(
  saved: SavedMolecularDocument,
  knownContext?: ProjectionContext
): Promise<ProjectedMolecularDocument> {
  const context = knownContext ?? {
    workspaceRoot: saved.workspaceRoot,
    workspaceScope: await resolveWorkspaceScope(saved.workspaceRoot),
  };
  const id = molecularDocumentAdapter.identity(saved.document, context);
  if (!context.workspaceScope)
    throw Error('The molecular document has no owning project identity.');
  const documentReference = await molecularDocumentReferenceFor(
    context.workspaceScope,
    saved.document
  );
  await molecularDocumentAdapter.writeProjection(
    saved.document,
    id,
    Date.now(),
    saved.path,
    context
  );
  await molecularDocumentAdapter.reconcileRelationships?.(saved.document, id, saved.path, context);
  emitRegistryChanged();
  return { ...saved, catalogEntityId: id, documentReference };
}

export async function readMolecularDocument(
  path: string,
  explicitWorkspaceRoot?: string
): Promise<ProjectedMolecularDocument> {
  const folders = useWorkspaceStore.getState().folders;
  const workspaceRoot =
    (await durableProjectRoot(path)) ??
    explicitWorkspaceRoot ??
    findWorkspaceRootForPath(folders, path) ??
    path.replace(/[\\/][^\\/]+$/, '');
  const saved = await platform().molecularDocuments.read({ path, workspaceRoot });
  let warning: string | undefined;
  try {
    for (const entry of saved.document.history)
      await importMolecularPresentationSnapshot(entry.referenceId, entry.snapshot, workspaceRoot);
  } catch {
    warning = 'The document file opened, but its legacy reference cache could not be refreshed.';
  }
  const projected = await project(saved);
  return warning
    ? { ...projected, warning: [projected.warning, warning].filter(Boolean).join(' ') }
    : projected;
}

export async function renameMolecularDocument(input: {
  saved: SavedMolecularDocument;
  name: string;
}): Promise<ProjectedMolecularDocument> {
  const saved = await platform().molecularDocuments.save({
    document: { ...input.saved.document, name: input.name },
    destination: { path: input.saved.path, workspaceRoot: input.saved.workspaceRoot },
    expectedRevision: input.saved.revision,
  });
  const complete = async () => {
    const current = await platform().molecularDocuments.read({
      path: saved.path,
      workspaceRoot: saved.workspaceRoot,
    });
    if (current.revision !== saved.revision)
      throw new Error('This document changed after its save. Reopen its current version.');
    await updateMolecularDocumentPresentation(current);
    return project(current);
  };
  try {
    await updateMolecularDocumentPresentation(saved);
    return await project(saved);
  } catch {
    throw new SavedDocumentCompletionError(
      'The document name is saved, but its Registry entry could not be refreshed. Retry save to finish.',
      async () => {
        await complete();
      }
    );
  }
}

async function updateMolecularDocumentPresentation(saved: SavedMolecularDocument): Promise<void> {
  const { useCanvasStore } = await import('../canvas/public/store');
  const { useStructure3dStore } = await import('../page/public/embeds/structure3d/store');
  const canvas = useCanvasStore.getState();
  for (const panel of Object.values(canvas.panels))
    for (const tab of panel.tabs) {
      if (
        tab.type !== 'structure' ||
        tab.initialStructureAttrs?.molecularDocumentPath !== saved.path ||
        tab.initialStructureAttrs.molecularDocumentId !== saved.document.id
      )
        continue;
      canvas.updateTab(panel.id, tab.id, {
        label: saved.document.name,
        initialStructureAttrs: {
          ...tab.initialStructureAttrs,
          label: saved.document.name,
          molecularDocumentRevision: saved.revision,
        },
      });
    }
  const structures = useStructure3dStore.getState();
  for (const [id, expanded] of Object.entries(structures.expandedStructures)) {
    const attrs = expanded.data;
    if (
      attrs.molecularDocumentPath === saved.path &&
      attrs.molecularDocumentId === saved.document.id
    )
      structures.updateStructureData(id, {
        ...attrs,
        label: saved.document.name,
        molecularDocumentRevision: saved.revision,
      });
  }
}

async function durableProjectRoot(path: string): Promise<string | null> {
  const binding = await getCatalogFileForPath(path);
  if (!binding) return null;
  const root = await getWorkspaceRootById(binding.workspace_id);
  if (!root)
    throw Error(
      'The molecular document’s owning project is unavailable. Reopen its project before continuing.'
    );
  return root;
}

async function boundProjectRoot(path: string, reference: DBEntityReference): Promise<string> {
  const durable = await durableProjectRoot(path);
  if (durable) return durable;
  const mounted = findWorkspaceRootForPath(useWorkspaceStore.getState().folders, path);
  if (mounted) return mounted;
  if (reference.workspace_root_path && pathIsAtOrUnder(path, reference.workspace_root_path))
    return reference.workspace_root_path;
  throw Error(
    'The molecular document’s owning project is unavailable. Reopen its project before saving.'
  );
}

function projectRoot(reference: DBEntityReference, attrs: Structure3dAttrs): string {
  const state = useWorkspaceStore.getState();
  const roots = writableProjectRoots(state.folders);
  const contextual = [
    attrs.molecularDocumentPath,
    attrs.coordinateFilePath,
    attrs.structureArtifactRef?.artifactPath,
    reference.workspace_root_path,
    state.selectedPath,
  ];
  for (const path of contextual) {
    const root =
      roots.find((root) => root.path === path)?.path ?? findWorkspaceRootForPath(roots, path);
    if (root) return root;
  }
  if (roots.length === 1) return roots[0].path;
  throw withUserMessage(
    Error(
      roots.length
        ? 'Select a folder in the project where this molecular document should be saved.'
        : 'Open a writable project to save this molecular document. Your result remains in chat.'
    ),
    roots.length ? 'molecular.destinationRequired' : 'molecular.projectRequired'
  );
}

async function absorbSourceCoordinates(
  attrs: Structure3dAttrs,
  root: string,
  snapshot: MolecularView
): Promise<boolean> {
  const source = attrs.coordinateFilePath;
  if (attrs.source !== 'file' || !source || !pathIsAtOrUnder(source, root)) return false;
  const files = platform().fs;
  const text = await (
    snapshot.coordinates.format === 'bcif'
      ? files.readFile(source).then(binaryCoordinateText)
      : files.readTextFile(source)
  ).catch(() => null);
  if (text === null || (await coordinateDigest(text)) !== snapshot.coordinates.sha256) return false;
  await platform().shell.trashItem(source);
  await markCatalogPathMissing(source, 'absorbed-into-view').catch(() => undefined);
  return true;
}

function join(root: string, leaf: string): string {
  return `${root.replace(/[\\/]$/, '')}/${leaf}`;
}

async function newDestination(
  root: string,
  name: string,
  sourcePath: string | undefined
): Promise<string> {
  const folder =
    sourcePath && pathIsAtOrUnder(sourcePath, root)
      ? sourcePath.replace(/[\\/][^\\/]+$/, '')
      : root;
  const stem =
    name
      .normalize('NFC')
      .replace(/[<>:"/\\|?*\p{Cc}]/gu, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 120) || 'Molecular view';
  for (let suffix = 1; suffix <= 1000; suffix++) {
    const path = join(
      folder,
      `${stem}${suffix === 1 ? '' : ` ${suffix}`}${MOLECULAR_DOCUMENT_SUFFIX}`
    );
    if (!(await platform().fs.exists(path))) return path;
  }
  throw Error('Choose a different document name before saving.');
}

async function resultLineage(reference: DBEntityReference): Promise<MolecularDocument['history']> {
  const history: MolecularDocument['history'] = [];
  const seen = new Set<string>();
  let current: DBEntityReference | null = reference;
  while (current) {
    if (seen.has(current.id)) throw Error('The molecular result has a cyclic history.');
    seen.add(current.id);
    const snapshot = molecularViewFromReferenceData(current.data);
    if (!snapshot) throw Error('The molecular result is missing or unsupported.');
    history.unshift({ referenceId: current.id, snapshot });
    const parent = snapshot.presentation?.parentReferenceId;
    current = parent ? await getEntityReference(parent) : null;
  }
  return history;
}

export async function saveMolecularDocumentResult(
  reference: DBEntityReference,
  attrs: Structure3dAttrs,
  destinationRoot?: string,
  options: { previous?: SavedMolecularDocument; preserveSource?: boolean } = {}
): Promise<ProjectedMolecularDocument> {
  if (attrs.molecularDocumentHistoricalRevisionId)
    throw Error(
      'This is a historical molecular document revision. Open its current version or explicitly copy it before saving.'
    );
  const snapshot = molecularViewFromReferenceData(reference.data);
  if (!snapshot) throw Error('The molecular result is missing or unsupported.');
  const hasBinding = Boolean(
    attrs.molecularDocumentId || attrs.molecularDocumentPath || attrs.molecularDocumentRevision
  );
  if (
    hasBinding &&
    (!attrs.molecularDocumentId || !attrs.molecularDocumentPath || !attrs.molecularDocumentRevision)
  )
    throw Error('This molecular document has an incomplete project binding. Reopen its file.');
  const root = hasBinding
    ? await boundProjectRoot(attrs.molecularDocumentPath!, reference)
    : (destinationRoot ?? projectRoot(reference, attrs));
  if (hasBinding && destinationRoot && destinationRoot !== root)
    throw Error(
      'Saving cannot change a molecular document’s owning project. Request an explicit document copy.'
    );
  let document: MolecularDocument;
  let path: string;
  let expectedRevision: string | null = null;
  if (hasBinding) {
    const previous =
      options.previous ??
      (await platform().molecularDocuments.read({
        path: attrs.molecularDocumentPath!,
        workspaceRoot: root,
      }));
    if (
      previous.document.id !== attrs.molecularDocumentId ||
      previous.revision !== attrs.molecularDocumentRevision
    )
      throw Error(
        'This molecular document changed elsewhere. Reopen its current version before saving.'
      );
    expectedRevision = attrs.molecularDocumentRevision!;
    path = attrs.molecularDocumentPath!;
    document = {
      ...previous.document,
      currentReferenceId: reference.id,
      history: previous.document.history.some((entry) => entry.referenceId === reference.id)
        ? previous.document.history
        : [...previous.document.history, { referenceId: reference.id, snapshot }],
    };
  } else {
    const name = stripDisplayExtension(snapshot.title);
    path = await newDestination(root, name, attrs.coordinateFilePath);
    document = {
      schema: MOLECULAR_DOCUMENT_SCHEMA,
      id: attrs.molecularDocumentDraftId ?? crypto.randomUUID(),
      name,
      currentReferenceId: reference.id,
      history: await resultLineage(reference),
    };
  }
  const context = { workspaceRoot: root, workspaceScope: await resolveWorkspaceScope(root) };
  if (!context.workspaceScope)
    throw Error('The molecular document has no owning project identity.');
  const catalogEntityId = molecularDocumentAdapter.identity(document, context);
  const saved = await platform().molecularDocuments.save({
    document,
    destination: { path, workspaceRoot: root },
    expectedRevision,
  });
  let cacheWarning: string | undefined;
  try {
    for (const entry of saved.document.history)
      await importMolecularPresentationSnapshot(entry.referenceId, entry.snapshot, root);
  } catch {
    cacheWarning =
      'The molecular document was saved, but its legacy reference cache could not be refreshed. Its typed document reference remains usable.';
  }

  let projected: ProjectedMolecularDocument;
  try {
    projected = await project(saved, context);
  } catch {
    projected = {
      ...saved,
      catalogEntityId,
      documentReference: await molecularDocumentReferenceFor(
        context.workspaceScope!,
        saved.document
      ),
      warning:
        'The molecular document was saved, but its Registry entry could not be refreshed. Reopen the file to retry.',
    };
  }
  if (!hasBinding && !options.preserveSource) {
    try {
      await absorbSourceCoordinates(attrs, root, snapshot);
    } catch {
      projected = {
        ...projected,
        warning:
          'The view was saved, but its source coordinate file could not be moved to the Trash. Remove it from the project to keep one entry.',
      };
    }
  }
  useWorkspaceStore.getState().bumpFileTreeRefresh();
  return cacheWarning
    ? { ...projected, warning: [projected.warning, cacheWarning].filter(Boolean).join(' ') }
    : projected;
}

export async function saveMolecularDocumentSnapshot(
  snapshot: MolecularView,
  attrs: Structure3dAttrs,
  options: { copy?: boolean; changeSummary?: string; destinationProject?: string } = {}
): Promise<
  ProjectedMolecularDocument & {
    revisionReference: DBEntityReference;
    reference: DBEntityReference | null;
  }
> {
  const current = options.copy
    ? {
        ...attrs,
        molecularDocumentId: undefined,
        molecularDocumentPath: undefined,
        molecularDocumentRevision: undefined,
        molecularDocumentSavedReferenceId: undefined,
        molecularDocumentHistoricalRevisionId: undefined,
        molecularDocumentDraftId: crypto.randomUUID(),
        molecularDocumentReference: undefined,
        molecularDocumentProjectId: undefined,
      }
    : attrs;
  let previous: SavedMolecularDocument | undefined;
  let parent: MolecularDocument['history'][number] | null = null;
  if (current.molecularDocumentPath) {
    const root = await durableProjectRoot(current.molecularDocumentPath);
    if (!root)
      throw Error('The owning molecular document project is unavailable. Reopen its file.');
    previous = await platform().molecularDocuments.read({
      path: current.molecularDocumentPath,
      workspaceRoot: root,
    });
    if (
      previous.document.id !== current.molecularDocumentId ||
      previous.revision !== current.molecularDocumentRevision
    )
      throw Error(
        'The molecular document changed elsewhere. Reopen its current version before saving.'
      );
    const document = previous.document;
    parent = document.history.find((entry) => entry.referenceId === document.currentReferenceId)!;
  }
  const revisionReference = await prepareMolecularPresentationRevision(
    snapshot,
    parent,
    options.changeSummary
  );
  const destinations = options.destinationProject
    ? writableProjectRoots(useWorkspaceStore.getState().folders).filter(
        (root) =>
          root.path === options.destinationProject || root.name === options.destinationProject
      )
    : [];
  if (options.destinationProject && destinations.length !== 1)
    throw Error(
      'Choose one exact mounted writable project name or path for this molecular document.'
    );
  const saved = await saveMolecularDocumentResult(
    revisionReference,
    current,
    destinations[0]?.path,
    { previous, preserveSource: options.copy }
  );
  let reference: DBEntityReference | null = null;
  let warning = saved.warning;
  try {
    const locator = molecularDocumentReferenceLocator(saved.documentReference);
    reference = await getEntityReferenceByLocator(locator);
    if (
      reference &&
      (reference.entity_type !== 'molecular-document' ||
        reference.data !== JSON.stringify(saved.documentReference))
    )
      throw Error('The document reference projection disagrees with its file.');
    reference ??= await createEntityReference({
      entityType: 'molecular-document',
      displayLabel: saved.document.name,
      locator,
      data: saved.documentReference,
      deepLinkParams: null,
      source: 'ai',
      workspaceScope: saved.documentReference.projectId,
      workspaceRootPath: saved.workspaceRoot,
    });
  } catch {
    warning = [
      warning,
      'The document was saved. Its reference cache is unavailable; use the returned documentReference.',
    ]
      .filter(Boolean)
      .join(' ');
  }
  return { ...saved, warning, revisionReference, reference };
}

export async function inspectMolecularDocumentBinding(
  attrs: Structure3dAttrs,
  coordinateAssets?: readonly MolecularCoordinateText[]
) {
  const documentOwner = molecularDocumentOwner(attrs);
  if (documentOwner.kind === 'draft')
    return {
      documentOwner,
      documentReference: undefined,
      ...(coordinateAssets
        ? { documentStorage: molecularDocumentStorageStatus(coordinateAssets) }
        : {}),
    };
  const root = attrs.molecularDocumentProjectId
    ? await getWorkspaceRootByScope(attrs.molecularDocumentProjectId)
    : await durableProjectRoot(documentOwner.path);
  if (!root) throw Error('The molecular document owning project is unavailable. Reopen its file.');
  const saved = await platform().molecularDocuments.read({
    path: documentOwner.path,
    workspaceRoot: root,
  });
  if (
    saved.document.id !== documentOwner.documentId ||
    saved.revision !== documentOwner.fileRevision
  )
    throw Error(
      'The molecular document changed elsewhere. Reopen it before addressing its parameters.'
    );
  const projectId = await resolveWorkspaceScope(root);
  if (!projectId) throw Error('The molecular document has no owning project identity.');
  return {
    documentOwner,
    ...(coordinateAssets
      ? { documentStorage: molecularDocumentStorageStatus(coordinateAssets, saved.document) }
      : {}),
    documentReference: await molecularDocumentReferenceFor(
      projectId,
      saved.document,
      documentOwner.revisionId
    ),
  };
}

export async function readMolecularDocumentFollowingRename(
  path: string,
  documentId: string | undefined
): Promise<ProjectedMolecularDocument> {
  try {
    return await readMolecularDocument(path);
  } catch (error) {
    const renamedPath = path.replace(
      /\.(pdb|ent|cif|mmcif|bcif)(\.dnaforge-molecular\.json)$/i,
      '$2'
    );
    if (renamedPath === path) throw error;
    const renamed = await readMolecularDocument(renamedPath);
    if (documentId && renamed.document.id !== documentId) throw error;
    return renamed;
  }
}
