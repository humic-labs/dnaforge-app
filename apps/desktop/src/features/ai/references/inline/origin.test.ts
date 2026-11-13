import { describe, expect, it, vi } from 'vitest';

import { resolveInlineReferenceOrigin, workspaceRootPathForGitLocator } from './origin';

const locator = 'git://Samples/constructs/pUC19';

function reference(
  overrides: Partial<{
    locator: string;
    workspace_root_path: string | null;
    workspace_scope: string | null;
  }> = {}
) {
  return {
    locator,
    workspace_root_path: null,
    workspace_scope: 'folders:["/original/Samples"]',
    ...overrides,
  };
}

describe('inline reference origin authority', () => {
  it('uses the immutable saved root without consulting legacy recovery', async () => {
    const validateCandidate = vi.fn(async () => false);
    await expect(
      resolveInlineReferenceOrigin({
        reference: reference({ workspace_root_path: '/saved/Samples' }),
        conversationWorkspacePath: null,
        validateCandidate,
      })
    ).resolves.toEqual({ ok: true, rootPath: '/saved/Samples', recovered: false });
    expect(validateCandidate).not.toHaveBeenCalled();
  });

  it('recovers an unmounted custom-labeled legacy root from one immutable scoped path', async () => {
    await expect(
      resolveInlineReferenceOrigin({
        reference: reference({ workspace_scope: 'folders:["/managed/uuid/repo"]' }),
        conversationWorkspacePath: null,
        validateCandidate: vi.fn(),
      })
    ).resolves.toEqual({ ok: true, rootPath: '/managed/uuid/repo', recovered: true });
  });

  it('never substitutes a same-named current root outside the saved scope', async () => {
    await expect(
      resolveInlineReferenceOrigin({
        reference: reference({ workspace_scope: 'folders:[]' }),
        conversationWorkspacePath: null,
        validateCandidate: vi.fn(async (path) => path === '/replacement/Samples'),
      })
    ).resolves.toEqual({ ok: false, code: 'origin-unrecoverable' });
  });

  it('recovers exactly one valid target from a historical multi-root scope', async () => {
    const validateCandidate = vi.fn(async (path: string) => path === '/second/custom-root');
    await expect(
      resolveInlineReferenceOrigin({
        reference: reference({
          workspace_scope: 'folders:["/first/custom-root","/second/custom-root"]',
        }),
        conversationWorkspacePath: null,
        validateCandidate,
      })
    ).resolves.toEqual({ ok: true, rootPath: '/second/custom-root', recovered: true });
    expect(validateCandidate).toHaveBeenCalledTimes(2);
  });

  it('refuses ambiguous validated multi-root recovery', async () => {
    await expect(
      resolveInlineReferenceOrigin({
        reference: reference({
          workspace_scope: 'folders:["/first/custom-root","/second/custom-root"]',
        }),
        conversationWorkspacePath: null,
        validateCandidate: vi.fn(async () => true),
      })
    ).resolves.toEqual({ ok: false, code: 'origin-unrecoverable' });
  });

  it('never rereads mutable workspace-file contents as historical authority', async () => {
    const validateCandidate = vi.fn(async (path: string) => path === '/replacement/custom-root');
    await expect(
      resolveInlineReferenceOrigin({
        reference: reference({ workspace_scope: 'file:/saved/lab.waypoint-workspace' }),
        conversationWorkspacePath: null,
        validateCandidate,
      })
    ).resolves.toEqual({ ok: false, code: 'origin-unrecoverable' });
    expect(validateCandidate).not.toHaveBeenCalled();
  });

  it('uses the conversation creation path for a legacy workspace-file scope', async () => {
    await expect(
      resolveInlineReferenceOrigin({
        reference: reference({ workspace_scope: 'file:/saved/lab.waypoint-workspace' }),
        conversationWorkspacePath: '/original/custom-root',
        validateCandidate: vi.fn(),
      })
    ).resolves.toEqual({ ok: true, rootPath: '/original/custom-root', recovered: true });
  });

  it('derives new-row authority only from one exact mounted root name', () => {
    expect(
      workspaceRootPathForGitLocator(locator, [{ name: 'Samples', path: '/workspace/Samples' }])
    ).toBe('/workspace/Samples');
    expect(
      workspaceRootPathForGitLocator(locator, [
        { name: 'Samples', path: '/first/Samples' },
        { name: 'Samples', path: '/second/Samples' },
      ])
    ).toBeNull();
  });
});
