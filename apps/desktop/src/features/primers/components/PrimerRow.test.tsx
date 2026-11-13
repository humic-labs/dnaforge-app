import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PrimerRow } from './PrimerRow';
import type { BoundPrimer } from '../types';

function createTestBoundPrimer(overrides?: Partial<BoundPrimer>): BoundPrimer {
  return {
    id: 'test-primer-1',
    catalogNumber: 'P042',
    name: 'lacZ_F1',
    sequence: 'ATCGATCGATCGATCGATCG',
    length: 20,
    tm: 58.4,
    gcPercent: 50.0,
    origin: 'manual',
    originDetails: null,
    status: 'designed',
    vendor: null,
    orderDate: null,
    application: null,
    scale: null,
    purification: null,
    modifications: null,
    stockLocation: null,
    concentration: null,
    notes: null,
    workspaceId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    binding: {
      id: 'bind-1',
      primerId: 'test-primer-1',
      sequenceId: 42,
      bindingStart: 100,
      bindingEnd: 120,
      strand: 1,
      source: 'manual',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    ...overrides,
  };
}

describe('PrimerRow', () => {
  it('shows full chemical names and codes when an attached modified primer is hovered', async () => {
    render(
      <PrimerRow
        primer={createTestBoundPrimer({
          vendor: 'IDT',
          sequence: 'atcgtatcgatcgatcgatcg',
          modifications: '/5Phos/atcg/iBiodT/atcgatcgatcgatcg',
        })}
      />
    );
    fireEvent.mouseEnter(screen.getByTestId('primer-row-bind-1'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Internal Biotin-dT /iBiodT/');
    expect(tooltip).toHaveTextContent('5′ phosphorylation /5Phos/');
  });

  it('renders primer name and catalog number', () => {
    const primer = createTestBoundPrimer();
    render(<PrimerRow primer={primer} />);

    expect(screen.getByText('lacZ_F1')).toBeDefined();
    expect(screen.getByText('P042')).toBeDefined();
  });

  it('displays Tm and length', () => {
    const primer = createTestBoundPrimer({ tm: 62.5, length: 25 });
    render(<PrimerRow primer={primer} />);

    expect(screen.getByText('25 nt')).toBeDefined();
    expect(screen.getByText('62.5°C')).toBeDefined();
  });

  it('shows forward arrow for forward primers', () => {
    render(
      <PrimerRow
        primer={createTestBoundPrimer({
          binding: {
            id: 'b1',
            primerId: 'p1',
            sequenceId: 42,
            bindingStart: 100,
            bindingEnd: 120,
            strand: 1,
            source: 'manual',
            createdAt: 0,
            updatedAt: 0,
          },
        })}
      />
    );
    expect(screen.getByText('→')).toBeDefined();
  });

  it('shows reverse arrow for reverse primers', () => {
    render(
      <PrimerRow
        primer={createTestBoundPrimer({
          binding: {
            id: 'b1',
            primerId: 'p1',
            sequenceId: 42,
            bindingStart: 100,
            bindingEnd: 120,
            strand: -1,
            source: 'manual',
            createdAt: 0,
            updatedAt: 0,
          },
        })}
      />
    );
    expect(screen.getByText('←')).toBeDefined();
  });

  it('shows status badge', () => {
    render(<PrimerRow primer={createTestBoundPrimer({ status: 'ordered' })} />);
    expect(screen.getByText('ordered')).toBeDefined();
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    render(<PrimerRow primer={createTestBoundPrimer()} onClick={onClick} />);

    fireEvent.click(screen.getByTestId('primer-row-bind-1'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows the FULL primer sequence (no ellipsis / truncation)', () => {
    const seq = 'ATCGATCGATCGATCGATCGATCGATCG';
    const primer = createTestBoundPrimer({ sequence: seq });
    render(<PrimerRow primer={primer} />);

    expect(screen.getByText(seq)).toBeDefined();
    expect(screen.queryByText(/\.\.\.$/)).toBeNull();
  });

  it('applies selected styling when isSelected=true', () => {
    const { container } = render(<PrimerRow primer={createTestBoundPrimer()} isSelected={true} />);
    const row = container.firstChild as HTMLElement;
    expect(row.className).toContain('border-l-accent');
  });
});
