import { userMessage } from '@waypoint/user-messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntityDetailsSession } from './session';
import { SavedDocumentCompletionError } from '../../services/saved-document-completion';
import type { EntityDetailsDefinition, EntityDetailsPorts, EntityDetailsValues } from './types';
import {
  freezeWorkspaceEditorWrites,
  getWorkspaceEditorBlockers,
} from '../../services/workspace-editor-mutation-state';

const sessions: EntityDetailsSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.discard();
    session.dispose();
  }
});

function setup() {
  let data: EntityDetailsValues = {
    name: 'Specimen',
    fields: { count: 3, future: { version: 9, payload: ['retained'] } },
    schema: {
      schemaId: 'specimen',
      schemaRevisionId: 'specimen-v1',
      name: 'future_kind',
      displayName: 'Specimen',
      baseKind: 'record',
      version: 1,
      fields: [{ key: 'count', label: 'Count', type: 'number' }],
    },
    refreshGeneticCodeRevision: false,
  };
  const save = vi.fn(async (update: EntityDetailsValues) => {
    data = update;
  });
  const definition = (): EntityDetailsDefinition => ({
    record: {
      ...data,
      id: 'specimen-1',
      path: '/workspace/specimen.entity.json',
      registryId: 's1',
      registrationStatus: 'registered',
      preview: null,
      properties: {},
    },
    save,
  });
  const ports: EntityDetailsPorts = {
    load: vi.fn(async () => definition()),
    history: vi.fn(async () => []),
    changed: vi.fn(),
  };
  const session = new EntityDetailsSession({ entityId: 'specimen-1' }, ports);
  sessions.push(session);
  return { session, save, ports, definition };
}

describe('entity-owned metadata session', () => {
  it('does not replace a completed save with a read started before that save', async () => {
    const { session, save, ports, definition } = setup();
    await session.load();
    const old = definition();
    let finish!: (value: EntityDetailsDefinition) => void;
    vi.mocked(ports.load).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const refresh = session.load();
    session.stage('count', { valid: true, value: 27 });
    await session.save();
    finish(old);
    await refresh;
    expect(save).toHaveBeenCalledOnce();
    expect(session.getSnapshot().draft?.fields.count).toBe(27);
    expect(session.getSnapshot().requiresReload).toBe(false);
  });

  it('opens an unfinished native save with completion retry without writing a second revision', async () => {
    const { session, save, ports, definition } = setup();
    let pending = true;
    const complete = vi.fn(async () => {
      pending = false;
    });
    ports.load = vi.fn(async () => ({
      ...definition(),
      ...(pending ? { pendingCompletion: complete } : {}),
    }));
    await session.load();
    expect(session.getSnapshot()).toMatchObject({
      requiresReload: true,
      completionPending: true,
      saveConfirmed: true,
    });
    session.discard();
    expect(session.getSnapshot().completionPending).toBe(true);
    await session.retryCompletion();
    expect(complete).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({
      requiresReload: false,
      completionPending: false,
    });
    expect(session.getSnapshot().definition?.record.id).toBe('specimen-1');
  });

  it('keeps pending custody changes blocked until every owning host releases its hold', async () => {
    const { session, save } = setup();
    await session.load();
    session.stage('count', { valid: true, value: 4 });
    const releaseRegistry = session.holdMutations('Finish the Registry change first.');
    const releaseEntity = session.holdMutations('Finish the entity change first.');
    const action = vi.fn(async () => {});
    await session.save();
    await session.performAction(action);
    expect(save).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    releaseRegistry();
    releaseRegistry();
    await session.save();
    expect(save).not.toHaveBeenCalled();
    expect(session.getSnapshot().draft?.fields.count).toBe(4);
    releaseEntity();
    await session.save();
    expect(save).toHaveBeenCalledOnce();
    expect(session.getSnapshot().definition?.record.fields.count).toBe(4);
  });

  it('keeps a missing optional field absent after clearing while saving zero and false changes', async () => {
    const { session, save } = setup();
    await session.load();
    session.stage('description', { valid: true, value: 'A temporary draft' });
    expect(session.dirty).toBe(true);
    session.stage('description', { valid: true, value: '' });
    expect(session.dirty).toBe(false);
    expect(session.getSnapshot().draft?.fields).not.toHaveProperty('description');
    session.stage('count', { valid: true, value: 0 });
    session.stage('enabled', { valid: true, value: false });
    await session.save();
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0].fields).toEqual({
      count: 0,
      enabled: false,
      future: { version: 9, payload: ['retained'] },
    });
  });

  it('shares drafts with two hosts and keeps unknown values through save and readback', async () => {
    const { session, save } = setup();
    await session.load();
    const registry = vi.fn();
    const entity = vi.fn();
    const detachRegistry = session.subscribe(registry);
    const detachEntity = session.subscribe(entity);
    session.stage('count', { valid: true, value: 4 });
    expect(registry).toHaveBeenCalled();
    expect(entity).toHaveBeenCalled();
    detachRegistry();
    expect(session.getSnapshot().draft?.fields.count).toBe(4);
    expect(session.dispose()).toBe(false);
    await session.save();
    expect(save).toHaveBeenCalledOnce();
    expect(session.getSnapshot().definition?.record.fields).toEqual({
      count: 4,
      future: { version: 9, payload: ['retained'] },
    });
    expect(session.dirty).toBe(false);
    detachEntity();
  });

  it('retains a failed draft and blocks closing until it is saved or discarded', async () => {
    const { session, save } = setup();
    await session.load();
    save.mockRejectedValueOnce(new Error('Project is busy.'));
    session.stage('count', { valid: true, value: 5 });
    await session.save();
    const close = vi.fn();
    session.requestClose(close);
    expect(close).not.toHaveBeenCalled();
    expect(session.getSnapshot().draft?.fields.count).toBe(5);
    expect(session.dirty).toBe(true);
    await session.save();
    expect(save).toHaveBeenCalledTimes(2);
    session.requestClose(close);
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not replay a committed write when refreshed metadata cannot be loaded', async () => {
    const { session, save, ports } = setup();
    await session.load();
    vi.mocked(ports.load).mockRejectedValueOnce(new Error('Read temporarily unavailable.'));
    session.stage('count', { valid: true, value: 6 });
    await session.save();
    expect(session.getSnapshot().error).toContain(userMessage('document.saveRefreshPending'));
    expect(session.dirty).toBe(false);
    expect(session.getSnapshot().requiresReload).toBe(true);
    await session.save();
    expect(save).toHaveBeenCalledOnce();
    await session.load();
    expect(session.getSnapshot().definition?.record.fields.count).toBe(6);
    expect(session.getSnapshot().requiresReload).toBe(false);
  });

  it('keeps one pending write and refuses discard or another save while it is running', async () => {
    const { session, save } = setup();
    await session.load();
    let finish!: () => void;
    save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    session.stage('count', { valid: true, value: 7 });
    const first = session.save();
    session.discard();
    session.stage('count', { valid: true, value: 8 });
    await session.save();
    expect(session.getSnapshot().draft?.fields.count).toBe(7);
    expect(save).toHaveBeenCalledOnce();
    expect(
      getWorkspaceEditorBlockers({
        workspaceRoot: '/workspace',
        affectedEntityIds: ['specimen-1'],
      }).some((blocker) => blocker.state === 'saving')
    ).toBe(true);
    finish();
    await first;
    expect(session.getSnapshot().saving).toBe(false);
  });

  it('retries only completion of a committed write and retains the block through a failed retry', async () => {
    const { session, save } = setup();
    await session.load();
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new Error('Still unavailable'))
      .mockResolvedValue(undefined);
    const write = save.getMockImplementation()!;
    save.mockImplementationOnce(async (update) => {
      await write(update);
      throw new SavedDocumentCompletionError('Saved; Registry refresh is pending.', complete);
    });
    session.stage('count', { valid: true, value: 12 });
    await session.save();
    expect(session.dirty).toBe(false);
    expect(session.getSnapshot().completionPending).toBe(true);
    session.discard();
    const close = vi.fn();
    session.requestClose(close);
    expect(close).not.toHaveBeenCalled();
    expect(session.dispose()).toBe(false);
    await session.save();
    await session.retryCompletion();
    expect(session.getSnapshot().completionPending).toBe(true);
    await session.retryCompletion();
    expect(save).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().definition?.record.fields.count).toBe(12);
    expect(session.getSnapshot().savedFields).toEqual(['count']);
    expect(session.getSnapshot().requiresReload).toBe(false);
    expect(session.getSnapshot().completionPending).toBe(false);
    session.requestClose(close);
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not repeat successful completion when its readback fails', async () => {
    const { session, save, ports } = setup();
    await session.load();
    const complete = vi.fn(async () => {});
    const write = save.getMockImplementation()!;
    save.mockImplementationOnce(async (update) => {
      await write(update);
      throw new SavedDocumentCompletionError('Saved; Registry refresh is pending.', complete);
    });
    session.stage('count', { valid: true, value: 13 });
    await session.save();
    vi.mocked(ports.load).mockRejectedValueOnce(new Error('Read unavailable'));
    await session.retryCompletion();
    expect(session.getSnapshot().completionPending).toBe(false);
    expect(session.getSnapshot().requiresReload).toBe(true);
    await session.retryCompletion();
    expect(complete).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(session.getSnapshot().requiresReload).toBe(false);
    expect(session.getSnapshot().draft?.fields.count).toBe(13);
  });

  it('keeps other staged fields when an immediate name save needs completion', async () => {
    const { session, ports, definition, save } = setup();
    const complete = vi.fn(async () => {});
    const rename = vi.fn(async () => {
      throw new SavedDocumentCompletionError('Name saved; refresh is pending.', complete);
    });
    vi.mocked(ports.load).mockResolvedValueOnce({ ...definition(), rename });
    await session.load();
    session.stage('count', { valid: true, value: 14 });
    await session.rename('Renamed');
    expect(session.getSnapshot().draft?.name).toBe('Renamed');
    expect(session.getSnapshot().definition?.record.name).toBe('Renamed');
    expect(session.getSnapshot().draft?.fields.count).toBe(14);
    expect(session.getSnapshot().definition?.record.fields.count).toBe(3);
    await session.retryCompletion();
    expect(session.getSnapshot().draft?.fields.count).toBe(14);
    expect(session.dirty).toBe(true);
    await session.save();
    expect(rename).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Renamed', fields: expect.objectContaining({ count: 14 }) })
    );
  });

  it('updates access restrictions without overwriting an unsaved field', async () => {
    const { session, ports, definition, save } = setup();
    await session.load();
    session.stage('count', { valid: true, value: 9 });
    vi.mocked(ports.load).mockResolvedValueOnce({
      ...definition(),
      record: { ...definition().record, readOnlyReason: userMessage('record.projectArchived') },
    });
    await session.load();
    expect(session.getSnapshot().draft?.fields.count).toBe(9);
    expect(session.getSnapshot().definition?.record.readOnlyReason).toBe('Project is archived.');
    await session.save();
    expect(save).not.toHaveBeenCalled();
  });

  it('refreshes the native baseline after discarding a draft that blocked an external update', async () => {
    const { session, ports, definition } = setup();
    await session.load();
    session.stage('count', { valid: true, value: 5 });
    vi.mocked(ports.load).mockResolvedValue({
      ...definition(),
      record: { ...definition().record, fields: { ...definition().record.fields, count: 9 } },
    });
    await session.load();
    expect(session.getSnapshot().draft?.fields.count).toBe(5);
    session.discard();
    await vi.waitFor(() => expect(session.getSnapshot().draft?.fields.count).toBe(9));
    expect(session.dirty).toBe(false);
  });

  it('releases the saving state when a workspace freeze refuses a name write', async () => {
    const { session, ports, definition } = setup();
    const rename = vi.fn(async () => {});
    vi.mocked(ports.load).mockResolvedValueOnce({ ...definition(), rename });
    await session.load();
    const thaw = freezeWorkspaceEditorWrites({
      workspaceRoot: '/workspace',
      affectedEntityIds: ['specimen-1'],
    });
    try {
      await expect(session.rename('Renamed')).rejects.toThrow('project update');
    } finally {
      thaw();
    }
    expect(session.getSnapshot().saving).toBe(false);
    expect(rename).not.toHaveBeenCalled();
  });

  it('ignores a stale lookup and keeps drafts separate for distinct entity identities', async () => {
    const { session, ports, definition } = setup();
    let first!: (definition: EntityDetailsDefinition) => void;
    vi.mocked(ports.load).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          first = resolve;
        })
    );
    const pending = session.load();
    await session.load();
    first({ ...definition(), record: { ...definition().record, name: 'Stale' } });
    await pending;
    expect(session.getSnapshot().draft?.name).toBe('Specimen');
    const other = new EntityDetailsSession(
      { entityId: 'specimen-2' },
      {
        ...ports,
        load: async () => ({
          ...definition(),
          record: { ...definition().record, id: 'specimen-2' },
        }),
      }
    );
    sessions.push(other);
    await other.load();
    session.stage('count', { valid: true, value: 10 });
    expect(other.getSnapshot().draft?.fields.count).toBe(3);
    session.discard();
    expect(session.getSnapshot().draft?.fields.count).toBe(3);
  });
});
