// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { NodeViewProps } from '@tiptap/react';
import { DecorationSet } from '@tiptap/pm/view';
import type { EmbedRendererProps } from '../../embeds/types';
import { EmbedNodeView } from './EmbedNodeView';

const rendered = vi.hoisted(() => ({ props: null as EmbedRendererProps | null }));
vi.mock('@tiptap/react', async (original) => ({
  ...(await original<typeof import('@tiptap/react')>()),
  NodeViewWrapper: ({ children }: { children: import('react').ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../embeds/registry', () => ({
  embedRegistry: {
    getRenderer: () => (props: EmbedRendererProps) => {
      rendered.props = props;
      return <div />;
    },
    get: () => ({ version: 1 }),
  },
}));
vi.mock('../../../../lib/analytics', () => ({
  captureAnalyticsOptionalOrigin: () => null,
  isAnalyticsCaptureReady: () => false,
  subscribeAnalyticsCaptureReady: () => () => {},
  trackRendererEvent: () => false,
  getAnalyticsIdentifiedAccountId: () => null,
  isAnalyticsIdentityIdentified: () => false,
  getMeaningfulActivityAuthority: () => ({
    actorKind: 'test',
    executionMode: 'synthetic',
    impersonated: false,
  }),
}));

const owners: Editor[] = [];
beforeEach(() => {
  rendered.props = null;
});
afterEach(() => {
  for (const owner of owners.splice(0)) owner.destroy();
});
function mount(getPos: () => number | undefined) {
  const embed = Node.create({
    name: 'embed',
    group: 'block',
    atom: true,
    addAttributes: () => ({
      type: { default: 'table' },
      version: { default: 1 },
      refId: { default: 'synthetic-table' },
      data: { default: {} },
    }),
    renderHTML: () => ['div'],
  });
  const editor = new Editor({
    extensions: [StarterKit, embed],
    content: { type: 'doc', content: [{ type: 'embed' }] },
  });
  owners.push(editor);
  const props: NodeViewProps = {
    editor,
    view: editor.view,
    extension: embed,
    HTMLAttributes: {},
    decorations: [],
    innerDecorations: DecorationSet.empty,
    node: editor.state.doc.nodeAt(0)!,
    getPos,
    selected: false,
    updateAttributes: () => {},
    deleteNode: () => {},
  };
  return render(<EmbedNodeView {...props} />);
}

describe('actual NodeView open is independent of optional source lookup', () => {
  it.each(['throw', 'absent', 'invalid'] as const)(
    'opens exactly once when getPos is %s',
    (mode) => {
      const view = mount(() => {
        if (mode === 'throw') throw new Error('synthetic stale NodeView position');
        return mode === 'absent' ? undefined : -1;
      });
      const open = vi.fn(() => true);
      act(() => rendered.props!.onOpenTable!(open));
      expect(open).toHaveBeenCalledTimes(1);
      view.unmount();
    }
  );

  it.each(['throw', 'absent', 'invalid', 'valid'] as const)(
    'retains the primary open error without a second invocation after %s position lookup',
    (mode) => {
      const view = mount(() => {
        if (mode === 'throw') throw new Error('synthetic stale NodeView position');
        return mode === 'absent' ? undefined : mode === 'invalid' ? -1 : 0;
      });
      const primary = new Error('synthetic primary open failure');
      const open = vi.fn(() => {
        throw primary;
      });
      act(() => expect(() => rendered.props!.onOpenTable!(open)).toThrow(primary));
      expect(open).toHaveBeenCalledTimes(1);
      view.unmount();
    }
  );
});
