import type Database from 'better-sqlite3';
import { basename, extname } from 'node:path';

export function projectAcceptedSequenceIdentityInsideTx(
  db: Database.Database,
  input: {
    workspaceId: number;
    documentId: string;
    path: string;
    name: string;
    length: number;
    circular: boolean;
  }
): number {
  if (!db.inTransaction) throw new Error('Sequence identity projection requires a transaction.');
  const sequence = db
    .prepare('SELECT id,file_id FROM sequences WHERE document_id=?')
    .get(input.documentId) as { id: number; file_id: number } | undefined;
  const file = db
    .prepare('SELECT id,workspace_id FROM indexed_files WHERE path=?')
    .get(input.path) as { id: number; workspace_id: number } | undefined;
  if (file && file.workspace_id !== input.workspaceId)
    throw new Error('Accepted sequence file index belongs to another workspace.');
  let fileId = file?.id;
  if (!fileId && sequence) {
    const owned = db
      .prepare('SELECT workspace_id FROM indexed_files WHERE id=?')
      .get(sequence.file_id) as { workspace_id: number } | undefined;
    if (!owned || owned.workspace_id !== input.workspaceId)
      throw new Error('Accepted sequence identity belongs to another workspace.');
    fileId = sequence.file_id;
    db.prepare('UPDATE indexed_files SET path=?,name=?,extension=? WHERE id=?').run(
      input.path,
      basename(input.path),
      extname(input.path).slice(1),
      fileId
    );
  }
  if (!fileId)
    fileId = Number(
      db
        .prepare(
          `INSERT INTO indexed_files
      (workspace_id,path,name,extension,indexed_at) VALUES (?,?,?,?,?)`
        )
        .run(
          input.workspaceId,
          input.path,
          basename(input.path),
          extname(input.path).slice(1),
          Date.now()
        ).lastInsertRowid
    );
  const legacy = !sequence
    ? (db
        .prepare(
          `SELECT id FROM sequences WHERE file_id=?
    AND document_id LIKE 'legacy-sequence:%' ORDER BY id LIMIT 1`
        )
        .get(fileId) as { id: number } | undefined)
    : undefined;
  if (sequence || legacy) {
    const id = sequence?.id ?? legacy!.id;
    db.prepare(
      'UPDATE sequences SET file_id=?,document_id=?,name=?,length=?,circular=? WHERE id=?'
    ).run(fileId, input.documentId, input.name, input.length, Number(input.circular), id);
    return id;
  }
  return Number(
    db
      .prepare(
        `INSERT INTO sequences (file_id,document_id,name,length,circular)
    VALUES (?,?,?,?,?)`
      )
      .run(fileId, input.documentId, input.name, input.length, Number(input.circular))
      .lastInsertRowid
  );
}
