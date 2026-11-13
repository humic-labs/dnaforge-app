import { describe, expect, it, vi } from 'vitest';

import type { DBEntityReference } from '../../../../db/entity-references';
import type { ResolveInlineReferenceTargetResult } from '../../../../shared/inline-reference-ipc';
import { buildInlineTextDocument } from './document';
import { createInlineReferenceSession } from './session';

const ROOTS = [{ name: 'Research Workspace', path: '/repo' }];
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_EXISTING = '33333333-3333-4333-8333-333333333333';

function entityUrl(name: string): string {
  return `dnaforge-chat://entity/sequence/Research%20Workspace/constructs/${name}`;
}

function workspaceUrl(name: string): string {
  return `dnaforge-chat://workspace/Research%20Workspace/constructs/${name}`;
}

function resolvedTarget(name: string): ResolveInlineReferenceTargetResult {
  return {
    ok: true,
    path: `/repo/constructs/${name}`,
    rootPath: '/repo',
    canonicalPath: `/repo/constructs/${name}`,
    canonicalRootPath: '/repo',
    relativePath: `constructs/${name}`,
    targetType: 'file',
  };
}

function existingReference(): DBEntityReference {
  return {
    id: ID_EXISTING,
    entity_type: 'sequence',
    display_label: 'existing.gb',
    locator: 'git://Research Workspace/constructs/existing.gb',
    deep_link_params: null,
    data: null,
    source: 'user',
    status: 'created',
    workspace_scope: 'scope-a',
    workspace_root_path: '/repo',
    created_at: 1,
    updated_at: 1,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

describe('inline reference session', () => {
  it('resolves a trusted reference created in this same turn without granting arbitrary UUIDs', async () => {
    const session = createInlineReferenceSession({
      roots: ROOTS,
      workspaceScope: 'scope-a',
      allowedExistingReferenceIds: [],
    });
    session.update('answer', `Inspect [the selection](dnaforge-chat://reference/${ID_EXISTING}).`);
    session.registerCreatedReference(existingReference());
    const result = await session.finalize();
    expect(result.blocks.get('answer')?.referenceIds).toEqual([ID_EXISTING]);
    expect(result.blocks.get('answer')?.document.parts[0].state).toMatchObject({
      status: 'resolved',
      referenceId: ID_EXISTING,
    });
    expect(result.referencedRows).toEqual([existingReference()]);
  });

  it('returns pending prose immediately and publishes the resolved document later', async () => {
    const target = deferred<ResolveInlineReferenceTargetResult>();
    const onDocument = vi.fn();
    const session = createInlineReferenceSession({
      roots: ROOTS,
      workspaceScope: 'scope-a',
      allowedExistingReferenceIds: [],
      resolveTarget: () => target.promise,
      createId: () => ID_A,
      onDocument,
    });

    const first = session.update('text-1', `Open [pUC19](${entityUrl('pUC19.gb')})`);
    const continued = session.update(
      'text-1',
      `Open [pUC19](${entityUrl('pUC19.gb')}) while I keep streaming.`
    );

    expect(first.parts[0]?.state).toEqual({ status: 'pending' });
    expect(continued.renderSource).toContain('while I keep streaming');
    expect(onDocument).not.toHaveBeenCalled();

    target.resolve(resolvedTarget('pUC19.gb'));
    await vi.waitFor(() => {
      expect(onDocument).toHaveBeenCalledWith(
        'text-1',
        expect.objectContaining({
          parts: [
            expect.objectContaining({
              state: expect.objectContaining({ status: 'resolved', referenceId: ID_A }),
            }),
          ],
        })
      );
    });
  });

  it('caps path resolution at four concurrent main-process calls', async () => {
    const gate = deferred<ResolveInlineReferenceTargetResult>();
    let active = 0;
    let maxObserved = 0;
    const resolveTarget = vi.fn(async () => {
      active += 1;
      maxObserved = Math.max(maxObserved, active);
      const result = await gate.promise;
      active -= 1;
      return result;
    });
    let nextId = 0;
    const session = createInlineReferenceSession({
      roots: ROOTS,
      workspaceScope: 'scope-a',
      allowedExistingReferenceIds: [],
      resolveTarget,
      createId: () => `${String(++nextId).padStart(8, '0')}-1111-4111-8111-111111111111`,
    });
    const content = Array.from(
      { length: 6 },
      (_, index) => `[file-${index}](${entityUrl(`file-${index}.gb`)})`
    ).join(' ');

    session.update('text-1', content);
    await vi.waitFor(() => expect(resolveTarget).toHaveBeenCalledTimes(4));
    expect(maxObserved).toBe(4);

    gate.resolve(resolvedTarget('shared.gb'));
    await session.finalize();
    expect(resolveTarget).toHaveBeenCalledTimes(6);
    expect(maxObserved).toBe(4);
  });

  it('orders joins by declaration even when resolutions finish out of order', async () => {
    const first = deferred<ResolveInlineReferenceTargetResult>();
    const second = deferred<ResolveInlineReferenceTargetResult>();
    const session = createInlineReferenceSession({
      roots: ROOTS,
      workspaceScope: 'scope-a',
      allowedExistingReferenceIds: [],
      resolveTarget: (request) =>
        request.segments.at(-1) === 'first.gb' ? first.promise : second.promise,
      createId: vi.fn().mockReturnValueOnce(ID_B).mockReturnValueOnce(ID_A),
    });
    session.update(
      'text-1',
      `[first](${entityUrl('first.gb')}) then [second](${entityUrl('second.gb')})`
    );

    second.resolve(resolvedTarget('second.gb'));
    await Promise.resolve();
    first.resolve(resolvedTarget('first.gb'));
    const finalized = await session.finalize();
    const block = finalized.blocks.get('text-1');

    expect(block?.referenceIds).toEqual([ID_A, ID_B]);
    expect(finalized.proposedRows.map((row) => row.locator)).toEqual([
      'git://Research Workspace/constructs/first.gb',
      'git://Research Workspace/constructs/second.gb',
    ]);
  });

  it('resolves duplicate declarations once while retaining only the first chip and one join', async () => {
    const resolveTarget = vi.fn(async () => resolvedTarget('pUC19.gb'));
    const session = createInlineReferenceSession({
      roots: ROOTS,
      workspaceScope: 'scope-a',
      allowedExistingReferenceIds: [],
      resolveTarget,
      createId: () => ID_A,
    });
    session.update(
      'text-1',
      `[first](${entityUrl('pUC19.gb')}) and [again](${entityUrl('pUC19.gb')})`
    );

    const finalized = await session.finalize();
    const block = finalized.blocks.get('text-1');

    expect(resolveTarget).toHaveBeenCalledTimes(1);
    expect(block?.referenceIds).toEqual([ID_A]);
    expect(block?.content.match(/dnaforge-chat:\/\/reference\//g)).toHaveLength(1);
    expect(block?.content).toMatch(/\[first\]\(dnaforge-chat:\/\/reference\/.+\) and pUC19/);
    expect(block?.document.parts).toHaveLength(1);
    expect(finalized.proposedRows).toHaveLength(1);
    expect(finalized.referencedRows).toHaveLength(1);
  });

  it.each([
    ['entity first', `[entity](${entityUrl('pUC19.gb')}) [path](${workspaceUrl('pUC19.gb')})`],
    ['workspace first', `[path](${workspaceUrl('pUC19.gb')}) [entity](${entityUrl('pUC19.gb')})`],
  ])(
    'suppresses a matching workspace path regardless of declaration order: %s',
    async (_name, source) => {
      const session = createInlineReferenceSession({
        roots: ROOTS,
        workspaceScope: 'scope-a',
        allowedExistingReferenceIds: [],
        resolveTarget: async () => resolvedTarget('pUC19.gb'),
        createId: () => ID_A,
      });
      session.update('text-1', source);

      const finalized = await session.finalize();
      const block = finalized.blocks.get('text-1');

      expect(block?.referenceIds).toEqual([ID_A]);
      expect(block?.content.match(/dnaforge-chat:\/\//g)).toHaveLength(1);
      expect(block?.content).not.toContain('dnaforge-chat://workspace');
      expect(block?.document.parts).toHaveLength(1);
      expect(block?.document.parts[0]?.declaration.kind).toBe('existing-reference');
      expect(finalized.proposedRows).toHaveLength(1);
    }
  );

  it.each(['file', 'directory', 'sequence-package'] as const)(
    'preserves the main-process %s classification on a finalized workspace chip',
    async (targetType) => {
      const session = createInlineReferenceSession({
        roots: ROOTS,
        workspaceScope: 'scope-a',
        allowedExistingReferenceIds: [],
        resolveTarget: async () => ({ ...resolvedTarget('target'), targetType }),
        createId: () => ID_A,
      });
      session.update('text-1', `[target](${workspaceUrl('target')})`);

      const finalized = await session.finalize();
      expect(finalized.blocks.get('text-1')?.document.parts[0]?.declaration.kind).toBe(
        'existing-reference'
      );
      expect(finalized.blocks.get('text-1')?.referenceIds).toEqual([ID_A]);
      expect(finalized.proposedRows).toEqual([
        expect.objectContaining({
          entity_type:
            targetType === 'directory'
              ? 'folder'
              : targetType === 'sequence-package'
                ? 'sequence'
                : 'file',
          workspace_root_path: '/repo',
        }),
      ]);
    }
  );

  it('rejects guessed UUIDs without loading them and accepts only exposed references', async () => {
    const loadReferences = vi.fn(async () => [existingReference()]);
    const rejected = createInlineReferenceSession({
      roots: ROOTS,
      workspaceScope: 'scope-a',
      allowedExistingReferenceIds: [],
      loadReferences,
    });
    rejected.update('text-1', `[secret](dnaforge-chat://reference/${ID_EXISTING})`);
    const rejectedResult = await rejected.finalize();

    expect(loadReferences).not.toHaveBeenCalled();
    expect(rejectedResult.blocks.get('text-1')?.content).toBe('secret');
    expect(rejectedResult.blocks.get('text-1')?.referenceIds).toEqual([]);

    const accepted = createInlineReferenceSession({
      roots: ROOTS,
      workspaceScope: 'scope-a',
      allowedExistingReferenceIds: [ID_EXISTING],
      loadReferences,
    });
    accepted.update('text-2', `[existing](dnaforge-chat://reference/${ID_EXISTING})`);
    const acceptedResult = await accepted.finalize();
    expect(acceptedResult.blocks.get('text-2')?.referenceIds).toEqual([ID_EXISTING]);
    expect(acceptedResult.blocks.get('text-2')?.content).toContain('[existing]');
    expect(acceptedResult.referencedRows).toEqual([existingReference()]);
  });

  it.each([
    ['a%5Bb%5D.gb', 'a[b].gb'],
    [`${'a'.repeat(201)}.gb`, `${'a'.repeat(201)}.gb`],
  ])('keeps a durable UUID node for the legal canonical filename %s', async (uriName, fileName) => {
    const session = createInlineReferenceSession({
      roots: ROOTS,
      workspaceScope: 'scope-a',
      allowedExistingReferenceIds: [],
      resolveTarget: async () => resolvedTarget(fileName),
      createId: () => ID_A,
    });
    session.update('text-1', `[safe label](${entityUrl(uriName)})`);

    const finalized = await session.finalize();
    const block = finalized.blocks.get('text-1');
    expect(block?.referenceIds).toEqual([ID_A]);
    expect(block?.document.parts).toHaveLength(1);
    expect(block?.document.parts[0]?.state).toMatchObject({
      status: 'resolved',
      canonicalLabel: fileName.slice(0, -3),
      referenceId: ID_A,
    });
  });

  it('does not reparse the full settled block for every ordinary trailing paint slice', () => {
    const buildDocument = vi.fn(buildInlineTextDocument);
    const session = createInlineReferenceSession({
      roots: ROOTS,
      workspaceScope: 'scope-a',
      allowedExistingReferenceIds: [],
      resolveTarget: async () => resolvedTarget('pUC19.gb'),
      createId: () => ID_A,
      buildDocument,
    });
    const prefix = `[pUC19](${entityUrl('pUC19.gb')})`;
    session.update('text-1', prefix);
    for (let index = 1; index <= 100; index += 1) {
      session.update('text-1', `${prefix}${'x'.repeat(index)}`);
    }

    expect(buildDocument).toHaveBeenCalledTimes(1);
  });

  it('resolves the same declaration across every streamed UTF-16 split boundary', async () => {
    const declaration = `[pUC19](${entityUrl('pUC19.gb')})`;

    for (let boundary = 1; boundary < declaration.length; boundary += 1) {
      const session = createInlineReferenceSession({
        roots: ROOTS,
        workspaceScope: 'scope-a',
        allowedExistingReferenceIds: [],
        resolveTarget: async () => resolvedTarget('pUC19.gb'),
        createId: () => ID_A,
      });

      session.update('text-1', declaration.slice(0, boundary));
      session.update('text-1', declaration);

      const finalized = await session.finalize();
      const block = finalized.blocks.get('text-1');
      expect(block?.referenceIds, `split at ${boundary}`).toEqual([ID_A]);
      expect(block?.document.parts, `split at ${boundary}`).toHaveLength(1);
      expect(block?.content, `split at ${boundary}`).not.toContain('dnaforge-chat://entity');
    }
  });

  it('invalidates path results when the workspace changes before settlement', async () => {
    let scopeCurrent = true;
    const session = createInlineReferenceSession({
      roots: ROOTS,
      workspaceScope: 'scope-a',
      allowedExistingReferenceIds: [],
      resolveTarget: async () => resolvedTarget('pUC19.gb'),
      createId: () => ID_A,
      isScopeCurrent: () => scopeCurrent,
    });
    session.update('text-1', `[pUC19](${entityUrl('pUC19.gb')})`);
    await vi.waitFor(() => expect(scopeCurrent).toBe(true));
    scopeCurrent = false;

    const finalized = await session.finalize();
    expect(finalized.blocks.get('text-1')?.content).toBe('pUC19');
    expect(finalized.blocks.get('text-1')?.referenceIds).toEqual([]);
    expect(finalized.proposedRows).toEqual([]);
  });

  it('settles cancellation and deadline expiry as inert readable prose', async () => {
    const never = deferred<ResolveInlineReferenceTargetResult>();
    const cancelled = createInlineReferenceSession({
      roots: ROOTS,
      workspaceScope: 'scope-a',
      allowedExistingReferenceIds: [],
      resolveTarget: () => never.promise,
      createId: () => ID_A,
    });
    cancelled.update('cancelled', `[pUC19](${entityUrl('pUC19.gb')})`);
    cancelled.cancel();
    const cancelledResult = await cancelled.finalize();
    expect(cancelledResult.blocks.get('cancelled')?.content).toBe('pUC19');
    expect(cancelledResult.proposedRows).toEqual([]);

    const timedOut = createInlineReferenceSession({
      roots: ROOTS,
      workspaceScope: 'scope-a',
      allowedExistingReferenceIds: [],
      settlementDeadlineMs: 1,
      resolveTarget: () => never.promise,
      createId: () => ID_A,
    });
    timedOut.update('timed-out', `[pUC19](${entityUrl('pUC19.gb')})`);
    const timedOutResult = await timedOut.finalize();
    expect(timedOutResult.blocks.get('timed-out')?.content).toBe('pUC19');
    expect(timedOutResult.blocks.get('timed-out')?.document.parts).toEqual([]);
    expect(timedOutResult.proposedRows).toEqual([]);
  });
});
