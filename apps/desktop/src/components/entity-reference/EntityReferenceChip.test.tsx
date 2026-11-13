import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EntityReferenceChip } from './EntityReferenceChip';

async function nextFrame(): Promise<void> {
  await act(
    () =>
      new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      })
  );
}

describe('EntityReferenceChip', () => {
  it('has one fixed shared visual contract without a host or prototype style switch', () => {
    render(
      <EntityReferenceChip
        entityType="sequence"
        label="pUC19.gb"
        detail="pUC19/pUC19.gb"
        onOpen={() => undefined}
        onReveal={() => undefined}
      />
    );
    const chip = screen.getByTestId('entity-reference-chip');
    expect(chip).not.toHaveAttribute('data-entity-reference-style');
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    expect(
      [...chip.children].map((child) => `${child.tagName}.${[...child.classList].join('.')}`)
    ).toEqual(['SPAN.entity-reference-chip__label', 'SPAN.entity-reference-chip__icon']);
  });
  it('uses an extension-free label followed by the registered SVG icon', () => {
    render(<EntityReferenceChip entityType="sequence" label="pUC19.gb" detail="pUC19/pUC19.gb" />);

    const chip = screen.getByTestId('entity-reference-chip');
    expect(screen.getByTestId('entity-reference-chip-label')).toHaveTextContent('pUC19');
    expect(chip.querySelector('svg')).not.toBeNull();
    expect(chip.textContent).not.toContain('🧬');
    expect(chip.lastElementChild?.classList.contains('entity-reference-chip__icon')).toBe(true);
  });

  it('shows the extension-free name followed by the entity type for a package product', () => {
    render(
      <EntityReferenceChip
        entityType="sequence"
        label="pUC19.gb"
        detail="git://My Workspace/pUC19/pUC19.gb"
      />
    );

    fireEvent.mouseEnter(screen.getByTestId('entity-reference-chip'));
    const detail = screen.getByTestId('entity-reference-chip-detail');
    expect(detail).toHaveTextContent('pUC19 · Sequence');
    expect(detail).not.toHaveTextContent('git://');
    expect(detail).not.toHaveTextContent('.gb');
  });

  it('keeps the package name when the durable locator already targets the package root', () => {
    render(
      <EntityReferenceChip entityType="sequence" label="pUC19" detail="git://My Workspace/pUC19" />
    );

    fireEvent.mouseEnter(screen.getByTestId('entity-reference-chip'));
    expect(screen.getByTestId('entity-reference-chip-detail')).toHaveTextContent(
      'pUC19 · Sequence'
    );
  });

  it('never exposes a machine locator scheme in hover detail', () => {
    render(<EntityReferenceChip entityType="structure" label="1FS0" detail="structure:1FS0" />);

    fireEvent.mouseEnter(screen.getByTestId('entity-reference-chip'));
    const detail = screen.getByTestId('entity-reference-chip-detail');
    expect(detail).toHaveTextContent('1FS0 · Structure');
    expect(detail).not.toHaveTextContent('structure:');
  });

  it('never exposes an absolute machine path in hover detail', () => {
    render(
      <EntityReferenceChip
        entityType="sequence"
        label="pUC19.gb"
        detail="/Users/researcher/private-workspace/pUC19/pUC19.gb"
      />
    );

    fireEvent.mouseEnter(screen.getByTestId('entity-reference-chip'));
    const detail = screen.getByTestId('entity-reference-chip-detail');
    expect(detail).toHaveTextContent('pUC19 · Sequence');
    expect(detail).not.toHaveTextContent(/Users|researcher|private-workspace|\.gb/i);
  });

  it('never exposes an absolute Windows path in hover detail', () => {
    render(
      <EntityReferenceChip
        entityType="file"
        label="results.csv"
        detail="C:\\Users\\researcher\\private-workspace\\results.csv"
      />
    );

    fireEvent.mouseEnter(screen.getByTestId('entity-reference-chip'));
    const detail = screen.getByTestId('entity-reference-chip-detail');
    expect(detail).toHaveTextContent('results · File');
    expect(detail).not.toHaveTextContent(/C:|Users|researcher|private-workspace|\.csv/i);
  });

  it('rejects legacy internal copy even when an adapter forgets its state flag', () => {
    render(
      <EntityReferenceChip entityType="sequence" label="pUC19.gb" detail="This workspace only" />
    );

    fireEvent.mouseEnter(screen.getByTestId('entity-reference-chip'));
    const detail = screen.getByTestId('entity-reference-chip-detail');
    expect(detail).toHaveTextContent('pUC19 · Sequence');
    expect(detail).not.toHaveTextContent(/workspace|scope|local.only/i);
  });

  it.each([
    'workspace scope mismatch',
    'current workspace',
    'SQLite',
    'database row',
    'origin-unrecoverable',
  ])('rejects the internal detail %s', (internalDetail) => {
    render(
      <EntityReferenceChip
        entityType="notebook"
        label="Burden mitigation"
        detail={internalDetail}
      />
    );

    fireEvent.mouseEnter(screen.getByTestId('entity-reference-chip'));
    expect(screen.getByTestId('entity-reference-chip-detail')).toHaveTextContent(
      'Burden mitigation · Notebook'
    );
    expect(screen.getByTestId('entity-reference-chip-detail')).not.toHaveTextContent(
      /workspace|scope|sqlite|database|origin/i
    );
  });

  it('never exposes an opaque entity id in hover detail', () => {
    render(
      <EntityReferenceChip
        entityType="notebook"
        label="Burden mitigation"
        detail="5a70e273-3835-4fc5-817b-c82730509c85"
      />
    );

    fireEvent.mouseEnter(screen.getByTestId('entity-reference-chip'));
    const detail = screen.getByTestId('entity-reference-chip-detail');
    expect(detail).toHaveTextContent('Burden mitigation · Notebook');
    expect(detail).not.toHaveTextContent('5a70e273');
  });

  it('gives chat and notebook primer entities the same name-and-type detail', () => {
    render(
      <EntityReferenceChip
        entityType="primer"
        label="F2 forward"
        detail="entity://primer/primer-f2-forward"
      />
    );

    fireEvent.mouseEnter(screen.getByTestId('entity-reference-chip'));
    expect(screen.getByTestId('entity-reference-chip-detail')).toHaveTextContent(
      'F2 forward · Primer'
    );
    expect(screen.getByTestId('entity-reference-chip-detail')).not.toHaveTextContent('entity://');
  });

  it('describes an installation-backed primer without workspace or scope jargon', () => {
    render(
      <EntityReferenceChip
        entityType="primer"
        label="F2 forward"
        detail="This workspace only"
        localOnly
        onOpen={() => undefined}
      />
    );

    const chip = screen.getByTestId('entity-reference-chip');
    expect(chip).toHaveAttribute('aria-label', 'F2 forward, Primer');
    expect(chip.getAttribute('aria-label')).not.toMatch(/workspace|scope|local.only/i);
    fireEvent.mouseEnter(chip);
    expect(screen.getByTestId('entity-reference-chip-detail')).toHaveTextContent(
      'F2 forward · Primer'
    );
    expect(screen.getByTestId('entity-reference-chip-detail')).not.toHaveTextContent(
      /workspace|scope|local.only/i
    );
  });

  it('renders an unknown entity kind as label-only instead of inventing an icon', () => {
    render(<EntityReferenceChip entityType="future-kind" label="Object" detail="Object" />);
    expect(screen.getByTestId('entity-reference-chip').querySelector('svg')).toBeNull();
    expect(screen.getByTestId('entity-reference-chip')).toHaveTextContent('Object');
  });

  it('opens on click, Enter, and Space', () => {
    const onOpen = vi.fn();
    render(
      <EntityReferenceChip entityType="sequence" label="pUC19" detail="pUC19" onOpen={onOpen} />
    );
    const chip = screen.getByTestId('entity-reference-chip');
    fireEvent.click(chip);
    fireEvent.keyDown(chip, { key: 'Enter' });
    fireEvent.keyDown(chip, { key: ' ' });
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it('uses reveal as the primary action when the target is storage-only', () => {
    const onReveal = vi.fn();
    render(
      <EntityReferenceChip
        entityType="text"
        label="README.md"
        detail="Research/README.md"
        onReveal={onReveal}
      />
    );

    const chip = screen.getByTestId('entity-reference-chip');
    expect(chip).toHaveAttribute('role', 'link');
    fireEvent.click(chip);
    fireEvent.keyDown(chip, { key: 'Enter' });
    expect(onReveal).toHaveBeenCalledTimes(2);

    fireEvent.contextMenu(chip);
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Show in Explorer',
    ]);
  });

  it('shows the same ordered action menu by right click and keyboard', async () => {
    const onOpen = vi.fn();
    const onReveal = vi.fn();
    render(
      <EntityReferenceChip
        entityType="sequence"
        label="pUC19"
        detail="pUC19"
        onOpen={onOpen}
        onReveal={onReveal}
      />
    );
    const chip = screen.getByTestId('entity-reference-chip');

    fireEvent.contextMenu(chip);
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Open',
      'Show in Explorer',
    ]);
    fireEvent.keyDown(document, { key: 'Escape' });
    await nextFrame();

    fireEvent.keyDown(chip, { key: 'F10', shiftKey: true });
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show in Explorer' }));
    await nextFrame();
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it('supports roving menu focus and returns focus on Escape', async () => {
    render(
      <EntityReferenceChip
        entityType="sequence"
        label="pUC19"
        detail="pUC19"
        onOpen={() => undefined}
        onReveal={() => undefined}
      />
    );
    const chip = screen.getByTestId('entity-reference-chip');
    act(() => chip.focus());
    fireEvent.keyDown(chip, { key: 'ContextMenu' });
    const items = await screen.findAllByRole('menuitem');
    await nextFrame();
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0].parentElement as HTMLElement, { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    await nextFrame();
    expect(chip).toHaveFocus();
  });

  it('shows associated non-reflowing detail on hover and focus', () => {
    render(<EntityReferenceChip entityType="sequence" label="pUC19" detail="sequences/pUC19.gb" />);
    const chip = screen.getByTestId('entity-reference-chip');
    fireEvent.mouseEnter(chip);
    const detail = screen.getByRole('tooltip');
    expect(detail).toHaveTextContent('pUC19 · Sequence');
    expect(chip).toHaveAttribute('aria-describedby', detail.id);
    fireEvent.mouseLeave(chip);
    fireEvent.focus(chip);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('waits the shared tooltip delay on an attachment chip and hides it on the remove mark', () => {
    vi.useFakeTimers();
    try {
      render(
        <EntityReferenceChip
          entityType="sequence"
          label="pUC19"
          detail="pUC19"
          attachmentPhase="draft"
          endSlot={
            <button type="button" className="entity-reference-chip__remove">
              Remove
            </button>
          }
        />
      );
      fireEvent.mouseEnter(screen.getByTestId('entity-reference-chip'));
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.getByRole('tooltip')).toBeInTheDocument();
      fireEvent.mouseMove(screen.getByRole('button', { name: 'Remove' }));
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a known unavailable reference recognizable and focusable but removes its menu', () => {
    render(
      <EntityReferenceChip
        entityType="sequence"
        label="missing.gb"
        detail="This reference needs to be resolved before it can open."
        unavailable
        onOpen={() => undefined}
        onReveal={() => undefined}
      />
    );
    const chip = screen.getByTestId('entity-reference-chip');
    expect(chip).toHaveAttribute('aria-disabled', 'true');
    expect(chip).toHaveAttribute('role', 'link');
    expect(chip).toHaveAttribute('tabindex', '0');
    fireEvent.mouseEnter(chip);
    expect(screen.getByTestId('entity-reference-chip-detail')).toHaveTextContent(
      'missing · Sequence · Unavailable'
    );
    expect(screen.getByTestId('entity-reference-chip-detail')).not.toHaveTextContent(/resolved/i);
    fireEvent.contextMenu(chip);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps focus and link semantics while one activation is in flight', () => {
    const onOpen = vi.fn();
    const onReveal = vi.fn();
    render(
      <EntityReferenceChip
        entityType="sequence"
        label="pUC19"
        detail="internal detail ignored"
        busy
        onOpen={onOpen}
        onReveal={onReveal}
      />
    );

    const chip = screen.getByTestId('entity-reference-chip');
    act(() => chip.focus());
    expect(chip).toHaveFocus();
    expect(chip).toHaveAttribute('role', 'link');
    expect(chip).toHaveAttribute('tabindex', '0');
    expect(chip).toHaveAttribute('aria-busy', 'true');

    fireEvent.click(chip);
    fireEvent.keyDown(chip, { key: 'Enter' });
    fireEvent.keyDown(chip, { key: ' ' });
    fireEvent.contextMenu(chip);

    expect(onOpen).not.toHaveBeenCalled();
    expect(onReveal).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(chip).toHaveFocus();
  });

  it('does not advertise link semantics when its host has no open action', () => {
    render(<EntityReferenceChip entityType="sequence" label="pUC19" detail="pUC19" />);
    const chip = screen.getByTestId('entity-reference-chip');
    expect(chip).not.toHaveAttribute('role');
    expect(chip).toHaveAttribute('tabindex', '-1');
  });
});
