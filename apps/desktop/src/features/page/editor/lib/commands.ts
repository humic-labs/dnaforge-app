import type { ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import type {} from '@tiptap/starter-kit';
import type {} from '@tiptap/extension-task-list';
import { NOTEBOOK_LAYOUTS } from '../extensions/notebook-layout';

export interface SlashCommand {
  name: string;
  label: string;
  description: string;

  icon: ReactNode;
  keywords: string[];
  category: 'format' | 'insert' | 'embed';
  action?: (editor: Editor) => void;
  flowName?: string;
}

export const builtInCommands: SlashCommand[] = [
  ...NOTEBOOK_LAYOUTS.map(
    (layout): SlashCommand => ({
      name: layout.id,
      label: layout.label,
      description: `Arrange this section into ${layout.columns} columns`,
      icon: layout.columns === 3 ? '▥' : '◫',
      keywords: ['layout', 'columns', 'side-by-side', layout.id],
      category: 'format',
      action: (editor) => {
        editor.chain().focus().setNotebookLayout(layout.id).run();
      },
    })
  ),
  {
    name: 'single-column',
    label: 'One column',
    description: 'Return this section to a single column, keeping all content',
    icon: '▤',
    keywords: ['layout', 'columns', 'unwrap'],
    category: 'format',
    action: (editor) => {
      editor.chain().focus().setNotebookLayout('single-column').run();
    },
  },
  {
    name: 'heading1',
    label: 'Heading 1',
    description: 'Large section heading',
    icon: 'H1',
    keywords: ['h1', 'title', 'heading'],
    category: 'format',
    action: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    name: 'heading2',
    label: 'Heading 2',
    description: 'Medium section heading',
    icon: 'H2',
    keywords: ['h2', 'subtitle'],
    category: 'format',
    action: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    name: 'heading3',
    label: 'Heading 3',
    description: 'Small section heading',
    icon: 'H3',
    keywords: ['h3'],
    category: 'format',
    action: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    name: 'bullet',
    label: 'Bullet List',
    description: 'Create a bullet list',
    icon: '•',
    keywords: ['list', 'ul', 'unordered'],
    category: 'format',
    action: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    name: 'numbered',
    label: 'Numbered List',
    description: 'Create a numbered list',
    icon: '1.',
    keywords: ['list', 'ol', 'ordered'],
    category: 'format',
    action: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    name: 'task',
    label: 'Task List',
    description: 'Create a task checklist',
    icon: '☐',
    keywords: ['todo', 'checkbox', 'checklist'],
    category: 'format',
    action: (editor) => editor.chain().focus().toggleTaskList().run(),
  },
  {
    name: 'quote',
    label: 'Quote',
    description: 'Add a quote block',
    icon: '"',
    keywords: ['blockquote'],
    category: 'format',
    action: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    name: 'code',
    label: 'Code Block',
    description: 'Add a code block',
    icon: '</>',
    keywords: ['codeblock', 'pre'],
    category: 'format',
    action: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
  {
    name: 'divider',
    label: 'Divider',
    description: 'Insert a horizontal line',
    icon: '—',
    keywords: ['hr', 'line', 'separator'],
    category: 'insert',
    action: (editor) => editor.chain().focus().setHorizontalRule().run(),
  },
];

export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  if (!query) return commands;

  const lowerQuery = query.toLowerCase();
  return commands.filter(
    (cmd) =>
      cmd.label.toLowerCase().includes(lowerQuery) ||
      cmd.keywords.some((k) => k.toLowerCase().includes(lowerQuery))
  );
}

export function groupCommandsByCategory(commands: SlashCommand[]): Record<string, SlashCommand[]> {
  const groups: Record<string, SlashCommand[]> = {
    format: [],
    insert: [],
    embed: [],
  };

  commands.forEach((cmd) => {
    groups[cmd.category]?.push(cmd);
  });

  return groups;
}
