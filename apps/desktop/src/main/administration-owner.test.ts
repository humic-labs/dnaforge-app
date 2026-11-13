// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { AdministrationOwner, type AdministrationOwnerDependencies } from './administration-owner';
import type {
  AdministrationAction,
  AdministrationResult,
  AdministrationSettings,
} from '../shared/administration';
import type { DeepShareReview } from '../shared/deep-share-ipc';
import { NativeDocumentWorkspaces } from './native-document-workspaces';

const allowed = () => {};
const account = {
  accountId: 'account-one',
  desktopSessionId: 'session-one',
  email: 'owner@example.test',
};
const selection = {
  workspaceUuid: 'workspace-one',
  rootArtifactId: 'artifact-one',
  selectedConversationIds: [],
};
const review: DeepShareReview = {
  workspace: {
    uuid: selection.workspaceUuid,
    name: 'Project',
    remoteWorkspaceId: 'remote-workspace-one',
  },
  rootArtifactId: selection.rootArtifactId,
  rootArtifact: { id: selection.rootArtifactId, type: 'sequence', name: 'Reviewed sequence' },
  manifest: {
    rootArtifactId: selection.rootArtifactId,
    artifacts: [
      { id: selection.rootArtifactId, type: 'sequence', name: 'Reviewed sequence', required: true },
    ],
    relationships: [],
    files: [],
    chats: [],
    omissions: [],
  },
  files: [],
  chats: [],
  conversationCandidates: [],
  digest: 'content-one',
};
const published = {
  ok: true as const,
  url: 'https://example.test/share',
  shortId: 'short',
  shareId: 'share-one',
  versionId: 'version-one',
  versionNumber: 1,
  versionContentSha256: 'a',
  bundleId: 'bundle-one',
  bundleContentSha256: 'b',
};

function fixture(overrides: Partial<AdministrationOwnerDependencies> = {}) {
  const actions = new Map<string, AdministrationAction>();
  let settings: Partial<AdministrationSettings> = {};
  const deps: AdministrationOwnerDependencies = {
    storage: {
      readSettings: () => structuredClone(settings),
      writeSettings: (values, adopted) => {
        settings = { ...settings, ...Object.fromEntries(adopted.map((key) => [key, values[key]])) };
      },
      readAction: (id) => (actions.has(id) ? structuredClone(actions.get(id)!) : null),
      writeAction: (action) => {
        actions.set(action.id, structuredClone(action));
      },
    },
    account: async () => account,
    prepareShare: async () => review,
    publishShare: vi.fn(async () => published),
    migration: async () => null,
    actOnMigration: vi.fn(),
    requestApproval: vi.fn(async () => true),
    beginHandoff: vi.fn(async () => {}),
    observeHandoff: async () => ({
      completed: false,
      message: 'Awaiting the actual settings change.',
    }),
    ...overrides,
  };
  const owner = new AdministrationOwner(deps);
  const settled = async (id: string) => {
    await vi.waitFor(
      () => expect(['awaiting-human', 'executing']).not.toContain(actions.get(id)?.state),
      { interval: 1, timeout: 1000 }
    );
    return action(
      await owner.execute({ operation: { kind: 'inspect-action', actionId: id } }, allowed)
    );
  };
  return { owner, deps, actions, settled };
}

function action(result: AdministrationResult): AdministrationAction {
  expect(result.kind).toBe('action');
  if (result.kind !== 'action') throw new Error(JSON.stringify(result));
  return result.action;
}

describe('native administration owner', () => {
  it('does not echo a capability when shared-link preparation fails', async () => {
    const sourceUrl =
      'dnaforge://import-share?shortId=shortid01&token=private_capability_not_for_errors';
    const { owner } = fixture({
      prepareShareImport: async () => {
        throw new Error(`Rejected source ${sourceUrl}`);
      },
    });
    const result = await owner.execute(
      { operation: { kind: 'prepare-share-import', sourceUrl } },
      allowed
    );
    expect(result).toMatchObject({
      kind: 'failed',
      code: 'ADMINISTRATION_SHARE_IMPORT_PREPARATION_FAILED',
      stateChanged: false,
    });
    expect(JSON.stringify(result)).not.toContain('private_capability');
    expect(JSON.stringify(result)).not.toContain(sourceUrl);
  });
  it('retries one failed preference without silently persisting another failed choice', async () => {
    const { owner, deps } = fixture();
    const write = deps.storage.writeSettings;
    deps.storage.writeSettings = () => {
      throw new Error('Selected key storage refused');
    };
    await owner.execute(
      { operation: { kind: 'adopt-settings', patch: { theme: 'dark' } } },
      allowed
    );
    const selected = await owner.execute(
      { operation: { kind: 'adopt-settings', patch: { assemblyColorScheme: 'carbon' } } },
      allowed
    );
    expect(selected).toMatchObject({
      kind: 'settings',
      snapshot: { unsavedKeys: ['theme', 'assemblyColorScheme'] },
    });
    if (selected.kind !== 'settings') throw new Error('Missing accepted preferences');
    deps.storage.writeSettings = write;
    const retried = await owner.execute(
      {
        operation: {
          kind: 'retry-settings',
          expectedRevision: selected.snapshot.revision,
          keys: ['assemblyColorScheme'],
        },
      },
      allowed
    );
    expect(retried).toMatchObject({
      kind: 'settings',
      snapshot: {
        values: { theme: 'dark', assemblyColorScheme: 'carbon' },
        unsavedKeys: ['theme'],
      },
    });
    expect(deps.storage.readSettings()).toEqual({ assemblyColorScheme: 'carbon' });
  });
  it('refuses an old prepared action after its real project enrollment is removed and renewed', async () => {
    const workspaces = new NativeDocumentWorkspaces({ resolveRoot: async (root) => root });
    await workspaces.replaceRoots(['/managed/project']);
    const { owner, deps } = fixture({
      captureTargetAuthority: async () => workspaces.capture('/managed/project'),
    });
    const prepared = action(
      await owner.execute({ operation: { kind: 'prepare-share', selection } }, allowed)
    );
    await workspaces.replaceRoots([]);
    await workspaces.replaceRoots(['/managed/project']);
    const result = await owner.execute(
      {
        operation: {
          kind: 'execute-action',
          actionId: prepared.id,
          expectedRevision: prepared.revision,
        },
      },
      allowed
    );
    expect(result).toMatchObject({ kind: 'failed', stateChanged: false });
    expect(deps.requestApproval).not.toHaveBeenCalled();
    expect(deps.publishShare).not.toHaveBeenCalled();
  });
  it('keeps actual native zoom separate from selected values and never persists a refused native factor', async () => {
    const { owner, deps } = fixture({
      applySettings: () => ({ status: 'failed', reason: 'apply_failed', factor: 1 }),
    });
    const selected = await owner.execute(
      { operation: { kind: 'adopt-settings', patch: { displayZoom: 1.25 } } },
      allowed
    );
    expect(selected).toMatchObject({
      kind: 'settings',
      snapshot: {
        values: { displayZoom: 1.25 },
        zoom: { status: 'failed', factor: 1 },
        persistence: 'unsaved',
      },
    });
    expect(deps.storage.readSettings()).not.toHaveProperty('displayZoom');
    if (selected.kind !== 'settings') throw new Error('Missing selection');
    deps.applySettings = () => ({ status: 'applied', factor: 1.25 });
    expect(
      await owner.execute(
        { operation: { kind: 'retry-settings', expectedRevision: selected.snapshot.revision } },
        allowed
      )
    ).toMatchObject({
      kind: 'settings',
      snapshot: { zoom: { status: 'applied', factor: 1.25 }, persistence: 'saved' },
    });
    expect(deps.storage.readSettings()).toMatchObject({ displayZoom: 1.25 });
  });

  it('retains sanitized import review, waits once, and imports the same frozen destination', async () => {
    const sourceUrl =
      'dnaforge://import-share?shortId=shortid01&token=secret_capability_never_returned';
    const review = {
      source: {
        shareId: 'share-source',
        shortId: 'shortid01',
        bundleSha256: 'bundle-digest',
        artifactName: 'Reviewed sequence',
        fileCount: 2,
        conversationCount: 1,
        totalBytes: 1234,
      },
      destination: {
        kind: 'new-private-project' as const,
        workspaceUuid: 'fork-id',
        displayName: 'Reviewed sequence private fork',
        repoPath: '/managed/fork-id/repo',
      },
    };
    const imported = {
      workspaceUuid: 'fork-id',
      displayName: review.destination.displayName,
      repoPath: review.destination.repoPath,
      warnings: [],
    };
    const apply = vi.fn(async (assertAuthority: () => Promise<void>) => {
      await assertAuthority();
      return imported;
    });
    const { owner, deps, actions, settled } = fixture({
      prepareShareImport: async () => ({ review, apply, assertCurrent: () => {} }),
      authorizeAgent: async () => {},
    });
    const agent = { identityId: 'agent-import', capabilities: ['*'] };
    const prepared = action(
      await owner.execute(
        { operation: { kind: 'prepare-share-import', sourceUrl } },
        allowed,
        agent
      )
    );
    expect(prepared.target).toEqual({ kind: 'share-import', review });
    expect(JSON.stringify([...actions.values()])).not.toContain('secret_capability');
    expect(apply).not.toHaveBeenCalled();
    await owner.execute(
      {
        operation: {
          kind: 'execute-action',
          actionId: prepared.id,
          expectedRevision: prepared.revision,
        },
      },
      allowed,
      agent
    );
    const completed = await settled(prepared.id);
    expect(completed).toMatchObject({ state: 'completed', result: imported });
    await owner.execute(
      {
        operation: {
          kind: 'execute-action',
          actionId: completed.id,
          expectedRevision: completed.revision,
        },
      },
      allowed,
      agent
    );
    expect(apply).toHaveBeenCalledTimes(1);
    expect(deps.requestApproval).toHaveBeenCalledTimes(1);
  });

  it('returns promptly for a human decision, refuses duplicate execution and checks revocation before publication', async () => {
    let decide!: (value: boolean) => void;
    let granted = true;
    const agent = { identityId: 'agent-one', capabilities: ['read-workspace', 'write-workspace'] };
    const { owner, deps, actions } = fixture({
      requestApproval: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            decide = resolve;
          })
      ),
      authorizeAgent: async () => {
        if (!granted) throw new Error('ADMINISTRATION_CAPABILITY_DENIED: Grant revoked.');
      },
    });
    const prepared = action(
      await owner.execute({ operation: { kind: 'prepare-share', selection } }, allowed, agent)
    );
    const pending = action(
      await owner.execute(
        {
          operation: {
            kind: 'execute-action',
            actionId: prepared.id,
            expectedRevision: prepared.revision,
          },
        },
        allowed,
        agent
      )
    );
    expect(pending.state).toBe('awaiting-human');
    expect(
      action(
        await owner.execute(
          {
            operation: {
              kind: 'execute-action',
              actionId: pending.id,
              expectedRevision: pending.revision,
            },
          },
          allowed,
          agent
        )
      ).state
    ).toBe('awaiting-human');
    expect(deps.requestApproval).toHaveBeenCalledTimes(1);
    granted = false;
    decide(true);
    await vi.waitFor(() => expect(actions.get(prepared.id)?.state).toBe('stale'), {
      interval: 1,
      timeout: 1000,
    });
    expect(deps.publishShare).not.toHaveBeenCalled();
  });

  it('does not let an agent execute a human preparation or another identity preparation', async () => {
    const { owner, deps } = fixture({ authorizeAgent: async () => {} });
    const prepared = action(
      await owner.execute({ operation: { kind: 'prepare-share', selection } }, allowed)
    );
    const result = await owner.execute(
      {
        operation: {
          kind: 'execute-action',
          actionId: prepared.id,
          expectedRevision: prepared.revision,
        },
      },
      allowed,
      { identityId: 'other-agent', capabilities: ['read-workspace', 'write-workspace'] }
    );
    expect(result).toMatchObject({
      kind: 'failed',
      code: 'ADMINISTRATION_ACTION_DENIED',
      stateChanged: false,
    });
    expect(result).not.toHaveProperty('action');
    expect(deps.publishShare).not.toHaveBeenCalled();
  });

  it('shares settings across callers and refuses an obsolete human revision without prompting', async () => {
    const { owner, deps } = fixture();
    const before = await owner.execute({ operation: { kind: 'inspect-settings' } }, allowed);
    if (before.kind !== 'settings') throw new Error('Missing settings');
    const updated = await owner.execute(
      {
        operation: {
          kind: 'update-settings',
          expectedRevision: before.snapshot.revision,
          patch: { theme: 'dark', displayZoom: 0.25 },
        },
      },
      allowed
    );
    expect(updated).toMatchObject({
      kind: 'settings',
      snapshot: { values: { theme: 'dark', displayZoom: 0.25 }, persistence: 'saved' },
    });
    expect(
      await owner.execute(
        {
          operation: {
            kind: 'update-settings',
            expectedRevision: before.snapshot.revision,
            patch: { theme: 'light' },
          },
        },
        allowed
      )
    ).toMatchObject({ kind: 'failed', code: 'STALE_ADMINISTRATION_SETTINGS', stateChanged: false });
    expect(deps.requestApproval).not.toHaveBeenCalled();
  });

  it('adopts each legacy preference once without losing preferences during a partial migration', async () => {
    const { owner, deps } = fixture();
    await owner.execute(
      { operation: { kind: 'adopt-settings', patch: { displayZoom: 2 } } },
      allowed
    );
    const restarted = new AdministrationOwner(deps);
    const adopted = await restarted.execute(
      { operation: { kind: 'adopt-settings', patch: { theme: 'dark', displayZoom: 1 } } },
      allowed
    );
    expect(adopted).toMatchObject({
      kind: 'settings',
      snapshot: { values: { displayZoom: 2, theme: 'dark' } },
    });
  });

  it('retains accepted unsaved preferences and retries the same native working values', async () => {
    const { owner, deps } = fixture();
    const original = deps.storage.writeSettings;
    deps.storage.writeSettings = () => {
      throw new Error('disk write refused');
    };
    const result = await owner.execute(
      { operation: { kind: 'adopt-settings', patch: { theme: 'dark' } } },
      allowed
    );
    expect(result).toMatchObject({
      kind: 'settings',
      snapshot: { values: { theme: 'dark' }, persistence: 'unsaved' },
    });
    if (result.kind !== 'settings') throw new Error('Missing accepted preferences');
    deps.storage.writeSettings = original;
    expect(
      await owner.execute(
        { operation: { kind: 'retry-settings', expectedRevision: result.snapshot.revision } },
        allowed
      )
    ).toMatchObject({
      kind: 'settings',
      snapshot: { values: { theme: 'dark' }, persistence: 'saved' },
    });
  });

  it('publishes the reviewed action once and observes its durable result after owner replacement', async () => {
    const { owner, deps, settled } = fixture();
    const prepared = action(
      await owner.execute({ operation: { kind: 'prepare-share', selection } }, allowed)
    );
    const pending = action(
      await owner.execute(
        {
          operation: {
            kind: 'execute-action',
            actionId: prepared.id,
            expectedRevision: prepared.revision,
          },
        },
        allowed
      )
    );
    expect(pending.state).toBe('awaiting-human');
    const completed = await settled(prepared.id);
    expect(completed).toMatchObject({ state: 'completed', result: published });
    const restarted = new AdministrationOwner(deps);
    expect(
      await restarted.execute(
        {
          operation: {
            kind: 'execute-action',
            actionId: completed.id,
            expectedRevision: completed.revision,
          },
        },
        allowed
      )
    ).toMatchObject({ kind: 'action', action: { state: 'completed', result: published } });
    expect(deps.publishShare).toHaveBeenCalledExactlyOnceWith(
      selection,
      review.digest,
      account.accountId,
      expect.any(Function)
    );
    expect(deps.requestApproval).toHaveBeenCalledTimes(1);
  });

  it('refuses changed share bytes after the human decision', async () => {
    const { owner, deps, settled } = fixture();
    const prepared = action(
      await owner.execute({ operation: { kind: 'prepare-share', selection } }, allowed)
    );
    deps.prepareShare = async () => ({ ...review, digest: 'outside-change' });
    await owner.execute(
      {
        operation: {
          kind: 'execute-action',
          actionId: prepared.id,
          expectedRevision: prepared.revision,
        },
      },
      allowed
    );
    expect(await settled(prepared.id)).toMatchObject({ state: 'stale' });
    expect(deps.publishShare).not.toHaveBeenCalled();
  });

  it('seals prepared content and results after account or session replacement', async () => {
    const { owner, deps } = fixture();
    const prepared = action(
      await owner.execute({ operation: { kind: 'prepare-share', selection } }, allowed)
    );
    deps.account = async () => ({ ...account, desktopSessionId: 'different-session' });
    for (const operation of [
      { kind: 'inspect-action', actionId: prepared.id },
      { kind: 'execute-action', actionId: prepared.id, expectedRevision: prepared.revision },
    ] as const) {
      const result = await owner.execute({ operation }, allowed);
      expect(result).toMatchObject({
        kind: 'failed',
        code: 'ADMINISTRATION_ACCOUNT_CHANGED',
        stateChanged: false,
      });
      expect(result).not.toHaveProperty('action');
    }
    expect(deps.publishShare).not.toHaveBeenCalled();
  });

  it('cancels an exact pending native decision without publishing', async () => {
    let signal: AbortSignal | null = null;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { owner, deps } = fixture({
      requestApproval: async (_action, abort) => {
        signal = abort;
        reached();
        return new Promise<boolean>((resolve) =>
          abort.addEventListener('abort', () => resolve(false), { once: true })
        );
      },
    });
    const prepared = action(
      await owner.execute({ operation: { kind: 'prepare-share', selection } }, allowed)
    );
    const executing = owner.execute(
      {
        operation: {
          kind: 'execute-action',
          actionId: prepared.id,
          expectedRevision: prepared.revision,
        },
      },
      allowed
    );
    await waiting;
    const current = action(
      await owner.execute({ operation: { kind: 'inspect-action', actionId: prepared.id } }, allowed)
    );
    expect(
      action(
        await owner.execute(
          {
            operation: {
              kind: 'cancel-action',
              actionId: current.id,
              expectedRevision: current.revision,
            },
          },
          allowed
        )
      ).state
    ).toBe('cancelled');
    expect(await executing).toMatchObject({ kind: 'action', action: { state: 'awaiting-human' } });
    expect(
      await owner.execute({ operation: { kind: 'inspect-action', actionId: prepared.id } }, allowed)
    ).toMatchObject({ kind: 'action', action: { state: 'cancelled' } });
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(deps.publishShare).not.toHaveBeenCalled();
  });

  it('does not replay publication whose process ended without a result', async () => {
    const { owner, deps, actions } = fixture();
    const prepared = action(
      await owner.execute({ operation: { kind: 'prepare-share', selection } }, allowed)
    );
    actions.set(prepared.id, { ...prepared, state: 'executing' });
    const restarted = new AdministrationOwner(deps);
    const observed = action(
      await restarted.execute(
        { operation: { kind: 'inspect-action', actionId: prepared.id } },
        allowed
      )
    );
    expect(observed.state).toBe('unresolved');
    await restarted.execute(
      {
        operation: {
          kind: 'execute-action',
          actionId: observed.id,
          expectedRevision: observed.revision,
        },
      },
      allowed
    );
    expect(deps.publishShare).not.toHaveBeenCalled();
  });

  it('retains uncertain server outcomes and never treats inspection as retry', async () => {
    const { owner, deps, settled } = fixture({
      publishShare: vi.fn(async () => {
        throw new Error('connection lost after request');
      }),
    });
    const prepared = action(
      await owner.execute({ operation: { kind: 'prepare-share', selection } }, allowed)
    );
    await owner.execute(
      {
        operation: {
          kind: 'execute-action',
          actionId: prepared.id,
          expectedRevision: prepared.revision,
        },
      },
      allowed
    );
    expect(await settled(prepared.id)).toMatchObject({
      state: 'unresolved',
      message: 'connection lost after request',
    });
    expect(deps.publishShare).toHaveBeenCalledTimes(1);
  });

  it('only completes a handoff when its existing feature observes the actual outcome', async () => {
    const { owner, deps } = fixture();
    const prepared = action(
      await owner.execute(
        {
          operation: {
            kind: 'prepare-handoff',
            target: { purpose: 'provider-setup', providerId: 'provider-one' },
          },
        },
        allowed
      )
    );
    const waiting = action(
      await owner.execute(
        {
          operation: {
            kind: 'execute-action',
            actionId: prepared.id,
            expectedRevision: prepared.revision,
          },
        },
        allowed
      )
    );
    expect(waiting.state).toBe('awaiting-human');
    expect(
      action(
        await owner.execute(
          { operation: { kind: 'inspect-action', actionId: waiting.id } },
          allowed
        )
      ).state
    ).toBe('awaiting-human');
    deps.observeHandoff = async () => ({ completed: true, message: 'Provider is connected.' });
    expect(
      action(
        await owner.execute(
          { operation: { kind: 'inspect-action', actionId: waiting.id } },
          allowed
        )
      ).state
    ).toBe('completed');
    expect(deps.beginHandoff).toHaveBeenCalledTimes(1);
  });
});
