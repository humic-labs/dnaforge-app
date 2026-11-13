import { describe, it, expect, beforeEach } from 'vitest';
import {
  createConversation,
  addMessage,
  deleteConversation,
  deleteMessage,
  getConnection,
  getMessageReferences,
  getMessageReferencesForMessages,
  setMessageReferences,
} from './index';
import { initializeTestSchema } from '../test/initializeTestSchema';
import '../platform/browser-mock';
import {
  createEntityReference,
  getEntityReference,
  getEntityReferencesByIds,
  linkReferenceToMessage,
  getReferencesForMessage,
  updateEntityReference,
  recordRevision,
  getRevisions,
  prepareEntityReferenceRow,
  setEntityReferenceWorkspaceRootPathIfMissing,
} from './entity-references';

describe('entity_references CRUD', () => {
  beforeEach(async () => {
    await initializeTestSchema();
  });

  it('creates and retrieves an entity reference', async () => {
    const ref = await createEntityReference({
      entityType: 'sequence',
      displayLabel: 'pUC19',
      locator: 'git://lab/plasmids/pUC19.gb@abc123',
      deepLinkParams: null,
      data: null,
      source: 'ai',
      workspaceScope: '/lab/project.waypoint-workspace',
      workspaceRootPath: '/lab',
    });

    expect(ref.id).toBeTruthy();
    expect(ref.entity_type).toBe('sequence');
    expect(ref.display_label).toBe('pUC19');
    expect(ref.workspace_scope).toBe('/lab/project.waypoint-workspace');
    expect(ref.workspace_root_path).toBe('/lab');

    const fetched = await getEntityReference(ref.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.locator).toBe('git://lab/plasmids/pUC19.gb@abc123');
    expect(fetched!.workspace_scope).toBe('/lab/project.waypoint-workspace');
    expect(fetched!.workspace_root_path).toBe('/lab');
  });

  it('rejects every new filesystem reference that lacks immutable root authority', () => {
    expect(() =>
      prepareEntityReferenceRow({
        entityType: 'sequence',
        displayLabel: 'pUC19',
        locator: 'git://lab/pUC19.gb',
        deepLinkParams: null,
        data: null,
        source: 'ai',
        workspaceScope: 'folders:["/lab"]',
        workspaceRootPath: null,
      })
    ).toThrow(/immutable project root/i);
  });

  it('rejects a view-bound selection before unresolved residue identities can be persisted', () => {
    const parent = '33290000-0000-4000-8000-000000000002';
    expect(() =>
      prepareEntityReferenceRow({
        entityType: 'structure',
        displayLabel: 'Missing identities',
        locator: `entity://molecular-view-target/${parent}/detail/view`,
        data: {
          kind: 'structure',
          molecularViewTarget: {
            kind: 'molecular-view-target',
            version: 1,
            viewReferenceId: parent,
            viewId: 'detail',
          },
        },
        deepLinkParams: null,
        source: 'user',
        workspaceScope: null,
        workspaceRootPath: '/project',
      })
    ).toThrow(/identity-complete|residue identities/i);
  });

  it('rejects a molecular document disguised as a raw structure reference', () => {
    expect(() =>
      prepareEntityReferenceRow({
        entityType: 'structure',
        displayLabel: 'Current document',
        locator: 'entity://structure/molecular-document:document-1',
        deepLinkParams: null,
        data: null,
        source: 'user',
        workspaceScope: null,
        workspaceRootPath: '/project',
      })
    ).toThrow(/molecular.*(?:target|document|view)/i);
  });

  it('backfills a historical root once and never lets a later click replace it', async () => {
    const sqlite = await getConnection();
    await sqlite.execute(
      `INSERT INTO entity_references (
        id, entity_type, display_label, locator, source, status,
        workspace_scope, workspace_root_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'legacy-ref',
        'sequence',
        'pUC19',
        'git://lab/pUC19.gb',
        'ai',
        'created',
        'folders:["/original/lab"]',
        null,
        1,
        1,
      ]
    );

    await expect(
      setEntityReferenceWorkspaceRootPathIfMissing('legacy-ref', '/original/lab')
    ).resolves.toBe('/original/lab');
    await expect(
      setEntityReferenceWorkspaceRootPathIfMissing('legacy-ref', '/replacement/lab')
    ).resolves.toBe('/original/lab');
  });

  it('links references to messages and retrieves them', async () => {
    const ref = await createEntityReference({
      entityType: 'sequence',
      displayLabel: 'pUC19',
      locator: 'git://lab/plasmids/pUC19.gb',
      deepLinkParams: null,
      data: null,
      source: 'ai',
      workspaceScope: null,
      workspaceRootPath: '/lab',
    });

    const messageId = crypto.randomUUID();
    await linkReferenceToMessage(messageId, ref.id, 0);

    const refs = await getReferencesForMessage(messageId);
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe(ref.id);
    expect(refs[0].display_label).toBe('pUC19');
  });

  it('setMessageReferences persists structured ids in order; getMessageReferences reads them ', async () => {
    const refA = await createEntityReference({
      entityType: 'sequence',
      displayLabel: 'A',
      locator: 'git://x/a.gb',
      deepLinkParams: null,
      data: null,
      source: 'user',
      workspaceScope: null,
      workspaceRootPath: '/x',
    });
    const refB = await createEntityReference({
      entityType: 'sequence',
      displayLabel: 'B',
      locator: 'git://x/b.gb',
      deepLinkParams: null,
      data: null,
      source: 'user',
      workspaceScope: null,
      workspaceRootPath: '/x',
    });
    const messageId = crypto.randomUUID();

    await setMessageReferences(messageId, [refA.id, refB.id]);
    expect(await getMessageReferences(messageId)).toEqual([refA.id, refB.id]);

    await setMessageReferences(messageId, [refB.id]);
    expect(await getMessageReferences(messageId)).toEqual([refB.id]);

    expect(await getMessageReferences(crypto.randomUUID())).toEqual([]);
  });

  it('loads structured references for a message history in one bulk projection', async () => {
    const refA = await createEntityReference({
      entityType: 'sequence',
      displayLabel: 'A',
      locator: 'git://x/a.gb',
      deepLinkParams: null,
      data: null,
      source: 'user',
      workspaceScope: null,
      workspaceRootPath: '/x',
    });
    const refB = await createEntityReference({
      entityType: 'sequence',
      displayLabel: 'B',
      locator: 'git://x/b.gb',
      deepLinkParams: null,
      data: null,
      source: 'user',
      workspaceScope: null,
      workspaceRootPath: '/x',
    });
    await setMessageReferences('message-a', [refB.id, refA.id]);
    await setMessageReferences('message-b', [refA.id]);

    const refsByMessage = await getMessageReferencesForMessages([
      'message-a',
      'message-b',
      'message-empty',
    ]);

    expect(refsByMessage).toEqual(
      new Map([
        ['message-a', [refB.id, refA.id]],
        ['message-b', [refA.id]],
        ['message-empty', []],
      ])
    );
  });

  it('deleteMessage clears the message_references join rows ', async () => {
    const ref = await createEntityReference({
      entityType: 'sequence',
      displayLabel: 'pUC19',
      locator: 'git://x/pUC19.gb',
      deepLinkParams: null,
      data: null,
      source: 'user',
      workspaceScope: null,
      workspaceRootPath: '/x',
    });
    const messageId = crypto.randomUUID();
    await setMessageReferences(messageId, [ref.id]);
    expect(await getMessageReferences(messageId)).toEqual([ref.id]);

    await deleteMessage(messageId);
    expect(await getMessageReferences(messageId)).toEqual([]);
  });

  it('records and retrieves revision history', async () => {
    const ref = await createEntityReference({
      entityType: 'primer',
      displayLabel: 'GFP_F1',
      locator: 'entity://primer/test',
      deepLinkParams: { bindingStart: 100, bindingEnd: 120 },
      data: { sequence: 'ATGCGA', tm: 60 },
      source: 'ai',
      workspaceScope: null,
      workspaceRootPath: null,
    });

    await recordRevision({
      referenceId: ref.id,
      changedBy: 'user',
      changeType: 'data_updated',
      previousState: { tm: 60 },
      newState: { tm: 65 },
    });

    const revisions = await getRevisions(ref.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].changed_by).toBe('user');
    expect(revisions[0].revision_number).toBe(1);
  });

  it('deletes message_references when conversation is deleted', async () => {
    const conv = await createConversation('conv-1', 'Test', '/ws');
    const msgId = crypto.randomUUID();
    await addMessage({
      id: msgId,
      conversation_id: conv.id,
      role: 'assistant',
      content: 'Hello [[ref:r1]]',
      tool_name: null,
      tool_call_id: null,
      created_at: Date.now(),
    });
    const ref = await createEntityReference({
      entityType: 'sequence',
      displayLabel: 'pUC19',
      locator: 'git://lab/plasmids/pUC19.gb',
      deepLinkParams: null,
      data: null,
      source: 'ai',
      workspaceScope: null,
      workspaceRootPath: '/lab',
    });
    await linkReferenceToMessage(msgId, ref.id, 0);

    const before = await getReferencesForMessage(msgId);
    expect(before).toHaveLength(1);

    await deleteConversation(conv.id);

    const sqlite = await getConnection();
    const rows = await sqlite.select<{ message_id: string }[]>(
      `SELECT message_id FROM message_references WHERE message_id = ?`,
      [msgId]
    );
    expect(rows).toHaveLength(0);
  });

  it('retrieves more than 100 references by chunking', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 150; i++) {
      const ref = await createEntityReference({
        entityType: 'sequence',
        displayLabel: `Seq${i}`,
        locator: `git://lab/seq${i}.gb`,
        deepLinkParams: null,
        data: null,
        source: 'ai',
        workspaceScope: null,
        workspaceRootPath: '/lab',
      });
      ids.push(ref.id);
    }

    const results = await getEntityReferencesByIds(ids);
    expect(results).toHaveLength(150);
  });

  it('skips DB update when no fields changed', async () => {
    const ref = await createEntityReference({
      entityType: 'sequence',
      displayLabel: 'pUC19',
      locator: 'git://lab/pUC19.gb',
      deepLinkParams: null,
      data: null,
      source: 'ai',
      workspaceScope: null,
      workspaceRootPath: '/lab',
    });

    const originalUpdatedAt = ref.updated_at;

    await new Promise((r) => setTimeout(r, 5));

    await updateEntityReference(ref.id, {});

    const after = await getEntityReference(ref.id);
    expect(after!.updated_at).toBe(originalUpdatedAt);
  });

  it('assigns unique sequential revision numbers', async () => {
    const ref = await createEntityReference({
      entityType: 'primer',
      displayLabel: 'Test',
      locator: 'entity://primer/test',
      deepLinkParams: null,
      data: null,
      source: 'ai',
      workspaceScope: null,
      workspaceRootPath: null,
    });

    const r1 = await recordRevision({
      referenceId: ref.id,
      changedBy: 'user',
      changeType: 'update',
      previousState: null,
      newState: { v: 1 },
    });
    const r2 = await recordRevision({
      referenceId: ref.id,
      changedBy: 'user',
      changeType: 'update',
      previousState: null,
      newState: { v: 2 },
    });
    const r3 = await recordRevision({
      referenceId: ref.id,
      changedBy: 'user',
      changeType: 'update',
      previousState: null,
      newState: { v: 3 },
    });

    expect(r1.revision_number).toBe(1);
    expect(r2.revision_number).toBe(2);
    expect(r3.revision_number).toBe(3);
  });
});
