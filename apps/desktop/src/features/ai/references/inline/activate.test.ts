import { describe, expect, it, vi } from 'vitest';
import { renderUserMessage } from '@waypoint/user-messages';

import type {
  ResolveInlineReferenceTargetRequest,
  ResolveInlineReferenceTargetResult,
} from '../../../../shared/inline-reference-ipc';
import {
  activateInlineReference,
  inlineReferenceActivationErrorMessage,
  inlinePathDeclarationFromReference,
  inlineWorkspaceDeclarationFromReference,
} from './activate';

const ROOTS = [{ name: 'Research Workspace', path: '/workspace' }];

function success(
  path: string,
  targetType: 'file' | 'directory' | 'sequence-package' = 'file'
): ResolveInlineReferenceTargetResult {
  return {
    ok: true,
    path,
    rootPath: '/workspace',
    canonicalPath: path,
    canonicalRootPath: '/workspace',
    relativePath: path.slice('/workspace/'.length),
    targetType,
  };
}

function deps(results: ResolveInlineReferenceTargetResult[]) {
  return {
    resolveTarget: vi.fn(async (_request: ResolveInlineReferenceTargetRequest) => {
      const next = results.shift();
      if (!next) throw new Error('Unexpected resolver call');
      return next;
    }),
    resolvePackageProduct: vi.fn(async () => '/workspace/constructs/pUC19/pUC19.gb'),
    openSequence: vi.fn(async () => ({
      tabId: 'sequence-tab',
      documentId: 'sequence-puc19',
    })),
    openStructure: vi.fn(async () => 'structure-tab'),
    revealWorkspacePath: vi.fn(),
  };
}

describe('activateInlineReference', () => {
  it('keeps saved-location guidance through the public message boundary', () => {
    const message = inlineReferenceActivationErrorMessage(
      'origin-unrecoverable',
      'pUC19.gb',
      'sequence'
    );
    expect(renderUserMessage(message)).toBe(
      'DNAForge can’t recover the saved location for “pUC19”.'
    );
  });

  it('maps activation failures to truthful saved-location messages', () => {
    expect(inlineReferenceActivationErrorMessage('target-not-found', 'pUC19', 'sequence')).toBe(
      'Couldn’t find “pUC19” at its saved location.'
    );
    expect(inlineReferenceActivationErrorMessage('root-not-found', 'pUC19', 'sequence')).toBe(
      'The saved location for “pUC19” can’t be reached.'
    );
    expect(inlineReferenceActivationErrorMessage('outside-root', 'pUC19', 'sequence')).toBe(
      'DNAForge blocked this reference because its saved location is unsafe.'
    );
    expect(inlineReferenceActivationErrorMessage('origin-unrecoverable', 'pUC19', 'sequence')).toBe(
      'DNAForge can’t recover the saved location for “pUC19”.'
    );
    expect(inlineReferenceActivationErrorMessage('target-not-found', 'pUC19.gb', 'sequence')).toBe(
      'Couldn’t find “pUC19” at its saved location.'
    );
    expect(inlineReferenceActivationErrorMessage('wrong-kind', 'pUC19.gb', 'sequence')).toBe(
      '“pUC19” is no longer a readable sequence.'
    );
    expect(inlineReferenceActivationErrorMessage('wrong-kind', 'notes.txt', 'file')).toBe(
      '“notes” is no longer a readable file.'
    );
    expect(inlineReferenceActivationErrorMessage('wrong-kind', 'results', 'folder')).toBe(
      '“results” is no longer a readable folder.'
    );
    expect(
      inlineReferenceActivationErrorMessage('origin-persistence-failed', 'pUC19.gb', 'sequence')
    ).toBe('DNAForge couldn’t restore the saved location for “pUC19”.');
    expect(inlineReferenceActivationErrorMessage('open-failed', 'pUC19', 'sequence')).toBe(
      'DNAForge found “pUC19” but couldn’t open it.'
    );
  });
  it('recovers a path entity from a canonical UUID row for replay-time revalidation', () => {
    expect(
      inlinePathDeclarationFromReference({
        entity_type: 'sequence',
        locator: 'git://Research Workspace/constructs/pUC19.gb',
      })
    ).toEqual({
      kind: 'path-entity',
      entityType: 'sequence',
      root: 'Research Workspace',
      segments: ['constructs', 'pUC19.gb'],
    });
    expect(
      inlineWorkspaceDeclarationFromReference({
        locator: 'git://Research Workspace/constructs/pUC19',
      })
    ).toEqual({
      kind: 'workspace-path',
      root: 'Research Workspace',
      segments: ['constructs', 'pUC19'],
    });
    expect(
      inlinePathDeclarationFromReference({
        entity_type: 'sequence_region',
        locator: 'git://Research Workspace/constructs/pUC19.gb',
      })
    ).toBeNull();
    expect(
      inlinePathDeclarationFromReference({
        entity_type: 'sequence',
        locator: 'entity://sequence/pUC19',
      })
    ).toBeNull();
    expect(
      inlinePathDeclarationFromReference({
        entity_type: 'sequence',
        locator: 'git://Research Workspace/constructs/yield-100%2e.gb',
      })
    ).toEqual({
      kind: 'path-entity',
      entityType: 'sequence',
      root: 'Research Workspace',
      segments: ['constructs', 'yield-100%2e.gb'],
    });
  });

  it('opens a sequence only after click-time main-process revalidation', async () => {
    const d = deps([success('/workspace/constructs/pUC19.gb')]);
    const result = await activateInlineReference(
      {
        declaration: {
          kind: 'path-entity',
          entityType: 'sequence',
          root: 'Research Workspace',
          segments: ['constructs', 'pUC19.gb'],
        },
        label: 'pUC19',
        rootPath: '/workspace',
      },
      d
    );
    expect(result).toEqual({
      ok: true,
      action: 'sequence',
      documentId: 'sequence-puc19',
      tabId: 'sequence-tab',
    });
    expect(d.openSequence).toHaveBeenCalledWith({
      sourcePath: '/workspace/constructs/pUC19.gb',
      label: 'pUC19',
    });
    expect(d.openStructure).not.toHaveBeenCalled();
    expect(d.revealWorkspacePath).not.toHaveBeenCalled();
  });

  it('opens from the persisted root even when the currently mounted workspace changed', async () => {
    const d = deps([success('/workspace/constructs/pUC19.gb')]);
    const result = await activateInlineReference(
      {
        declaration: {
          kind: 'path-entity',
          entityType: 'sequence',
          root: 'Research Workspace',
          segments: ['constructs', 'pUC19.gb'],
        },
        label: 'pUC19',
        rootPath: '/workspace',
      },
      d
    );

    expect(result).toEqual({
      ok: true,
      action: 'sequence',
      documentId: 'sequence-puc19',
      tabId: 'sequence-tab',
    });
    expect(d.resolveTarget).toHaveBeenCalledWith({
      roots: ROOTS,
      root: 'Research Workspace',
      segments: ['constructs', 'pUC19.gb'],
      targetKind: 'sequence',
    });
    expect(d.openSequence).toHaveBeenCalledWith({
      sourcePath: '/workspace/constructs/pUC19.gb',
      label: 'pUC19',
    });
  });

  it('opens a structure through the canonical structure opener', async () => {
    const d = deps([success('/workspace/structures/mioC.pdb')]);
    const result = await activateInlineReference(
      {
        declaration: {
          kind: 'path-entity',
          entityType: 'structure',
          root: 'Research Workspace',
          segments: ['structures', 'mioC.pdb'],
        },
        label: 'MioC',
        rootPath: '/workspace',
      },
      d
    );
    expect(result).toMatchObject({ ok: true, action: 'structure', tabId: 'structure-tab' });
    expect(d.openStructure).toHaveBeenCalledWith({
      filePath: '/workspace/structures/mioC.pdb',
      label: 'MioC',
    });
  });

  it('reveals an ordinary workspace path through one semantic action', async () => {
    const d = deps([success('/workspace/notes/README.md')]);
    const result = await activateInlineReference(
      {
        declaration: {
          kind: 'workspace-path',
          root: 'Research Workspace',
          segments: ['notes', 'README.md'],
        },
        label: 'notes',
        rootPath: '/workspace',
      },
      d
    );
    expect(result).toEqual({
      ok: true,
      action: 'workspace',
      path: '/workspace/notes/README.md',
      revealPath: '/workspace/notes/README.md',
    });
    expect(d.revealWorkspacePath).toHaveBeenCalledWith('/workspace/notes/README.md');
    expect(d.openSequence).not.toHaveBeenCalled();
    expect(d.openStructure).not.toHaveBeenCalled();
  });

  it('opens a package product after a second containment check without changing Explorer', async () => {
    const d = deps([
      success('/workspace/constructs/pUC19', 'sequence-package'),
      success('/workspace/constructs/pUC19/pUC19.gb'),
    ]);
    const result = await activateInlineReference(
      {
        declaration: {
          kind: 'path-entity',
          entityType: 'sequence',
          root: 'Research Workspace',
          segments: ['constructs', 'pUC19'],
        },
        label: 'pUC19',
        rootPath: '/workspace',
      },
      d
    );
    expect(d.resolveTarget).toHaveBeenCalledTimes(2);
    expect(d.resolveTarget.mock.calls[1][0].segments).toEqual(['constructs', 'pUC19', 'pUC19.gb']);
    expect(d.openSequence).toHaveBeenCalledWith({
      sourcePath: '/workspace/constructs/pUC19/pUC19.gb',
      label: 'pUC19',
    });
    expect(d.revealWorkspacePath).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      action: 'sequence',
      documentId: 'sequence-puc19',
    });
  });

  it('reveals a package root without resolving or opening its internal product', async () => {
    const d = deps([success('/workspace/constructs/pUC19', 'sequence-package')]);
    const result = await activateInlineReference(
      {
        declaration: {
          kind: 'path-entity',
          entityType: 'sequence',
          root: 'Research Workspace',
          segments: ['constructs', 'pUC19'],
        },
        intent: 'reveal',
        label: 'pUC19',
        rootPath: '/workspace',
      },
      d
    );

    expect(d.resolveTarget).toHaveBeenCalledTimes(1);
    expect(d.resolvePackageProduct).not.toHaveBeenCalled();
    expect(d.openSequence).not.toHaveBeenCalled();
    expect(d.openStructure).not.toHaveBeenCalled();
    expect(d.revealWorkspacePath).toHaveBeenCalledWith('/workspace/constructs/pUC19');
    expect(result).toEqual({
      ok: true,
      action: 'workspace',
      path: '/workspace/constructs/pUC19',
      revealPath: '/workspace/constructs/pUC19',
    });
  });

  it.each([
    ['deleted target', { ok: false, code: 'target-not-found' }],
    ['unmounted root', { ok: false, code: 'root-not-found' }],
    ['symlink replacement', { ok: false, code: 'outside-root' }],
  ] as const)('makes no UI change for a %s', async (_name, failure) => {
    const d = deps([failure]);
    const result = await activateInlineReference(
      {
        declaration: {
          kind: 'workspace-path',
          root: 'Research Workspace',
          segments: ['notes', 'README.md'],
        },
        label: 'notes',
        rootPath: '/workspace',
      },
      d
    );
    expect(result).toEqual(failure);
    expect(d.openSequence).not.toHaveBeenCalled();
    expect(d.openStructure).not.toHaveBeenCalled();
    expect(d.revealWorkspacePath).not.toHaveBeenCalled();
  });

  it('does not open or reveal when a package product fails the second containment check', async () => {
    const d = deps([
      success('/workspace/constructs/pUC19', 'sequence-package'),
      { ok: false, code: 'outside-root' },
    ]);
    const result = await activateInlineReference(
      {
        declaration: {
          kind: 'path-entity',
          entityType: 'sequence',
          root: 'Research Workspace',
          segments: ['constructs', 'pUC19'],
        },
        label: 'pUC19',
        rootPath: '/workspace',
      },
      d
    );
    expect(result).toEqual({ ok: false, code: 'outside-root' });
    expect(d.openSequence).not.toHaveBeenCalled();
    expect(d.revealWorkspacePath).not.toHaveBeenCalled();
  });

  it.each(['sequence', 'structure'] as const)(
    'releases an aborted %s open without waiting for the raw opener',
    async (entityType) => {
      const controller = new AbortController();
      const d = deps([
        success(
          entityType === 'sequence'
            ? '/workspace/constructs/held.gb'
            : '/workspace/structures/held.pdb'
        ),
      ]);
      const pendingOpen = new Promise<never>(() => undefined);
      if (entityType === 'sequence') d.openSequence.mockReturnValue(pendingOpen);
      else d.openStructure.mockReturnValue(pendingOpen);

      const activation = activateInlineReference(
        {
          declaration: {
            kind: 'path-entity',
            entityType,
            root: 'Research Workspace',
            segments: [entityType === 'sequence' ? 'constructs/held.gb' : 'structures/held.pdb'],
          },
          label: 'held',
          rootPath: '/workspace',
        },
        { ...d, signal: controller.signal }
      );
      await vi.waitFor(() => {
        expect(entityType === 'sequence' ? d.openSequence : d.openStructure).toHaveBeenCalledTimes(
          1
        );
      });

      controller.abort();

      await expect(activation).resolves.toEqual({ ok: false, code: 'open-failed' });
      expect(d.revealWorkspacePath).not.toHaveBeenCalled();
    }
  );
});
