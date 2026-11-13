import type {
  WorkspaceSessionAdapter,
  WorkspaceSessionController,
} from '@waypoint/domain-services';
import {
  parseSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
} from '../db/sequence-package';
import { copySequencePackageDocument } from '../db/sequence-package-copy';
import { hostedDurableSync, hostedWorkspaceSessionController } from './controller';
import { hostedAbsolutePath, parseHostedFsPath } from './paths';

type CopyPort = Pick<WorkspaceSessionController, 'getState' | 'commit'> &
  Pick<WorkspaceSessionAdapter, 'readFile'>;

export async function duplicateHostedSequencePackage(
  absoluteRoot: string,
  port: CopyPort = {
    getState: hostedWorkspaceSessionController.getState,
    commit: hostedWorkspaceSessionController.commit.bind(hostedWorkspaceSessionController),
    readFile: hostedDurableSync.runtime.readFile.bind(hostedDurableSync.runtime),
  }
): Promise<string> {
  const parsed = parseHostedFsPath(absoluteRoot);
  const initial = port.getState();
  const snapshot = initial.snapshot;
  const actorId = initial.principal?.id;
  if (
    !parsed?.workspaceId ||
    !parsed.relativePath ||
    initial.activeWorkspaceId !== parsed.workspaceId ||
    snapshot?.workspaceId !== parsed.workspaceId ||
    !actorId
  ) {
    throw new Error('The sequence package is not in the active signed-in project.');
  }
  const root = parsed.relativePath;
  const paths = sequencePackagePaths(root);
  const sources = snapshot.files.filter((file) => file.path.startsWith(`${root}/`));
  const marker = sources.find((file) => file.path === paths.metaPath);
  if (!marker) throw new Error('The sequence package marker is missing. No copy was created.');
  const frozen = await Promise.all(
    sources.map(async (file) => ({
      file,
      bytes: new Uint8Array(await port.readFile({ snapshot, file })),
    }))
  );
  const original = parseSequencePackageDocument(
    new TextDecoder('utf-8', { fatal: true }).decode(
      frozen.find((entry) => entry.file === marker)!.bytes
    )
  );
  for (const memberPath of [
    original.product.file,
    ...original.members.map((member) => member.path),
  ]) {
    if (!sources.some((file) => file.path === `${root}/${memberPath}`)) {
      throw new Error(`Sequence package is missing ${memberPath}. No copy was created.`);
    }
  }
  const current = port.getState();
  if (
    current.principal?.id !== actorId ||
    current.activeWorkspaceId !== parsed.workspaceId ||
    current.snapshot?.workspaceId !== snapshot.workspaceId ||
    current.snapshot.revisionId !== snapshot.revisionId ||
    current.snapshot.localRevisionId !== snapshot.localRevisionId
  ) {
    throw new Error(
      'The project, account, or saved capture changed while copying. No copy was created.'
    );
  }
  const baseName = root.slice(root.lastIndexOf('/') + 1);
  const parent = root.slice(0, root.lastIndexOf('/') + 1);
  for (let number = 1; number <= 10_000; number += 1) {
    const suffix = number === 1 ? ' copy' : ` copy ${number}`;
    const destination = `${parent}${baseName}${suffix}`;
    const folded = destination.toLocaleLowerCase('en-US');
    if (
      current.snapshot.files.some((file) => {
        const path = file.path.toLocaleLowerCase('en-US');
        return path === folded || path.startsWith(`${folded}/`) || folded.startsWith(`${path}/`);
      })
    )
      continue;
    const document = copySequencePackageDocument(original, `${original.name}${suffix}`);
    const writes = frozen.map(({ file, bytes }) => ({
      path: `${destination}${file.path.slice(root.length)}`,
      bytes:
        file === marker
          ? new TextEncoder().encode(serializeSequencePackageDocument(document))
          : bytes,
      contentType: file.contentType,
      resourceId: crypto.randomUUID(),
    }));
    await port.commit(writes);
    return hostedAbsolutePath(parsed.workspaceId, destination);
  }
  throw new Error('Could not find an available sequence copy name.');
}
