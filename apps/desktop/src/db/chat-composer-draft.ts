import { platform } from '../platform';
import { isDesktopRuntime } from '../utils/environment';
import { isAgentAttachmentManifest } from '../shared/agent-attachments';
import { getEntityReferencesByIds } from './entity-references';
import type { ChatComposerDraft } from '../features/ai/orchestration/chat-store-types';

export async function readChatComposerDraft(id: string): Promise<ChatComposerDraft | null> {
  if (!isDesktopRuntime()) return null;
  const [row] = await platform().db.select<{ draft_json: string }[]>(
    'SELECT draft_json FROM chat_composer_drafts WHERE conversation_id = ?',
    [id]
  );
  if (!row?.draft_json) return null;
  const draft = JSON.parse(row.draft_json);
  if (
    typeof draft?.text !== 'string' ||
    !Array.isArray(draft.attachments) ||
    !draft.attachments.every(isAgentAttachmentManifest) ||
    !Array.isArray(draft.referenceIds) ||
    !draft.referenceIds.every((value: unknown) => typeof value === 'string')
  )
    throw new Error('Invalid saved chat draft');
  const referenceIds: string[] = draft.referenceIds;
  const references = new Map(
    (await getEntityReferencesByIds(referenceIds)).map((row) => [row.id, row])
  );
  return {
    text: draft.text,
    attachments: draft.attachments,
    references: referenceIds.flatMap((id) => references.get(id) ?? []),
  };
}

export async function writeChatComposerDraft(
  id: string,
  draft: ChatComposerDraft | null
): Promise<void> {
  if (!isDesktopRuntime()) return;
  const sqlite = platform().db;
  if (!draft) {
    await sqlite.execute('DELETE FROM chat_composer_drafts WHERE conversation_id = ?', [id]);
    return;
  }
  const json = JSON.stringify({
    text: draft.text,
    attachments: draft.attachments,
    referenceIds: draft.references.map((ref) => ref.id),
  });
  await sqlite.execute(
    `INSERT INTO chat_composer_drafts (conversation_id, draft_json)
     SELECT id, ? FROM conversations WHERE id = ?
     ON CONFLICT(conversation_id) DO UPDATE SET draft_json = excluded.draft_json`,
    [json, id]
  );
}
