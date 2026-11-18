'use client';

import { useEffect, useState, useCallback } from 'react';
import { ColorPalette } from './ColorPalette';
import { NotebookLayoutControl } from './NotebookLayoutControl';
import type { Editor } from '@tiptap/react';
import { formatShortcut } from '@waypoint/ui-components/keyboard';
import { Tooltip } from '@/shared/components';
import {
  HIGHLIGHT_COLORS,
  DEFAULT_HIGHLIGHT_COLOR,
  TEXT_COLORS,
  DEFAULT_TEXT_COLOR,
} from '../editor/extensions';

interface FormattingToolbarProps {
  editor: Editor | null;
}

interface FormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  codeBlock: boolean;
  highlight: boolean;
  textColor: boolean;
  h1: boolean;
  h2: boolean;
  h3: boolean;
  bulletList: boolean;
  orderedList: boolean;
  taskList: boolean;
  blockquote: boolean;
}

export function FormattingToolbar({ editor }: FormattingToolbarProps) {
  const [formatState, setFormatState] = useState<FormatState>({
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    code: false,
    codeBlock: false,
    highlight: false,
    textColor: false,
    h1: false,
    h2: false,
    h3: false,
    bulletList: false,
    orderedList: false,
    taskList: false,
    blockquote: false,
  });

  const updateState = useCallback(() => {
    if (!editor) return;
    setFormatState({
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      underline: editor.isActive('underline'),
      strike: editor.isActive('strike'),
      code: editor.isActive('code'),
      codeBlock: editor.isActive('codeBlock'),
      highlight: editor.isActive('highlight'),
      textColor: editor.isActive('textColor'),
      h1: editor.isActive('heading', { level: 1 }),
      h2: editor.isActive('heading', { level: 2 }),
      h3: editor.isActive('heading', { level: 3 }),
      bulletList: editor.isActive('bulletList'),
      orderedList: editor.isActive('orderedList'),
      taskList: editor.isActive('taskList'),
      blockquote: editor.isActive('blockquote'),
    });
  }, [editor]);

  useEffect(() => {
    if (!editor) return;

    editor.on('update', updateState);
    editor.on('selectionUpdate', updateState);
    editor.on('focus', updateState);

    updateState();

    return () => {
      editor.off('update', updateState);
      editor.off('selectionUpdate', updateState);
      editor.off('focus', updateState);
    };
  }, [editor, updateState]);

  const runCommand = useCallback(
    (command: () => void) => {
      return () => {
        editor?.chain().focus().run();
        command();
      };
    },
    [editor]
  );

  if (!editor) return null;

  return (
    <div className="tab-chrome-surface flex flex-wrap items-center gap-0.5 px-2 py-1 border-b border-border">
      <ToolbarGroup>
        <ToolbarButton
          isActive={formatState.bold}
          onClick={runCommand(() => editor.chain().focus().toggleBold().run())}
          tooltip="Bold"
          shortcut={formatShortcut(['cmd', 'b'])}
        >
          <span className="font-bold">B</span>
        </ToolbarButton>
        <ToolbarButton
          isActive={formatState.italic}
          onClick={runCommand(() => editor.chain().focus().toggleItalic().run())}
          tooltip="Italic"
          shortcut={formatShortcut(['cmd', 'i'])}
        >
          <span className="italic">I</span>
        </ToolbarButton>
        <ToolbarButton
          isActive={formatState.underline}
          onClick={runCommand(() => editor.chain().focus().toggleUnderline().run())}
          tooltip="Underline"
          shortcut={formatShortcut(['cmd', 'u'])}
        >
          <span className="underline">U</span>
        </ToolbarButton>
        <ToolbarButton
          isActive={formatState.strike}
          onClick={runCommand(() => editor.chain().focus().toggleStrike().run())}
          tooltip="Strikethrough"
          shortcut={formatShortcut(['cmd', 'shift', 'x'])}
        >
          <span className="line-through">S</span>
        </ToolbarButton>
        <ToolbarButton
          isActive={formatState.code}
          onClick={runCommand(() => editor.chain().focus().toggleCode().run())}
          tooltip="Inline Code"
          shortcut={formatShortcut(['cmd', 'e'])}
        >
          <span className="font-mono text-[10px]">&lt;/&gt;</span>
        </ToolbarButton>
        <ColorControl
          kind="highlight"
          label="Highlight"
          shortcut={formatShortcut(['cmd', 'shift', 'h'])}
          isActive={formatState.highlight}
          swatches={HIGHLIGHT_COLORS}
          preview={DEFAULT_HIGHLIGHT_COLOR}
          onToggle={() => editor.chain().focus().toggleHighlight().run()}
          onPick={(color) => editor.chain().focus().setHighlight({ color }).run()}
          onClear={() => editor.chain().focus().unsetHighlight().run()}
        />
        <ColorControl
          kind="text-color"
          label="Text color"
          isActive={formatState.textColor}
          swatches={TEXT_COLORS}
          preview={DEFAULT_TEXT_COLOR}
          onToggle={() =>
            formatState.textColor
              ? editor.chain().focus().unsetTextColor().run()
              : editor.chain().focus().setTextColor(DEFAULT_TEXT_COLOR).run()
          }
          onPick={(color) => editor.chain().focus().setTextColor(color).run()}
          onClear={() => editor.chain().focus().unsetTextColor().run()}
        />
      </ToolbarGroup>

      <ToolbarDivider />

      <ToolbarGroup>
        <ToolbarButton
          isActive={formatState.h1}
          onClick={runCommand(() => editor.chain().focus().toggleHeading({ level: 1 }).run())}
          tooltip="Heading 1"
          shortcut={formatShortcut(['cmd', 'alt', '1'])}
        >
          H1
        </ToolbarButton>
        <ToolbarButton
          isActive={formatState.h2}
          onClick={runCommand(() => editor.chain().focus().toggleHeading({ level: 2 }).run())}
          tooltip="Heading 2"
          shortcut={formatShortcut(['cmd', 'alt', '2'])}
        >
          H2
        </ToolbarButton>
        <ToolbarButton
          isActive={formatState.h3}
          onClick={runCommand(() => editor.chain().focus().toggleHeading({ level: 3 }).run())}
          tooltip="Heading 3"
          shortcut={formatShortcut(['cmd', 'alt', '3'])}
        >
          H3
        </ToolbarButton>
      </ToolbarGroup>

      <ToolbarDivider />

      <ToolbarGroup>
        <ToolbarButton
          isActive={formatState.bulletList}
          onClick={runCommand(() => editor.chain().focus().toggleBulletList().run())}
          tooltip="Bullet List"
          shortcut={formatShortcut(['cmd', 'shift', '8'])}
        >
          •
        </ToolbarButton>
        <ToolbarButton
          isActive={formatState.orderedList}
          onClick={runCommand(() => editor.chain().focus().toggleOrderedList().run())}
          tooltip="Numbered List"
          shortcut={formatShortcut(['cmd', 'shift', '7'])}
        >
          1.
        </ToolbarButton>
        <ToolbarButton
          isActive={formatState.taskList}
          onClick={runCommand(() => editor.chain().focus().toggleTaskList().run())}
          tooltip="Task List"
          shortcut={formatShortcut(['cmd', 'shift', '9'])}
        >
          ☑
        </ToolbarButton>
      </ToolbarGroup>

      <ToolbarDivider />

      <ToolbarGroup>
        <ToolbarButton
          isActive={formatState.blockquote}
          onClick={runCommand(() => editor.chain().focus().toggleBlockquote().run())}
          tooltip="Quote"
          shortcut={formatShortcut(['cmd', 'shift', '.'])}
        >
          &quot;
        </ToolbarButton>
        <ToolbarButton
          isActive={formatState.codeBlock}
          onClick={runCommand(() => editor.chain().focus().toggleCodeBlock().run())}
          tooltip="Code Block"
          shortcut={formatShortcut(['cmd', 'alt', 'c'])}
        >
          <span className="font-mono text-[10px]">{'{}'}</span>
        </ToolbarButton>
      </ToolbarGroup>

      <ToolbarDivider />
      <NotebookLayoutControl editor={editor} />
    </div>
  );
}

interface ColorControlProps {
  kind: 'highlight' | 'text-color';
  label: string;
  shortcut?: string;
  isActive: boolean;
  swatches: ReadonlyArray<{ readonly name: string; readonly value: string }>;

  preview: string;
  onToggle: () => void;
  onPick: (color: string) => void;
  onClear: () => void;
}

function ColorControl({
  kind,
  label,
  shortcut,
  isActive,
  swatches,
  preview,
  onToggle,
  onPick,
  onClear,
}: ColorControlProps) {
  const isHighlight = kind === 'highlight';

  return (
    <div className="flex items-center">
      <Tooltip content={shortcut ? `${label} (${shortcut})` : label}>
        <button
          type="button"
          data-testid={`toolbar-${kind}`}
          aria-pressed={isActive}
          onClick={onToggle}
          className={`px-1.5 py-0.5 rounded text-xs transition-colors ${
            isActive ? 'bg-accent text-accent-fg' : 'wp-interactive'
          }`}
        >
          <span
            className="px-0.5 rounded-[2px]"
            style={
              isHighlight
                ? { backgroundColor: preview }
                : { color: preview, borderBottom: `2px solid ${preview}` }
            }
          >
            A
          </span>
        </button>
      </Tooltip>
      <ColorPalette
        label={isHighlight ? `${label} color` : label}
        colors={swatches}
        onPick={onPick}
        onClear={onClear}
        testId={`toolbar-${kind}-colors`}
        className="px-0.5 py-0.5 rounded text-[8px] leading-none wp-interactive"
      >
        ▾
      </ColorPalette>
    </div>
  );
}

interface ToolbarButtonProps {
  isActive: boolean;
  onClick: () => void;
  tooltip: string;
  shortcut?: string;
  children: React.ReactNode;
}

function ToolbarButton({ isActive, onClick, tooltip, shortcut, children }: ToolbarButtonProps) {
  const label = shortcut ? `${tooltip} (${shortcut})` : tooltip;

  return (
    <Tooltip content={label} side="bottom">
      <button
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
        aria-pressed={isActive}
        aria-label={tooltip}
        className={`
          w-7 h-7 flex items-center justify-center rounded text-xs
          transition-colors duration-100
          ${isActive ? 'bg-accent text-accent-fg' : 'text-fg wp-interactive'}
        `}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function ToolbarGroup({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-0.5">{children}</div>;
}

function ToolbarDivider() {
  return <div className="w-px h-5 bg-border mx-1" />;
}
