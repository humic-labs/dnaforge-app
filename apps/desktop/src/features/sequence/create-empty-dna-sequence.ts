import { withUserMessage } from '@waypoint/user-messages';
import { decodeSequenceDocument, serializeGenBank } from '@waypoint/sequence-utils';
import { platform } from '../../platform';
import { openSequenceFile } from '../document-opening/public/compat';
import { useSequenceStore } from './store';
import { useCanvasStore } from '../canvas/public/store';
import { defineBlob } from '@waypoint/workspace-revisions';
import { scientificIdentityPath } from '@waypoint/scientific-objects';
import type { ScientificAcceptedDocumentRevision } from '@waypoint/domain-services';
import { findWorkspaceRootForPath } from '../../db/workspace-catalog';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { readScientificCatalog } from '../../services/read-scientific-namespace';
import {
  publishNativeArtifact,
  NativeArtifactPublicationPendingError,
} from '../../services/publish-native-artifact';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import { pathRelativeToBoundary } from '../../shared/path-boundary';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
  sequencePackagePaths,
} from '../../db/sequence-package';
import { isGitRepo, gitStatus, gitCommitPaths } from '../workspace/public/git';
import type { SequenceProductCreation } from '../../shared/sequence-product';

const GENBANK_EXTENSION = /\.(?:gb|gbk|genbank)$/i;
const INVALID_FILE_NAME_CHARACTERS = /[/\\:?%*"<>|]/g;
const MAX_SEQUENCE_NAME_LENGTH = 80;

export interface CreateEmptyDnaSequenceRequest {
  destinationPath: string;
  name: string;
  creationId?: string;
  publication?: CapturedSequenceCreation;
}

export interface CapturedSequenceCreation {
  readonly name: string;
  readonly destinationPath: string;
  readonly workspaceRoot: string;
  readonly artifactPath: string;
  readonly resourceId: string;
  readonly expectedHead: string | null;
  readonly content: string;
  readonly sequencePackageText: string;
}

export class SequenceCreationPendingError extends Error {
  constructor(
    readonly creation: CapturedSequenceCreation,
    readonly accepted: ScientificAcceptedDocumentRevision,
    reason: string
  ) {
    super(`Sequence creation accepted; ${reason}`);
    this.name = 'SequenceCreationPendingError';
    withUserMessage(this, 'document.saveRefreshPending');
  }
}

export interface CreateEmptyDnaSequenceResult {
  filePath: string;
  tabId: string | null;
}

export class SequenceCreationCollisionError extends Error {}

export interface CreateDnaSequencePackageRequest extends CreateEmptyDnaSequenceRequest {
  content: string;
  exactPackageName?: boolean;
  open?: boolean;
  requireAccepted?: boolean;

  creationDerivation?: SequenceProductCreation;
}

export interface CreateDnaSequencePackageResult extends CreateEmptyDnaSequenceResult {
  committed: boolean;
  publication?: {
    creation: CapturedSequenceCreation;
    accepted: ScientificAcceptedDocumentRevision;
  };
}

export function normalizeEmptyDnaSequenceName(input: string): string {
  return normalizeSequencePackageName(input.trim().replace(GENBANK_EXTENSION, ''));
}

export function normalizeSequencePackageName(input: string): string {
  const printableName = Array.from(input.trim(), (character) =>
    character.charCodeAt(0) < 32 ? '-' : character
  ).join('');
  const sanitized = printableName
    .replace(INVALID_FILE_NAME_CHARACTERS, '-')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_SEQUENCE_NAME_LENGTH)
    .trim();
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error('Enter a name for the DNA sequence.');
  }
  return sanitized;
}

export async function createEmptyDnaSequence(
  request: CreateEmptyDnaSequenceRequest
): Promise<CreateEmptyDnaSequenceResult> {
  const name = normalizeEmptyDnaSequenceName(request.name);
  const result = await createDnaSequencePackage({
    ...request,
    content:
      request.publication?.content ??
      serializeGenBank({
        id: name,
        name,
        sequence: '',
        length: 0,
        circular: false,
        annotations: [],
      }),
  });
  return { filePath: result.filePath, tabId: result.tabId };
}

export async function createDnaSequencePackage(
  request: CreateDnaSequencePackageRequest
): Promise<CreateDnaSequencePackageResult> {
  request = structuredClone(request);
  const name = request.exactPackageName
    ? normalizeSequencePackageName(request.name)
    : normalizeEmptyDnaSequenceName(request.name);
  if (request.exactPackageName && name !== request.name)
    throw new Error('Choose a valid name for the new sequence package.');
  const workspaceRoot = findWorkspaceRootForPath(
    useWorkspaceStore.getState().folders,
    request.destinationPath
  );
  const namespace = workspaceRoot ? await readScientificCatalog(workspaceRoot) : null;
  if (request.requireAccepted && !namespace)
    throw new Error('The accepted sequence project is unavailable. Reopen it before importing.');
  if (request.creationDerivation && !namespace)
    throw new Error('Traceable sequence products require an accepted scientific project.');
  if (request.publication && (!namespace || workspaceRoot !== request.publication.workspaceRoot))
    throw new Error('The accepted sequence project is unavailable. Reopen it before retrying.');

  const internalProductFileName = `${name}.gb`;
  const content = request.content;
  if (request.publication && request.publication.content !== content)
    throw new Error('Finish the accepted sequence creation with its original source bytes.');
  const prepared = decodeSequenceDocument(content, { filename: internalProductFileName });
  if (prepared.format !== 'genbank')
    throw new Error('Sequence package creation requires prepared GenBank bytes.');

  let filePath: string;
  let committed = false;
  let completedCreation:
    | { creation: CapturedSequenceCreation; accepted: ScientificAcceptedDocumentRevision }
    | undefined;
  if (workspaceRoot && namespace) {
    const packageRoot = `${request.destinationPath.replace(/[\\/]+$/u, '')}/${name}`;
    const paths = sequencePackagePaths(packageRoot, { productFile: internalProductFileName });
    const relativePath = pathRelativeToBoundary(paths.productPath, workspaceRoot);
    const metadataPath = pathRelativeToBoundary(paths.metaPath, workspaceRoot);
    if (!relativePath || !metadataPath)
      throw new Error('Choose a folder inside the sequence project.');
    if (request.publication) {
      if (
        request.publication.name !== name ||
        request.publication.destinationPath !== request.destinationPath ||
        request.publication.artifactPath !== paths.productPath ||
        (request.creationId && request.creationId !== request.publication.resourceId)
      )
        throw new Error(
          'Finish the accepted sequence creation unchanged before creating another draft.'
        );
    } else if (
      namespace.entries.some((entry) =>
        entry.path?.startsWith(`${pathRelativeToBoundary(packageRoot, workspaceRoot)}/`)
      ) ||
      (await platform().fs.exists(packageRoot))
    )
      throw new SequenceCreationCollisionError(
        'A sequence package already exists there. Choose a new name.'
      );
    const resourceId = request.creationId ?? crypto.randomUUID();
    const creation: CapturedSequenceCreation = request.publication ?? {
      name,
      destinationPath: request.destinationPath,
      workspaceRoot,
      artifactPath: paths.productPath,
      resourceId,
      expectedHead: namespace.head,
      content,
      sequencePackageText: serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: resourceId,
          name,
          ...(request.creationDerivation
            ? { existing: { creationDerivation: request.creationDerivation } }
            : {}),
          product: {
            file: internalProductFileName,
            genBankChecksum: defineBlob(new TextEncoder().encode(content)).hash,
          },
        })
      ),
    };
    await withRendererWorkspaceMutation(workspaceRoot, async (mutationToken) => {
      const isGit = await isGitRepo(workspaceRoot, mutationToken);
      const dirtyBefore = isGit
        ? await gitStatus(workspaceRoot, mutationToken)
        : new Map<string, unknown>();
      let accepted: ScientificAcceptedDocumentRevision;
      try {
        accepted = await publishNativeArtifact({
          workspaceRoot,
          artifactPath: creation.artifactPath,
          resourceId: creation.resourceId,
          prior: null,
          expectedHead: creation.expectedHead,
          representation: { format: 'genbank-v1', text: creation.content },
          sequencePackageText: creation.sequencePackageText,
          mutationToken,
        });
      } catch (error) {
        if (error instanceof NativeArtifactPublicationPendingError)
          throw new SequenceCreationPendingError(creation, error.accepted, error.message);
        throw error;
      }
      try {
        const rows = await platform().db.select<{ entity_id: string }[]>(
          "SELECT entity_id FROM catalog_entity_files WHERE path = ? AND status = 'current'",
          [paths.root]
        );
        if (rows.length !== 1 || rows[0].entity_id !== creation.resourceId)
          throw new Error('The new sequence is not visible in the project yet. Retry creation.');
        if (isGit) {
          const dirtyAfter = await gitStatus(workspaceRoot, mutationToken);
          const owned = [
            relativePath,
            metadataPath,
            scientificIdentityPath,
            ...[...dirtyAfter.keys()].filter(
              (path) => path.startsWith('.waypoint/lims/') && !dirtyBefore.has(path)
            ),
          ];
          const dirty = owned.filter((path) => dirtyAfter.has(path));
          if (dirty.length > 0)
            await gitCommitPaths(workspaceRoot, `Add sequence ${name}`, dirty, mutationToken);
        }
        completedCreation = { creation, accepted };
        committed = isGit;
      } catch (error) {
        throw new SequenceCreationPendingError(
          creation,
          accepted,
          error instanceof Error ? error.message : 'Sequence publication remains incomplete.'
        );
      }
    });
    filePath = paths.productPath;
  } else if (request.exactPackageName) {
    if (!workspaceRoot) throw new Error('Choose an open project for the new sequence package.');
    const relativePath = pathRelativeToBoundary(
      request.destinationPath.replace(/[\\/]+$/u, '') + '/' + internalProductFileName,
      workspaceRoot
    );
    if (!relativePath) throw new Error('Choose a folder in the destination project.');
    const write = await platform().workspace.importSequenceFromContent({
      targetRoot: workspaceRoot,
      relativePath,
      content,
      collisionPolicy: 'refuse',
    });
    if (write.kind !== 'imported') throw new Error(write.error);
    if (write.packageProductPaths.length !== 1)
      throw new Error('The new sequence package was not confirmed.');
    filePath = write.packageProductPaths[0];
    committed = write.committed;
  } else {
    const write = await platform().workspace.importFileFromContent({
      targetRoot: request.destinationPath,
      fileName: internalProductFileName,
      content,
    });
    filePath = write.destPath;
    committed = write.committed;
  }
  if (request.open === false)
    return {
      filePath,
      tabId: null,
      committed,
      ...(completedCreation ? { publication: completedCreation } : {}),
    };
  const sequence = decodeSequenceDocument(content, {
    path: filePath,
    filename: internalProductFileName,
  }).sequence;

  let tabId: string | null;
  try {
    tabId = await openSequenceFile({
      filePath,
      label: name,
      strategy: { kind: 'focused' },
      sourceSurface: 'file_tree',
    });
    if (completedCreation && !tabId)
      throw new Error('The accepted sequence viewer could not be opened.');
  } catch (error) {
    if (completedCreation)
      throw new SequenceCreationPendingError(
        completedCreation.creation,
        completedCreation.accepted,
        error instanceof Error ? error.message : 'The accepted sequence viewer could not be opened.'
      );
    throw error;
  }
  if (tabId && !namespace) {
    const openedTab = Object.values(useCanvasStore.getState().panels)
      .flatMap((panel) => panel.tabs)
      .find((tab) => tab.id === tabId);
    if (openedTab?.type === 'sequence') {
      useSequenceStore.getState().setSequence(openedTab.entityId, sequence);
    }
  }

  return {
    filePath,
    tabId,
    committed,
    ...(completedCreation ? { publication: completedCreation } : {}),
  };
}
