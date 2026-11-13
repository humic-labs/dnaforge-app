import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';
import { GeneticCodeControl, GeneticCodeStatusLine } from './GeneticCodeControl';

function cds(code?: string, name = 'cox1'): Annotation {
  return {
    name,
    type: 'CDS',
    start: 1,
    end: 9,
    direction: 1,
    ...(code ? { qualifiers: { transl_table: [code] } } : {}),
  };
}

function sequence(overrides: Partial<AnnotatedSequence> = {}): AnnotatedSequence {
  return {
    id: 'doc',
    name: 'doc',
    sequence: 'ATGTGAAAA',
    length: 9,
    annotations: [],
    circular: false,
    ...overrides,
  };
}

const organellar = sequence({
  annotations: [
    {
      name: 'source',
      type: 'source',
      start: 1,
      end: 9,
      direction: 0,
      qualifiers: { organelle: ['mitochondrion'] },
    },
  ],
});

function trigger() {
  return screen.getByTestId('genetic-code-control');
}

function open() {
  fireEvent.click(trigger());
  return screen.getByTestId('genetic-code-control-menu');
}

describe('GeneticCodeControl', () => {
  it('names the declared code with one separator, not two', () => {
    render(<GeneticCodeControl sequence={sequence({ annotations: [cds('3')] })} />);
    expect(trigger().textContent).toBe('3 — Yeast Mitochondrial');
  });

  it('carries its state for tooltips and probes', () => {
    const { container } = render(
      <GeneticCodeControl sequence={sequence({ annotations: [cds('3')] })} />
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.dataset.geneticCode).toBe('3');
    expect(wrapper.dataset.geneticCodeBasis).toBe('declared');
    expect(trigger().title).toBe('Declared by 1 feature in this file.');
  });

  it('renders its menu in a portal, outside the info bar that clipped the first version', () => {
    const { container } = render(<GeneticCodeControl sequence={sequence()} onChange={vi.fn()} />);
    const menu = open();
    expect(container.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
  });

  it("leads with the file's own code and lists every published table once", () => {
    render(
      <GeneticCodeControl sequence={sequence({ annotations: [cds('3')] })} onChange={vi.fn()} />
    );
    const options = within(open()).getAllByRole('option');
    expect(options[0].textContent).toContain('Yeast Mitochondrial');
    expect(options[0].textContent).toContain('declared by 1 feature');
    expect(options[0].dataset.testid ?? options[0].getAttribute('data-testid')).toBe(
      'genetic-code-option-3'
    );
    expect(options).toHaveLength(27);
    expect(options.filter((o) => o.textContent?.includes('Yeast Mitochondrial'))).toHaveLength(1);
  });

  it('reports a chosen code', () => {
    const onChange = vi.fn();
    render(<GeneticCodeControl sequence={sequence()} onChange={onChange} />);
    open();
    fireEvent.click(screen.getByTestId('genetic-code-option-4'));
    expect(onChange).toHaveBeenCalledWith('4');
  });

  it('filters the published codes by name in the menu', () => {
    const onChange = vi.fn();
    render(<GeneticCodeControl sequence={sequence()} onChange={onChange} />);
    const menu = open();
    fireEvent.change(within(menu).getByRole('searchbox', { name: 'Search genetic codes' }), {
      target: { value: 'yeast mitochondrial' },
    });
    expect(within(menu).getAllByRole('option')).toHaveLength(1);
    fireEvent.click(within(menu).getByRole('option'));
    expect(onChange).toHaveBeenCalledWith('3');
  });

  it("reports the file's own code as a code, so the caller can clear the override", () => {
    const onChange = vi.fn();
    render(
      <GeneticCodeControl
        sequence={sequence({ annotations: [cds('3')], chosenGeneticCode: 4 })}
        onChange={onChange}
      />
    );
    open();
    fireEvent.click(screen.getByTestId('genetic-code-option-3'));
    expect(onChange).toHaveBeenCalledWith('3');
  });

  it('shows a staged value the caller has not saved yet', () => {
    render(
      <GeneticCodeControl
        sequence={sequence({ annotations: [cds('3')] })}
        value="2"
        onChange={vi.fn()}
      />
    );
    expect(trigger().textContent).toBe('2 — Vertebrate Mitochondrial');
  });

  it('flags a file that needs an answer', () => {
    render(<GeneticCodeControl sequence={organellar} onChange={vi.fn()} />);
    expect(screen.getByTestId('genetic-code-control-warn')).toBeTruthy();
  });

  it('is disabled, not hidden, on a read-only document', () => {
    render(<GeneticCodeControl sequence={sequence({ annotations: [cds('3')] })} />);
    expect(trigger()).toBeDisabled();
    fireEvent.click(trigger());
    expect(screen.queryByTestId('genetic-code-control-menu')).toBeNull();
  });

  it('never offers the retired ids', () => {
    render(<GeneticCodeControl sequence={sequence()} onChange={vi.fn()} />);
    open();
    expect(screen.queryByTestId('genetic-code-option-7')).toBeNull();
    expect(screen.queryByTestId('genetic-code-option-8')).toBeNull();
    expect(screen.getByTestId('genetic-code-option-33')).toBeTruthy();
  });
});

describe('GeneticCodeStatusLine', () => {
  it('says one specific thing about this file', () => {
    render(
      <GeneticCodeStatusLine sequence={sequence({ annotations: [cds('3'), cds('3', 'b')] })} />
    );
    expect(screen.getByTestId('genetic-code-status').textContent).toBe(
      'Declared by 2 features in this file.'
    );
  });

  it('turns amber and asks when the file needs an answer', () => {
    render(<GeneticCodeStatusLine sequence={organellar} />);
    const line = screen.getByTestId('genetic-code-status');
    expect(line.dataset.warn).toBe('true');
    expect(line.textContent).toContain('Pick one');
  });
});
