import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { useState } from 'react';
import { PrimerSequenceInput } from './PrimerSequenceInput';

const scrollIntoNearestScrollContainerMock = vi.hoisted(() => vi.fn());

vi.mock('../../../shared/utils/safeFocus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/utils/safeFocus')>();
  return {
    ...actual,
    scrollIntoNearestScrollContainer: scrollIntoNearestScrollContainerMock,
  };
});

function clickMenuItem(element: Element) {
  fireEvent.mouseDown(element);
  fireEvent.mouseUp(element);
  fireEvent.click(element);
}

function modificationFact(term: string): string | null {
  const facts = screen.getByTestId('primer-modification-facts');
  const label = within(facts).queryByText(term, { selector: 'dt' });
  return label?.nextElementSibling?.textContent ?? null;
}

function EditablePrimerSequence({
  initial = '',
  orderType = 'dna',
  variant = 'canvas',
}: {
  initial?: string;
  orderType?: 'dna' | 'rna';
  variant?: 'field' | 'canvas';
}) {
  const [value, setValue] = useState(initial);
  return (
    <PrimerSequenceInput
      value={value}
      onChange={setValue}
      variant={variant}
      orderType={orderType}
    />
  );
}

describe('PrimerSequenceInput', () => {
  beforeEach(() => {
    scrollIntoNearestScrollContainerMock.mockClear();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
  });

  it('keeps a manually resized field height while its sequence is edited', () => {
    const { rerender } = render(<PrimerSequenceInput value="acgt" onChange={vi.fn()} />);
    const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;
    input.style.height = '160px';
    rerender(<PrimerSequenceInput value="acgta" onChange={vi.fn()} />);
    expect(input.style.height).toBe('160px');
    input.style.height = '80px';
    rerender(<PrimerSequenceInput value="acgtac" onChange={vi.fn()} />);
    expect(input.style.height).toBe('80px');
  });

  it.each(['field', 'canvas'] as const)(
    'uses one cell per modification in the %s entry with exact copy notation',
    (variant) => {
      render(<EditablePrimerSequence initial="/5Phos/AC/iBiodT/G" variant={variant} />);
      const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;
      expect(input.value).toBe('*ACTG');
      const token = screen
        .getByTestId('primer-sequence-highlight')
        .querySelector('[data-vendor-code="iBiodT"]')!;
      expect(token.textContent).toBe('T');
      fireEvent.mouseEnter(token);
      expect(screen.getByTestId('primer-modification-token-preview')).toHaveTextContent(
        'Internal Biotin-dT'
      );
      input.setSelectionRange(0, input.value.length);
      const clipboardData = { setData: vi.fn() };
      fireEvent.copy(input, { clipboardData });
      expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', '/5Phos/AC/iBiodT/G');
    }
  );

  it('replaces a modified base with the same plain letter without retaining its chemistry', () => {
    render(<EditablePrimerSequence initial="AC/iBiodT/G" />);
    const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;
    input.setSelectionRange(2, 3);
    input.dispatchEvent(
      new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: 'T' })
    );
    fireEvent.input(input, { target: { value: 'ACTG', selectionStart: 3, selectionEnd: 3 } });
    expect(input).toHaveAttribute('data-oligo-notation', 'ACTG');
    expect(
      screen.getByTestId('primer-sequence-highlight').querySelector('[data-vendor-code]')
    ).toBeNull();
    fireEvent.keyDown(input, { key: 'z', metaKey: true });
    expect(input).toHaveAttribute('data-oligo-notation', 'AC/iBiodT/G');
  });

  it('renders each base and marks mismatch positions (matching the drawn primer)', () => {
    render(<PrimerSequenceInput value="ACGT" onChange={vi.fn()} mismatchPositions={[1, 3]} />);
    const backdrop = screen.getByTestId('primer-sequence-highlight');
    const spans = Array.from(backdrop.querySelectorAll('span'));
    expect(spans.map((s) => s.textContent).join('')).toBe('ACGT');
    const marked = spans.filter((s) => s.getAttribute('data-mismatch') === 'true');
    expect(marked.map((s) => s.textContent)).toEqual(['C', 'T']);
    expect(marked[0].className).toContain('text-error');
    expect(marked[0].className).toContain('font-black');
  });

  it('marks nothing when there are no mismatches', () => {
    render(<PrimerSequenceInput value="ACGT" onChange={vi.fn()} mismatchPositions={[]} />);
    const backdrop = screen.getByTestId('primer-sequence-highlight');
    expect(backdrop.querySelectorAll('[data-mismatch="true"]')).toHaveLength(0);
  });

  it('preserves the typed case (lowercase is meaningful for primers)', () => {
    const onChange = vi.fn();
    render(<PrimerSequenceInput value="" onChange={onChange} />);
    fireEvent.change(screen.getByTestId('primer-sequence-input'), { target: { value: 'acGT' } });
    expect(onChange).toHaveBeenCalledWith('acGT');
  });

  it('keeps sequential lowercase M ambiguity input valid in a DNA oligo', () => {
    render(<EditablePrimerSequence />);
    const input = screen.getByTestId('primer-sequence-input');

    for (const value of ['m', 'ma', 'mc', 'mg', 'mt']) {
      fireEvent.change(input, { target: { value } });
      expect(input, value).not.toHaveAttribute('aria-invalid');
      const backdrop = screen.getByTestId('primer-sequence-highlight');
      expect(backdrop.querySelectorAll('[data-oligo-run="invalid"]'), value).toHaveLength(0);
      expect(backdrop.querySelector('[data-oligo-run="degenerate-base"]'), value).toHaveTextContent(
        'm'
      );
    }
  });

  it('soft-wraps long primers instead of forcing a single horizontal line', () => {
    render(
      <PrimerSequenceInput
        value={'ACGT'.repeat(30)}
        onChange={vi.fn()}
        variant="canvas"
        showPrimeLabels
      />
    );
    const input = screen.getByTestId('primer-sequence-input');
    expect(input).toHaveAttribute('wrap', 'soft');
    expect(input.className).toContain('overflow-x-hidden');
    expect(screen.getByTestId('primer-sequence-highlight').className).toContain(
      'whitespace-pre-wrap'
    );
  });

  it('fills its canvas container and scrolls the colored backdrop with the textarea', () => {
    const { rerender } = render(
      <PrimerSequenceInput value="ACGT" onChange={vi.fn()} variant="canvas" showPrimeLabels />
    );
    const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;
    const backdrop = screen.getByTestId('primer-sequence-highlight');
    const shell = screen.getByTestId('primer-sequence-shell');
    expect(input.style.height).toBe('');
    expect(input.className).toContain('h-full');
    expect(input.className).toContain('min-h-0');
    expect(shell.className).toContain('h-full');
    expect(shell.className).toContain('min-h-0');

    rerender(
      <PrimerSequenceInput
        value={'ACGT'.repeat(500)}
        onChange={vi.fn()}
        variant="canvas"
        showPrimeLabels
      />
    );
    expect(input.style.height).toBe('');
    input.scrollTop = 96;
    fireEvent.scroll(input);
    expect(backdrop.scrollTop).toBe(96);
  });

  it('keeps prime labels inside the canvas while excluding them from the editable sequence', () => {
    render(
      <PrimerSequenceInput value="ACGT" onChange={vi.fn()} variant="canvas" showPrimeLabels />
    );

    const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;
    const fivePrime = screen.getByTestId('primer-sequence-five-prime');
    const threePrime = screen.getByTestId('primer-sequence-three-prime');
    const backdrop = screen.getByTestId('primer-sequence-highlight');

    expect(input.value).toBe('ACGT');
    expect(fivePrime).toHaveTextContent('5′');
    expect(threePrime).toHaveTextContent('3′');
    expect(fivePrime).toHaveAttribute('aria-hidden', 'true');
    expect(threePrime).toHaveAttribute('aria-hidden', 'true');
    expect(fivePrime.className).toContain('select-none');
    expect(threePrime.className).toContain('select-none');
    expect(threePrime.className).toContain('ml-3');
    expect(backdrop.textContent).toContain('ACGT3′');
  });

  it('shows the fixed 5′ label but no detached 3′ suffix before bases exist', () => {
    render(<PrimerSequenceInput value="" onChange={vi.fn()} variant="canvas" showPrimeLabels />);

    expect(screen.getByTestId('primer-sequence-five-prime')).toBeInTheDocument();
    expect(screen.queryByTestId('primer-sequence-three-prime')).not.toBeInTheDocument();
  });

  it('does not draw the field focus box around the canvas variant', () => {
    render(<PrimerSequenceInput value="ACGT" onChange={vi.fn()} variant="canvas" />);
    const shell = screen.getByTestId('primer-sequence-shell');
    expect(shell.className).not.toContain('focus-within:ring-1');
    expect(shell.className).not.toContain('focus-within:border-accent');
  });

  it('opens a searchable IDT picker on slash and inserts the selected modification', () => {
    render(<EditablePrimerSequence />);
    const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;

    fireEvent.change(input, {
      target: { value: '/pho', selectionStart: 4, selectionEnd: 4 },
    });

    expect(screen.getByTestId('primer-modification-picker')).toBeVisible();
    expect(screen.getByRole('option', { name: /5′ phosphorylation.*5Phos/i })).toBeVisible();
    expect(screen.getByRole('option', { name: /3′ phosphorylation.*3Phos/i })).toBeVisible();
    clickMenuItem(screen.getByRole('option', { name: /5′ phosphorylation.*5Phos/i }));

    expect(input).toHaveAttribute('data-oligo-notation', '/5Phos/');
    expect(screen.queryByTestId('primer-modification-picker')).not.toBeInTheDocument();
  });

  it('anchors the field modification picker below the entire input', () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const isInput = this.tagName === 'TEXTAREA';
        return {
          top: 300,
          bottom: isInput ? 360 : 320,
          left: 100,
          right: 300,
          width: 200,
          height: isInput ? 60 : 20,
          x: 100,
          y: 300,
          toJSON: () => ({}),
        } as DOMRect;
      });
    try {
      render(<EditablePrimerSequence variant="field" />);
      const input = screen.getByTestId('primer-sequence-input');
      fireEvent.change(input, { target: { value: '/pho', selectionStart: 4, selectionEnd: 4 } });
      const picker = screen.getByTestId('primer-modification-picker');
      expect(picker).toHaveAttribute('data-placement', 'below');
      expect(picker.style.top).toBe('364px');
    } finally {
      rect.mockRestore();
    }
  });

  it('links to the official IDT modification catalog from the picker footer', () => {
    render(<EditablePrimerSequence />);
    const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;

    fireEvent.change(input, {
      target: { value: '/', selectionStart: 1, selectionEnd: 1 },
    });

    expect(
      screen.getByRole('link', { name: /browse the IDT modification catalog/i })
    ).toHaveAttribute('href', 'https://www.idtdna.com/site/catalog/modifications');
  });

  it('derives picker hits and category counts from the selected oligo entity type', () => {
    const rna = render(<EditablePrimerSequence orderType="rna" />);
    const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;

    fireEvent.change(input, {
      target: { value: '/55HydMe', selectionStart: 9, selectionEnd: 9 },
    });
    expect(screen.getByText('No IDT modifications match these filters.')).toBeVisible();

    fireEvent.change(input, {
      target: { value: '/5IRD700', selectionStart: 9, selectionEnd: 9 },
    });
    expect(screen.getByText('No IDT modifications match these filters.')).toBeVisible();

    rna.unmount();
    render(<EditablePrimerSequence orderType="dna" />);
    fireEvent.change(screen.getByTestId('primer-sequence-input'), {
      target: { value: '/55HydMe', selectionStart: 9, selectionEnd: 9 },
    });
    expect(screen.getByRole('option', { name: /Hydroxymethyl dC.*55HydMe-dC/i })).toBeVisible();

    fireEvent.change(screen.getByTestId('primer-sequence-input'), {
      target: { value: '/5IRD700', selectionStart: 9, selectionEnd: 9 },
    });
    expect(screen.getByRole('option', { name: /IRDye.*700.*5IRD700/i })).toBeVisible();
  });

  it('uses polymer-specific markup for bare T and U bases', () => {
    const dna = render(<EditablePrimerSequence initial="TU" orderType="dna" />);
    let input = screen.getByTestId('primer-sequence-input');
    let backdrop = screen.getByTestId('primer-sequence-highlight');

    expect(backdrop.querySelector('[data-oligo-run="base"]')).toHaveTextContent('T');
    expect(backdrop.querySelector('[data-oligo-run="invalid"]')).toHaveTextContent('U');
    expect(input).toHaveAttribute('aria-invalid', 'true');

    dna.unmount();
    render(<EditablePrimerSequence initial="UT" orderType="rna" />);
    input = screen.getByTestId('primer-sequence-input');
    backdrop = screen.getByTestId('primer-sequence-highlight');

    expect(backdrop.querySelector('[data-oligo-run="rna-base"]')).toHaveTextContent('U');
    const alternatePolymerBase = backdrop.querySelector(
      '[data-oligo-run="alternate-polymer-base"]'
    );
    expect(alternatePolymerBase).toHaveTextContent('T');
    expect(alternatePolymerBase).toHaveAttribute('data-oligo-visual-state', 'special-base');
    expect(alternatePolymerBase?.className).toContain('text-oligo-special');
    expect(alternatePolymerBase?.className).not.toContain('text-warning');
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('marks a recognized DNA-only code as incompatible in an RNA oligo', () => {
    render(
      <PrimerSequenceInput
        value="/55HydMe-dC/rArC"
        onChange={vi.fn()}
        variant="canvas"
        orderType="rna"
      />
    );

    const token = screen
      .getByTestId('primer-sequence-highlight')
      .querySelector('[data-vendor-code="55HydMe-dC"]');
    expect(token).toHaveAttribute('data-oligo-status', 'incompatible-position');
    expect(token).toHaveAttribute('data-oligo-error', 'true');
    expect(screen.getByTestId('primer-sequence-input')).toHaveAttribute('aria-invalid', 'true');
  });

  it('filters the picker by official IDT category and allowed sequence position', () => {
    render(<EditablePrimerSequence />);
    const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;

    fireEvent.change(input, {
      target: { value: '/', selectionStart: 1, selectionEnd: 1 },
    });
    const category = screen.getByLabelText('IDT modification category');
    const placement = screen.getByLabelText('IDT modification position');

    fireEvent.click(category);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Fluorophores \(/ }));
    fireEvent.click(category);
    expect(screen.getByRole('option', { name: /5′ 6-FAM 56-FAM$/i })).toBeVisible();
    expect(screen.queryByRole('option', { name: /5′ phosphorylation.*5Phos/i })).toBeNull();

    fireEvent.click(placement);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /3′ end \(/ }));
    expect(screen.getByRole('option', { name: /3′ 6-FAM 36-FAM$/i })).toBeVisible();
    expect(screen.queryByRole('option', { name: /5′ 6-FAM 56-FAM$/i })).toBeNull();

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /5′ end \(/ }));
    expect(screen.getByRole('option', { name: /3′ 6-FAM 36-FAM$/i })).toBeVisible();
    expect(screen.getByRole('option', { name: /5′ 6-FAM 56-FAM$/i })).toBeVisible();
    expect(placement).toHaveTextContent('2 selected');
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /5′ end \(/ }));
    fireEvent.click(placement);

    fireEvent.click(category);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Fluorophores \(/ }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Phosphorylation \(/ }));
    fireEvent.click(category);
    expect(screen.getByRole('option', { name: /3′ phosphorylation.*3Phos/i })).toBeVisible();
    expect(screen.queryByRole('option', { name: /5′ phosphorylation.*5Phos/i })).toBeNull();

    fireEvent.click(placement);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Internal \(/ }));
    fireEvent.click(placement);
    expect(screen.getByTestId('primer-modification-picker')).toBeVisible();
    expect(screen.getByText('No IDT modifications match these filters.')).toBeVisible();

    fireEvent.click(category);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Phosphorylation \(/ }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Click Chemistry \(/ }));
    fireEvent.click(category);
    fireEvent.click(placement);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear' }));
    fireEvent.click(placement);
    expect(screen.getByRole('option', { name: /5′ Hexynyl.*5Hexynyl/i })).toBeVisible();
    expect(screen.queryByRole('option', { name: /5′ phosphorylation.*5Phos/i })).toBeNull();
  });

  it('places shared compact filter controls directly above the rows they filter', () => {
    render(<EditablePrimerSequence />);
    const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;

    fireEvent.change(input, {
      target: { value: '/', selectionStart: 1, selectionEnd: 1 },
    });

    const filterBar = screen.getByTestId('primer-modification-filter-bar');
    const results = screen.getByTestId('primer-modification-results');
    expect(filterBar.nextElementSibling).toBe(results);
    expect(screen.getByLabelText('IDT modification category')).toHaveAttribute(
      'data-compact-filter-multiselect',
      'true'
    );
    const positionFilter = screen.getByLabelText('IDT modification position');
    expect(positionFilter).toHaveAttribute('data-compact-filter-multiselect', 'true');
    vi.spyOn(positionFilter, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(220, 120, 124, 24)
    );
    fireEvent.click(positionFilter);
    const positionMenu = screen.getByRole('menu', { name: 'IDT modification position' });
    expect(positionMenu).toHaveAttribute('data-compact-filter-menu', 'true');
    expect(positionMenu).toHaveStyle({ top: '148px', left: '220px', width: '124px' });
    expect(positionFilter).toHaveClass('wp-menu-trigger');
    expect(positionFilter).toHaveAttribute('aria-expanded', 'true');
    expect(positionMenu).toHaveClass('wp-menu');
    expect(positionFilter).toHaveAttribute('aria-controls', positionMenu.id);

    fireEvent.click(positionFilter);
    const categoryFilter = screen.getByLabelText('IDT modification category');
    vi.spyOn(categoryFilter, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(12, 120, 200, 24)
    );
    fireEvent.click(categoryFilter);
    const categoryMenu = screen.getByRole('menu', { name: 'IDT modification category' });
    expect(categoryMenu).toHaveAttribute('data-menu-align', 'end');
    expect(categoryMenu.className.split(/\s+/)).toContain('fixed');
    expect(categoryMenu).toHaveStyle({ top: '148px', left: '12px', width: '200px' });
  });

  it('combines checked modification categories with OR semantics', () => {
    render(<EditablePrimerSequence />);
    const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;

    fireEvent.change(input, {
      target: { value: '/', selectionStart: 1, selectionEnd: 1 },
    });
    fireEvent.click(screen.getByLabelText('IDT modification category'));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Fluorophores \(/ }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Phosphorylation \(/ }));

    expect(screen.getByRole('option', { name: /5′ 6-FAM 56-FAM$/i })).toBeVisible();
    expect(screen.getByRole('option', { name: /5′ phosphorylation.*5Phos/i })).toBeVisible();
    expect(screen.getByTestId('primer-modification-category-filter')).toHaveTextContent(
      '2 selected'
    );
  });

  it('renders RNA and 2-prime-O-methyl bases as one biological character and copies exact RNA', () => {
    render(
      <PrimerSequenceInput
        value="/5Phos/rAmCrGrU"
        onChange={vi.fn()}
        orderType="rna"
        variant="canvas"
      />
    );

    const backdrop = screen.getByTestId('primer-sequence-highlight');
    expect(backdrop.querySelectorAll('[data-oligo-run="rna-base"]')).toHaveLength(3);
    expect(backdrop.querySelectorAll('[data-oligo-run="two-prime-o-methyl-base"]')).toHaveLength(1);
    expect(backdrop.textContent?.trim()).toBe('*ACGU');

    fireEvent.contextMenu(screen.getByTestId('primer-sequence-input'), {
      clientX: 10,
      clientY: 10,
    });
    clickMenuItem(screen.getByRole('menuitem', { name: 'Copy for IDT' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/5Phos/rAmCrGrU');
  });

  it('copies an RNA-compatible U modification as U while preserving exact IDT notation', () => {
    const notation = 'rA/i2FU/rC';
    render(
      <PrimerSequenceInput value={notation} onChange={vi.fn()} orderType="rna" variant="canvas" />
    );

    fireEvent.contextMenu(screen.getByTestId('primer-sequence-input'), {
      clientX: 10,
      clientY: 10,
    });
    clickMenuItem(screen.getByRole('menuitem', { name: 'Copy bases' }));
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('AUC');

    fireEvent.contextMenu(screen.getByTestId('primer-sequence-input'), {
      clientX: 10,
      clientY: 10,
    });
    clickMenuItem(screen.getByRole('menuitem', { name: 'Copy for IDT' }));
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(notation);
  });

  it('copies plain RNA editor bases as vendor-ready IDT notation', () => {
    render(
      <PrimerSequenceInput value="MRGU" onChange={vi.fn()} orderType="rna" variant="canvas" />
    );

    fireEvent.contextMenu(screen.getByTestId('primer-sequence-input'), {
      clientX: 10,
      clientY: 10,
    });
    clickMenuItem(screen.getByRole('menuitem', { name: 'Copy for IDT' }));
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('rMrRrGrU');
  });

  it('keeps the keyboard-highlighted modification visible in the result scroller', () => {
    render(<EditablePrimerSequence />);
    const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;

    fireEvent.change(input, {
      target: { value: '/', selectionStart: 1, selectionEnd: 1 },
    });
    scrollIntoNearestScrollContainerMock.mockClear();
    for (let index = 0; index < 20; index += 1) {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    }

    const selected = screen
      .getByTestId('primer-modification-results')
      .querySelector('button[role="option"][aria-selected="true"]');
    expect(selected).not.toBeNull();
    expect(scrollIntoNearestScrollContainerMock).toHaveBeenLastCalledWith(selected, {
      block: 'nearest',
    });
  });

  it('inserts an Affinity Plus base from the slash picker as exact IDT notation', () => {
    render(<EditablePrimerSequence initial="AC" />);
    const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;

    fireEvent.change(input, {
      target: { value: 'AC/affinity', selectionStart: 11, selectionEnd: 11 },
    });
    const option = screen.getByRole('option', { name: /Affinity Plus A.*\+A/i });
    clickMenuItem(option);

    expect(input).toHaveAttribute('data-oligo-notation', 'AC+A');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(
      screen.getByTestId('primer-sequence-highlight').querySelector('[data-vendor-code="+A"]')
    ).toHaveTextContent('A');
  });

  it('keeps every matching placement available while an oligo is still being typed', () => {
    render(<EditablePrimerSequence initial="AC" />);
    const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;

    fireEvent.change(input, {
      target: { value: 'AC/spacer', selectionStart: 9, selectionEnd: 9 },
    });
    expect(screen.getByRole('option', { name: /5′ Spacer 18.*5Sp18/i })).toBeVisible();
    expect(screen.getByRole('option', { name: /Internal Spacer 18.*iSp18/i })).toBeVisible();
    expect(screen.getByRole('option', { name: /3′ Spacer 18.*3Sp18/i })).toBeVisible();

    clickMenuItem(screen.getByRole('option', { name: /Internal Spacer 18.*iSp18/i }));
    expect(input).toHaveAttribute('data-oligo-notation', 'AC/iSp18/');
    expect(input).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(input, {
      target: { value: 'AC/iSp18/G', selectionStart: 10, selectionEnd: 10 },
    });
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('supports keyboard navigation in the slash picker', () => {
    render(<EditablePrimerSequence />);
    const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;
    fireEvent.change(input, {
      target: { value: '/phos', selectionStart: 5, selectionEnd: 5 },
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveAttribute('data-oligo-notation', '/5Phos/');
  });

  it('closes an unfinished slash picker when horizontal caret movement leaves its query', () => {
    render(<EditablePrimerSequence />);
    const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;
    fireEvent.change(input, {
      target: { value: '/ph', selectionStart: 3, selectionEnd: 3 },
    });

    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    expect(screen.queryByTestId('primer-modification-picker')).not.toBeInTheDocument();
    expect(input.value).toBe('/ph');

    fireEvent.change(input, {
      target: { value: '/pho', selectionStart: 4, selectionEnd: 4 },
    });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByTestId('primer-modification-picker')).toBeVisible();
  });

  it('closes the slash picker whenever the native selection leaves its anchor', () => {
    render(<EditablePrimerSequence />);
    const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;
    fireEvent.change(input, {
      target: { value: '/pho', selectionStart: 4, selectionEnd: 4 },
    });

    input.setSelectionRange(1, 1);
    fireEvent.click(input);

    expect(screen.queryByTestId('primer-modification-picker')).not.toBeInTheDocument();
  });

  it('offers only direct base and IDT representations from the primer right-click menu', async () => {
    render(<EditablePrimerSequence initial="/5Phos/ACGTACGTACGT" />);
    const input = screen.getByTestId('primer-sequence-input');

    fireEvent.contextMenu(input, { clientX: 120, clientY: 80 });
    const menu = screen.getByRole('menu', { name: 'Primer copy options' });
    expect(menu).toBeVisible();
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
    expect(within(menu).getByRole('menuitem', { name: 'Copy bases' })).toBeVisible();
    expect(within(menu).getByRole('menuitem', { name: 'Copy for IDT' })).toBeVisible();
    expect(within(menu).queryByRole('menuitem', { name: 'Copy' })).not.toBeInTheDocument();
    expect(screen.queryByText('Copy Special')).not.toBeInTheDocument();
    expect(screen.queryByText('Natural DNA')).not.toBeInTheDocument();
    clickMenuItem(within(menu).getByRole('menuitem', { name: 'Copy bases' }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('ACGTACGTACGT');
  });

  it('copies compact vendor notation that can be pasted directly into IDT', () => {
    render(<EditablePrimerSequence initial=" /5Phos/ ACGT /3SpC3/ " />);
    const input = screen.getByTestId('primer-sequence-input');

    fireEvent.contextMenu(input, { clientX: 120, clientY: 80 });
    clickMenuItem(screen.getByRole('menuitem', { name: 'Copy for IDT' }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/5Phos/ACGT/3SpC3/');
  });

  it('maps DNA/RNA ambiguity bases to the shared purple special-base state', () => {
    const notation = '/5Phos/AR/iBiodT/G';
    render(<EditablePrimerSequence initial={notation} />);
    const backdrop = screen.getByTestId('primer-sequence-highlight');
    const modificationRuns = backdrop.querySelectorAll('[data-oligo-run="modification"]');
    const degenerateRuns = backdrop.querySelectorAll('[data-oligo-run="degenerate-base"]');

    expect(Array.from(modificationRuns).map((run) => run.textContent)).toEqual(['*', 'T']);
    expect(Array.from(modificationRuns).every((run) => run.className.includes('text-accent'))).toBe(
      true
    );
    expect(Array.from(degenerateRuns).map((run) => run.textContent)).toEqual(['R']);
    expect(degenerateRuns[0]).toHaveAttribute('data-oligo-visual-state', 'special-base');
    expect(degenerateRuns[0].className).toContain('text-oligo-special');
    expect(degenerateRuns[0].className).not.toContain('text-warning');
    expect(backdrop.textContent).toContain('*ARTG');

    cleanup();
    render(<EditablePrimerSequence initial="rArNrU" orderType="rna" />);
    const rnaAmbiguity = screen
      .getByTestId('primer-sequence-highlight')
      .querySelector('[data-oligo-run="rna-degenerate-base"]');
    expect(rnaAmbiguity).toHaveTextContent('N');
    expect(rnaAmbiguity).toHaveAttribute('data-oligo-visual-state', 'special-base');
    expect(rnaAmbiguity?.className).toContain('text-oligo-special');
    expect(rnaAmbiguity?.className).not.toContain('text-warning');
  });

  it('marks only the invalid modification span and exposes it as a clickable edit target', () => {
    render(<EditablePrimerSequence initial="A/5BiodT/CG" />);
    const invalidToken = screen
      .getByTestId('primer-sequence-highlight')
      .querySelector('[data-vendor-code="5BiodT"]');

    expect(invalidToken).toHaveTextContent('T');
    expect(invalidToken).toHaveAttribute('data-oligo-error', 'true');
    expect(invalidToken?.className).toContain('decoration-wavy');
    expect(invalidToken?.className).toContain('cursor-pointer');
  });

  it('distinguishes unknown modification codes from recognized modifications in invalid positions', () => {
    vi.useFakeTimers();
    try {
      render(<EditablePrimerSequence initial="/NotARealMod/ACGT/5BiodT/" />);
      const backdrop = screen.getByTestId('primer-sequence-highlight');
      const unknown = backdrop.querySelector('[data-oligo-status="unknown-modification"]');
      const incompatible = backdrop.querySelector('[data-oligo-status="incompatible-position"]');

      expect(unknown).toHaveTextContent('/NotARealMod/');
      expect(unknown?.className).toContain('bg-error/10');
      expect(unknown?.className).toContain('text-error');
      expect(unknown?.className).toContain('cursor-help');

      expect(incompatible).toHaveTextContent('T');
      expect(incompatible).toHaveAttribute('data-vendor-code', '5BiodT');
      expect(incompatible?.className).toContain('bg-warning/15');
      expect(incompatible?.className).toContain('text-warning');
      expect(incompatible?.className).toContain('cursor-pointer');

      fireEvent.mouseEnter(unknown?.parentElement as HTMLElement);
      act(() => vi.advanceTimersByTime(300));
      expect(screen.getByRole('tooltip')).toHaveTextContent('Not recognized by IDT');
      expect(screen.getByRole('tooltip')).toHaveTextContent(
        'Unknown IDT modification /NotARealMod/.'
      );

      fireEvent.mouseLeave(unknown?.parentElement as HTMLElement);
      fireEvent.mouseEnter(incompatible?.parentElement as HTMLElement);
      act(() => vi.advanceTimersByTime(300));
      expect(screen.getByRole('tooltip')).toHaveTextContent('Recognized by IDT, wrong position');
      expect(screen.getByRole('tooltip')).toHaveTextContent(
        '/5BiodT/ can only be used at the 5′ end.'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks evidence-linked vendor guidance as a warning without invalidating the oligo', () => {
    vi.useFakeTimers();
    try {
      render(<EditablePrimerSequence initial="A/iDTPA//iDTPA//iDTPA//iDTPA/T" />);
      const input = screen.getByTestId('primer-sequence-input');
      const tokens = screen
        .getByTestId('primer-sequence-highlight')
        .querySelectorAll('[data-vendor-code="iDTPA"]');

      expect(tokens).toHaveLength(4);
      expect(tokens[3]).toHaveAttribute('data-oligo-warning', 'true');
      expect(tokens[3]).not.toHaveAttribute('data-oligo-error');
      fireEvent.mouseEnter(tokens[3].parentElement as HTMLElement);
      act(() => vi.advanceTimersByTime(300));
      expect(screen.getByRole('tooltip')).toHaveTextContent('IDT synthesis guidance');
      expect(screen.getByRole('tooltip')).toHaveTextContent(/documents adjacent DTPA/i);
      expect(input).not.toHaveAttribute('aria-invalid');
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates the modification preview for keyboard and pointer picker navigation', () => {
    render(<EditablePrimerSequence />);
    const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;
    fireEvent.change(input, {
      target: { value: '/spacer', selectionStart: 7, selectionEnd: 7 },
    });

    expect(screen.getByTestId('primer-modification-preview')).toHaveTextContent('5′ Spacer 18');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByTestId('primer-modification-preview')).toHaveTextContent(
      'Internal Spacer 18'
    );

    fireEvent.change(input, {
      target: { value: '/biotin', selectionStart: 7, selectionEnd: 7 },
    });
    fireEvent.mouseEnter(screen.getByRole('option', { name: /5′ Biotin-dT.*5BiodT/i }));
    const preview = screen.getByTestId('primer-modification-preview');
    expect(preview).toHaveTextContent('5′ Biotin-dT');
    expect(preview.querySelector('img')).toBeNull();
    expect(modificationFact('Position')).toBe('5′ end');
    expect(modificationFact('Oligo types')).toBe('DNA, RNA');
    expect(modificationFact('Molecular weight')).toBe('684.7 g/mol');
    expect(modificationFact('Extinction coefficient')).toBeNull();
    expect(modificationFact('Purification')).toBeNull();
    expect(screen.getByTestId('primer-modification-product-link')).toHaveAttribute(
      'href',
      'https://www.idtdna.com/site/Catalog/Modifications/Product/1606'
    );
    expect(screen.getByTestId('primer-modification-product-link')).toHaveAttribute(
      'target',
      '_blank'
    );

    fireEvent.change(input, {
      target: { value: '/iowa', selectionStart: 5, selectionEnd: 5 },
    });
    fireEvent.mouseEnter(screen.getByRole('option', { name: /3IABkFQ/ }));
    expect(modificationFact('Position')).toBe('3′ end');
    expect(modificationFact('Molecular weight')).toBe('442.4 g/mol');
    expect(modificationFact('Extinction coefficient')).toBe('13,344 L/(mol·cm) at 260 nm');
    expect(modificationFact('Purification')).toBe('HPLC required');
  });

  it('keeps the vendor hover card open long enough to follow the exact product link', () => {
    vi.useFakeTimers();
    try {
      render(<EditablePrimerSequence initial="/5BiodT/ACGT" />);
      const token = screen
        .getByTestId('primer-sequence-highlight')
        .querySelector('[data-vendor-code="5BiodT"]');
      expect(token).not.toBeNull();

      fireEvent.mouseEnter(token as Element);
      const card = screen.getByTestId('primer-modification-token-preview');
      expect(card).toHaveTextContent('5′ Biotin-dT');
      expect(card).toHaveTextContent('684.7 g/mol');
      expect(card.querySelector('img')).toBeNull();
      expect(screen.getByTestId('primer-modification-token-product-link')).toHaveAttribute(
        'href',
        'https://www.idtdna.com/site/Catalog/Modifications/Product/1606'
      );

      fireEvent.mouseLeave(token as Element);
      fireEvent.mouseEnter(screen.getByTestId('primer-modification-token-product-link'));
      act(() => vi.advanceTimersByTime(300));
      expect(screen.getByTestId('primer-modification-token-preview')).toBeVisible();

      fireEvent.mouseLeave(screen.getByTestId('primer-modification-token-product-link'));
      act(() => vi.advanceTimersByTime(300));
      expect(screen.queryByTestId('primer-modification-token-preview')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses the token hover card while the modification picker is open', () => {
    render(<EditablePrimerSequence initial="/5BiodT/ACGT" />);
    const token = screen
      .getByTestId('primer-sequence-highlight')
      .querySelector('[data-vendor-code="5BiodT"]');
    expect(token).not.toBeNull();

    fireEvent.mouseEnter(token as Element);
    expect(screen.getByTestId('primer-modification-token-preview')).toBeVisible();

    fireEvent.mouseDown(token as Element);
    expect(screen.getByTestId('primer-modification-picker')).toBeVisible();
    expect(screen.queryByTestId('primer-modification-token-preview')).toBeNull();

    fireEvent.mouseEnter(token as Element);
    expect(screen.queryByTestId('primer-modification-token-preview')).toBeNull();

    fireEvent.keyDown(screen.getByTestId('primer-sequence-input'), { key: 'Escape' });
    fireEvent.mouseEnter(token as Element);
    expect(screen.getByTestId('primer-modification-token-preview')).toBeVisible();
  });

  it('searches and inserts an uncommon modification from the complete IDT catalog', () => {
    render(<EditablePrimerSequence initial="AC" />);
    const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;

    fireEvent.change(input, {
      target: { value: 'AC/iSuper-dG', selectionStart: 12, selectionEnd: 12 },
    });
    const option = screen.getByRole('option', { name: /Internal Super G.*iSuper-dG/i });
    expect(option).toBeVisible();
    clickMenuItem(option);

    expect(input).toHaveAttribute('data-oligo-notation', 'AC/iSuper-dG/');
    fireEvent.change(input, {
      target: { value: 'AC/iSuper-dG/T', selectionStart: 14, selectionEnd: 14 },
    });
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('clicking an existing modification reopens the picker and replaces that token', () => {
    render(<EditablePrimerSequence initial="/5Phos/ACGT" />);
    const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;
    const token = screen
      .getByTestId('primer-sequence-highlight')
      .querySelector('[data-vendor-code="5Phos"]');
    expect(token).not.toBeNull();
    fireEvent.mouseDown(token as Element);
    fireEvent.select(input);

    expect(screen.getByTestId('primer-modification-picker')).toBeVisible();
    expect(screen.getByText('5′ Spacer 18')).toBeVisible();
    clickMenuItem(screen.getByRole('option', { name: /5′ Spacer 18.*5Sp18/i }));

    expect(input).toHaveAttribute('data-oligo-notation', '/5Sp18/ACGT');
    expect(input.dataset.oligoNotation).not.toContain('5Phos');
  });

  it('restores the replacement caret during the controlled-value commit, never in a later frame', () => {
    const requestAnimationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => 1);

    try {
      render(<EditablePrimerSequence initial="/5Phos/ACGT" />);
      const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;
      const token = screen
        .getByTestId('primer-sequence-highlight')
        .querySelector('[data-vendor-code="5Phos"]');
      fireEvent.mouseDown(token as Element);
      clickMenuItem(screen.getByRole('option', { name: /5′ Spacer 18.*5Sp18/i }));
      expect(input).toHaveAttribute('data-oligo-notation', '/5Sp18/ACGT');
      expect(input.selectionStart).toBe(1);
      expect(requestAnimationFrame).not.toHaveBeenCalled();

      const newerNotation = '/5Phos/ACGT/3SpC3/';
      fireEvent.change(input, {
        target: {
          value: newerNotation,
          selectionStart: newerNotation.length,
          selectionEnd: newerNotation.length,
        },
      });
      expect(input).toHaveAttribute('data-oligo-notation', newerNotation);
      expect(input.value).toBe('*ACGT*');
      expect(input.selectionStart).toBe(6);
      expect(input.selectionEnd).toBe(6);
    } finally {
      requestAnimationFrame.mockRestore();
    }
  });
});
