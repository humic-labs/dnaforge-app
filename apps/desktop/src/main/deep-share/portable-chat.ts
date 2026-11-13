import type Database from 'better-sqlite3';
import type { DeepShareArtifactType, PortableConversationV1 } from '@waypoint/share-bundle';
import { projectPortableConversation } from '../../shared/deep-share-chat-projection';

export interface DeepShareChatArtifact {
  id: string;
  type: DeepShareArtifactType;
  name: string;
  locator: string;
}

export interface DeepShareConversationCandidate {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  exactReferenceCount: number;
}

export function listDeepShareConversationCandidates(
  db: Database.Database,
  input: { workspacePath: string; artifacts: readonly DeepShareChatArtifact[] }
): DeepShareConversationCandidate[] {
  const artifactByLocator = new Map(
    input.artifacts.map((artifact) => [artifact.locator, artifact])
  );
  const rows = db
    .prepare(
      `SELECT c.id, c.title, c.created_at, c.updated_at,
              COUNT(DISTINCT CASE WHEN er.locator IS NOT NULL THEN er.id END) AS exact_reference_count
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id
       LEFT JOIN message_references mr ON mr.message_id = m.id
       LEFT JOIN entity_references er ON er.id = mr.reference_id
       WHERE c.workspace_path = ?
       GROUP BY c.id, c.title, c.created_at, c.updated_at
       ORDER BY c.updated_at DESC, c.id ASC`
    )
    .all(input.workspacePath);

  return rows.flatMap((row) => {
    const record = objectRecord(row);
    if (!record) return [];
    const id = text(record.id);
    const title = text(record.title);
    const createdAt = integer(record.created_at);
    const updatedAt = integer(record.updated_at);
    if (!id || !title || createdAt === null || updatedAt === null) return [];
    const exactReferenceCount = countExactReferences(db, id, artifactByLocator);
    return [{ id, title, createdAt, updatedAt, exactReferenceCount }];
  });
}

export function loadPortableConversation(
  db: Database.Database,
  input: {
    conversationId: string;
    workspacePath: string;
    artifacts: readonly DeepShareChatArtifact[];
  }
): PortableConversationV1 {
  const conversationRecord = objectRecord(
    db
      .prepare(
        `SELECT id, title, created_at, updated_at
         FROM conversations
         WHERE id = ? AND workspace_path = ?
         LIMIT 1`
      )
      .get(input.conversationId, input.workspacePath)
  );
  const conversationId = text(conversationRecord?.id);
  const title = text(conversationRecord?.title);
  const createdAt = integer(conversationRecord?.created_at);
  const updatedAt = integer(conversationRecord?.updated_at);
  if (!conversationId || !title || createdAt === null || updatedAt === null) {
    throw new Error('Selected Deep Share conversation was not found in this workspace.');
  }

  const messages = db
    .prepare(
      `SELECT id, turn_id, role, content, created_at
       FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC, id ASC`
    )
    .all(conversationId)
    .flatMap((row) => parseMessage(row));
  const artifactByLocator = new Map(
    input.artifacts.map((artifact) => [artifact.locator, artifact])
  );
  const includedArtifacts = new Map(
    input.artifacts.map((artifact) => [artifact.id, { type: artifact.type, name: artifact.name }])
  );
  const referencesByMessageId = new Map<
    string,
    Array<{ artifactId: string; artifactType: DeepShareArtifactType; label: string }>
  >();
  const referenceRows = db
    .prepare(
      `SELECT mr.message_id, er.display_label, er.locator
       FROM message_references mr
       JOIN messages m ON m.id = mr.message_id
       JOIN entity_references er ON er.id = mr.reference_id
       WHERE m.conversation_id = ?
       ORDER BY mr.message_id ASC, mr.position ASC`
    )
    .all(conversationId);
  for (const row of referenceRows) {
    const record = objectRecord(row);
    const messageId = text(record?.message_id);
    const locator = text(record?.locator);
    const label = text(record?.display_label);
    if (!messageId || !locator || !label) continue;
    const artifact = artifactByLocator.get(locator);
    if (!artifact) continue;
    const existing = referencesByMessageId.get(messageId) ?? [];
    existing.push({ artifactId: artifact.id, artifactType: artifact.type, label });
    referencesByMessageId.set(messageId, existing);
  }

  return projectPortableConversation({
    conversation: { id: conversationId, title, createdAt, updatedAt },
    messages,
    referencesByMessageId,
    includedArtifacts,
  });
}

function countExactReferences(
  db: Database.Database,
  conversationId: string,
  artifactByLocator: ReadonlyMap<string, DeepShareChatArtifact>
): number {
  const rows = db
    .prepare(
      `SELECT DISTINCT er.locator
       FROM messages m
       JOIN message_references mr ON mr.message_id = m.id
       JOIN entity_references er ON er.id = mr.reference_id
       WHERE m.conversation_id = ?`
    )
    .all(conversationId);
  let count = 0;
  for (const row of rows) {
    const locator = text(objectRecord(row)?.locator);
    if (locator && artifactByLocator.has(locator)) count += 1;
  }
  return count;
}

function parseMessage(value: unknown): Array<{
  id: string;
  turnId: string | null;
  role: 'user' | 'assistant' | 'tool' | 'activity';
  content: string;
  createdAt: number;
}> {
  const record = objectRecord(value);
  const id = text(record?.id);
  const turnId = nullableText(record?.turn_id);
  const role = chatRole(record?.role);
  const content = typeof record?.content === 'string' ? record.content : null;
  const createdAt = integer(record?.created_at);
  return id && role && content !== null && createdAt !== null
    ? [{ id, turnId, role, content, createdAt }]
    : [];
}

function chatRole(value: unknown): 'user' | 'assistant' | 'tool' | 'activity' | null {
  return value === 'user' || value === 'assistant' || value === 'tool' || value === 'activity'
    ? value
    : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record: Record<string, unknown> = {};
  for (const key of Object.keys(value))
    record[key] = Object.getOwnPropertyDescriptor(value, key)?.value;
  return record;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}
