import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  molecularDocumentReferenceFor,
  molecularDocumentReferenceHref,
} from '../../shared/molecular-document-reference';
import type { MolecularDocument } from '../../shared/molecular-document';
import type { MolecularView } from '../../shared/molecular-view';

const mocks = vi.hoisted(() => ({
  files: vi.fn(),
  read: vi.fn(),
  getReference: vi.fn(),
  root: vi.fn(),
  scope: vi.fn(),
}));
vi.mock('../../platform', () => ({
  platform: () => ({ molecularDocuments: { read: mocks.read } }),
}));
vi.mock('../../db/workspace-catalog', () => ({
  getCurrentMolecularDocumentFiles: mocks.files,
  getWorkspaceRootById: mocks.root,
  getWorkspaceRootByScope: vi.fn(),
  resolveWorkspaceScope: mocks.scope,
}));
vi.mock('../../db/entity-references', () => ({ getEntityReference: mocks.getReference }));
import {
  molecularDocumentReferenceForFile,
  resolveMolecularDocumentReference,
  recoverMolecularDocumentRevision,
  resolveMolecularReferenceRecord,
} from './references';

const projectId = 'project-a',
  otherProject = 'project-b';
const documentId = 'b6888cec-80bd-4133-9530-0744c7977cda',
  revisionId = 'a92a4446-d52d-48d2-9ee4-7abbd7e9b9cd';
const snapshot: MolecularView = {
  kind: 'molecular-view',
  version: 1,
  title: 'Protein data view',
  caption: '',
  scene: JSON.stringify({ root: { kind: 'root' }, metadata: { key: 'native-view' } }),
  coordinates: { format: 'pdb', text: 'ATOM source', sha256: 'a'.repeat(64) },
  source: {},
  evidence: [],
  preview: 'data:image/png;base64,AAAA',
  createdAt: 1,
};
const document: MolecularDocument = {
  schema: 'dnaforge.molecular-document.v2',
  id: documentId,
  name: 'Protein view',
  currentReferenceId: revisionId,
  history: [{ referenceId: revisionId, snapshot }],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.files.mockImplementation(async (scope?: string) =>
    [
      {
        entity_id: `${projectId}::${documentId}`,
        workspace_id: 1,
        path: '/project/moved.dnaforge-molecular.json',
      },
      {
        entity_id: `${otherProject}::${documentId}`,
        workspace_id: 2,
        path: '/copy/view.dnaforge-molecular.json',
      },
    ].filter((file) => !scope || file.entity_id.startsWith(scope + '::'))
  );
  mocks.root.mockImplementation(async (id: number) => (id === 1 ? '/project' : '/copy'));
  mocks.scope.mockImplementation(async (root: string) =>
    root === '/project' ? projectId : otherProject
  );
  mocks.read.mockImplementation(async ({ path, workspaceRoot }) => ({
    path,
    workspaceRoot,
    revision: 'b'.repeat(64),
    document: structuredClone(document),
  }));
  mocks.getReference.mockResolvedValue(null);
});
describe('file-owned molecular document reference resolution', () => {
  it('derives inserted references through the owning project and refuses a missing identity', async () => {
    await expect(molecularDocumentReferenceForFile('/project', document)).resolves.toEqual(
      await molecularDocumentReferenceFor(projectId, document)
    );
    mocks.scope.mockResolvedValueOnce(null);
    await expect(molecularDocumentReferenceForFile('/missing', document)).rejects.toThrow(
      'project identity is unavailable'
    );
  });
  it('opens a moved file by scoped identity and verifies exact revision bytes without a snapshot cache', async () => {
    const reference = await molecularDocumentReferenceFor(
      projectId,
      document,
      revisionId,
      'native-view'
    );
    const resolved = await resolveMolecularDocumentReference(reference);
    expect(resolved.saved.path).toContain('moved.dnaforge-molecular.json');
    expect(resolved.snapshot).toEqual(snapshot);
    expect(mocks.getReference).not.toHaveBeenCalled();
    expect(
      await resolveMolecularReferenceRecord(
        molecularDocumentReferenceHref(reference),
        'Pinned view'
      )
    ).toMatchObject({ entity_type: 'molecular-document', data: JSON.stringify(reference) });
  });
  it('recovers old notebook UUID aliases from its owning project and rejects ownerless ambiguity', async () => {
    const resolved = await recoverMolecularDocumentRevision(
      revisionId,
      projectId + '::notebook-id'
    );
    expect(resolved?.documentReference.projectId).toBe(projectId);
    await expect(recoverMolecularDocumentRevision(revisionId)).rejects.toThrow(/ambiguous/);
  });
  it('rejects changed content, wrong document IDs and missing named views', async () => {
    const reference = await molecularDocumentReferenceFor(projectId, document);
    await expect(
      resolveMolecularDocumentReference({ ...reference, revisionSha256: '0'.repeat(64) })
    ).rejects.toThrow(/exact referenced content/);
    await expect(
      resolveMolecularDocumentReference({ ...reference, viewId: 'missing' })
    ).rejects.toThrow(/missing or ambiguous/);
    mocks.read.mockResolvedValue({ document: { ...document, id: crypto.randomUUID() } });
    await expect(resolveMolecularDocumentReference(reference)).rejects.toThrow(
      /different document identity/
    );
  });
});
