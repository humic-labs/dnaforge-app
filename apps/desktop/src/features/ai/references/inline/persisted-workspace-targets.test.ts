import { describe, expect, it, vi } from 'vitest';

import type { InlineTextDocument } from './types';
import {
  persistedWorkspaceTargetKey,
  persistedWorkspaceTargetResolutionKey,
  persistedWorkspaceTargetTypesEqual,
  resolvePersistedWorkspaceTargetTypes,
} from './persisted-workspace-targets';

function persistedWorkspaceDocument(root: string, segments: string[]): InlineTextDocument {
  return {
    source: '',
    renderSource: '',
    parts: [
      {
        key: `${root}/${segments.join('/')}`,
        label: segments.at(-1) ?? root,
        sourceRange: { start: 0, end: 0 },
        declaration: { kind: 'workspace-path', root, segments },
        state: { status: 'resolved', canonicalLabel: segments.at(-1) ?? root },
      },
    ],
  };
}

describe('persisted workspace target hydration', () => {
  it('re-resolves each durable workspace declaration and preserves directory/package identity', async () => {
    const roots = [{ name: 'Samples', path: '/mounted/samples' }];
    const directory = persistedWorkspaceDocument('Samples', ['results']);
    const sequencePackage = persistedWorkspaceDocument('Samples', ['pUC19']);
    const resolveTarget = vi.fn(async ({ segments }: { segments: string[] }) => ({
      ok: true as const,
      targetType: segments[0] === 'pUC19' ? ('sequence-package' as const) : ('directory' as const),
    }));

    const result = await resolvePersistedWorkspaceTargetTypes(
      [directory, sequencePackage],
      roots,
      resolveTarget
    );
    const directoryDeclaration = directory.parts[0].declaration;
    const packageDeclaration = sequencePackage.parts[0].declaration;
    if (
      directoryDeclaration.kind !== 'workspace-path' ||
      packageDeclaration.kind !== 'workspace-path'
    ) {
      throw new Error('Expected workspace declarations.');
    }

    expect(resolveTarget).toHaveBeenCalledTimes(2);
    expect(result.get(persistedWorkspaceTargetKey(directoryDeclaration, roots))).toBe('directory');
    expect(result.get(persistedWorkspaceTargetKey(packageDeclaration, roots))).toBe(
      'sequence-package'
    );
  });

  it('deduplicates the same declaration and omits failures without inventing a target type', async () => {
    const roots = [{ name: 'Samples', path: '/mounted/samples' }];
    const first = persistedWorkspaceDocument('Samples', ['missing']);
    const duplicate = persistedWorkspaceDocument('Samples', ['missing']);
    const resolveTarget = vi.fn(async () => ({ ok: false as const }));

    const result = await resolvePersistedWorkspaceTargetTypes(
      [first, duplicate],
      roots,
      resolveTarget
    );

    expect(resolveTarget).toHaveBeenCalledTimes(1);
    expect(result).toEqual(new Map());
  });

  it('does not reuse a target classification after the mounted root changes', () => {
    const declaration = {
      kind: 'workspace-path' as const,
      root: 'Samples',
      segments: ['pUC19'],
    };

    expect(
      persistedWorkspaceTargetKey(declaration, [{ name: 'Samples', path: '/first/samples' }])
    ).not.toBe(
      persistedWorkspaceTargetKey(declaration, [{ name: 'Samples', path: '/second/samples' }])
    );
  });

  it('includes every duplicate-name project in a stable cache identity', () => {
    const declaration = {
      kind: 'workspace-path' as const,
      root: 'Samples',
      segments: ['pUC19'],
    };
    const firstOrder = persistedWorkspaceTargetKey(declaration, [
      { name: 'Samples', path: '/projects/first' },
      { name: 'Samples', path: '/projects/second' },
    ]);
    const reversed = persistedWorkspaceTargetKey(declaration, [
      { name: 'Samples', path: '/projects/second' },
      { name: 'Samples', path: '/projects/first' },
    ]);

    expect(firstOrder).toBe(reversed);
    expect(firstOrder).toContain('/projects/first');
    expect(firstOrder).toContain('/projects/second');
  });

  it('gives fresh but semantically equal replay inputs the same resolution identity', () => {
    const first = persistedWorkspaceTargetResolutionKey(
      [
        persistedWorkspaceDocument('Samples', ['pUC19']),
        persistedWorkspaceDocument('Samples', ['results']),
      ],
      [{ name: 'Samples', path: '/mounted/samples' }]
    );
    const replayed = persistedWorkspaceTargetResolutionKey(
      [
        persistedWorkspaceDocument('Samples', ['results']),
        persistedWorkspaceDocument('Samples', ['pUC19']),
      ],
      [{ name: 'Samples', path: '/mounted/samples' }]
    );

    expect(replayed).toBe(first);
    expect(JSON.parse(first).map((key: string) => JSON.parse(key))).toEqual([
      ['Samples', ['/mounted/samples'], 'pUC19'],
      ['Samples', ['/mounted/samples'], 'results'],
    ]);
  });

  it('changes resolution identity when the durable target or mounted root changes', () => {
    const original = persistedWorkspaceTargetResolutionKey(
      [persistedWorkspaceDocument('Samples', ['pUC19'])],
      [{ name: 'Samples', path: '/first/samples' }]
    );

    expect(
      persistedWorkspaceTargetResolutionKey(
        [persistedWorkspaceDocument('Samples', ['pBR322'])],
        [{ name: 'Samples', path: '/first/samples' }]
      )
    ).not.toBe(original);
    expect(
      persistedWorkspaceTargetResolutionKey(
        [persistedWorkspaceDocument('Samples', ['pUC19'])],
        [{ name: 'Samples', path: '/second/samples' }]
      )
    ).not.toBe(original);
  });

  it('treats separately allocated equal resolver results as the same state', () => {
    const first = new Map<string, 'directory' | 'sequence-package'>([
      ['samples', 'directory'],
      ['pUC19', 'sequence-package'],
    ]);

    expect(
      persistedWorkspaceTargetTypesEqual(
        first,
        new Map([
          ['pUC19', 'sequence-package'],
          ['samples', 'directory'],
        ])
      )
    ).toBe(true);
    expect(persistedWorkspaceTargetTypesEqual(first, new Map([['samples', 'directory']]))).toBe(
      false
    );
    expect(
      persistedWorkspaceTargetTypesEqual(
        first,
        new Map([
          ['samples', 'directory'],
          ['pUC19', 'directory'],
        ])
      )
    ).toBe(false);
  });
});
