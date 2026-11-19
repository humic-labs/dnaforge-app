import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImageFileIcon, SpreadsheetFileIcon } from '../../../../components/icons/glyphs';
import { iconForEntityKind } from '../../../../components/icons/entity-icon-registry';
import { FormattingToolbar } from '../../components/FormattingToolbar';
import { getNotebookLayout, NotebookColumn, NotebookColumns } from '../extensions/notebook-layout';
import { builtInCommands } from '../lib/commands';
import { SlashCommandMenu } from './SlashCommandMenu';

vi.mock('../../embeds/image/Renderer', () => ({ ImageRenderer: () => null }));
vi.mock('../../embeds/table/Renderer', () => ({ TableRenderer: () => null }));
vi.mock('../../embeds/structure3d/Renderer', () => ({ Structure3dRenderer: () => null }));

import { imageEmbed } from '../../embeds/image/definition';
import { tableEmbed } from '../../embeds/table/definition';
import { structure3dEmbed } from '../../embeds/structure3d/definition';
import { embedRegistry } from '../../embeds/registry';

const layoutCases = [
  { id: 'single-column', label: 'One column', weights: [1] },
  { id: 'two-columns', label: 'Two columns', weights: [1, 1] },
  { id: 'wide-left', label: 'Wider left', weights: [2, 1] },
  { id: 'wide-right', label: 'Wider right', weights: [1, 2] },
  { id: 'three-columns', label: 'Three columns', weights: [1, 1, 1] },
] as const;

let editor: Editor | null = null;
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
});

it('keeps the full formatting order before the retained section-layout commands', () => {
  render(<SlashCommandMenu items={builtInCommands} command={vi.fn()} />);
  const format = screen.getByRole('group', { name: 'Format' });
  const labels = within(format)
    .getAllByRole('option')
    .map(
      (button) => builtInCommands.find((item) => button.textContent?.endsWith(item.label))?.label
    );
  expect(labels).toEqual([
    'Heading 1',
    'Heading 2',
    'Heading 3',
    'Bullet List',
    'Numbered List',
    'Task List',
    'Quote',
    'Code Block',
    'Divider',
    'One column',
    'Two columns',
    'Wider left',
    'Wider right',
    'Three columns',
  ]);
});

it('labels the Layout section below the formatting actions without another column', () => {
  render(<SlashCommandMenu items={builtInCommands} command={vi.fn()} />);
  const format = screen.getByRole('group', { name: 'Format' });
  const layout = within(format).getByText('Layout');
  const divider = within(format).getByRole('option', { name: /Divider$/ });
  const twoColumns = within(format).getByRole('option', { name: /Two columns$/ });
  expect(divider.compareDocumentPosition(layout) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(
    layout.compareDocumentPosition(twoColumns) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  expect(screen.getAllByRole('group')).toHaveLength(1);
});

it('shows the same formatting glyphs in the real toolbar and slash list', () => {
  editor = new Editor({
    extensions: [StarterKit.configure({ trailingNode: false }), NotebookColumns, NotebookColumn],
    content: '<p>Notebook</p>',
  });
  const toolbar = render(<FormattingToolbar editor={editor} />);
  for (const name of [
    'heading1',
    'heading2',
    'heading3',
    'bullet',
    'numbered',
    'task',
    'quote',
    'code',
  ]) {
    const command = builtInCommands.find((item) => item.name === name)!;
    expect(within(toolbar.container).getByRole('button', { name: command.label }).textContent).toBe(
      command.icon
    );
  }
});

it('offers the same explicit layout order in the notebook toolbar and slash menu', () => {
  editor = new Editor({
    extensions: [StarterKit.configure({ trailingNode: false }), NotebookColumns, NotebookColumn],
    content: '<p>Notebook</p>',
  });
  render(<FormattingToolbar editor={editor} />);
  const trigger = screen.getByRole('button', { name: 'Notebook layout' });
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 40, 28));
  fireEvent.click(trigger);
  const options = within(screen.getByRole('menu', { name: 'Notebook layout' }))
    .getAllByRole('menuitemradio')
    .map((option) => option.textContent);
  expect(options).toEqual(layoutCases.map(({ label }) => label));
  expect(
    builtInCommands.filter(({ section }) => section === 'layout').map(({ label }) => label)
  ).toEqual(layoutCases.map(({ label }) => label));
});

it.each(layoutCases)(
  '$label depicts its actual column count and left-to-right width proportions',
  ({ label, weights }) => {
    render(<SlashCommandMenu items={builtInCommands} command={vi.fn()} />);
    const row = screen.getByRole('option', { name: new RegExp(`${label}$`) });
    const svg = row.querySelector('svg');
    expect(svg, `${label} needs a real layout diagram, not a font glyph`).not.toBeNull();
    if (!svg) return;
    expect(svg.querySelector('text,image')).toBeNull();
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    const frames = svg.querySelectorAll('rect');
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    const left = Number(frame.getAttribute('x'));
    const top = Number(frame.getAttribute('y'));
    const width = Number(frame.getAttribute('width'));
    const height = Number(frame.getAttribute('height'));
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    const partitions = [...svg.querySelectorAll('line')]
      .map((line) => {
        const x = Number(line.getAttribute('x1'));
        expect(Number(line.getAttribute('x2'))).toBe(x);
        expect(Number(line.getAttribute('y1'))).toBe(top);
        expect(Number(line.getAttribute('y2'))).toBe(top + height);
        expect(x).toBeGreaterThan(left);
        expect(x).toBeLessThan(left + width);
        return x;
      })
      .sort((a, b) => a - b);
    expect(partitions).toHaveLength(weights.length - 1);
    const boundaries = [left, ...partitions, left + width];
    const total = weights.reduce<number>((sum, weight) => sum + weight, 0);
    weights.forEach((weight, index) => {
      expect((boundaries[index + 1] - boundaries[index]) / width).toBeCloseTo(weight / total, 5);
    });
  }
);

it.each(layoutCases)(
  '$label invokes the matching real layout action without dropping content or marks',
  ({ id, label, weights }) => {
    editor = new Editor({
      extensions: [StarterKit.configure({ trailingNode: false }), NotebookColumns, NotebookColumn],
      content: {
        type: 'doc',
        content: [
          {
            type: 'notebookColumns',
            attrs: { layout: 'three-columns' },
            content: ['Method', 'Observation', 'Conclusion'].map((text) => ({
              type: 'notebookColumn',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text,
                      marks: [{ type: 'bold' }],
                    },
                  ],
                },
              ],
            })),
          },
        ],
      },
    });
    editor.commands.setTextSelection(3);
    const before: unknown[] = [];
    editor.state.doc.descendants((node) => {
      if (node.isTextblock) before.push(node.toJSON());
    });
    render(
      <SlashCommandMenu
        items={builtInCommands}
        command={(command) => {
          expect(command.action).toBeTypeOf('function');
          command.action!(editor!);
        }}
      />
    );
    act(() => fireEvent.click(screen.getByRole('option', { name: new RegExp(`${label}$`) })));
    expect(getNotebookLayout(editor.state)).toBe(id);
    const after: unknown[] = [];
    editor.state.doc.descendants((node) => {
      if (node.isTextblock) after.push(node.toJSON());
    });
    expect(after).toEqual(before);
    const layout = editor.state.doc.firstChild!;
    if (id === 'single-column') {
      expect(layout.type.name).toBe('paragraph');
      expect(editor.view.dom.querySelector('[data-type="notebookColumns"]')).toBeNull();
    } else {
      expect(layout.type.name).toBe('notebookColumns');
      expect(layout.attrs.layout).toBe(id);
      expect(layout.childCount).toBe(weights.length);
    }
  }
);

it.each([
  {
    label: 'Image',
    definition: imageEmbed,
    icon: createElement(ImageFileIcon, { className: 'w-4 h-4' }),
  },
  {
    label: 'Table',
    definition: tableEmbed,
    icon: createElement(SpreadsheetFileIcon, { className: 'w-4 h-4' }),
  },
  { label: '3D Structure', definition: structure3dEmbed, icon: iconForEntityKind('structure3d') },
])('uses the canonical icon for $label embeds', ({ definition, icon }) => {
  expect(renderToStaticMarkup(<>{definition.icon}</>)).toBe(renderToStaticMarkup(<>{icon}</>));
  render(<SlashCommandMenu items={embedRegistry.getSlashCommands()} command={vi.fn()} />);
  const row = screen.getByRole('option', { name: new RegExp(`${definition.label}$`) });
  expect(row.querySelector('svg')?.outerHTML).toBe(renderToStaticMarkup(<>{icon}</>));
});
