import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';
import { isBinarySequencePath, parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import type { PrimerArtifactV1 } from '../shared/primers/primer-artifact';
import type { ResolvedPrimerArtifactBinding } from '../shared/primers/primer-artifact-projection';
import { readFileBoundedFromHandle } from './ipc/bounded-file-read';
import { createNativeSequenceDocumentResolver } from './native-sequence-document-resolver';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';

interface Context {
  db: Database.Database;
  runDatabase: <T>(work: () => T) => T;
}
interface IndexedTarget {
  id: number;
  documentId: string;
  path: string;
  workspaceId: number;
  length: number;
  circular: number;
}
export interface CheckedPrimerBinding extends ResolvedPrimerArtifactBinding {
  indexed: IndexedTarget;
}

function indexedTarget(db: Database.Database, documentId: string): IndexedTarget | undefined {
  const rows = db
    .prepare(
      `SELECT s.id,s.document_id AS documentId,f.path,
      f.workspace_id AS workspaceId,s.length,s.circular
    FROM sequences s JOIN indexed_files f ON f.id=s.file_id WHERE s.document_id=?`
    )
    .all(documentId) as IndexedTarget[];
  return rows.length === 1 ? rows[0] : undefined;
}

export async function readPrimerArtifactBindings(
  input: Context & {
    artifact: PrimerArtifactV1;
    workspaceId: number;
    workspacePath: string;
    operationId: string;
  }
): Promise<CheckedPrimerBinding[]> {
  const resolve = createNativeSequenceDocumentResolver({
    db: () => input.db,
    workspaceRoots: () => [input.workspacePath],
  });
  const checked: CheckedPrimerBinding[] = [];
  for (const binding of input.artifact.bindings) {
    if (!binding.target.documentId)
      throw new Error(
        'The primer binding needs its stable sequence document identity before publication.'
      );
    const indexed = input.runDatabase(() => indexedTarget(input.db, binding.target.documentId));
    if (!indexed || indexed.workspaceId !== input.workspaceId)
      throw new Error(
        'The primer binding target is not indexed in its owning project; restore it and retry.'
      );
    const document = await resolve({
      operationId: input.operationId,
      targetDocumentId: binding.target.documentId,
    });
    if (
      document.documentId !== binding.target.documentId ||
      workspaceMutationRootIdentity(document.workspaceRoot) !==
        workspaceMutationRootIdentity(input.workspacePath) ||
      workspaceMutationRootIdentity(document.sourcePath) !==
        workspaceMutationRootIdentity(indexed.path)
    ) {
      throw new Error(
        'The primer binding target ownership or locator changed; review it before retrying.'
      );
    }
    const bytes = Buffer.from(await readFileBoundedFromHandle(document.sourcePath, HARD_CAP_BYTES));
    const source = isBinarySequencePath(document.sourcePath) ? bytes : bytes.toString('utf8');
    const parsed = parseSequenceFileAsDocument(source, document.sourcePath).sequence;
    const digest = (value: string | Buffer) =>
      `sha256:${createHash('sha256').update(value).digest('hex')}`;
    const topology = parsed.circular ? 'circular' : 'linear';
    if (
      binding.target.fileContentHash !== digest(source) ||
      binding.target.normalizedSequenceHash !== digest(parsed.sequence.toUpperCase()) ||
      binding.target.length !== parsed.length ||
      binding.target.topology !== topology ||
      indexed.length !== parsed.length ||
      Boolean(indexed.circular) !== parsed.circular
    ) {
      throw new Error('Primer target has changed; review the binding before publication.');
    }
    input.runDatabase(() => {
      if (!isDeepStrictEqual(indexedTarget(input.db, binding.target.documentId), indexed))
        throw new Error('The primer binding target changed while its saved bytes were read.');
    });
    checked.push({ binding, sequenceId: indexed.id, indexed });
  }
  return checked;
}

export function assertPrimerBindingIdentitiesCurrent(
  db: Database.Database,
  bindings: readonly CheckedPrimerBinding[]
): void {
  for (const binding of bindings) {
    if (!isDeepStrictEqual(indexedTarget(db, binding.indexed.documentId), binding.indexed))
      throw new Error('The primer binding identity changed before its projection could settle.');
  }
}
