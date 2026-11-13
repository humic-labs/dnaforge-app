// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MentionChip } from './MentionChip';

vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: ({
    as: As = 'div',
    children,
    ...rest
  }: { as?: string; children?: React.ReactNode } & Record<string, unknown>) => {
    const Tag = As as 'span';
    return <Tag {...rest}>{children}</Tag>;
  },
}));

const listener = vi.fn();

beforeEach(() => {
  listener.mockReset();
  window.addEventListener('waypoint:open-entity', listener);
});
afterEach(() => window.removeEventListener('waypoint:open-entity', listener));

function chip(attrs: Record<string, unknown>) {
  const props = { node: { attrs } } as never;
  return render(<MentionChip {...props} />);
}

describe('a Registry link chip', () => {
  it('keeps the record kind and opens the record by its Registry id', () => {
    chip({
      entityType: 'registry',
      entityId: 'ent-strain',
      label: 'BL21(DE3)',
      registryKind: 'strain',
      path: null,
      contentHash: null,
      objectUuid: null,
    });

    const node = screen.getByTestId('mention-node');
    expect(node.getAttribute('data-entity-type')).toBe('registry');
    expect(node.getAttribute('data-registry-kind')).toBe('strain');
    expect(node.querySelector('svg')).not.toBeNull();

    fireEvent.click(screen.getByTestId('mention-chip'));

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
      entityType: 'registry',
      entityId: 'ent-strain',
      label: 'BL21(DE3)',
      action: 'open',
    });
  });
});
