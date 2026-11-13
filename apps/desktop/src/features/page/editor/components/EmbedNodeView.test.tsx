// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoEmbedRenderer } from './EmbedNodeView';

function makeRenderer(spy: () => void) {
  return function MockRenderer(_props: Record<string, unknown>): ReactNode {
    spy();
    return <div data-testid="mock-renderer">mock</div>;
  };
}

describe('MemoEmbedRenderer', () => {
  it('does not re-render when only handler identities change', () => {
    const spy = vi.fn();
    const Renderer = makeRenderer(spy);
    const data = { source: 'pdb', sourceId: '4OO8' };
    const noop = () => {};

    const { rerender } = render(
      <MemoEmbedRenderer
        Renderer={Renderer}
        type="structure3d"
        refId="x"
        data={data}
        selected={false}
        onUpdateAttrs={noop}
        onSelect={noop}
        onBlurToEditor={noop}
        onExpand={noop}
        onRemove={noop}
      />
    );

    expect(spy).toHaveBeenCalledTimes(1);

    rerender(
      <MemoEmbedRenderer
        Renderer={Renderer}
        type="structure3d"
        refId="x"
        data={{ source: 'pdb', sourceId: '4OO8' }}
        selected={false}
        onUpdateAttrs={() => {}}
        onSelect={() => {}}
        onBlurToEditor={() => {}}
        onExpand={() => {}}
        onRemove={() => {}}
      />
    );

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('re-renders when type, version, refId, or selected change', () => {
    const spy = vi.fn();
    const Renderer = makeRenderer(spy);
    const noop = () => {};
    const baseProps = {
      Renderer,
      type: 'structure3d',
      storedVersion: 1,
      supportedVersion: 1,
      refId: 'x',
      data: { source: 'pdb' },
      selected: false,
      onUpdateAttrs: noop,
      onSelect: noop,
      onBlurToEditor: noop,
      onExpand: noop,
      onRemove: noop,
    };

    const { rerender } = render(<MemoEmbedRenderer {...baseProps} />);
    expect(spy).toHaveBeenCalledTimes(1);

    rerender(<MemoEmbedRenderer {...baseProps} selected={true} />);
    expect(spy).toHaveBeenCalledTimes(2);

    rerender(<MemoEmbedRenderer {...baseProps} selected={true} refId="y" />);
    expect(spy).toHaveBeenCalledTimes(3);

    rerender(<MemoEmbedRenderer {...baseProps} selected={true} refId="y" type="other" />);
    expect(spy).toHaveBeenCalledTimes(4);

    rerender(
      <MemoEmbedRenderer {...baseProps} selected={true} refId="y" type="other" storedVersion={2} />
    );
    expect(spy).toHaveBeenCalledTimes(5);
  });

  it('re-renders when data attribute values change', () => {
    const spy = vi.fn();
    const Renderer = makeRenderer(spy);
    const noop = () => {};
    const props = {
      Renderer,
      type: 'structure3d',
      refId: 'x',
      data: { source: 'pdb', sourceId: '4OO8' },
      selected: false,
      onUpdateAttrs: noop,
      onSelect: noop,
      onBlurToEditor: noop,
      onExpand: noop,
      onRemove: noop,
    };

    const { rerender } = render(<MemoEmbedRenderer {...props} />);
    expect(spy).toHaveBeenCalledTimes(1);

    rerender(<MemoEmbedRenderer {...props} data={{ source: 'pdb', sourceId: '6XYZ' }} />);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('detects NaN-vs-null change (JSON.stringify would have masked this)', () => {
    const spy = vi.fn();
    const Renderer = makeRenderer(spy);
    const noop = () => {};
    const props = {
      Renderer,
      type: 'structure3d',
      refId: 'x',
      data: { x: NaN } as Record<string, unknown>,
      selected: false,
      onUpdateAttrs: noop,
      onSelect: noop,
      onBlurToEditor: noop,
      onExpand: noop,
      onRemove: noop,
    };

    const { rerender } = render(<MemoEmbedRenderer {...props} />);
    expect(spy).toHaveBeenCalledTimes(1);

    rerender(<MemoEmbedRenderer {...props} data={{ x: null }} />);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('treats two NaN values as equal (Object.is(NaN, NaN) is true)', () => {
    const spy = vi.fn();
    const Renderer = makeRenderer(spy);
    const noop = () => {};
    const props = {
      Renderer,
      type: 'structure3d',
      refId: 'x',
      data: { x: NaN } as Record<string, unknown>,
      selected: false,
      onUpdateAttrs: noop,
      onSelect: noop,
      onBlurToEditor: noop,
      onExpand: noop,
      onRemove: noop,
    };

    const { rerender } = render(<MemoEmbedRenderer {...props} />);
    expect(spy).toHaveBeenCalledTimes(1);

    rerender(<MemoEmbedRenderer {...props} data={{ x: NaN }} />);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not re-render when keys are reordered (JSON.stringify would have)', () => {
    const spy = vi.fn();
    const Renderer = makeRenderer(spy);
    const noop = () => {};
    const props = {
      Renderer,
      type: 'structure3d',
      refId: 'x',
      data: { a: 1, b: 2 },
      selected: false,
      onUpdateAttrs: noop,
      onSelect: noop,
      onBlurToEditor: noop,
      onExpand: noop,
      onRemove: noop,
    };

    const { rerender } = render(<MemoEmbedRenderer {...props} />);
    expect(spy).toHaveBeenCalledTimes(1);

    rerender(<MemoEmbedRenderer {...props} data={{ b: 2, a: 1 }} />);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('detects undefined-vs-missing-key change', () => {
    const spy = vi.fn();
    const Renderer = makeRenderer(spy);
    const noop = () => {};
    const props = {
      Renderer,
      type: 'structure3d',
      refId: 'x',
      data: { a: 1 } as Record<string, unknown>,
      selected: false,
      onUpdateAttrs: noop,
      onSelect: noop,
      onBlurToEditor: noop,
      onExpand: noop,
      onRemove: noop,
    };

    const { rerender } = render(<MemoEmbedRenderer {...props} />);
    expect(spy).toHaveBeenCalledTimes(1);

    rerender(<MemoEmbedRenderer {...props} data={{ a: 1, b: undefined }} />);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
