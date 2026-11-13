import { describe, expect, it, vi } from 'vitest';
import {
  readDesktopScientificDocument,
  workspaceRelativePath,
} from './desktop-scientific-documents';

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
