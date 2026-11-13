import {
  SEQUENCE_PACKAGE_HISTORY_SCHEMA,
  sequenceManagedMemberPath,
  type SequencePackageDocument,
  type SequencePackageMember,
  type SequencePackageRevision,
  type SequencePackageRevisionKind,
} from './sequence-package';
import { parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import { listManagedGenBankAnnotations } from '@waypoint/sequence-utils';

export interface PreparedSequencePackageRevision {
  document: SequencePackageDocument;
  snapshots: ReadonlyArray<{ path: string; sha256: string; content: string }>;
  revision: SequencePackageRevision;
}

export class SequencePackageVersionConflict extends Error {
  readonly code = 'SEQUENCE_PACKAGE_VERSION_CONFLICT' as const;
}

export function sequenceReferenceCheckpointId(document: SequencePackageDocument): string | null {
  const revisions = new Map(
    document.versionHistory.revisions.map((revision) => [revision.id, revision])
  );
  let revision = document.versionHistory.headId
    ? revisions.get(document.versionHistory.headId)
    : undefined;
  const visited = new Set<string>();
  while (revision) {
    if (visited.has(revision.id)) throw new Error('Sequence package revision ancestry is cyclic.');
    visited.add(revision.id);
    const parent = revision.parentId ? revisions.get(revision.parentId) : undefined;
    if (revision.parentId && !parent)
      throw new Error('Sequence package revision parent is missing.');
    if (
      !parent ||
      revision.kind === 'assembly-finalization' ||
      (revision.kind === 'restore' &&
        Object.keys(revision.sources ?? {}).some(
          (itemId) => itemId === 'product' || itemId === 'topology' || itemId === 'assembly'
        )) ||
      (revision.state.product.sequenceChecksum && parent.state.product.sequenceChecksum
        ? revision.state.product.sequenceChecksum !== parent.state.product.sequenceChecksum
        : revision.productSnapshot.sha256 !== parent.productSnapshot.sha256) ||
      revision.state.product.topology !== parent.state.product.topology
    )
      return revision.id;
    revision = parent;
  }
  return null;
}

export async function prepareSequencePackageRevision(input: {
  current: SequencePackageDocument | null;
  currentProductContent: string | null;
  next: SequencePackageDocument;
  nextProductContent: string;
  kind: SequencePackageRevisionKind;
  operationId: string;
  requestFingerprint?: string;
  revisionId: string;
  adoptedRevisionId?: string;
  createdAt?: string;
  sources?: SequencePackageRevision['sources'];
  evidenceRunId?: string;
}): Promise<PreparedSequencePackageRevision> {
  const { current, currentProductContent, next } = input;
  if ((current === null) !== (currentProductContent === null)) {
    throw new Error('Current package and product bytes must be supplied together.');
  }
  if (current && current.id !== next.id) {
    throw new Error('A package revision cannot change the stable entity identity.');
  }
  if (!input.operationId || !input.revisionId) {
    throw new Error('A package revision requires operation and revision identities.');
  }
  if ((input.kind === 'sequencing-apply') !== Boolean(input.evidenceRunId)) {
    throw new Error('Sequencing application requires a retained evidence run.');
  }
  const history = current?.versionHistory ?? {
    schema: SEQUENCE_PACKAGE_HISTORY_SCHEMA,
    headId: null,
    revisions: [],
  };
  if (history.revisions.some((revision) => revision.operationId === input.operationId)) {
    throw new SequencePackageVersionConflict(
      `Operation ${input.operationId} has already published a package revision.`
    );
  }
  if (history.revisions.some((revision) => revision.id === input.revisionId)) {
    throw new SequencePackageVersionConflict(
      `Revision ${input.revisionId} already exists in this package.`
    );
  }
  const snapshots: Array<{ path: string; sha256: string; content: string }> = [];
  const revisions = [...history.revisions];
  const createdAt = input.createdAt ?? new Date().toISOString();
  let parentId = history.headId;
  if (current && currentProductContent !== null) {
    const before = await snapshotFor(currentProductContent);
    const head = revisions.find((revision) => revision.id === parentId);
    if (head && head.productSnapshot.sha256 !== before.sha256) {
      throw new SequencePackageVersionConflict(
        'The product bytes no longer match the published package head. Reopen and review the external edit.'
      );
    }
    if (!head) {
      if (parentId !== null || revisions.length !== 0) {
        throw new SequencePackageVersionConflict('The package history has no valid current head.');
      }
      const adoptedId = input.adoptedRevisionId;
      if (!adoptedId || adoptedId === input.revisionId) {
        throw new Error('Adopting a legacy product requires a distinct revision identity.');
      }
      revisions.push({
        id: adoptedId,
        parentId: null,
        operationId: `${input.operationId}:adopted`,
        kind: 'adopted',
        createdAt,
        productSnapshot: { path: before.path, sha256: before.sha256 },
        state: revisionState(current, currentProductContent),
      });
      snapshots.push(before);
      parentId = adoptedId;
    }
  }
  const after = await snapshotFor(input.nextProductContent);
  if (!snapshots.some((snapshot) => snapshot.sha256 === after.sha256)) snapshots.push(after);
  const revision: SequencePackageRevision = {
    id: input.revisionId,
    parentId,
    operationId: input.operationId,
    ...(input.requestFingerprint ? { requestFingerprint: input.requestFingerprint } : {}),
    kind: input.kind,
    createdAt,
    productSnapshot: { path: after.path, sha256: after.sha256 },
    state: revisionState(next, input.nextProductContent),
    ...(input.sources ? { sources: input.sources } : {}),
    ...(input.evidenceRunId ? { evidenceRunId: input.evidenceRunId } : {}),
  };
  revisions.push(revision);
  const members = appendSnapshotMembers(next.members, snapshots, createdAt);
  return {
    document: {
      ...next,
      members,
      versionHistory: {
        schema: SEQUENCE_PACKAGE_HISTORY_SCHEMA,
        headId: revision.id,
        revisions,
      },
    },
    snapshots,
    revision,
  };
}

export async function verifySequencePackageSnapshot(input: {
  revision: SequencePackageRevision;
  content: string;
}): Promise<void> {
  const actual = await snapshotFor(input.content);
  if (
    actual.sha256 !== input.revision.productSnapshot.sha256 ||
    actual.path !== input.revision.productSnapshot.path
  ) {
    throw new Error(`Sequence package revision ${input.revision.id} snapshot integrity failed.`);
  }
}

function revisionState(
  document: SequencePackageDocument,
  productContent: string
): SequencePackageRevision['state'] {
  let geneticCode: SequencePackageRevision['state']['geneticCode'] | undefined;
  let annotationItems: SequencePackageRevision['state']['annotationItems'] | undefined;
  try {
    const parsed = parseSequenceFileAsDocument(productContent, document.product.file).sequence;
    geneticCode = parsed.chosenGeneticCode ?? null;
    annotationItems = listManagedGenBankAnnotations(productContent).map((item) => ({
      id: item.id,
      label: item.name || item.type,
    }));
  } catch {}
  return {
    name: document.name,
    product: structuredClone(document.product),
    ...(geneticCode !== undefined ? { geneticCode } : {}),
    ...(annotationItems !== undefined ? { annotationItems } : {}),
    entity: structuredClone(document.entity),
    acceptedAssembly: document.assembly?.accepted
      ? structuredClone(document.assembly.accepted)
      : null,
    userAttachments: structuredClone(document.userAttachments),
  };
}

function appendSnapshotMembers(
  members: readonly SequencePackageMember[],
  snapshots: ReadonlyArray<{ path: string; sha256: string }>,
  createdAt: string
): SequencePackageMember[] {
  const next = [...members];
  for (const snapshot of snapshots) {
    const existing = next.find((member) => member.path === snapshot.path);
    if (existing) {
      if (existing.role !== 'sequence-snapshot' || existing.replaceable) {
        throw new SequencePackageVersionConflict(
          `Snapshot path ${snapshot.path} belongs to a different package member.`
        );
      }
      continue;
    }
    next.push({
      id: `sequence-snapshot:${snapshot.sha256}`,
      role: 'sequence-snapshot',
      path: snapshot.path,
      replaceable: false,
      createdAt,
      mediaType: 'chemical/x-genbank',
    });
  }
  return next;
}

async function snapshotFor(content: string): Promise<{
  path: string;
  sha256: string;
  content: string;
}> {
  const bytes = new TextEncoder().encode(content);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return {
    path: sequenceManagedMemberPath(`sequence-snapshot-${hex}.gb`),
    sha256: `sha256:${hex}`,
    content,
  };
}
