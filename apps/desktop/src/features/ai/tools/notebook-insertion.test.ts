import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMolecularDocument } from '../../../shared/molecular-document';
import { molecularDocumentReferenceFromHref } from '../../../shared/molecular-document-reference';
import legacyDocument from '../../../test/fixtures/molecular-document-v1.json';
import { prepareNotebookInsertion } from './notebook-insertion';
import { createWorkspaceFilesTool } from './workspace-files';
import { execTool } from './test-helpers';

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  read: vi.fn(),
  project: vi.fn(),
  embed: vi.fn(),
}));
vi.mock('../../../platform', () => ({
  platform: () => ({
    molecularDocuments: { read: mocks.read },
    shell: { fileTrash: async () => ({ kind: 'inspect', source: await mocks.inspect() }) },
    fs: {
      validateWorkspacePath: async () => true,
      contentHash: async () => `sha256:${'c'.repeat(64)}`,
      stat: async () => ({
        isFile: true,
        canonicalPath: '/project/saved.dnaforge-molecular.json',
        size: 200,
      }),
    },
  }),
}));
vi.mock('../../../db/workspace-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../db/workspace-catalog')>()),
  resolveWorkspaceScope: mocks.project,
}));
vi.mock('../../../db/catalog-reference-search', () => ({
  searchMountedCatalogEntitiesByName: vi.fn(),
}));
vi.mock('../../../db/primer-reference-search', () => ({ searchPrimerReferencesByName: vi.fn() }));
vi.mock('../../page/public/embed-insertion', () => ({
  embedRegistry: { get: mocks.embed },
  IMAGE_CONSTANTS: { MAX_FILE_SIZE: 50_000_000 },
}));

describe('saved molecular documents inserted as inspected notebook files', () => {
  const source = {
    kind: 'file' as const,
    path: '/project/saved.dnaforge-molecular.json',
    expectedRevision: 'inspected-file',
  };
  const fileHash = 'c'.repeat(64);
  const document = parseMolecularDocument(JSON.stringify(legacyDocument));
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inspect.mockResolvedValue({
      path: 'saved.dnaforge-molecular.json',
      type: 'file',
      size: 200,
      revision: source.expectedRevision,
      contentHash: `sha256:${fileHash}`,
    });
    mocks.read.mockResolvedValue({ document, revision: fileHash });
    mocks.project.mockResolvedValue('project-a');
  });

  it('accepts the actual workspace-files inspection to create an exact native document chip', async () => {
    const inspected = await execTool<{ ok: true; revision: string; canTrash: boolean }>(
      createWorkspaceFilesTool([{ path: '/project', name: 'Project', addedAt: 0 }]),
      { operation: { kind: 'inspect', path: source.path } }
    );
    expect(inspected).toMatchObject({ ok: true, revision: source.expectedRevision, canTrash: true });
    const prepared = await prepareNotebookInsertion('/project', {
      ...source,
      expectedRevision: inspected.revision,
    });
    expect(prepared.block.type).toBe('paragraph');
    const chip = prepared.block.content![0];
    expect(chip.type).toBe('mention');
    expect(molecularDocumentReferenceFromHref(chip.attrs!.referenceUri)).toMatchObject({
      projectId: 'project-a',
      documentId: document.id,
      revisionId: document.currentReferenceId,
    });
    expect(chip.attrs!.label).toBe(document.history.at(-1)!.snapshot.title);
    expect(mocks.embed).not.toHaveBeenCalled();
    await prepared.verify();
  });

  it('refuses a document that changed since its file inspection', async () => {
    mocks.read.mockResolvedValue({ document, revision: 'd'.repeat(64) });
    await expect(prepareNotebookInsertion('/project', source)).rejects.toThrow('changed');
  });

  it('refuses a changed source before committing the insertion', async () => {
    const prepared = await prepareNotebookInsertion('/project', source);
    mocks.inspect.mockResolvedValue({
      type: 'file',
      revision: 'changed',
      contentHash: 'd'.repeat(64),
    });
    await expect(prepared.verify()).rejects.toThrow('changed');
  });

  it('refuses missing project identity instead of inventing a file reference', async () => {
    mocks.project.mockResolvedValue(null);
    await expect(prepareNotebookInsertion('/project', source)).rejects.toThrow('project identity');
  });
});
