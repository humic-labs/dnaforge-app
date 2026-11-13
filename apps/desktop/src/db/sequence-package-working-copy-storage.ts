import type { SequenceDesign } from '../features/design/types';
import {
  designContentIdentity,
  DesignArtifactConflictError,
  DesignArtifactRetiredError,
} from '../features/design/design-recovery';
import { platform } from '../platform';
import { findContainingPathBoundary } from '../shared/path-boundary';
import { withRendererWorkspaceMutation } from '../services/workspace-mutation-transaction';
import { useWorkspaceStore } from '../stores/workspaceStore';
import {
  parseSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
  type SequencePackageDocument,
} from './sequence-package';
import {
  ASSEMBLY_WORKING_COPY_RELATIVE_PATH,
  sequenceAssemblyWorkingCopyMember,
  sequenceAssemblyWorkingCopyPath,
  withSequenceAssemblyWorkingCopy,
  withoutSequenceAssemblyWorkingCopy,
} from './sequence-package-working-copy';
import { getCurrentCatalogFileForEntity } from './workspace-catalog';
import type { WorkspaceArtifactResult } from './workspace-artifacts';

export interface PackageAssemblyWorkingCopy {
  packageRoot: string;
  path: string;
  design: SequenceDesign;
  published: boolean;
}

function workspaceRootFor(packageRoot: string): string {
  const root = findContainingPathBoundary(
    useWorkspaceStore.getState().folders.filter((folder) => !folder.pinned),
    packageRoot
  )?.path;
  if (!root) throw new Error('The sequence package is not inside an open writable project.');
  return root;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseWorkingCopy(raw: string, packageId: string, draftId: string): SequenceDesign {
  const parsed = JSON.parse(raw) as unknown;
  const artifact = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const design = artifact.design as SequenceDesign | null;
  if (
    artifact.schema !== 'waypoint.design.v1' ||
    artifact.kind !== 'assembly-design' ||
    artifact.id !== draftId ||
    !design ||
    design.id !== draftId ||
    design.constructId !== packageId ||
    !design.parentAcceptedAssemblyVersionId
  ) {
    throw new Error(`Package assembly working copy ${draftId} has inconsistent identity.`);
  }
  return design;
}

function acceptedProductWasPublishedFrom(
  document: SequencePackageDocument,
  draftId: string
): boolean {
  const accepted = document.assembly?.accepted;
  return accepted?.designId === draftId;
}

async function readPackageMarker(packageRoot: string): Promise<{
  document: SequencePackageDocument;
  raw: string;
  metaPath: string;
}> {
  const metaPath = sequencePackagePaths(packageRoot).metaPath;
  const raw = await platform().fs.readTextFile(metaPath);
  return { document: parseSequencePackageDocument(raw), raw, metaPath };
}

export async function readPackageAssemblyWorkingCopy(
  packageRoot: string
): Promise<PackageAssemblyWorkingCopy | null> {
  const { document } = await readPackageMarker(packageRoot);
  const member = sequenceAssemblyWorkingCopyMember(document);
  if (!member) return null;
  const path = sequenceAssemblyWorkingCopyPath(packageRoot, member);
  const raw = await platform().fs.readTextFile(path);
  return {
    packageRoot,
    path,
    design: parseWorkingCopy(raw, document.id, member.id),
    published: acceptedProductWasPublishedFrom(document, member.id),
  };
}

export async function createPackageAssemblyWorkingCopy(input: {
  packageRoot: string;
  packageId: string;
  design: SequenceDesign;
  mutationToken?: string;
}): Promise<{ copy: PackageAssemblyWorkingCopy; created: boolean }> {
  const workspaceRoot = workspaceRootFor(input.packageRoot);
  const { document, raw, metaPath } = await readPackageMarker(input.packageRoot);
  if (document.id !== input.packageId || input.design.constructId !== document.id) {
    throw new Error('Assembly working-copy package identity changed.');
  }
  const member = sequenceAssemblyWorkingCopyMember(document);
  if (member) {
    const path = sequenceAssemblyWorkingCopyPath(input.packageRoot, member);
    const saved = parseWorkingCopy(await platform().fs.readTextFile(path), document.id, member.id);
    if (saved.parentAcceptedAssemblyVersionId !== input.design.parentAcceptedAssemblyVersionId) {
      throw new Error(
        'An unfinished assembly from another accepted version already belongs to this package.'
      );
    }
    return {
      copy: {
        packageRoot: input.packageRoot,
        path,
        design: saved,
        published: acceptedProductWasPublishedFrom(document, member.id),
      },
      created: false,
    };
  }

  const path = `${input.packageRoot}/${ASSEMBLY_WORKING_COPY_RELATIVE_PATH}`;
  if (await platform().fs.exists(path)) {
    throw new Error(
      `Unregistered assembly working copy exists at ${path}. It will not be overwritten.`
    );
  }
  const createdAt = new Date().toISOString();
  const artifact = `${JSON.stringify(
    {
      schema: 'waypoint.design.v1',
      kind: 'assembly-design',
      id: input.design.id,
      name: input.design.name,
      storage: { type: 'sequence-package-member', packageId: document.id },
      design: input.design,
      createdAt,
    },
    null,
    2
  )}\n`;
  await platform().fs.mkdir(
    sequencePackagePaths(input.packageRoot).contentsDir,
    {
      recursive: true,
    },
    input.mutationToken
  );
  await platform().fs.writeWorkspaceTextFileAtomic({
    workspaceRoot,
    path,
    content: artifact,
    mode: 'create',
    artifactNoun: 'assembly working copy',
    mutationToken: input.mutationToken,
  });
  const next = withSequenceAssemblyWorkingCopy(document, input.design.id, createdAt);
  await platform().fs.writeWorkspaceTextFileAtomic({
    workspaceRoot,
    path: metaPath,
    content: serializeSequencePackageDocument(next),
    mode: 'replace',
    expectedContentHash: await sha256Text(raw),
    artifactNoun: 'sequence package',
    mutationToken: input.mutationToken,
  });
  return {
    copy: { packageRoot: input.packageRoot, path, design: input.design, published: false },
    created: true,
  };
}

export async function writePackageAssemblyWorkingCopySnapshot(input: {
  designId: string;
  name: string;
  design: SequenceDesign | null;
  recovery?: { base: string | null; attempted?: string; beforeWrite: () => void };
}): Promise<WorkspaceArtifactResult | null> {
  const constructId = input.design?.constructId;
  if (!constructId) return null;
  const binding = await getCurrentCatalogFileForEntity(constructId);
  if (!binding || binding.file_kind !== 'waypoint-sequence') return null;
  const packageRoot = binding.path;
  const workspaceRoot = workspaceRootFor(packageRoot);
  return withRendererWorkspaceMutation(workspaceRoot, async (mutationToken) => {
    const current = await getCurrentCatalogFileForEntity(constructId);
    if (!current || current.path !== packageRoot || current.file_kind !== 'waypoint-sequence') {
      throw new DesignArtifactRetiredError();
    }
    const { document } = await readPackageMarker(packageRoot);
    if (document.id !== constructId) throw new DesignArtifactRetiredError();
    const member = sequenceAssemblyWorkingCopyMember(document);
    if (!member || member.id !== input.designId) return null;
    if (acceptedProductWasPublishedFrom(document, member.id)) {
      throw new DesignArtifactRetiredError();
    }
    const path = sequenceAssemblyWorkingCopyPath(packageRoot, member);
    const raw = await platform().fs.readTextFile(path);
    const diskDesign = parseWorkingCopy(raw, constructId, input.designId);
    const diskRevision = designContentIdentity(diskDesign);
    const revision = designContentIdentity(input.design);
    if (
      input.recovery &&
      diskRevision !== revision &&
      diskRevision !== input.recovery.base &&
      diskRevision !== input.recovery.attempted
    ) {
      throw new DesignArtifactConflictError(diskDesign);
    }
    let savedRaw = raw;
    if (diskRevision !== revision || diskDesign.name !== input.name) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const next = `${JSON.stringify(
        { ...parsed, name: input.name, design: input.design, updatedAt: new Date().toISOString() },
        null,
        2
      )}\n`;
      input.recovery?.beforeWrite();
      await platform().fs.writeWorkspaceTextFileAtomic({
        workspaceRoot,
        path,
        content: next,
        mode: 'replace',
        expectedContentHash: await sha256Text(raw),
        artifactNoun: 'assembly working copy',
        mutationToken,
      });
      savedRaw = next;
    }
    return {
      path,
      name: path.split('/').pop() ?? path,
      fileKind: 'waypoint-design',
      sizeBytes: new TextEncoder().encode(savedRaw).byteLength,
    };
  });
}

export async function consumePackageAssemblyWorkingCopy(input: {
  packageRoot: string;
  packageId: string;
  designId: string;
  mutationToken?: string;
}): Promise<string | null> {
  const { document, raw, metaPath } = await readPackageMarker(input.packageRoot);
  if (document.id !== input.packageId) throw new Error('Assembly package identity changed.');
  const member = sequenceAssemblyWorkingCopyMember(document);
  if (!member) return null;
  if (member.id !== input.designId || !acceptedProductWasPublishedFrom(document, member.id)) {
    throw new Error('The accepted product does not consume this assembly working copy.');
  }
  const path = sequenceAssemblyWorkingCopyPath(input.packageRoot, member);
  parseWorkingCopy(await platform().fs.readTextFile(path), document.id, member.id);
  await platform().fs.writeWorkspaceTextFileAtomic({
    workspaceRoot: workspaceRootFor(input.packageRoot),
    path: metaPath,
    content: serializeSequencePackageDocument(
      withoutSequenceAssemblyWorkingCopy(document, member.id)
    ),
    mode: 'replace',
    expectedContentHash: await sha256Text(raw),
    artifactNoun: 'sequence package',
    mutationToken: input.mutationToken,
  });
  await platform().shell.trashItem(path, input.mutationToken);
  return path;
}
