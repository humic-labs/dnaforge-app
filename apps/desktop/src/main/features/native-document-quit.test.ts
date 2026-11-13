// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  createNativeDocumentQuitSaver,
  type NativeDocumentQuitWindow,
} from './native-document-quit';
import type { LegacyUnsavedDiscardSnapshot } from '../../shared/legacy-unsaved-discard';

function fixture() {
  const snapshot: LegacyUnsavedDiscardSnapshot = {
    version: 1,
    copies: [{ store: 'draft', key: 'page:book', workspaceRoot: '/project', sha256: 'exact-copy' }],
  };
  const scripts: string[] = [],
    order: string[] = [],
    roots = { current: ['/project'] },
    invoke = vi.fn(async (script: string) => {
      scripts.push(script);
      const capturing = script.includes('__dnaforgeCaptureUnsavedCopies');
      order.push(capturing ? 'capture' : 'cleanup');
      return capturing ? snapshot : undefined;
    }),
    window = {
      isDestroyed: () => false,
      webContents: { executeJavaScript: invoke },
    } satisfies NativeDocumentQuitWindow,
    settle = vi.fn(async ({ action }: { action: 'save' | 'discard' }) => {
      order.push(action);
      return { action, failures: [], remaining: [], settled: [] };
    }),
    deps = {
      getMainWindow: () => window,
      isRendererAvailable: () => true,
      getDirtyState: () => ({ hasDirtyWork: true, details: 'book', dirtyPageIds: ['book'] }),
      readCurrentDirtyState: async () => ({
        hasDirtyWork: true,
        details: 'book',
        dirtyPageIds: ['book'],
      }),
      requestSaveAll: vi.fn(async () => {}),
      nativeDocuments: {
        workspaces: { readableRoots: () => roots.current },
        settleDirtyDocuments: settle,
      },
    };
  return {
    saver: createNativeDocumentQuitSaver(deps),
    deps,
    snapshot,
    scripts,
    order,
    invoke,
    settle,
    roots,
  };
}

describe('native document quit feature', () => {
  it('captures exact legacy copies before native discard and cleans only the acknowledged snapshot afterward', async () => {
    const f = fixture();
    await f.saver.discardRecoveryCopies!(null);
    expect(f.order).toEqual(['capture', 'discard', 'cleanup']);
    expect(f.scripts[0]).toContain('"dirtyPageIds":["book"]');
    expect(f.scripts[1]).toContain(JSON.stringify(f.snapshot));
  });
  it('keeps legacy recovery when its project loses admission during native settlement', async () => {
    const f = fixture();
    f.settle.mockImplementation(async ({ action }) => {
      f.roots.current = [];
      return { action, failures: [], remaining: [], settled: [] };
    });
    await expect(f.saver.discardRecoveryCopies!(null)).rejects.toThrow('no longer admitted');
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(f.scripts[0]).toContain('__dnaforgeCaptureUnsavedCopies');
  });
});
