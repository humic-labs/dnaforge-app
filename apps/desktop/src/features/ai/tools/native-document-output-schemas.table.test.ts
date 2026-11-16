import { describe, expect, it } from 'vitest';
import { nativeFileDocumentOutputSchema } from './native-document-output-schemas';

const digest = 'a'.repeat(64);
const value = () => ({ ok: true, documentId: 'file-routing-identity', path: '/project/Samples/.forge/table.json', workspaceRoot: '/project',
  type: 'table', kind: 'table', owner: { kind: 'table', runtime: 'native' }, revision: 'owner:1', persistedRevision: 'owner:1',
  ready: true, readOnly: false, dirty: false, saving: false, canUndo: false, canRedo: false, capabilities: ['inspect', 'table', 'save'],
  tableDocument: { id: '8b42f5f1-635e-4cda-a07b-8fc2531fc97e', snapshotSha256: digest, persistedSnapshotSha256: digest, status: 'active' } });

describe('native table output contract', () => {
  it('accepts the bounded native ordinary-table identity and saved-version metadata', () => {
    expect(nativeFileDocumentOutputSchema.safeParse(value()).success).toBe(true);
  });
  it('rejects malformed portable identities and saved digests', () => {
    expect(nativeFileDocumentOutputSchema.safeParse({ ...value(), tableDocument: { ...value().tableDocument, id: 'ws7-profile-id' } }).success).toBe(false);
    expect(nativeFileDocumentOutputSchema.safeParse({ ...value(), tableDocument: { ...value().tableDocument, persistedSnapshotSha256: '../bad' } }).success).toBe(false);
  });
  it('keeps complete private head and history contents out of the bounded tool result', () => {
    expect(nativeFileDocumentOutputSchema.safeParse({ ...value(), content: '{"private":"whole-table-history"}' }).success).toBe(false);
  });
  it('includes rich tables in native dirty-document inventory', () => {
    expect(nativeFileDocumentOutputSchema.safeParse({ ok: true, documents: [{ documentId: 'file-routing-identity', target: { documentId: 'file-routing-identity' },
      path: value().path, workspaceRoot: '/project', kind: 'table', revision: 'owner:1', readOnly: false, dirty: true, saving: false, recovery: false, inspectionRequired: false }], nextCursor: null }).success).toBe(true);
  });
});
