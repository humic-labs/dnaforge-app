import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  MOLECULAR_DOCUMENT_SCHEMA,
  MOLECULAR_DOCUMENT_SUFFIX,
  molecularDocumentSchema,
  parseMolecularDocument,
  serializeMolecularDocument,
  validateMolecularDocumentCoordinates,
  type MolecularDocumentLocation,
  type SaveMolecularDocumentRequest,
  type SavedMolecularDocument,
} from '../shared/molecular-document';
import { assertMolecularDocumentSize } from '../shared/molecular-storage';
import { supportsMolecularDocumentExtension } from '../shared/molecular-document-extensions';
import {
  canonicalWorkspacePath,
  writeWorkspaceTextFileAtomicInMain,
} from './primer-artifact-files';
import { withWorkspaceMutation } from './workspace-sync-mutation-lease';

const locationSchema = z
  .object({ path: z.string().min(1), workspaceRoot: z.string().min(1) })
  .strict();
const saveSchema = z
  .object({
    document: molecularDocumentSchema,
    destination: locationSchema,
    expectedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
  })
  .strict();

async function preservePreUpgradeFile(
  destination: MolecularDocumentLocation,
  expectedRevision: string
): Promise<void> {
  const { candidate } = await canonicalWorkspacePath({
    ...destination,
    allowMissing: false,
    artifactNoun: 'molecular document',
  });
  const bytes = await readFile(candidate, 'utf8');
  if (createHash('sha256').update(bytes).digest('hex') !== expectedRevision)
    throw Error('The molecular document changed before its upgrade. Reload it before saving.');
  if (JSON.parse(bytes).schema === MOLECULAR_DOCUMENT_SCHEMA) return;
  const path = join(
    dirname(destination.path),
    `.${basename(destination.path)}.before-${expectedRevision}`
  );
  try {
    const existing = await canonicalWorkspacePath({
      ...destination,
      path,
      allowMissing: false,
      artifactNoun: 'molecular document upgrade backup',
    });
    if (!(await lstat(existing.candidate)).isFile())
      throw Error('The molecular document upgrade backup is not a regular file.');
    if ((await readFile(existing.candidate, 'utf8')) !== bytes)
      throw Error('The molecular document upgrade backup differs from its original.');
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeWorkspaceTextFileAtomicInMain(
    {
      workspaceRoot: destination.workspaceRoot,
      path,
      content: bytes,
      artifactNoun: 'molecular document upgrade backup',
      mode: 'create',
    },
    { durable: true }
  );
}

export async function readMolecularDocumentFile(
  input: MolecularDocumentLocation
): Promise<SavedMolecularDocument> {
  const location = locationSchema.parse(input);
  if (!location.path.endsWith(MOLECULAR_DOCUMENT_SUFFIX))
    throw new Error('This file is not a molecular document.');
  const { candidate } = await canonicalWorkspacePath({
    ...location,
    allowMissing: false,
    artifactNoun: 'molecular document',
  });
  const stat = await lstat(candidate);
  if (!stat.isFile()) throw new Error('The molecular document is not a regular file.');
  assertMolecularDocumentSize(stat.size);
  const bytes = await readFile(candidate, 'utf8');
  const document = parseMolecularDocument(bytes);
  await validateMolecularDocumentCoordinates(document);
  return { ...location, document, revision: createHash('sha256').update(bytes).digest('hex') };
}

export class MolecularDocumentLibrary {
  async read(input: MolecularDocumentLocation): Promise<SavedMolecularDocument> {
    const location = locationSchema.parse(input);
    return withWorkspaceMutation(location.workspaceRoot, () => readMolecularDocumentFile(location));
  }

  async save(input: SaveMolecularDocumentRequest): Promise<SavedMolecularDocument> {
    const request = saveSchema.parse(input);
    const { document, destination, expectedRevision } = request;
    if (!destination.path.endsWith(MOLECULAR_DOCUMENT_SUFFIX))
      throw new Error('Choose a molecular document destination.');
    await validateMolecularDocumentCoordinates(document);
    const content = serializeMolecularDocument(document);
    return withWorkspaceMutation(destination.workspaceRoot, async () => {
      if (expectedRevision !== null) {
        const previous = await readMolecularDocumentFile(destination);
        if (previous.revision !== expectedRevision)
          throw new Error(
            'The molecular document changed since it was opened. Reload it before saving.'
          );
        if (previous.document.id !== document.id)
          throw new Error('This file belongs to another molecular document identity.');
        const nextResults = new Map(
          document.history.map((entry) => [entry.referenceId, entry.snapshot])
        );
        for (const entry of previous.document.history) {
          if (!isDeepStrictEqual(nextResults.get(entry.referenceId), entry.snapshot))
            throw new Error('Saved molecular result history cannot be removed or rewritten.');
        }
        const nextSelections = new Map(
          (document.selections ?? []).map((selection) => [selection.id, selection])
        );
        for (const selection of previous.document.selections ?? []) {
          const next = nextSelections.get(selection.id);
          if (!next)
            throw new Error('Saved selections cannot be removed from a molecular document.');
          for (const [index, revision] of selection.revisions.entries())
            if (JSON.stringify(next.revisions[index]) !== JSON.stringify(revision))
              throw new Error('Saved selection revision history cannot be rewritten.');
        }
        for (const [name, extension] of Object.entries(previous.document.extensions ?? {})) {
          if (
            !supportsMolecularDocumentExtension(name, extension.version) &&
            !isDeepStrictEqual(document.extensions?.[name], extension)
          )
            throw Error(`The unsupported extension ${name} must be preserved without changes.`);
        }
        await preservePreUpgradeFile(destination, expectedRevision);
      }
      const result = await writeWorkspaceTextFileAtomicInMain(
        {
          workspaceRoot: destination.workspaceRoot,
          path: destination.path,
          content,
          artifactNoun: 'molecular document',
          mode: expectedRevision === null ? 'create' : 'replace',
          ...(expectedRevision === null ? {} : { expectedContentHash: expectedRevision }),
        },
        { durable: true }
      );
      return {
        ...destination,
        document,
        revision: result.contentHash,
        ...(result.cleanupWarning ? { warning: result.cleanupWarning } : {}),
      };
    });
  }
}
