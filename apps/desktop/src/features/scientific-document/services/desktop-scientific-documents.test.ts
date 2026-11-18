import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseScientificDocumentIdentity,
  parseWorkspaceIdentity,
  type ScientificAcceptedDocumentRevision,
} from '@waypoint/domain-services';
import { setRememberedDeveloperImportSourceRootsForRenderer } from '../../../shared/developer-import-sources';
import {
  readDesktopScientificDocument,
  workspaceRelativePath,
} from './desktop-scientific-documents';
import { readScientificText } from './read-scientific-text';

const mocks = vi.hoisted(() => ({
  resolveWorkspaceScope: vi.fn(),
  readScientificDocument: vi.fn(),
  cancelRead: vi.fn(),
  readTextFile: vi.fn(),
}));

vi.mock('../../../db/workspace-catalog', () => ({
  resolveWorkspaceScope: mocks.resolveWorkspaceScope,
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    scientificDocuments: {
      read: mocks.readScientificDocument,
      cancelRead: mocks.cancelRead,
    },
    fs: { readTextFile: mocks.readTextFile },
  }),
}));

vi.mock('../../../utils/environment', () => ({
  isBrowserOnly: () => false,
  isHostedBrowserRuntime: () => false,
}));

vi.mock('../../../shared/developer-import-sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/developer-import-sources')>();
  return {
    ...actual,
    isDeveloperImportSourcePath: (path: string) =>
      actual.isDeveloperImportSourcePath(path, ['/developer/wp-assets']) ||
      actual.isDeveloperImportSourcePath(path),
  };
});

describe('desktop scientific document adapter', () => {
  it('converts an absolute file into a domain identity before transport', async () => {
    const read = vi.fn(async (request) => ({
      ok: false as const,
      error: { code: 'DOCUMENT_NOT_FOUND' as const, message: request.document },
    }));
    const result = await readDesktopScientificDocument({
      filePath: '/lab/sequences/pUC19.gb',
      workspaceRoot: '/lab',
      resolveScope: async () => 'workspace-42',
      operationId: () => 'operation-1',
      transport: { read, cancelRead: vi.fn(async () => undefined) },
    });
    expect(read).toHaveBeenCalledWith({
      operationId: 'operation-1',
      workspaceRoot: '/lab',
      workspace: 'workspace-42',
      document: 'sequences/pUC19.gb',
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'DOCUMENT_NOT_FOUND' } });
  });

  it('denies sibling-prefix and traversal-shaped paths', () => {
    expect(workspaceRelativePath('/lab', '/laboratory/secret.gb')).toBeNull();
    expect(workspaceRelativePath('/lab', '/lab/../secret.gb')).toBe('../secret.gb');
  });

  it('cancels the exact in-flight operation and removes the listener', async () => {
    const controller = new AbortController();
    const cancelRead = vi.fn(async () => undefined);
    const read = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true,
          });
        })
    );
    const pending = readDesktopScientificDocument({
      filePath: '/lab/a.gb',
      workspaceRoot: '/lab',
      signal: controller.signal,
      resolveScope: async () => 'workspace-42',
      operationId: () => 'operation-2',
      transport: { read, cancelRead },
    });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(cancelRead).toHaveBeenCalledWith({ operationId: 'operation-2' });
  });
});

describe('native scientific text read routing', () => {
  const acceptedRevision: ScientificAcceptedDocumentRevision = {
    kind: 'accepted-object',
    contentSha256: 'a'.repeat(64),
    resourceId: 'pUC19',
    resourceRevisionId: `rr_${'b'.repeat(64)}`,
    workspaceVersionId: `wv_${'c'.repeat(64)}`,
    sequenceEditParentEventId: 'sequence-edit-parent-42',
  };
  const nativeContent = 'LOCUS       accepted-project\nORIGIN\n        1 tgca\n//\n';

  beforeEach(() => {
    vi.clearAllMocks();
    setRememberedDeveloperImportSourceRootsForRenderer([]);
    mocks.resolveWorkspaceScope.mockResolvedValue('workspace-42');
    mocks.readScientificDocument.mockResolvedValue({
      ok: true,
      document: {
        workspace: parseWorkspaceIdentity('workspace-42'),
        document: parseScientificDocumentIdentity('sequences/pUC19.gb'),
        name: 'pUC19.gb',
        format: 'genbank',
        content: nativeContent,
        byteLength: new TextEncoder().encode(nativeContent).length,
        revision: acceptedRevision,
        support: { route: 'desktop', access: 'read-write' },
      },
    });
  });

  afterEach(() => {
    setRememberedDeveloperImportSourceRootsForRenderer([]);
  });

  it.each([
    { policy: 'configured', sourceRoot: '/developer/wp-assets' },
    { policy: 'remembered', sourceRoot: '/remembered/source' },
  ] as const)(
    'previews a $policy developer source without resolving a project owner',
    async ({ policy, sourceRoot }) => {
      if (policy === 'remembered') setRememberedDeveloperImportSourceRootsForRenderer([sourceRoot]);
      const filePath = `${sourceRoot}/Source package/product.gb`;
      const content = 'LOCUS       source-preview\r\nORIGIN\r\n        1 acgt\r\n//\r\n';
      const readLegacy = vi.fn(async () => content);

      const result = await readScientificText(filePath, sourceRoot, readLegacy);

      expect.soft(result).toEqual({ content, acceptedRevision: null });
      expect.soft(readLegacy).toHaveBeenCalledOnce();
      expect.soft(readLegacy).toHaveBeenCalledWith(filePath);
      expect.soft(mocks.resolveWorkspaceScope).not.toHaveBeenCalled();
      expect.soft(mocks.readScientificDocument).not.toHaveBeenCalled();
      expect.soft(mocks.readTextFile).not.toHaveBeenCalled();
    }
  );

  it.each(['/lab/project', '/developer/wp-assets-other'])(
    'reads project %s through its accepted native document',
    async (workspaceRoot) => {
      const filePath = `${workspaceRoot}/sequences/pUC19.gb`;
      const acceptedHead = `wv_${'d'.repeat(64)}`;
      const readLegacy = vi.fn(async () => 'legacy bytes must not replace accepted content');

      const result = await readScientificText(filePath, workspaceRoot, readLegacy, acceptedHead);

      expect(mocks.resolveWorkspaceScope).toHaveBeenCalledOnce();
      expect(mocks.resolveWorkspaceScope).toHaveBeenCalledWith(workspaceRoot);
      expect(mocks.readScientificDocument).toHaveBeenCalledOnce();
      expect(mocks.readScientificDocument).toHaveBeenCalledWith({
        operationId: expect.any(String),
        workspaceRoot,
        workspace: 'workspace-42',
        document: 'sequences/pUC19.gb',
        acceptedHead,
      });
      expect(result).toEqual({ content: nativeContent, acceptedRevision });
      expect(result.acceptedRevision).toBe(acceptedRevision);
      expect(readLegacy).not.toHaveBeenCalled();
      expect(mocks.readTextFile).not.toHaveBeenCalled();
    }
  );
});
