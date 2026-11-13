import { NativeReferenceChips } from './native-reference-chips';
import { Extension } from '@tiptap/core';
import Placeholder from '@tiptap/extension-placeholder';
import { getNotebookBaseExtensions } from './notebook-model-extensions';
export {
  HIGHLIGHT_COLORS,
  DEFAULT_HIGHLIGHT_COLOR,
  TEXT_COLORS,
  DEFAULT_TEXT_COLOR,
} from './notebook-model-extensions';
export { MentionExtension, type MentionAttrs } from './mention';
export { SlashCommandsExtension, type SlashCommand } from './slash-commands';
export { EmbedNode } from './embed-node';
export { RawMarkdownNode } from './raw-markdown';
export { builtInCommands } from '../lib/commands';

const CustomKeyboardShortcuts = Extension.create({
  name: 'customKeyboardShortcuts',

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-x': () => this.editor.chain().focus().toggleStrike().run(),

      'Mod-Shift-k': () => {
        const previous = this.editor.getAttributes('link').href as string | undefined;
        const href = window.prompt('Link address', previous ?? 'https://');
        if (href === null) return true;
        const trimmed = href.trim();
        if (!trimmed) return this.editor.chain().focus().unsetLink().run();
        return this.editor.chain().focus().extendMarkRange('link').setLink({ href: trimmed }).run();
      },

      'Mod-e': () => this.editor.chain().focus().toggleCode().run(),

      'Mod-Alt-c': () => this.editor.chain().focus().toggleCodeBlock().run(),

      'Mod-Alt-1': () => this.editor.chain().focus().toggleHeading({ level: 1 }).run(),
      'Mod-Alt-2': () => this.editor.chain().focus().toggleHeading({ level: 2 }).run(),
      'Mod-Alt-3': () => this.editor.chain().focus().toggleHeading({ level: 3 }).run(),

      'Mod-Shift-7': () => this.editor.chain().focus().toggleOrderedList().run(),
      'Mod-Shift-8': () => this.editor.chain().focus().toggleBulletList().run(),
      'Mod-Shift-9': () => this.editor.chain().focus().toggleTaskList().run(),

      'Mod-Shift-.': () => this.editor.chain().focus().toggleBlockquote().run(),

      'Mod-\\': () => this.editor.chain().focus().unsetAllMarks().clearNodes().run(),

      'Mod-Shift-ArrowUp': () => {
        const { state } = this.editor.view;
        const { $from } = state.selection;

        const pos = $from.before($from.depth);
        if (pos <= 0) return false;

        const $prevPos = state.doc.resolve(pos - 1);
        const prevPos = $prevPos.before($prevPos.depth);

        return this.editor
          .chain()
          .focus()
          .command(({ tr, state: s }) => {
            const node = s.doc.nodeAt($from.before($from.depth));
            if (!node) return false;

            tr.delete($from.before($from.depth), $from.after($from.depth));
            tr.insert(prevPos, node);
            return true;
          })
          .run();
      },

      'Mod-Shift-ArrowDown': () => {
        const { state } = this.editor.view;
        const { $from } = state.selection;

        const afterPos = $from.after($from.depth);
        if (afterPos >= state.doc.content.size) return false;

        const $nextPos = state.doc.resolve(afterPos + 1);
        const nextAfterPos = $nextPos.after($nextPos.depth);

        return this.editor
          .chain()
          .focus()
          .command(({ tr, state: s }) => {
            const node = s.doc.nodeAt($from.before($from.depth));
            if (!node) return false;

            tr.insert(nextAfterPos, node);
            tr.delete($from.before($from.depth), $from.after($from.depth));
            return true;
          })
          .run();
      },

      'Mod-d': () => {
        const { state, dispatch } = this.editor.view;
        const { $from } = state.selection;
        const blockStart = $from.start($from.depth);
        const blockEnd = $from.end($from.depth);
        const block = state.doc.slice(blockStart, blockEnd + 1);

        const tr = state.tr;
        tr.insert(blockEnd + 1, block.content);
        dispatch(tr);
        return true;
      },

      'Mod-Shift-Backspace': () => {
        const { state, dispatch } = this.editor.view;
        const { $from } = state.selection;

        if (state.doc.childCount <= 1) {
          return this.editor.commands.clearContent();
        }

        const blockStart = $from.start($from.depth);
        const blockEnd = $from.end($from.depth);

        const tr = state.tr;
        tr.delete(blockStart - 1, blockEnd + 1);
        dispatch(tr);
        return true;
      },
    };
  },
});

export function getBaseExtensions(placeholder: string = 'Start typing...', nativeHistory = false) {
  return [
    CustomKeyboardShortcuts,
    ...getNotebookBaseExtensions(nativeHistory),
    NativeReferenceChips,
    Placeholder.configure({ placeholder }),
  ];
}
