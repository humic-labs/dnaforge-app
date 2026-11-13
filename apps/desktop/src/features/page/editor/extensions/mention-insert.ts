import type { Editor, Range } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';

import { createInsertionRangeTracker } from '../../entity-ref/insertion-range-tracker';
import type { MentionAttrs } from '../components/MentionMenu';
import type { MentionOptions, MentionReferenceRecord } from './mention-types';

const EMPTY_RECORD: MentionReferenceRecord = { path: null, contentHash: null, objectUuid: null };

export function createMentionInsertCommand({
  editor,
  range,
  props,
}: {
  editor: Editor;
  range: Range;
  props: unknown;
}): void | Promise<void> {
  const attrs = props as MentionAttrs;

  if (attrs.entityId === 'new') {
    console.log('[Mention] Create page flow not yet implemented:', attrs.label);
  }

  const mentionExtension = editor.extensionManager.extensions.find(
    (extension) => extension.name === 'mention'
  );
  const resolveRecord =
    (mentionExtension?.options as MentionOptions | undefined)?.resolveReferenceRecord ?? null;

  const insertChip = (record: MentionReferenceRecord, at: number): void => {
    editor
      .chain()
      .focus()
      .insertContentAt(at, {
        type: 'mention',
        attrs: {
          id: attrs.entityId,
          label: attrs.label,
          entityType: attrs.entityType,
          entityId: attrs.entityId,
          path: record.path,
          contentHash: record.contentHash,
          objectUuid: record.objectUuid ?? null,
          registryKind: attrs.registryKind ?? null,
          projectId: attrs.projectId ?? null,
        },
      })
      .insertContent(' ')
      .run();
  };

  if (attrs.path) {
    editor.chain().focus().deleteRange(range).run();
    insertChip(
      {
        path: attrs.path,
        contentHash: attrs.contentHash ?? null,
        objectUuid: attrs.objectUuid ?? null,
      },
      range.from
    );
    return;
  }

  if (!resolveRecord || attrs.entityType === 'registry') {
    editor.chain().focus().deleteRange(range).run();
    insertChip(EMPTY_RECORD, range.from);
    return;
  }

  editor.chain().focus().deleteRange(range).run();

  const tracker = createInsertionRangeTracker();
  const token = tracker.capture(range.from);
  const onTransaction = ({ transaction }: { transaction: Transaction }): void => {
    tracker.onTransaction(transaction.mapping);
  };
  editor.on('transaction', onTransaction);

  return resolveRecord({
    entityType: attrs.entityType,
    entityId: attrs.entityId ?? null,
    label: attrs.label,
  })
    .catch((error: unknown) => {
      console.error('[Mention] Failed to resolve reference record:', error);
      return EMPTY_RECORD;
    })
    .then((record) => {
      if (editor.isDestroyed) return;

      const at = tracker.resolve(token);
      if (!at.ok) {
        console.warn(
          `[Mention] Abandoned chip for "${attrs.label}": ${at.reason}. ` +
            'The text it was anchored to no longer exists.'
        );
        return;
      }
      insertChip(record, at.pos);
    })
    .finally(() => {
      editor.off('transaction', onTransaction);
      tracker.release(token);
    });
}
