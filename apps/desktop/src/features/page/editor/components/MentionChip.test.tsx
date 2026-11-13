/**
 * @vitest-environment jsdom
 */
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

function chip(attrs: Record<string, unknown>) {
  const props = { node: { attrs } } as never;
  return render(<MentionChip {...props} />);
}

const SEQ = {
  entityType: 'sequence',
  entityId: 'ent-1',
  label: 'pUC19',
  path: 'sequences/pUC19.gb',
  contentHash: null,
};

let opened: CustomEvent[] = [];
const listener = (event: Event) => opened.push(event as CustomEvent);

beforeEach(() => {
  opened = [];
  window.addEventListener('waypoint:open-entity', listener);
});
afterEach(() => window.removeEventListener('waypoint:open-entity', listener));

describe('markup contract', () => {
  it('renders as a SPAN, never a div', () => {
    const { container } = chip(SEQ);
    expect(container.querySelector('span[data-testid="mention-chip"]')).not.toBeNull();
    expect(container.querySelector('div[data-testid="mention-chip"]')).toBeNull();
  });

  it('keeps the .mention class and data-type the rest of the app keys off', () => {
    const el = chip(SEQ).container.querySelector('[data-testid="mention-node"]');
    expect(el?.classList.contains('mention')).toBe(true);
    expect(el?.getAttribute('data-type')).toBe('mention');
  });

  it('shows the label', () => {
    chip(SEQ);
    expect(screen.getByTestId('mention-chip-label')).toHaveTextContent('pUC19');
  });
});

describe('routing', () => {
  it('opens the target on click, carrying the whole record', () => {
    chip(SEQ);
    fireEvent.click(screen.getByTestId('mention-chip'));

    expect(opened).toHaveLength(1);
    expect(opened[0].detail).toMatchObject({
      action: 'open',
      path: 'sequences/pUC19.gb',
      entityId: 'ent-1',
    });
  });

  it('opens a chip that has ONLY a path (entityId null under D8)', () => {
    chip({ ...SEQ, entityId: null });
    fireEvent.click(screen.getByTestId('mention-chip'));

    expect(opened).toHaveLength(1);
    expect(opened[0].detail).toMatchObject({ action: 'open', entityId: null });
  });

  it('opens a chip whose only surviving identity is its content fingerprint', () => {
    chip({
      ...SEQ,
      entityId: null,
      path: null,
      objectUuid: null,
      contentHash: `sha256:${'a'.repeat(64)}`,
    });
    fireEvent.click(screen.getByTestId('mention-chip'));

    expect(opened).toHaveLength(1);
    expect(opened[0].detail.contentHash).toBe(`sha256:${'a'.repeat(64)}`);
  });

  it('routes Show in Explorer through the same portable record without opening', () => {
    chip(SEQ);
    fireEvent.contextMenu(screen.getByTestId('mention-chip'));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Open',
      'Show in Explorer',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show in Explorer' }));

    expect(opened).toHaveLength(1);
    expect(opened[0].detail).toMatchObject({
      action: 'reveal',
      path: 'sequences/pUC19.gb',
      entityId: 'ent-1',
    });
  });

  it('reads the owning root at click time instead of keeping a stale mount-time value', () => {
    let root: string | null = null;
    const props = {
      node: { attrs: SEQ },
      extension: { options: { referenceWorkspaceRoot: () => root } },
    } as never;
    render(<MentionChip {...props} />);
    root = '/workspace/now-ready';

    fireEvent.click(screen.getByTestId('mention-chip'));

    expect(opened[0].detail.owningRoot).toBe('/workspace/now-ready');
  });

  it('does not memoize away a repaired durable identity', () => {
    const firstProps = { node: { attrs: { ...SEQ, objectUuid: null } } } as never;
    const repairedProps = {
      node: { attrs: { ...SEQ, objectUuid: 'object-after-repair' } },
    } as never;
    const view = render(<MentionChip {...firstProps} />);

    view.rerender(<MentionChip {...repairedProps} />);
    fireEvent.click(screen.getByTestId('mention-chip'));

    expect(opened[0].detail.objectUuid).toBe('object-after-repair');
  });

  it('does nothing when there is neither a path nor an id', () => {
    chip({ ...SEQ, entityId: null, path: null });
    fireEvent.click(screen.getByTestId('mention-chip'));
    expect(opened).toHaveLength(0);
  });

  it('carries NO trailing affordance inside the link', () => {
    chip(SEQ);
    expect(screen.queryByTestId('mention-chip-registry')).toBeNull();
  });

  it('a single click produces exactly ONE open, and nothing else', () => {
    chip(SEQ);
    fireEvent.click(screen.getByTestId('mention-chip'));
    expect(opened.map((e) => e.detail.action)).toEqual(['open']);
  });
});

describe('keyboard', () => {
  it('is focusable', () => {
    expect(chip(SEQ).container.querySelector('[data-testid="mention-chip"]')).toHaveAttribute(
      'tabindex',
      '0'
    );
  });

  it('activates on Enter', () => {
    chip(SEQ);
    fireEvent.keyDown(screen.getByTestId('mention-chip'), { key: 'Enter' });
    expect(opened.map((e) => e.detail.action)).toEqual(['open']);
  });

  it('activates on Space', () => {
    chip(SEQ);
    fireEvent.keyDown(screen.getByTestId('mention-chip'), { key: ' ' });
    expect(opened.map((e) => e.detail.action)).toEqual(['open']);
  });

  it('ignores other keys so typing around a chip is unaffected', () => {
    chip(SEQ);
    fireEvent.keyDown(screen.getByTestId('mention-chip'), { key: 'a' });
    expect(opened).toHaveLength(0);
  });

  it('surfaces the detail on FOCUS, not only hover', () => {
    chip(SEQ);
    expect(screen.queryByTestId('mention-chip-detail')).toBeNull();

    fireEvent.focus(screen.getByTestId('mention-chip'));
    expect(screen.getByTestId('mention-chip-detail')).toHaveTextContent('pUC19 · Sequence');
  });

  it('surfaces the detail on hover too', () => {
    chip(SEQ);
    fireEvent.mouseEnter(screen.getByTestId('mention-chip'));
    expect(screen.getByTestId('mention-chip-detail')).toBeInTheDocument();
  });
});

describe('legacy chips (the shipped MoClo shape)', () => {
  const LEGACY = {
    entityType: 'sequence',
    entityId: 'sequences/kits/moclo-cidar/E1010m_CD.gb',
    label: 'E1010m (mRFP)',
    path: null,
    contentHash: null,
  };

  it('is NOT marked local-only — its entityId is a portable path', () => {
    const el = chip(LEGACY).container.querySelector('[data-testid="mention-chip"]');
    expect(el?.getAttribute('data-local-only')).toBeNull();
  });

  it('shows the same name-and-type hover detail as every other entity chip', () => {
    chip(LEGACY);
    fireEvent.mouseEnter(screen.getByTestId('mention-chip'));
    const detail = screen.getByTestId('mention-chip-detail');
    expect(detail).toHaveTextContent('E1010m (mRFP) · Sequence');
    expect(detail).not.toHaveTextContent('.gb');
  });

  it('still opens', () => {
    chip(LEGACY);
    fireEvent.click(screen.getByTestId('mention-chip'));
    expect(opened).toHaveLength(1);
  });

  it('a PAGE id that is not a path stays non-portable', () => {
    const el = chip({
      entityType: 'page',
      entityId: 'page-123',
      label: 'Notes',
      path: null,
      contentHash: null,
    }).container.querySelector('[data-testid="mention-chip"]');
    expect(el?.getAttribute('data-local-only')).toBe('true');
  });
});

describe('the hover card can never be stranded on screen', () => {
  it('drops the hover card when the chip is clicked', () => {
    chip(SEQ);
    fireEvent.mouseEnter(screen.getByTestId('mention-chip'));
    expect(screen.getByTestId('mention-chip-detail')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('mention-chip'));

    expect(screen.queryByTestId('mention-chip-detail')).toBeNull();
  });

  it('drops the hover card on the first pointer move that is not over the chip', () => {
    chip(SEQ);
    fireEvent.mouseEnter(screen.getByTestId('mention-chip'));
    expect(screen.getByTestId('mention-chip-detail')).toBeInTheDocument();

    fireEvent.pointerMove(document.body);

    expect(screen.queryByTestId('mention-chip-detail')).toBeNull();
  });

  it('keeps the card while the pointer is still inside the chip', () => {
    chip(SEQ);
    fireEvent.mouseEnter(screen.getByTestId('mention-chip'));

    fireEvent.pointerMove(screen.getByTestId('mention-chip-label'));

    expect(screen.getByTestId('mention-chip-detail')).toBeInTheDocument();
  });

  it('leaves a FOCUSED chip alone — a keyboard user is still on it', () => {
    chip(SEQ);
    fireEvent.focus(screen.getByTestId('mention-chip'));

    fireEvent.pointerMove(document.body);

    expect(screen.getByTestId('mention-chip-detail')).toBeInTheDocument();
  });

  it('listens only while its card is open', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');

    chip(SEQ);
    expect(add.mock.calls.filter(([type]) => type === 'pointermove')).toHaveLength(0);

    fireEvent.mouseEnter(screen.getByTestId('mention-chip'));
    expect(add.mock.calls.filter(([type]) => type === 'pointermove')).toHaveLength(1);

    fireEvent.mouseLeave(screen.getByTestId('mention-chip'));
    expect(remove.mock.calls.filter(([type]) => type === 'pointermove')).toHaveLength(1);

    add.mockRestore();
    remove.mockRestore();
  });
});

describe('installation-backed chips (D9)', () => {
  const LOCAL = { ...SEQ, entityType: 'primer', path: null, entityId: 'p1' };

  it('marks itself local-only', () => {
    const el = chip(LOCAL).container.querySelector('[data-testid="mention-chip"]');
    expect(el?.getAttribute('data-local-only')).toBe('true');
  });

  it('uses the entity kind in its accessible name without internal scope language', () => {
    const el = chip(LOCAL).container.querySelector('[data-testid="mention-chip"]');
    expect(el?.getAttribute('aria-label')).toBe('pUC19, Primer');
    expect(el?.getAttribute('aria-label')).not.toMatch(/workspace|scope|local.only/i);
  });

  it('uses the shared name-and-type detail without storage language', () => {
    chip({ ...LOCAL, label: 'F2 forward' });
    fireEvent.mouseEnter(screen.getByTestId('mention-chip'));
    const detail = screen.getByTestId('mention-chip-detail');
    expect(detail).toHaveTextContent('F2 forward · Primer');
    expect(detail).not.toHaveTextContent(/workspace|scope|database|unresolved/i);
  });

  it('still opens, because it resolves on THIS installation', () => {
    chip(LOCAL);
    fireEvent.click(screen.getByTestId('mention-chip'));
    expect(opened).toHaveLength(1);
  });
});

describe('a link to another notebook entry has ordinary entity language', () => {
  const ENTRY = {
    entityType: 'page',
    entityId: 'corpus-11-burden-mitigation',
    label: '11 — Burden mitigation',
    path: 'notebooks/11 — Burden mitigation',
    contentHash: null,
  };

  it('is not marked local-only', () => {
    const el = chip(ENTRY).container.querySelector('[data-testid="mention-chip"]');
    expect(el?.getAttribute('data-local-only')).toBeNull();
  });

  it('does not expose internal scope language in its accessible name', () => {
    const el = chip(ENTRY).container.querySelector('[data-testid="mention-chip"]');
    expect(el?.getAttribute('aria-label')).toBe('11 — Burden mitigation, Notebook');
    expect(el?.getAttribute('aria-label')).not.toMatch(/workspace|scope|local.only/i);
  });

  it('an entry link with NO location is still honestly marked', () => {
    const el = chip({ ...ENTRY, path: null }).container.querySelector(
      '[data-testid="mention-chip"]'
    );
    expect(el?.getAttribute('data-local-only')).toBe('true');
    fireEvent.mouseEnter(screen.getByTestId('mention-chip'));
    expect(screen.getByTestId('mention-chip-detail')).toHaveTextContent(
      '11 — Burden mitigation · Notebook'
    );
  });
});
