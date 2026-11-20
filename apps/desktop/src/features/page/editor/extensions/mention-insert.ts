import type { Editor, Range } from '@tiptap/core';
import type { MentionAttrs } from '../components/MentionMenu';

export function mentionAttributes(attrs: MentionAttrs, occurrenceId = crypto.randomUUID()) {
  return {
    id: attrs.entityId,
    occurrenceId,
    label: attrs.label,
    entityType: attrs.entityType,
    entityId: attrs.entityId,
    path: attrs.path ?? null,
    contentHash: attrs.contentHash ?? null,
    objectUuid: attrs.objectUuid ?? null,
    registryKind: attrs.registryKind ?? null,
    projectId: attrs.projectId ?? null,
  };
}

export function createMentionInsertCommand({
  editor,
  range,
  props,
}: {
  editor: Editor;
  range: Range;
  props: unknown;
}): void {
  const attrs = props as MentionAttrs;
  if (!attrs.entityId || attrs.entityId === 'new' || editor.isDestroyed) return;
  editor
    .chain()
    .focus()
    .insertContentAt(range, {
      type: 'mention',
      attrs: mentionAttributes(attrs),
    })
    .run();
}
